#!/usr/bin/env bash
# Boot gate for pm2-webadmin.service: wait until Postgres accepts connections, so the apps do not
# crash-loop while its container starts. Gives up after 120 s and starts pm2 anyway; pm2 retries.
# Never prints the URL: it holds the database password.
set -u
env_file=${1:-/var/www/html/projects/tmbilling/.env}
url=$(grep -m1 '^[[:space:]]*DATABASE_URL=' "$env_file" 2>/dev/null | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//")
if [ -z "$url" ] || ! command -v pg_isready >/dev/null; then
  echo "wait-for-db: no DATABASE_URL in $env_file or no pg_isready; not waiting"
  exit 0
fi
for i in $(seq 1 60); do
  if pg_isready -q -d "$url"; then
    echo "wait-for-db: postgres ready after $(((i - 1) * 2)) s"
    exit 0
  fi
  sleep 2
done
echo "wait-for-db: postgres not ready after 120 s; starting pm2 anyway"
exit 0
