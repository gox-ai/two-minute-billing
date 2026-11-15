// tmb listen: poll the business's events and POST each new one to a local URL, signed and
// shaped exactly as a webhook endpoint receives it.
import { createHmac } from "node:crypto";
import { CliError, call, opt, requireTestKey, settings, testBusiness } from "./api.mjs";

// Rows are stamped at transaction START (and with the simulated time under Time Travel),
// so an event can become visible with an occurred_at older than the last poll.
const LOOKBACK_MS = 120_000;
const SEEN_CAP = 200_000;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function parseDuration(s) {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s ?? "");
  if (!m) return NaN;
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

/** The real creation time an event id carries (base36 ms after the prefix); NaN if none. */
function idTime(id) {
  const m = /^evt_([0-9a-z]{9})/.exec(id);
  return m ? parseInt(m[1], 36) : NaN;
}

/** The webhook envelope, in the key order the engine signs. */
export function envelope(e) {
  const pick = (a, b) => (a in e ? e[a] : (e[b] ?? null));
  return JSON.stringify({
    id: e.id,
    occurred_at: e.occurred_at,
    source: e.source,
    user: pick("user", "actor"),
    event_type: pick("event_type", "type"),
    api_version: e.api_version,
    content: pick("content", "data"),
    object: "event",
  });
}

export async function listen(argv) {
  const target = opt(argv, "forward");
  if (!target) throw new CliError("pass --forward http://localhost:<port>/<webhook path>.");
  let u;
  try {
    u = new URL(target);
  } catch {
    throw new CliError(`not a URL: ${target}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new CliError("--forward must be an http(s) URL.");
  if (!LOOPBACK.includes(u.hostname) && !argv.includes("--allow-remote"))
    throw new CliError(
      "--forward accepts a loopback URL only (localhost, 127.0.0.1, [::1]). Add --allow-remote to forward elsewhere.",
    );
  const interval = parseDuration(opt(argv, "interval") ?? "2s");
  if (!(interval >= 250))
    throw new CliError("--interval must look like 2s or 500ms (250ms or more).");
  const since = opt(argv, "since") ?? "now";
  const types = (opt(argv, "events") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const secret = process.env.TMBILLING_WEBHOOK_SECRET ?? "";
  if (!secret)
    throw new CliError(
      "TMBILLING_WEBHOOK_SECRET is not set. Set it to the signing secret your app checks. " +
        "For local use, any value that your app and listen both read is correct.",
    );

  const s = settings({ needBusiness: true, business: opt(argv, "business") });
  await requireTestKey(s, "tmb listen");
  await testBusiness(s);
  const sign = (body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  const seen = new Set();
  const remember = (id) => {
    seen.add(id);
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
  };
  // `through`: the server's real time at the last good poll. `sim`: the Time Travel state then.
  const state = { through: 0, sim: null, genesis: null };

  async function clock() {
    const r = await call(s, "GET", `/v1/businesses/${s.biz}/time_travel`, undefined, {
      allow: [403, 404],
    });
    const now = Date.parse(r.date ?? "") || Date.now();
    const on = r.status === 200 && r.body.status === "in_progress" && r.body.simulated_now;
    return {
      now,
      sim: on ? Date.parse(r.body.simulated_now) : null,
      genesis: on ? r.body.genesis_time : null,
    };
  }

  // Every event at or after `from`, oldest first, across as many pages as there are.
  async function fetchFrom(from) {
    const out = [];
    let after;
    for (;;) {
      const q = new URLSearchParams({
        "sort_by[asc]": "occurred_at",
        occurred_after: new Date(from).toISOString(),
        limit: "100",
      });
      for (const t of types) q.append("type", t);
      if (after) q.set("starting_after", after);
      const { body: page } = await call(s, "GET", `/v1/businesses/${s.biz}/events?${q}`);
      out.push(...(page.data ?? []));
      if (!page.has_more || !page.data?.length) return out;
      after = page.next_cursor ?? page.data[page.data.length - 1].id;
    }
  }

  function floor(c) {
    const at = [state.through];
    if (c.sim != null) {
      at.push(c.sim);
      // A new session stamps from its genesis; an ongoing one from where it was last poll.
      at.push(state.genesis === c.genesis && state.sim != null ? state.sim : Date.parse(c.genesis));
    }
    if (state.sim != null) at.push(state.sim);
    return Math.min(...at.filter(Number.isFinite)) - LOOKBACK_MS;
  }

  const start = await clock();
  if (since === "now") state.through = start.now;
  else if (Number.isFinite(parseDuration(since))) state.through = start.now - parseDuration(since);
  else if (Number.isFinite(Date.parse(since))) state.through = Date.parse(since);
  else throw new CliError("--since must be now, a duration (10m, 2h) or an ISO time.");
  // Never forward an event created before the start, whatever its stamp.
  const guard = state.through - 2000;
  if (since === "now") {
    for (const e of await fetchFrom(floor(start))) remember(e.id);
  }
  state.sim = start.sim;
  state.genesis = start.genesis;

  const stop = () => {
    console.log("\nStopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `Ready. Forwarding events of ${s.biz}${types.length ? ` (${types.join(", ")})` : ""} to ${target}` +
      ` every ${interval}ms. Press Ctrl-C to stop.`,
  );

  for (;;) {
    try {
      const c = await clock();
      const events = await fetchFrom(floor(c));
      state.through = c.now;
      state.sim = c.sim;
      state.genesis = c.genesis;
      for (const e of events) {
        if (seen.has(e.id) || e.imported) continue;
        remember(e.id);
        if (idTime(e.id) < guard) continue;
        await forward(e);
      }
    } catch (e) {
      console.error(`listen: ${e.message} (retrying)`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  async function forward(e) {
    const body = envelope(e);
    const t0 = performance.now();
    let status;
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Tmbilling-Signature": sign(body),
          "Tmbilling-Event-Id": e.id,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      await res.arrayBuffer().catch(() => null);
      status = String(res.status);
    } catch (err) {
      status = `ERR ${err?.cause?.code ?? err?.name ?? "failed"}`;
    }
    const ms = Math.round(performance.now() - t0);
    console.log(
      `${e.occurred_at}  ${String(e.event_type ?? e.type).padEnd(30)} ${e.id}  → ${status}  ${ms}ms`,
    );
  }
}
