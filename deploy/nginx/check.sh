#!/usr/bin/env bash
# Proxy-only nginx check. Run after ANY nginx change — and before trusting the box.
#   On the box:   sudo bash deploy/nginx/check.sh            (validate + drift + local probes)
#   From outside: bash deploy/nginx/check.sh --outside <ip>  (what the internet sees)
# Hostnames and the API prefix come from deploy/nginx/nginx.local. Rules: deploy/README.md § 8.
set -uo pipefail
cd "$(dirname "$0")"

[ -f nginx.local ] || { echo "deploy/nginx/nginx.local is missing — copy nginx.local.example."; exit 1; }
# shellcheck disable=SC1091
. ./nginx.local

FAIL=0
check() { # label, wanted code, curl args...
  local label=$1 want=$2 got; shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$@" 2>/dev/null); got=${got:-000}
  if [ "$got" = "$want" ]; then printf '  ok    %-46s %s\n' "$label" "$got"
  else printf '  FAIL  %-46s %s (want %s)\n' "$label" "$got" "$want"; FAIL=1; fi
}

if [ "${1:-}" = "--outside" ]; then
  IP=${2:?usage: check.sh --outside <ip>}
  echo "Straight to the box (000 = refused, which is right):"
  check "http  <ip>/"                               000 "http://$IP/"
  check "https <ip>/"                               000 -k "https://$IP/"
  check "https <ip> with app's name (skips Cloudflare)" 403 -k --resolve "app.$DOMAIN:443:$IP" "https://app.$DOMAIN/login"
  echo "Through Cloudflare:"
  check "docs site"                                 200 "https://$DOMAIN/"
  check "http www -> https apex"                    301 "http://www.$DOMAIN/"
  check "https www -> https apex"                   301 "https://www.$DOMAIN/"
  check "app login"                                 200 "https://app.$DOMAIN/login"
  check "ops login"                                 200 "https://ops.$DOMAIN/login"
  check "portal"                                    200 "https://portal.$DOMAIN/portal"
  check "API host /"                                404 "https://$API_HOST/"
  check "API health"                                200 "https://$API_HOST/$API_PREFIX/health"
  [ $FAIL = 0 ] && echo "All good." || echo "Something is off — see FAIL lines."
  exit $FAIL
fi

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (nginx -T reads the TLS keys)."; exit 1; }

echo "1. Syntax"
nginx -t 2>&1 | sed 's/^/  /' || FAIL=1
echo "2. Proxy only"
nginx -T 2>/dev/null | python3 nginx-tool.py validate | sed 's/^/  /'
[ "${PIPESTATUS[1]}" = 0 ] || FAIL=1
echo "3. Live config vs repo"
python3 nginx-tool.py drift /etc/nginx | sed 's/^/  /'
[ "${PIPESTATUS[0]}" = 0 ] || FAIL=1
echo "4. Probes from the box"
R() { echo "--resolve" "$1:443:127.0.0.1" "https://$1$2"; }
check "http  127.0.0.1/ (default site)"           000 "http://127.0.0.1/"
check "http  www -> https apex"                   301 -H "Host: www.$DOMAIN" "http://127.0.0.1/"
check "https unknown name"                        000 -k $(R unknown.invalid /)
check "https docs site"                           200 -k $(R "$DOMAIN" /)
check "https app login"                           200 -k $(R "app.$DOMAIN" /login)
check "https ops login"                           200 -k $(R "ops.$DOMAIN" /login)
check "https portal"                              200 -k $(R "portal.$DOMAIN" /portal)
check "https portal checkout"                     200 -k $(R "portal.$DOMAIN" /checkout)
check "https API host /"                          404 -k $(R "$API_HOST" /)
[ $FAIL = 0 ] && echo "All good." || echo "Something is off — see FAIL / DRIFT lines."
exit $FAIL
