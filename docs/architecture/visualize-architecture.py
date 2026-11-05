#!/usr/bin/env python3
"""Visualize docs/architecture.json as a local, standalone HTML diagram.

Reads architecture.json (module dependency + data-flow graph), embeds it into a
self-contained HTML file, writes it next to the JSON, and opens it in the browser.

Usage:
    python3 docs/visualize-architecture.py            # build + open
    python3 docs/visualize-architecture.py --no-open  # just build
"""
import json
import pathlib
import sys
import webbrowser

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "architecture.json"
OUT = HERE / "architecture.html"

HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__NAME__ · architecture</title>
<style>
  :root {
    --bg: #0d1017;
    --panel: #151a24;
    --panel-2: #1b2230;
    --line: #26303f;
    --ink: #e6ebf2;
    --muted: #8b97a8;
    --faint: #5a6675;
    --accent: #38bdf8;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    font-size: 14px; line-height: 1.5; overflow: hidden;
  }
  a { color: var(--accent); }

  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }

  header {
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px;
    background: linear-gradient(180deg, #10151f, #0d1017);
  }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .3px; font-weight: 650; }
  header h1 .dim { color: var(--faint); font-weight: 400; }
  .hier { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .hier b { color: var(--ink); font-weight: 600; }
  .hier .sep { color: var(--faint); }
  .spacer { flex: 1; }
  .meta { color: var(--faint); font-size: 12px; font-family: var(--mono); }

  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lbl { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; margin-right: 2px; }
  .chip {
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
    padding: 5px 11px; border-radius: 999px; font-size: 12px; cursor: pointer;
    font-family: var(--sans); transition: all .12s ease;
  }
  .chip:hover { color: var(--ink); border-color: #3a4657; }
  .chip[aria-pressed="true"] { background: var(--accent); color: #04121c; border-color: var(--accent); font-weight: 600; }

  .stage { position: relative; display: grid; grid-template-columns: 1fr 340px; min-height: 0; }
  .canvas { position: relative; overflow: auto; padding: 22px 24px 60px; }
  svg.edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }

  .band { position: relative; z-index: 2; margin-bottom: 26px; }
  .band-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 10px 2px; }
  .band-dot { width: 9px; height: 9px; border-radius: 3px; align-self: center; }
  .band-name { font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
  .band-note { color: var(--faint); font-size: 12px; font-family: var(--mono); }

  .row { display: flex; flex-wrap: wrap; gap: 12px; }
  .node {
    position: relative; width: 210px; background: var(--panel); border: 1px solid var(--line);
    border-left-width: 3px; border-radius: 8px; padding: 10px 12px; cursor: pointer;
    transition: transform .1s ease, box-shadow .1s ease, opacity .15s ease, border-color .1s ease;
  }
  .node:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  .node .id { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .node .resp {
    color: var(--muted); font-size: 11.5px; line-height: 1.45; margin-top: 4px;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .node .tags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .tag {
    font-family: var(--mono); font-size: 10.5px; color: var(--faint);
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px;
  }
  .node.dim { opacity: .22; }
  .node.hot { box-shadow: 0 0 0 2px currentColor; }
  .node.dep { box-shadow: 0 0 0 1.5px var(--accent); }
  .node.selected { box-shadow: 0 0 0 2px var(--accent), 0 6px 20px rgba(0,0,0,.5); }
  .node .seq {
    position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; border-radius: 50%;
    background: var(--accent); color: #04121c; font-size: 11px; font-weight: 700;
    display: none; align-items: center; justify-content: center; font-family: var(--mono);
  }
  .node.instep .seq { display: flex; }

  /* detail panel */
  aside {
    border-left: 1px solid var(--line); background: var(--panel); overflow: auto; padding: 18px;
  }
  aside .empty { color: var(--faint); font-size: 13px; margin-top: 40px; text-align: center; }
  aside h2 { font-family: var(--mono); font-size: 17px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
  aside .layer-pill { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  aside .resp-full { color: var(--muted); font-size: 13px; margin: 10px 0 16px; }
  aside section { margin-bottom: 16px; }
  aside .h { font-size: 10.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--faint); margin-bottom: 6px; }
  aside .list { display: flex; flex-direction: column; gap: 4px; }
  aside code { font-family: var(--mono); font-size: 12px; background: var(--panel-2); padding: 2px 7px; border-radius: 5px; border: 1px solid var(--line); }
  aside .chips-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
  aside .dep-link { cursor: pointer; }
  aside .dep-link:hover { border-color: var(--accent); color: var(--ink); }
  aside .emit { color: #f0abfc; }

  .legend { display: flex; gap: 4px 14px; flex-wrap: wrap; align-items: center; }
  .legend .item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
  .legend .sw { width: 10px; height: 10px; border-radius: 3px; }

  .hint { position: absolute; bottom: 12px; left: 24px; color: var(--faint); font-size: 11px; z-index: 3; font-family: var(--mono); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2a3444; border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>__NAME__ <span class="dim">/ architecture</span></h1>
    <div class="hier" id="hier"></div>
    <div class="spacer"></div>
    <div class="meta" id="meta"></div>
  </header>
  <div style="padding:10px 20px; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:16px; align-items:center; background:var(--panel);">
    <div class="controls">
      <span class="lbl">Flows</span>
      <span id="flowChips"></span>
    </div>
    <div class="spacer"></div>
    <div class="legend" id="legend"></div>
  </div>
  <div class="stage">
    <div class="canvas" id="canvas">
      <svg class="edges" id="edges"><defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#38bdf8"></path>
        </marker>
      </defs></svg>
      <div id="bands"></div>
      <div class="hint">Hover a module to trace its dependencies · click to pin details · pick a flow to trace a path</div>
    </div>
    <aside id="detail"><div class="empty">Select a module to see tables, key functions,<br>emitted events and dependencies.</div></aside>
  </div>
</div>

<script>
const DATA = __DATA__;

const layerById = Object.fromEntries(DATA.layers.map(l => [l.id, l]));
const nodeById  = Object.fromEntries(DATA.nodes.map(n => [n.id, n]));
// flows reference some ids that aren't domain nodes (e.g. platform.clock); keep them harmless.

const $ = (s, r=document) => r.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt!=null) e.textContent = txt; return e; };

// ---- hierarchy + meta ----
const hier = $("#hier");
DATA.hierarchy.forEach((h, i) => {
  if (i) hier.append(Object.assign(el("span","sep"),{textContent:"›"}));
  hier.append(el("b", null, h));
});
$("#meta").textContent = DATA.nodes.length + " modules · " + DATA.layers.length + " layers · generated " + DATA.generated;

// ---- legend ----
const legend = $("#legend");
DATA.layers.forEach(l => {
  const item = el("div","item");
  const sw = el("span","sw"); sw.style.background = l.color; item.append(sw, el("span",null,l.name));
  legend.append(item);
});

// ---- render bands + nodes ----
const bands = $("#bands");
const nodeEls = {};
for (const layer of DATA.layers) {
  const nodes = DATA.nodes.filter(n => n.layer === layer.id);
  if (!nodes.length) continue;
  const band = el("div","band");
  const head = el("div","band-head");
  const dot = el("span","band-dot"); dot.style.background = layer.color;
  head.append(dot, Object.assign(el("span","band-name",layer.name),{style:`color:${layer.color}`}), el("span","band-note", layer.note||""));
  band.append(head);
  const row = el("div","row");
  for (const n of nodes) {
    const card = el("div","node");
    card.style.borderLeftColor = layer.color;
    card.style.color = layer.color; // used by .hot glow
    card.dataset.id = n.id;
    card.append(el("div","id", n.id));
    card.append(el("div","resp", n.responsibility || ""));
    const tags = el("div","tags");
    if (n.routes) tags.append(el("span","tag", n.routes + " routes"));
    if (n.emits && n.emits.length) tags.append(el("span","tag", n.emits.length + " events"));
    if (n.dependsOn && n.dependsOn.length) tags.append(el("span","tag", "→ " + n.dependsOn.length + " deps"));
    card.append(tags);
    const seq = el("div","seq"); card.append(seq);
    card.addEventListener("mouseenter", () => { if (!pinned) traceDeps(n.id); });
    card.addEventListener("mouseleave", () => { if (!pinned) clearTrace(); });
    card.addEventListener("click", () => { pinned = (pinned===n.id)?null:n.id; select(n.id); });
    row.append(card);
    nodeEls[n.id] = card;
  }
  band.append(row);
  bands.append(band);
}

// ---- edge drawing ----
const svg = $("#edges");
const canvas = $("#canvas");
function centerBottom(r, base) { return { x: r.left - base.left + r.width/2, y: r.top - base.top + r.height }; }
function centerTop(r, base)    { return { x: r.left - base.left + r.width/2, y: r.top - base.top }; }

function drawEdges(pairs, color) {
  // remove old paths (keep defs)
  [...svg.querySelectorAll("path.edge")].forEach(p => p.remove());
  const base = svg.getBoundingClientRect();
  for (const [from, to] of pairs) {
    const a = nodeEls[from], b = nodeEls[to];
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const p1 = { x: ra.left - base.left + ra.width/2, y: ra.top - base.top + ra.height/2 };
    const p2 = { x: rb.left - base.left + rb.width/2, y: rb.top - base.top + rb.height/2 };
    const dx = (p2.x - p1.x) * 0.3, dy = (p2.y - p1.y) * 0.5;
    const path = document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("class","edge");
    path.setAttribute("d", `M ${p1.x} ${p1.y} C ${p1.x+dx} ${p1.y+dy}, ${p2.x-dx} ${p2.y-dy}, ${p2.x} ${p2.y}`);
    path.setAttribute("fill","none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width","1.6");
    path.setAttribute("opacity","0.8");
    path.setAttribute("marker-end","url(#arrow)");
    svg.append(path);
  }
}
function clearEdges(){ [...svg.querySelectorAll("path.edge")].forEach(p => p.remove()); }

// ---- trace dependencies of one node ----
let pinned = null;
function traceDeps(id) {
  const n = nodeById[id]; if (!n) return;
  const deps = new Set(n.dependsOn || []);
  Object.entries(nodeEls).forEach(([k,c]) => {
    c.classList.remove("hot","dep","instep","selected");
    c.classList.toggle("dim", !(k===id || deps.has(k)));
    if (k===id) c.classList.add("hot");
    if (deps.has(k)) c.classList.add("dep");
  });
  drawEdges([...deps].map(d => [id, d]), "#38bdf8");
}
function clearTrace() {
  Object.values(nodeEls).forEach(c => c.classList.remove("dim","hot","dep","instep","selected"));
  clearEdges();
  if (activeFlow) applyFlow(activeFlow);
}

// ---- detail panel ----
function select(id) {
  const n = nodeById[id];
  if (!n) return;
  traceDeps(id);
  nodeEls[id].classList.add("selected");
  const layer = layerById[n.layer];
  const d = $("#detail"); d.innerHTML = "";
  const h = el("h2", null); h.append(el("span",null,n.id));
  const pill = el("span","layer-pill", layer.name); pill.style.background = layer.color + "22"; pill.style.color = layer.color;
  h.append(pill); d.append(h);
  d.append(el("div","resp-full", n.responsibility || ""));

  const sec = (title, build) => { const s = el("section"); s.append(el("div","h", title)); build(s); d.append(s); };

  if (n.tables && n.tables.length) sec("Tables / schema", s => {
    const w = el("div","chips-wrap"); n.tables.forEach(t => w.append(el("code",null,t))); s.append(w);
  });
  if (n.routeFile) sec("Routes", s => {
    const w = el("div","chips-wrap"); w.append(el("code",null, n.routeFile + (n.routes?` · ${n.routes}`:""))); s.append(w);
  });
  if (n.keyFunctions && n.keyFunctions.length) sec("Key functions", s => {
    const w = el("div","list"); n.keyFunctions.forEach(f => w.append(el("code",null, f+"()"))); s.append(w);
  });
  if (n.emits && n.emits.length) sec("Emits events", s => {
    const w = el("div","chips-wrap"); n.emits.forEach(e => { const c = el("code","emit", e); w.append(c); }); s.append(w);
  });
  if (n.dependsOn && n.dependsOn.length) sec("Depends on", s => {
    const w = el("div","chips-wrap");
    n.dependsOn.forEach(dep => {
      const c = el("code", "dep-link", dep);
      if (nodeById[dep]) c.addEventListener("click", () => { pinned = dep; nodeEls[dep].scrollIntoView({block:"center",behavior:"smooth"}); select(dep); });
      w.append(c);
    });
    s.append(w);
  });
  // dependents (reverse edges)
  const dependents = DATA.nodes.filter(m => (m.dependsOn||[]).includes(id)).map(m => m.id);
  if (dependents.length) sec("Depended on by", s => {
    const w = el("div","chips-wrap");
    dependents.forEach(dep => { const c = el("code","dep-link", dep); c.addEventListener("click",()=>{pinned=dep;nodeEls[dep].scrollIntoView({block:"center",behavior:"smooth"});select(dep);}); w.append(c); });
    s.append(w);
  });
}

// ---- flows ----
let activeFlow = null;
const flowChips = $("#flowChips");
const allChip = el("button","chip","All modules"); allChip.setAttribute("aria-pressed","true");
allChip.addEventListener("click", () => setFlow(null));
flowChips.append(allChip);
DATA.flows.forEach(f => {
  const c = el("button","chip", f.name); c.setAttribute("aria-pressed","false");
  c.addEventListener("click", () => setFlow(f.name));
  flowChips.append(c);
});
function setFlow(name) {
  activeFlow = name; pinned = null;
  [...flowChips.children].forEach(c => c.setAttribute("aria-pressed", String((c===allChip && !name) || c.textContent===name)));
  clearTrace();
  if (name) applyFlow(name); else { clearEdges(); Object.values(nodeEls).forEach(c=>c.classList.remove("dim","instep")); }
}
function applyFlow(name) {
  const flow = DATA.flows.find(f => f.name===name); if (!flow) return;
  const steps = flow.steps;
  const inFlow = new Set(steps);
  Object.entries(nodeEls).forEach(([k,c]) => {
    c.classList.remove("hot","dep","selected");
    c.classList.toggle("dim", !inFlow.has(k));
    c.classList.remove("instep");
    $(".seq", c).textContent = "";
  });
  // number the steps that map to real nodes
  steps.forEach((s, i) => { const c = nodeEls[s]; if (c) { c.classList.add("instep"); $(".seq", c).textContent = i+1; } });
  // draw path edges between consecutive real nodes
  const pairs = [];
  let prev = null;
  for (const s of steps) { if (nodeEls[s]) { if (prev) pairs.push([prev, s]); prev = s; } }
  drawEdges(pairs, "#fbbf24");
}

// redraw edges on resize / scroll (positions shift)
let raf;
function refresh(){ cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (activeFlow) applyFlow(activeFlow); else if (pinned) traceDeps(pinned); }); }
window.addEventListener("resize", refresh);
canvas.addEventListener("scroll", refresh);
</script>
</body>
</html>
"""


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} not found", file=sys.stderr)
        return 1
    data = json.loads(SRC.read_text())
    html = (HTML
            .replace("__NAME__", str(data.get("name", "architecture")))
            .replace("__DATA__", json.dumps(data)))
    OUT.write_text(html)
    print(f"wrote {OUT}  ({len(html)//1024} KB)")
    if "--no-open" not in sys.argv:
        webbrowser.open(OUT.as_uri())
        print("opened in browser")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
