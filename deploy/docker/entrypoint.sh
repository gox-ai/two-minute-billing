#!/bin/sh
# Resolve <NAME>_FILE (a Docker, Swarm or Kubernetes secret file) into <NAME> for the secrets
# below, then exec the command, so tini's child is node itself.
set -eu

for name in DATABASE_URL MIGRATION_DATABASE_URL APP_DB_PASSWORD API_KEY_SECRET \
  GATEWAY_CREDENTIALS_KEY GATEWAY_CREDENTIALS_KEY_PREVIOUS SMTP_PASSWORD AWS_EMAIL_SECRET \
  R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY GOOGLE_CLIENT_SECRET HUBSPOT_CLIENT_SECRET \
  TMBILLING_INIT_ADMIN_PASSWORD TMBILLING_INIT_API_KEY; do
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || continue
  eval "current=\${${name}:-}"
  if [ -n "$current" ]; then
    echo "entrypoint: set ${name} or ${name}_FILE, not both" >&2
    exit 1
  fi
  if [ ! -r "$file" ]; then
    echo "entrypoint: ${name}_FILE names a file that cannot be read" >&2
    exit 1
  fi
  value="$(cat "$file")"
  export "${name}=${value}"
  unset "${name}_FILE"
done

exec "$@"
