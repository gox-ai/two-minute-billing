#!/usr/bin/env bash
#
# Deploy the docs site (twominutebilling.com) from this machine: build here, ship the
# Nitro output, swap it in on the server and reload ONLY `tmbilling-docs`.
#
#   bash deploy/docs-deploy.sh             # build, check, ship, swap, reload, verify
#   bash deploy/docs-deploy.sh --dry-run   # build, check and package; touch nothing remote
#   bash deploy/docs-deploy.sh --rollback  # put the previous build back and reload
#
# The server is read from deploy/docs-deploy.local (gitignored; copy the .example) or the
# environment: DOCS_DEPLOY_HOST (user@host, required), DOCS_DEPLOY_PORT (default 22),
# DOCS_DEPLOY_PATH (the repo checkout on the server). The build is the Cloud edition
# (NUXT_PUBLIC_EDITION, default cloud here). The running server reads its NUXT_* settings
# from the server's root .env (docs-site/server/lib/root-env.ts).
#
# Why build here: the docs are content + a Nitro server, independent of the API, the
# dashboard and the worker, so `deploy/reload.sh` never touches them. Building on the
# server would compete for its 7.5 GB with Postgres and the billing worker.
#
# A failed health check after the swap restores the previous build automatically. One
# previous build is kept on the server for --rollback; older ones are deleted.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS="$ROOT/docs-site"
CONFIG="$ROOT/deploy/docs-deploy.local"
# A second copy of the site (another pm2 app, port and folder) can reuse this script.
PM2_NAME="${DOCS_PM2_NAME:-tmbilling-docs}"
REMOTE_PORT_HTTP="${DOCS_REMOTE_PORT:-4201}"
SMOKE_PORT=4299
CHECK_PATH="/help/guides/read-your-numbers"

