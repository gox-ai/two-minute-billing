#!/usr/bin/env bash
# Write the two settings files a self-hosted install runs on, once.
#
#   ./init-env.sh            # production: Caddy serves APP_HOST and API_HOST over HTTPS
#   ./init-env.sh --local    # this machine only: http://localhost:4100 and :4000
#
# Answers can come from the environment instead of prompts (TMB_APP_HOST, TMB_API_HOST,
# TMB_ADMIN_EMAIL, TMB_ORG_NAME, TMB_VERSION, TMB_SMTP_HOST, TMB_SMTP_USERNAME,
# TMB_SMTP_PASSWORD, TMB_MAIL_FROM).
#
# It refuses to overwrite either file: a new GATEWAY_CREDENTIALS_KEY makes every stored
# gateway credential unreadable, and a new API_KEY_SECRET invalidates every API key.
set -Eeuo pipefail
cd "$(dirname "$0")"

LOCAL=0
for a in "$@"; do
  case "$a" in
    --local) LOCAL=1 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

for f in .env app.env; do
  if [ -e "$f" ]; then
    echo "deploy/docker/$f exists. Keep it: it holds the keys your data depends on." >&2
    echo "To start again with an EMPTY database, remove the volumes and both files first." >&2
    exit 1
  fi
done
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 1; }

ask() { # ask VAR "prompt" [default]
  local var=$1 prompt=$2 def=${3:-} val
  val="${!var:-}"
  if [ -z "$val" ]; then
    if [ -t 0 ]; then
      read -r -p "$prompt${def:+ [$def]}: " val
    fi
    val="${val:-$def}"
  fi
  printf -v "$var" '%s' "$val"
}

hex() { openssl rand -hex "$1"; }
# Meets the password policy: random base64url, then a symbol, a digit and a capital.
admin_password() { printf '%s-7Q' "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')"; }

default_version="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
ask TMB_VERSION "Image version (a release tag, or any name for a local build)" "${default_version:-local}"
if [ "$LOCAL" = 1 ]; then
  TMB_APP_HOST=localhost TMB_API_HOST=localhost
  app_url="http://localhost:4100" api_url="http://localhost:4000" hops=0
else
  ask TMB_APP_HOST "Dashboard host name (DNS must point here), e.g. billing.example.com"
  ask TMB_API_HOST "API host name, e.g. api.billing.example.com"
  [ -n "$TMB_APP_HOST" ] && [ -n "$TMB_API_HOST" ] || { echo "Both host names are required." >&2; exit 1; }
  app_url="https://$TMB_APP_HOST" api_url="https://$TMB_API_HOST" hops=1
fi
ask TMB_ADMIN_EMAIL "First admin email"
ask TMB_ORG_NAME "Organization name" "My company"
[ -n "$TMB_ADMIN_EMAIL" ] || { echo "The admin email is required." >&2; exit 1; }
ask TMB_SMTP_HOST "SMTP host (empty = log emails instead of sending)"
if [ -n "$TMB_SMTP_HOST" ]; then
  ask TMB_SMTP_USERNAME "SMTP username"
  ask TMB_SMTP_PASSWORD "SMTP password"
  ask TMB_MAIL_FROM "From address" "billing@$TMB_APP_HOST"
fi

admin_pw="$(admin_password)"
umask 077

{
  echo "# Compose values. Back this file up with app.env: without them the data is unreadable."
  echo "TMBILLING_VERSION=$TMB_VERSION"
  [ "$LOCAL" = 1 ] && echo "COMPOSE_FILE=compose.yaml:compose.local.yaml"
  echo "APP_HOST=$TMB_APP_HOST"
  echo "API_HOST=$TMB_API_HOST"
  echo "TMBILLING_PUBLIC_API_URL=$api_url"
  echo "POSTGRES_PASSWORD=$(hex 24)"
  echo "APP_DB_PASSWORD=$(hex 24)"
  echo
  echo "# Used once, while the database has no users. Remove the password after the first start."
  echo "TMBILLING_INIT_ADMIN_EMAIL=$TMB_ADMIN_EMAIL"
  echo "TMBILLING_INIT_ORG_NAME=$TMB_ORG_NAME"
  echo "TMBILLING_INIT_ADMIN_PASSWORD=$admin_pw"
  echo "# TMBILLING_INIT_API_KEY=sk_live_<32 or more characters>"
} > .env

{
  echo "# Engine settings. Every name is documented in the repository's .env.example."
  echo "NODE_ENV=production"
  echo "TMBILLING_EDITION=self_hosted"
  echo "API_KEY_SECRET=$(hex 32)"
  echo "GATEWAY_CREDENTIALS_KEY=$(hex 32)"
  echo "DASHBOARD_BASE_URL=$app_url"
  echo "PORTAL_BASE_URL=$app_url"
  echo "WEBHOOK_BASE_URL=$api_url"
  echo "TRUST_PROXY_HOPS=$hops"
  echo "PASSWORD_BREACH_CHECK=TRUE"
  echo "# Logs go to stdout and your Docker log driver. TRUE ships them to Google Cloud Logging."
  echo "CLOUD_LOGGING=FALSE"
  if [ -n "$TMB_SMTP_HOST" ]; then
    echo "MAILER_PROVIDER=smtp"
    echo "SMTP_HOST=$TMB_SMTP_HOST"
    echo "SMTP_USERNAME=$TMB_SMTP_USERNAME"
    echo "SMTP_PASSWORD=$TMB_SMTP_PASSWORD"
    echo "MAIL_FROM=$TMB_MAIL_FROM"
  else
    echo "MAILER_PROVIDER=console"
  fi
  echo "# Logo uploads: any S3-compatible store (OBJECT_STORE_ENDPOINT, R2_BUCKET_NAME,"
  echo "# R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CDN_URL). Unset = upload controls hidden."
} > app.env

echo
echo "Wrote deploy/docker/.env and deploy/docker/app.env (mode 600)."
echo
echo "  First admin: $TMB_ADMIN_EMAIL"
echo "  Password   : $admin_pw"
echo
echo "This is the only time the password is shown. Store it in a password manager now."
echo "Back up .env and app.env with your database backups: they hold the keys."
echo
echo "Next: docker compose up -d     (dashboard: $app_url)"
