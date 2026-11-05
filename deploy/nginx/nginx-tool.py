#!/usr/bin/env python3
"""Proxy-only nginx: render the templates, validate the live config, report drift.

  render OUTDIR      write the files as they belong under /etc/nginx (needs nginx.local)
  validate           read `nginx -T` on stdin; fail on any file serving or fall-through
  drift [ETC]        compare the rendered templates with ETC (default /etc/nginx),
                     ignoring comments, whitespace and the order of simple directives

The rules and the 2026-10-24 incident behind them: deploy/README.md § 8.
"""
import difflib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_GUARD = ["/nonexistent/nginx-proxy-only"]
SERVES_FILES = ("root", "alias", "try_files", "autoindex")


def load_local():
    path = os.path.join(HERE, "nginx.local")
    if not os.path.exists(path):
        sys.exit("deploy/nginx/nginx.local is missing — copy nginx.local.example and fill it in.")
    env = {}
    for line in open(path):
        m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"#\n]*)"?', line)
        if m:
            env[m.group(1)] = m.group(2).strip()
    for k in ("DOMAIN", "API_HOST", "API_PREFIX"):
        if not env.get(k) or env[k] in ("example.com", "api.example.com", "change-me"):
            sys.exit(f"nginx.local: set {k}")
    return env


def rendered():
    """{path under /etc/nginx: text}"""
    env = load_local()
    names = {
        "apex.conf": env["DOMAIN"],
        "app.conf": "app." + env["DOMAIN"],
        "portal.conf": "portal." + env["DOMAIN"],
        "ops.conf": "ops." + env["DOMAIN"],
        "api.conf": env["API_HOST"],
    }
    out = {
        "sites-available/default": open(os.path.join(HERE, "default")).read(),
        "conf.d/00-proxy-only.conf": open(os.path.join(HERE, "00-proxy-only.conf")).read(),
        "conf.d/10-proxy-buffers.conf": open(os.path.join(HERE, "10-proxy-buffers.conf")).read(),
    }
    for tpl, name in names.items():
        text = open(os.path.join(HERE, "sites", tpl)).read()
        for k in ("DOMAIN", "API_HOST", "API_PREFIX"):
            text = text.replace(f"@{k}@", env[k])
        if "@" in re.sub(r"#[^\n]*", "", text).replace("$", ""):
            sys.exit(f"{tpl}: unreplaced placeholder")
        out[f"sites-available/{name}"] = text
    return out


def parse(text):
    """nginx config → [(directive tokens, child list or None)]"""
    toks = re.findall(r'"[^"]*"|\'[^\']*\'|[{};]|[^\s{};]+', re.sub(r"#[^\n]*", "", text))

    def block(i):
        out, cur = [], []
        while i < len(toks):
            t = toks[i]
            if t == ";":
                out.append((cur, None))
                cur = []
            elif t == "{":
                body, i = block(i + 1)
                out.append((cur, body))
                cur = []
            elif t == "}":
                return out, i
            else:
                cur.append(t)
            i += 1
        return out, i

    return block(0)[0]


def validate(text):
    bad = []

    def walk(nodes, ctx):
        for d, body in nodes:
            if not d:
                continue
            name = d[0]
            if name in SERVES_FILES and not (name == "root" and ctx in ("main", "http") and d[1:] == ROOT_GUARD):
                bad.append(f"{' '.join(d)}  (in {ctx})")
            if body is None:
                continue
            # nginx -T prints each included file at top level, so servers show up under "main".
            if name == "server" and ctx in ("main", "http"):
                names = [x[0][1:] for x in body if x[0][:1] == ["server_name"]]
                ok = any(x[0][:1] in (["return"], ["ssl_reject_handshake"]) for x in body)
                for x, b in body:
                    if x[:1] == ["location"] and x[1:] in (["/"], ["^~", "/"]) and b is not None:
                        ok = ok or any(y[0][:1] in (["proxy_pass"], ["return"]) for y in b)
                if not ok:
                    bad.append(f"server {names}: no catch-all `location /` that proxies or returns")
            walk(body, name)

    walk(parse(text), "main")
    if bad:
        print("FAIL: the effective config serves files or falls through:")
        for b in bad:
            print("   " + b)
        return 1
    print("OK: no file serving; every server proxies or returns.")
    return 0


def canonical(nodes, depth=0):
    """Simple directives sorted, blocks kept in order — so cosmetic edits do not show as drift."""
    simple = sorted("  " * depth + " ".join(d) + ";" for d, b in nodes if b is None and d)
    lines = list(simple)
    for d, b in nodes:
        if b is not None:
            lines.append("  " * depth + " ".join(d) + " {")
            lines += canonical(b, depth + 1)
            lines.append("  " * depth + "}")
    return lines


def drift(etc):
    want = rendered()
    rc = 0
    for rel, text in sorted(want.items()):
        path = os.path.join(etc, rel)
        if not os.path.exists(path):
            print(f"MISSING  {path}")
            rc = 1
            continue
        a, b = canonical(parse(text)), canonical(parse(open(path).read()))
        if a != b:
            rc = 1
            print(f"DRIFT    {path}")
            for line in difflib.unified_diff(a, b, "repo", "live", lineterm="", n=1):
                print("    " + line)
        else:
            print(f"same     {path}")
    expected = {os.path.basename(r) for r in want if r.startswith("sites-available/")}
    conf_d = {r.split("/", 1)[1] for r in want if r.startswith("conf.d/")}
    for d, allowed in (("sites-enabled", expected), ("conf.d", conf_d)):
        full = os.path.join(etc, d)
        for f in sorted(os.listdir(full)) if os.path.isdir(full) else []:
            if f not in allowed:
                print(f"EXTRA    {full}/{f} — not in the repo")
                rc = 1
    print("OK: live nginx matches the repo." if rc == 0 else "Drift found: update the repo or the box so they agree.")
    return rc


def main():
    args = sys.argv[1:]
    if args[:1] == ["render"] and len(args) == 2:
        for rel, text in rendered().items():
            path = os.path.join(args[1], rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w").write(text)
            print("wrote", path)
        return 0
    if args == ["validate"]:
        return validate(sys.stdin.read())
    if args[:1] == ["drift"] and len(args) <= 2:
        return drift(args[1] if len(args) == 2 else "/etc/nginx")
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
