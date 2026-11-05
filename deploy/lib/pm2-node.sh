# Sourced by the deploy scripts. pm2 records the absolute node binary an app was first started
# with. fnm gives each shell a temporary node under /run/user/<uid>/fnm_multishells/…, which fnm
# later deletes; a reload after that starts nothing, while pm2 still reports the app "online".

# Put fnm's stable `default` alias first, so any `pm2 start` from this shell records a path
# that outlives the shell.
use_stable_node() {
  local bin="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin"
  if [ -x "$bin/node" ]; then export PATH="$bin:$PATH"; fi
  return 0
}

# Print "<app> <path>" for each named app whose recorded node or script no longer exists.
pm2_missing_node() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const i = s.indexOf("[");
      if (i < 0) process.exit(3);
      const want = process.argv.slice(1);
      for (const p of JSON.parse(s.slice(i))) {
        if (want.length && !want.includes(p.name)) continue;
        const e = p.pm2_env || {};
        for (const f of [e.pm_exec_path, e.exec_interpreter])
          if (f && f.startsWith("/") && !require("fs").existsSync(f)) console.log(p.name, f);
      }
    });' "$@"
}

# Refuse BEFORE anything is stopped, and print the repair. Usage: require_live_node cfgdir app…
require_live_node() {
  local cfgdir=$1 missing app
  shift
  missing=$(pm2_missing_node "$@") || return 0 # pm2 unreadable: the callers' own checks catch it
  [ -z "$missing" ] && return 0
  {
    echo "pm2 would restart these apps with a node binary that no longer exists:"
    echo "$missing"
    echo "Nothing was reloaded. Re-register each one with a stable node, then re-run:"
    echo "  export PATH=\"\${FNM_DIR:-\$HOME/.local/share/fnm}/aliases/default/bin:\$PATH\""
    while read -r app _; do echo "  pm2 delete $app && pm2 start $cfgdir/$app.json"; done <<<"$missing"
    echo "  pm2 save"
  } >&2
  return 1
}