DRY_RUN=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() {
  printf '\n\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# ------------------------------------------------------------------ config + ssh

if [[ -f "$CONFIG" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG"
fi
HOST="${DOCS_DEPLOY_HOST:-}"
PORT="${DOCS_DEPLOY_PORT:-22}"
REMOTE_REPO="${DOCS_DEPLOY_PATH:-/var/www/html/projects/tmbilling}"
REMOTE_DOCS="$REMOTE_REPO/${DOCS_REMOTE_DIR:-docs-site}"

need_remote() {
  [[ -n "$HOST" ]] || die "DOCS_DEPLOY_HOST is not set — copy deploy/docs-deploy.local.example to deploy/docs-deploy.local"
  # A passphrase-protected key cannot sign without an agent; say so up front instead of
  # failing halfway with "Permission denied (publickey)".
  if ! ssh-add -l >/dev/null 2>&1; then
    die "no key in ssh-agent — run: eval \"\$(ssh-agent)\" && ssh-add ~/.ssh/id_ed25519"
  fi
}

# `bash -ic`: pm2 is on PATH only in the remote user's interactive shell (.bashrc).
remote() {
  local script="$1"
  ssh -p "$PORT" -o BatchMode=yes "$HOST" "bash -ic $(printf '%q' "$script")" \
    2> >(grep -v -e 'cannot set terminal process group' -e 'no job control' >&2)
}

# ------------------------------------------------------------------ rollback

if [[ "$ROLLBACK" == 1 ]]; then
  need_remote
  say "Rolling back $PM2_NAME on $HOST"
  remote "set -e
cd '$REMOTE_DOCS'
prev=\$(ls -d .output.prev-* 2>/dev/null | sort | tail -1)
[ -n \"\$prev\" ] || { echo 'no previous build to roll back to' >&2; exit 1; }
rm -rf .output.failed && mv .output .output.failed && mv \"\$prev\" .output
pm2 reload $PM2_NAME
sleep 3
code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$REMOTE_PORT_HTTP$CHECK_PATH)
echo \"restored \$prev -> .output, health \$code\"
rm -rf .output.failed
[ \"\$code\" = 200 ]"
  say "Rolled back"
  exit 0
fi

# ------------------------------------------------------------------ preflight

cd "$ROOT"
SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

say "Preflight ($BRANCH @ $SHA)"
[[ "$BRANCH" == "main" ]] || echo "warning: deploying from '$BRANCH', not main"
if ! git diff --quiet HEAD -- docs-site; then
  echo "warning: docs-site has uncommitted changes — they will be deployed too"
fi
git fetch -q origin main 2>/dev/null || true
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null || echo none)" ]]; then
  echo "warning: HEAD is not origin/main — the live site will not match what is pushed"
fi
# `nuxt dev` holds the Nuxt Content SQLite database and the build fails with
# "database is locked" (see deploy/pm2/tmbilling-docs.json).
if pgrep -f "nuxt dev" >/dev/null 2>&1; then
  die "a 'nuxt dev' server is running — stop it before building"
fi
[[ "$DRY_RUN" == 1 ]] || need_remote

# ------------------------------------------------------------------ build + checks

say "Building docs-site"
# This script deploys our own site, so it builds the Cloud edition unless told otherwise. A
# plain `pnpm docs-site:build` keeps the self_hosted default.
export NUXT_PUBLIC_EDITION="${NUXT_PUBLIC_EDITION:-cloud}"
# Prerendered pages bake the public keys in at build time; the server's root .env reaches only
# server-rendered pages and /api/*. Set them in deploy/docs-deploy.local to build with them.
for key in NUXT_PUBLIC_APP_URL NUXT_PUBLIC_SITE_URL NUXT_PUBLIC_TURNSTILE_SITE_KEY NUXT_PUBLIC_GA_ID; do
  if [[ -n "${!key:-}" ]]; then export "${key?}"; fi
done
# Marketing pages read the Free band from the plan catalogue while prerendering and fail
# without it. Say so here rather than as twenty prerender errors.
if [[ "$NUXT_PUBLIC_EDITION" == cloud ]]; then
  [[ -n "${NUXT_PRICING_API_URL:-}" && -n "${NUXT_PRICING_BUSINESS:-}" ]] ||
    die "NUXT_PRICING_API_URL and NUXT_PRICING_BUSINESS must be set in deploy/docs-deploy.local (the public API base, not the server's local one)"
  export NUXT_PRICING_API_URL NUXT_PRICING_BUSINESS
fi
echo "  edition: $NUXT_PUBLIC_EDITION · analytics: ${NUXT_PUBLIC_GA_ID:-off}"
# Nuxt keeps prerendered fetches on disk between builds, keyed by name only: a stale "plans"
# copy shipped the prices from before a reprice. Every deploy prerenders fresh.
rm -rf "$ROOT/docs-site/node_modules/.cache/nuxt/.nuxt/cache/nitro/prerender"
# The canonical build: regenerates the webhook and API references, then `nuxt build`.
pnpm docs-site:build

say "Checking the build"
# The build machine's Node may differ from the server's. Only N-API binaries (sharp) are
# ABI-stable across Node versions; anything else compiled here would crash there.
bad_native="$(find "$DOCS/.output" -name '*.node' ! -path '*/@img/sharp-*' || true)"
[[ -z "$bad_native" ]] || die "build bundles Node-version-specific binaries:
$bad_native"
# A require of this checkout's own path resolves here, so the smoke test passes, and 500s on
# the server. nuxt 4.6 did this for estree-walker and source-map-js.
local_requires="$(grep -rlF --include='*.mjs' "require(\"$ROOT/" "$DOCS/.output/server" || true)"
[[ -z "$local_requires" ]] || die "build requires modules by this machine's absolute path:
$local_requires"

say "Smoke-testing the build on :$SMOKE_PORT"
PORT=$SMOKE_PORT HOST=127.0.0.1 NODE_ENV=production node "$DOCS/.output/server/index.mjs" \
  >/dev/null 2>&1 &
SMOKE_PID=$!
trap 'kill $SMOKE_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$SMOKE_PORT/" && break
  sleep 0.5
done
for path in / "$CHECK_PATH"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT$path")"
  echo "  $path -> $code"
  [[ "$code" == 200 ]] || die "local build answered $code for $path"
done
kill "$SMOKE_PID" 2>/dev/null || true
trap - EXIT

say "Packaging"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TGZ="docs-output-$SHA.tgz"
tar -czf "$TMP/$TGZ" -C "$DOCS" .output
SUM="$(sha256sum "$TMP/$TGZ" | cut -d' ' -f1)"
echo "  $TGZ  $(du -h "$TMP/$TGZ" | cut -f1)  sha256 $SUM"

if [[ "$DRY_RUN" == 1 ]]; then
  say "Dry run — nothing sent to the server"
  exit 0
fi

# ------------------------------------------------------------------ ship + swap

say "Copying to $HOST"
scp -q -P "$PORT" -o BatchMode=yes "$TMP/$TGZ" "$HOST:~/$TGZ"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
say "Swapping in and reloading $PM2_NAME"
remote "set -e
cd '$REMOTE_DOCS'
echo '$SUM  '\"\$HOME/$TGZ\" | sha256sum -c --quiet
# Refuse before the swap if pm2 would restart the site with a deleted node (deploy/lib/pm2-node.sh).
if [ -f ../deploy/lib/pm2-node.sh ]; then
  . ../deploy/lib/pm2-node.sh
  use_stable_node
  require_live_node deploy/pm2 $PM2_NAME || exit 1
fi
if [ -d .output ]; then mv .output '.output.prev-$STAMP'; fi
if ! tar -xzf \"\$HOME/$TGZ\"; then
  rm -rf .output && mv '.output.prev-$STAMP' .output
  echo 'extract failed — previous build left in place' >&2; exit 1
fi
pm2 reload $PM2_NAME
code=000
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$REMOTE_PORT_HTTP$CHECK_PATH || true)
  [ \"\$code\" = 200 ] && break
done
if [ \"\$code\" != 200 ]; then
  echo \"health check answered \$code — rolling back\" >&2
  rm -rf .output && mv '.output.prev-$STAMP' .output && pm2 reload $PM2_NAME
  rm -f \"\$HOME/$TGZ\"
  exit 1
fi
echo \"health \$code\"
rm -f \"\$HOME/$TGZ\"
# Keep the newest previous build for --rollback; drop the rest.
ls -d .output.prev-* 2>/dev/null | sort | head -n -1 | xargs -r rm -rf"

say "Live: $SHA deployed to $PM2_NAME (previous build kept for --rollback)"
