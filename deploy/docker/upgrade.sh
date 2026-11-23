#!/usr/bin/env bash
# Upgrade a Docker install to a newer release, in one command.
#
#   ./upgrade.sh                 # the newest release
#   ./upgrade.sh v0.2.3          # a specific release
#   ./upgrade.sh --dry-run       # show the plan; change nothing
#   ./upgrade.sh --version       # the installed release and the newest one
#
# Options: --yes (no prompt), --no-backup (skip the backup; not recommended).
#
# Steps: refuse local code changes, a local build and a downgrade; back up the database; check
# out the release tag; set TMBILLING_VERSION in .env; pull the images; start. `init` applies the
# database changes before the API starts. On a failure it shows init's log and how to go back.
# It never restores or downgrades by itself.
set -Eeuo pipefail

# Everything runs from main(): `git checkout` replaces this file while it runs, and bash reads
# a script as it goes, but it reads a whole function before it starts it.
main() {
  local TARGET="" DRY=0 YES=0 BACKUP=1 SHOW=0
  for a in "$@"; do
    case "$a" in
      --dry-run | -n) DRY=1 ;;
      --yes | -y) YES=1 ;;
      --no-backup) BACKUP=0 ;;
      --version | -V) SHOW=1 ;;
      -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
      v[0-9]* | [0-9]*) TARGET="v${a#v}" ;;
      *) die "unknown argument: $a (see ./upgrade.sh --help)" ;;
    esac
  done

  cd "$(dirname "$0")"
  [ -f .env ] || die "no .env here. Install first: ./init-env.sh, then docker compose up -d"
  command -v git >/dev/null || die "git is required"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  git rev-parse --git-dir >/dev/null 2>&1 || die "this is not a git checkout; upgrade by hand (see the help page)"

  local CURRENT
  CURRENT="v$(sed -n 's/^TMBILLING_VERSION=//p' .env | tail -n 1 | tr -d '"'"'"' ' | sed 's/^v//')"
  git fetch --quiet --tags origin || die "could not fetch the releases from origin"
  local LATEST
  LATEST="$(git tag -l 'v*' --sort=-v:refname | grep -v -- '-' | head -n 1 || true)"
  [ -n "$LATEST" ] || die "no releases found on origin"

  if [ "$SHOW" = 1 ]; then
    echo "installed: $CURRENT"
    echo "newest:    $LATEST"
    if [ "$CURRENT" != "$LATEST" ] && is_release "$CURRENT" && newer "$LATEST" "$CURRENT"; then
      echo "Run ./upgrade.sh to upgrade."
    fi
    return 0
  fi

  TARGET="${TARGET:-$LATEST}"
  git rev-parse --verify --quiet "refs/tags/$TARGET" >/dev/null || die "$TARGET is not a release"
  is_release "$CURRENT" \
    || die "TMBILLING_VERSION is ${CURRENT#v}, a local build. Upgrade it with git checkout and docker compose build"
  if [ "$CURRENT" = "$TARGET" ]; then
    ok "already on $TARGET"
    [ "$TARGET" = "$LATEST" ] || echo "  The newest release is $LATEST."
    return 0
  fi
  newer "$TARGET" "$CURRENT" \
    || die "$TARGET is older than $CURRENT. There is no downgrade: restore a backup made on the older release"
  # Mode-only changes do not count: older releases shipped init-env.sh without its x bit.
  [ -z "$(git -c core.fileMode=false status --porcelain --untracked-files=no)" ] \
    || die "the checkout has local code changes. Commit or remove them first (git status)"

  step "Upgrade $CURRENT → $TARGET"
  db_changes "$TARGET"
  manual_steps "$CURRENT" "$TARGET"
  echo "  Release notes: https://github.com/gox-ai/two-minute-billing/releases"
  if [ "$DRY" = 1 ]; then
    echo; echo "Dry run: nothing changed."
    return 0
  fi
  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "no terminal to confirm in; run with --yes"
    local reply
    read -r -p "  Upgrade to $TARGET? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || die "not upgraded"
  fi

  local BACKUP_FILE=""
  if [ "$BACKUP" = 1 ]; then
    step "Back up the database"
    docker compose --profile backup run --rm backup >/dev/null || die "the backup failed; nothing changed"
    BACKUP_FILE="$(ls -t backups/*.dump 2>/dev/null | head -n 1)"
    ok "backups/${BACKUP_FILE#backups/}"
  fi

  step "Check out $TARGET"
  local PREV_REF
  PREV_REF="$(git rev-parse HEAD)"
  git -c advice.detachedHead=false -c core.fileMode=false checkout --quiet "$TARGET"
  set_version "${TARGET#v}"
  ok "code at $TARGET; TMBILLING_VERSION=${TARGET#v}"

  step "Pull the images"
  docker compose pull --quiet || fail "could not pull the $TARGET images" "$CURRENT" "$PREV_REF" "$BACKUP_FILE"
  ok "pulled"

  step "Start: init applies the database changes, then the API, worker and dashboard"
  if ! docker compose up -d --wait; then
    fail "the stack did not start on $TARGET" "$CURRENT" "$PREV_REF" "$BACKUP_FILE"
  fi
  ok "running $TARGET"
  docker compose ps --format '  {{.Service}}: {{.Status}}' 2>/dev/null || true
}

