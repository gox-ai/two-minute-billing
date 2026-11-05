#!/usr/bin/env bash
#
# From a fresh clone to a dashboard full of demo data.
#
#   pnpm setup:local [--yes] [--reset] [--small]
#
# The prose version is SETUP.md; this is the same runbook, executable, so nobody has to
# remember the ordering that is easy to get wrong: `geo:seed` must run before the seed
# (address validation reads those tables).
#
# Safe to re-run with --reset. Without it a second run stops at "An account with that email
# already exists": the seed mints a fresh org and signup refuses the duplicate login.
#
#   --yes    never prompt
#   --reset  TRUNCATE all tenant data first (pnpm db:reset)
#   --small  a smaller, faster seed (fewer customers and months)
set -euo pipefail
cd "$(dirname "$0")/.."

YES=0; RESET=0; SMALL=0
for a in "$@"; do case "$a" in
  --yes|-y) YES=1 ;; --reset) RESET=1 ;; --small) SMALL=1 ;;
  # Printed by scanning the header rather than a line range: `sed -n '3,18p'` silently
  # stopped naming the flags the moment the comment above it grew.
  *) echo "unknown flag: $a"; awk 'NR>2 { if (/^#/) print; else exit }' "$0"; exit 2 ;;
esac; done

STEP=0
say()  { STEP=$((STEP+1)); printf '\n\033[1m%s. %s\033[0m\n' "$STEP" "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[2m%s\033[0m\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
# Defaults are applied without asking under --yes; a prompt with no default always asks.
prompt() { # prompt <question> <default>
  if [ "$YES" = 1 ] && [ -n "${2:-}" ]; then REPLY="$2"; return; fi
  read -r -p "  $1${2:+ [$2]}: " REPLY || true
  REPLY="${REPLY:-${2:-}}"
}

say "Environment"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }
# API_KEY_SECRET is what API keys are hashed against, so leaving the example placeholder
# means every machine hashes keys identically.
for var in API_KEY_SECRET GATEWAY_CREDENTIALS_KEY; do
  if grep -qE "^$var=change-me" .env; then
    sed -i "s|^$var=.*|$var=$(openssl rand -hex 32)|" .env
    ok "generated $var"
  fi
done
# An exported DATABASE_URL wins over the file (dotenv never overrides), so report the
# one the children will actually connect to rather than the one in .env.
if [ -n "${DATABASE_URL:-}" ]; then
  ok "DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#')  (from the environment, overriding .env)"
else
  grep -qE '^DATABASE_URL=.' .env || die "set DATABASE_URL in .env first"
  ok "$(grep -E '^DATABASE_URL=' .env | sed -E 's#(://[^:]+:)[^@]+@#\1***@#')"
fi
note "no Postgres yet? \`docker compose up -d\` (needs POSTGRES_USER/PASSWORD/PORT in .env, see SETUP.md §1)"

say "Schema + reference data"
# db:migrate runs db:bootstrap first (the graphile_worker schema migration 0130 grants on).
pnpm db:migrate || die "migrations failed — is Postgres up and DATABASE_URL a superuser connection? (migration 0001 runs CREATE ROLE)"
# Upsert-idempotent, so it is cheaper to always run than to check. NOT optional: address
# validation reads these tables.
pnpm geo:seed
ok "schema + geo reference data ready"

if [ "$RESET" = 1 ]; then
  say "Reset"
  # Typed confirmation even under --reset: db:reset truncates every tenant table and the
  # ledger is append-only, so there is nothing to undo it with.
  if [ "$YES" = 1 ]; then REPLY=reset; else read -r -p "  type 'reset' to TRUNCATE all tenant data: " REPLY || true; fi
  [ "$REPLY" = reset ] || die "not resetting"
  pnpm db:reset
  ok "truncated (schema, migration history and geo data kept)"
fi

say "Demo data"
SEED_ARGS=(); [ "$SMALL" = 1 ] && SEED_ARGS=(--small)
note "runs the real billing engine through months of simulated history — takes a few minutes"
pnpm seed "${SEED_ARGS[@]}" || die "seed failed — if it says the account already exists, re-run with --reset"
ok "seeded — login + API key printed above"

# dashboard/ is a package in the pnpm workspace, so the root `pnpm install` a
# fresh clone already ran has linked its dependencies too. This used to be a
# second, independent install against dashboard/pnpm-lock.yaml.
[ -d dashboard/node_modules ] || pnpm install

printf '\n\033[1;32m%s\033[0m\n' "Setup complete — three processes, one terminal each:"
printf '  \033[36mpnpm dev\033[0m                     API on :4000   \033[2mcurl localhost:4000/health\033[0m\n'
printf '  \033[36mpnpm worker\033[0m                  billing clock\n'
printf '  \033[36mpnpm dev:dashboard\033[0m           admin UI on :4100\n\n'
note "log in at http://localhost:4100 with the credentials \`pnpm seed\` printed above"
note "the dashboard holds no credential of its own — it authenticates as whoever is signed in"
note "geo data is loaded once at boot — restart the API and worker after a reseed"
note "⚠ pnpm verify:all runs db:reset and truncates the seed — use pnpm verify:all:fresh"
echo
