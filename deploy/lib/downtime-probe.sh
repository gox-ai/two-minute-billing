# shellcheck shell=bash
# Measure what a reload costs callers: one background loop per target, a request every 100 ms,
# each answer logged. 000 (refused / no answer) and 502/503/504 count as downtime.
#
# Sourced by deploy/reload.sh, or run on its own around anything you want to measure:
#   bash deploy/lib/downtime-probe.sh 60 api=http://127.0.0.1:4001/healthz dash=http://127.0.0.1:4101/login
# A target may carry curl flags after a second `=`, e.g. to go through nginx on the box:
#   app=https://app.example.com/login=--resolve app.example.com:443:127.0.0.1 -k

PROBE_DIR=""

probe_start() { # target...
  PROBE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/downtime-probe.XXXXXX")
  local t label rest url extra
  for t in "$@"; do
    label=${t%%=*}; rest=${t#*=}
    url=${rest%%=*}; extra=""; [ "$url" != "$rest" ] && extra=${rest#*=}
    (
      trap 'exit 0' TERM
      while :; do
        # shellcheck disable=SC2086 # extra is a flag list by design
        code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' $extra "$url" 2>/dev/null) || true
        printf '%s %s\n' "$(date +%s.%N)" "${code:-000}" >>"$PROBE_DIR/$label.log"
        sleep 0.1
      done
    ) &
    echo $! >>"$PROBE_DIR/pids"
  done
}

probe_stop() {
  [ -n "$PROBE_DIR" ] && [ -f "$PROBE_DIR/pids" ] || return 0
  local p
  while read -r p; do kill "$p" 2>/dev/null || true; done <"$PROBE_DIR/pids"
  wait 2>/dev/null || true
}

# Prints one line per target; returns 1 if any target saw downtime.
probe_report() {
  [ -n "$PROBE_DIR" ] || return 0
  local f bad=0 line
  for f in "$PROBE_DIR"/*.log; do
    [ -f "$f" ] || continue
    line=$(awk -v label="$(basename "$f" .log)" '
      { n++; failed = ($2 == "000" || $2 == "502" || $2 == "503" || $2 == "504")
        if (failed) { f++; if (!start) start = $1; last = $1 }
        else if (start) { gap = $1 - start; if (gap > worst) worst = gap; start = 0 } }
      END { if (start) { gap = last - start; if (gap > worst) worst = gap }
            printf "%s %d %d %.1f\n", label, n, f, worst }' "$f")
    read -r label n f worst <<<"$line"
    printf '    %-10s %5d requests  %4d failed  longest gap %ss\n' "$label" "$n" "$f" "$worst"
    [ "$f" -gt 0 ] && bad=1
  done
  rm -rf "$PROBE_DIR"
  return $bad
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  secs=${1:?usage: downtime-probe.sh SECONDS label=url[=curl flags]...}; shift
  probe_start "$@"
  trap 'probe_stop; probe_report; exit' INT
  sleep "$secs"
  probe_stop
  probe_report
fi