B=$'\033[1m' G=$'\033[32m' R=$'\033[31m' N=$'\033[0m'
[ -t 1 ] || { B="" G="" R="" N=""; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
die() { printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

is_release() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
# newer A B: A is a later version than B.
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

# Changes the line in place, keeping the file's mode (it holds passwords).
set_version() {
  sed -i.bak "s/^TMBILLING_VERSION=.*/TMBILLING_VERSION=$1/" .env && rm -f .env.bak
}

# The migrations the running database lacks, from its own record when Postgres is up.
db_changes() {
  local target=$1 applied whens n
  applied="$(docker compose exec -T postgres psql -U tmbilling -d tmbilling -tAc \
    "select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations" 2>/dev/null | tr -d '[:space:]' || true)"
  whens="$(git show "$target:db/migrations/meta/_journal.json" 2>/dev/null \
    | grep -o '"when": *[0-9]*' | grep -o '[0-9]*$' || true)"
  if [[ "$applied" =~ ^[0-9]+$ ]]; then
    n="$(printf '%s\n' "$whens" | awk -v a="$applied" '$1 > a' | grep -c . || true)"
    if [ "$n" = 0 ]; then echo "  Database: no changes to apply."
    else echo "  Database: $n changes to apply. init applies them; there is nothing to run by hand."; fi
  else
    echo "  Database: init applies the changes this database lacks (Postgres is not running, so not counted)."
  fi
}

# Every "#### vX.Y.Z" version note after CURRENT, up to and including TARGET, from TARGET's help page.
manual_steps() {
  local current=$1 target=$2 page="docs-site/content/help/40.developers/01.getting-started/06.self-host-docker.md"
  local notes
  notes="$(git show "$target:$page" 2>/dev/null | awk '
    /^#### v[0-9]/ { v = $2; on = 1; print "@@" v; next }
    on && /^##/ { on = 0 }
    on { print }
  ' || true)"
  local out="" v="" keep=0 line
  while IFS= read -r line; do
    if [[ "$line" == @@* ]]; then
      v="${line#@@}"
      keep=0
      if newer "$v" "$current" && ! newer "$v" "$target"; then keep=1; out+=$'\n'"  $v:"; fi
    elif [ "$keep" = 1 ] && [ -n "$line" ]; then
      out+=$'\n'"    $line"
    fi
  done <<<"$notes"
  if [ -n "$out" ]; then echo "  Manual steps from the version notes:$out"; else echo "  Manual steps: none."; fi
}

fail() {
  local why=$1 prev=$2 ref=$3 backup=$4
  printf '\n  %s✗%s %s\n\n' "$R" "$N" "$why" >&2
  # init first: it migrates. Then the API, whose schema check names a database left behind.
  echo "  The last log lines of init and the api:" >&2
  docker compose logs --no-color --tail 15 init api 2>/dev/null | sed 's/^/    /' >&2 || true
  {
    echo
    echo "  The database may be partly upgraded. To go back to $prev:"
    echo "    git checkout $ref"
    echo "    sed -i.bak 's/^TMBILLING_VERSION=.*/TMBILLING_VERSION=${prev#v}/' .env && rm -f .env.bak"
    if [ -n "$backup" ]; then
      echo "    docker compose down"
      echo "    docker compose up -d postgres"
      echo "    docker compose exec -T postgres pg_restore -U tmbilling -d tmbilling --clean --if-exists < $backup"
    fi
    echo "    docker compose up -d"
  } >&2
  exit 1
}

# One line: after main, bash must not read on into the file checkout replaced.
main "$@"; exit $?
