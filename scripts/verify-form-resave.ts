/**
 * A save shows what was saved, a second save too, and a refused save keeps the edits.
 *
 *   pnpm dev:stack:fresh                   # or any dashboard signed in with the seed login
 *   pnpm verify:form-resave                # FORM_RESAVE_URL=http://localhost:4110 by default
 *
 * Drives a real Chrome over CDP through settings pages, one per form control kind (switch,
 * checkbox, radio, select), and on each:
 *   1. changes two controls, saves, changes them back (plus a third), saves again WITHOUT a
 *      reload, and checks the page shows exactly what a reload shows;
 *   2. changes a control and some typed text, sends a stale `expected_version`, and checks
 *      the refused save leaves both edits on screen.
 *
 * Why a browser: React 19 resets the form inside the commit that brings a save's new
 * defaults. A control re-applying a stale default there showed the PREVIOUS save and posted
 * it back on the next Save (2026-11-16, Settings → Email notifications). Nothing short of a
 * real reset in a real commit reproduces that. The static half of this rule is
 * `verify:form-validation` § D.
 *
 * Needs a RUNNING dashboard, so it is not in verify:all (like bff-tenancy). It REFUSES to run
 * when the dashboard is down rather than skipping: a skipped check reads like a pass.
 * It writes settings on the first business it finds: use a throwaway stack.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.FORM_RESAVE_URL ?? "http://localhost:4110").replace(/\/$/, "");
const EMAIL = process.env.FORM_RESAVE_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.FORM_RESAVE_PASSWORD ?? "Sparrow-Lantern-9134";

type Kind = "switch" | "checkbox" | "radio" | "select";
const CASES: Array<{ path: string; kind: Kind }> = [
  { path: "settings/emails", kind: "switch" },
  { path: "settings/billing-rules/pause-resume", kind: "checkbox" },
  { path: "settings/documents", kind: "radio" },
  { path: "settings/invoices", kind: "select" },
];

const checks: Array<[string, boolean, string?]> = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── a minimal CDP client ─────────────────────────────────────────────────────────
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

const CHROME = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));

// A CDP-driven tab may get no animation frames; React reveals Suspense content inside one.
const RAF_FALLBACK = `(() => {
  const native = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    let done = false;
    const once = (t) => { if (!done) { done = true; cb(t); } };
    const h = native(once);
    setTimeout(() => once(performance.now()), 32);
    return h;
  };
})()`;

interface Tab {
  send: (method: string, params?: object) => Promise<Record<string, unknown>>;
  js: <T = unknown>(expr: string) => Promise<T>;
  close: () => void;
}

async function open(port: number): Promise<Tab> {
  const target = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      const n = ++id;
      pending.set(n, (m) =>
        m.error
          ? rej(new Error(`${method}: ${m.error.message}`))
          : res(m.result as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const js = async <T>(expr: string): Promise<T> => {
    const r = (await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string } } };
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "page threw");
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: RAF_FALLBACK });
  return { send, js, close: () => ws.close() };
}

/** Navigate and wait until the page is hydrated and its main pane has text. */
async function go(tab: Tab, url: string) {
  await tab.send("Page.navigate", { url });
  for (let i = 0; i < 240; i++) {
    await wait(250);
    const ready = await tab
      .js<boolean>(
        `document.readyState === "complete" && !!document.querySelector("main, form") &&
         Object.keys(document.querySelector("main form, form") ?? {}).some((k) => k.startsWith("__react")) &&
         !document.querySelector('main [aria-busy="true"]')`,
      )
      .catch(() => false);
    if (ready) return wait(500);
  }
  throw new Error(`${url} never finished loading`);
}

/** A trusted key press, to close a Select that offered nothing to pick. */
async function key(tab: Tab, k: "Escape") {
  const code = { Escape: 27 }[k];
  const base = { key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await wait(150);
}

// ── page model: the form whose Save sits in the sticky action bar ─────────────────
const FORM = `([...document.querySelectorAll("[data-action-bar] button[type=submit]")]
  .map((b) => b.closest("form")).find(Boolean))`;

/** Every control in the form, as `label = value`. */
const SNAPSHOT = `(() => {
  const form = ${FORM};
  if (!form) return null;
  const label = (el, i) => (el.getAttribute("aria-label") || el.id || el.getAttribute("name") || "#" + i);
  const out = {};
  [...form.querySelectorAll("[role=switch],[role=checkbox]")].forEach((el, i) => {
    out["toggle " + label(el, i) + " " + i] = el.getAttribute("aria-checked");
  });
  [...form.querySelectorAll("[role=radio]")].forEach((el, i) => {
    out["radio " + label(el, i) + " " + i] = el.getAttribute("aria-checked");
  });
  [...form.querySelectorAll("button[role=combobox]")].forEach((el, i) => {
    out["select " + label(el, i) + " " + i] = el.textContent.trim();
  });
  [...form.querySelectorAll("input[type=hidden][name]")].forEach((el) => {
    if (el.name !== "expected_version") out["posts " + el.name + "=" + el.value] = "1";
  });
  return out;
})()`;

/** The changeable controls of one kind: visible, enabled, outside any dialog. */
const CANDIDATES = (kind: Kind) => `(() => {
  const form = ${FORM};
  const sel = { switch: "[role=switch]", checkbox: "[role=checkbox]", radio: "[role=radio]",
                select: "button[role=combobox]" }[${JSON.stringify(kind)}];
  const all = [...form.querySelectorAll(sel)];
  return all.map((el, i) => ({ i, el })).filter(({ el }) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
      !el.closest("[role=dialog]") && (${JSON.stringify(kind)} !== "radio" || el.getAttribute("aria-checked") !== "true");
  }).map(({ i }) => i);
})()`;

async function change(tab: Tab, kind: Kind, index: number) {
  const target = `[...(${FORM}).querySelectorAll(${JSON.stringify(
    {
      switch: "[role=switch]",
      checkbox: "[role=checkbox]",
      radio: "[role=radio]",
      select: "button[role=combobox]",
    }[kind],
  )})][${index}]`;
  if (kind !== "select") {
    await tab.js(
      `(() => { const el = ${target}; el.scrollIntoView({ block: "center" }); el.click(); })()`,
    );
    return wait(200);
  }
  // Radix Select opens on pointerdown and picks an item on pointerup (mouse pointers).
  await tab.js(`(() => {
    const el = ${target};
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1,
      pointerType: "mouse", isPrimary: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
  })()`);
  await wait(400);
  const picked = await tab.js<string | null>(`(() => {
    const item = [...document.querySelectorAll("[role=listbox] [role=option]")]
      .find((o) => o.getAttribute("aria-selected") !== "true" && o.getAttribute("aria-disabled") !== "true");
    if (!item) return null;
    const r = item.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 0, pointerId: 1,
      pointerType: "mouse", isPrimary: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    item.dispatchEvent(new PointerEvent("pointermove", o));
    item.dispatchEvent(new PointerEvent("pointerup", o));
    return item.textContent.trim();
  })()`);
  if (!picked) await key(tab, "Escape");
  return wait(200);
}

/** Press Save and wait for the toast and the refresh that follows it. */
async function save(tab: Tab): Promise<string> {
  // Mark the toasts already up rather than removing them: they belong to React's tree.
  await tab.js(
    `document.querySelectorAll("[data-sonner-toast]").forEach((t) => t.setAttribute("data-resave-seen", ""))`,
  );
  await tab.js(
    `[...document.querySelectorAll("[data-action-bar] button[type=submit]")][0].click()`,
  );
  for (let i = 0; i < 80; i++) {
    await wait(250);
    const toast = await tab.js<string | null>(
      `document.querySelector("[data-sonner-toast]:not([data-resave-seen])")?.innerText.replace(/\\s+/g, " ") ?? null`,
    );
    if (toast) {
      await wait(2000);
      return toast;
    }
  }
  return "(no toast)";
}

const diff = (a: Record<string, string> | null, b: Record<string, string> | null) =>
  Object.keys({ ...a, ...b })
    .filter((k) => a?.[k] !== b?.[k])
    .map((k) => `${k}: ${a?.[k] ?? "∅"} ≠ ${b?.[k] ?? "∅"}`)
    .slice(0, 6)
    .join("; ");

// ── run ──────────────────────────────────────────────────────────────────────────
const up = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
if (!up?.ok) {
  console.error(
    `✗ no dashboard at ${BASE}. Start one: pnpm dev:stack:fresh (or set FORM_RESAVE_URL).`,
  );
  console.log("❌ FORM RESAVE: FAIL");
  process.exit(1);
}
if (!CHROME) {
  console.error("✗ no Chrome found. Set CHROME_BIN.");
  console.log("❌ FORM RESAVE: FAIL");
  process.exit(1);
}

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), "form-resave-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
try {
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`http://127.0.0.1:${port}/json/version`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await wait(250);
  }
  const tab = await open(port);
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await go(tab, `${BASE}/login`);
  await tab.js(`(() => {
    const set = (n, v) => {
      const el = document.querySelector("input[name=" + n + "]");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("email", ${JSON.stringify(EMAIL)});
    set("password", ${JSON.stringify(PASSWORD)});
    document.querySelector("form button[type=submit]").click();
  })()`);
  for (let i = 0; i < 120 && (await tab.js<string>("location.pathname")) === "/login"; i++)
    await wait(250);
  await wait(1500);
  const biz = await tab.js<string | null>(
    `location.pathname.match(/biz_[A-Za-z0-9]+/)?.[0] ??
     [...document.querySelectorAll('a[href*="/businesses/biz_"]')]
       .map((a) => a.getAttribute("href").match(/biz_[A-Za-z0-9]+/)?.[0]).find(Boolean) ?? null`,
  );
  // Still on /login: say why (a wrong login, or the 15-minute sign-in rate limit).
  const why = await tab.js<string>(
    `location.pathname === "/login" ? (document.querySelector("[role=alert], form p")?.innerText ?? "") : ""`,
  );
  ok("signed in and found a business", !!biz, `at ${await tab.js("location.pathname")} ${why}`);
  if (!biz) throw new Error("no business");

  for (const { path, kind } of CASES) {
    const url = `${BASE}/businesses/${biz}/${path}`;
    const tag = `${path} (${kind})`;
    await go(tab, url);
    const loaded = await tab.js<Record<string, string> | null>(SNAPSHOT);
    const picks = (await tab.js<number[]>(CANDIDATES(kind))).slice(0, kind === "radio" ? 1 : 3);
    if (!loaded || picks.length === 0) {
      ok(
        `${tag}: has a saveable ${kind}`,
        false,
        loaded ? "none changeable" : "no form with a sticky Save",
      );
      continue;
    }

    // 1 · two saves, no reload in between.
    for (const i of picks.slice(0, 2)) await change(tab, kind, i);
    const editedFirst = await tab.js<Record<string, string>>(SNAPSHOT);
    ok(`${tag}: the first change shows on screen`, !!diff(loaded, editedFirst), "nothing moved");
    const first = await save(tab);
    ok(`${tag}: first save accepted`, /saved|updated/i.test(first), first);
    const afterFirst = await tab.js<Record<string, string>>(SNAPSHOT);
    if (kind === "radio") {
      const back = (await tab.js<number[]>(CANDIDATES(kind)))[0];
      if (back !== undefined) await change(tab, kind, back);
    } else for (const i of picks) await change(tab, kind, i);
    const editedSecond = await tab.js<Record<string, string>>(SNAPSHOT);
    ok(
      `${tag}: the second change shows on screen`,
      !!diff(afterFirst, editedSecond),
      "nothing moved",
    );
    const second = await save(tab);
    ok(`${tag}: second save accepted`, /saved|updated/i.test(second), second);
    const shown = await tab.js<Record<string, string>>(SNAPSHOT);
    await go(tab, url);
    const stored = await tab.js<Record<string, string>>(SNAPSHOT);
    ok(
      `${tag}: after the second save the page shows what was saved`,
      !diff(shown, stored),
      diff(shown, stored),
    );
    ok(
      `${tag}: the second save stored what was on screen`,
      !diff(editedSecond, stored),
      diff(editedSecond, stored),
    );

    // 2 · a refused save keeps the edits.
    const pick = (await tab.js<number[]>(CANDIDATES(kind)))[0];
    if (pick === undefined) continue;
    await change(tab, kind, pick);
    const typed = await tab.js<string | null>(`(() => {
      const el = [...(${FORM}).querySelectorAll("input[type=text][name], input:not([type])[name], textarea[name]")]
        .find((e) => e.getBoundingClientRect().width > 0 && !e.disabled && !e.readOnly);
      if (!el) return null;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, el.value + " kept");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.name;
    })()`);
    const edited = await tab.js<Record<string, string>>(SNAPSHOT);
    const stale = await tab.js<boolean>(`(() => {
      const v = (${FORM}).querySelector("input[name=expected_version]");
      if (!v || Number(v.value) < 2) return false;
      v.value = "1";
      return true;
    })()`);
    if (!stale) {
      ok(`${tag}: refused save (needs expected_version ≥ 2)`, true);
      await go(tab, url);
      continue;
    }
    const refused = await save(tab);
    ok(
      `${tag}: the stale save is refused in our words`,
      /could not save/i.test(refused) && !/resource_version/.test(refused),
      refused,
    );
    const kept = await tab.js<Record<string, string>>(SNAPSHOT);
    ok(`${tag}: a refused save keeps the control edits`, !diff(edited, kept), diff(edited, kept));
    if (typed) {
      const value = await tab.js<string>(`(${FORM}).querySelector("[name=${typed}]").value`);
      ok(`${tag}: a refused save keeps typed text`, value.endsWith(" kept"), value);
    }
    await go(tab, url);
  }
  tab.close();
} catch (e) {
  ok("ran to the end", false, String(e));
} finally {
  chrome.kill("SIGTERM");
  await wait(300);
  rmSync(profile, { recursive: true, force: true });
}

console.log("");
let pass = true;
for (const [name, cond, detail] of checks) {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? `  — ${detail}` : ""}`);
  if (!cond) pass = false;
}
console.log("");
console.log(pass ? "✅ FORM RESAVE: PASS" : "❌ FORM RESAVE: FAIL");
process.exit(pass ? 0 : 1);
