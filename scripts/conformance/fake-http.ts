import { randomBytes } from "node:crypto";

/**
 * The fake gateway APIs behind the real adapters. One `fetch` replacement routes each request
 * to the fake that owns its host; anything else goes to the real network.
 */

export interface FakeRequest {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  /** Raw body text. */
  text: string;
  /** JSON body, or a form body flattened to `a[b]` keys. */
  body: Record<string, unknown>;
}

export interface FakeCall {
  op: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  status: number | "network";
}

/**
 * `afterCreate`: the gateway did the work, and the answer is what was lost. Without it the
 * fault comes first and nothing is created.
 */
export type Fault =
  | { kind: "network"; afterCreate?: boolean }
  | {
      kind: "http";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
      afterCreate?: boolean;
    };

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export abstract class FakeGateway {
  abstract readonly host: string;
  readonly calls: FakeCall[] = [];
  private readonly faults = new Map<string, Fault[]>();
  private seq = 0;

  /** Run-unique, so ids never collide with an earlier run's rows in the same database. */
  private readonly run = randomBytes(3).toString("hex").toUpperCase();

  /** Same-shape fake id: `prefix` + this run's tag + a zero-padded counter. */
  id(prefix: string, width = 10): string {
    return `${prefix}${this.run}${String(++this.seq).padStart(width, "0")}`;
  }

  /** The next `n` calls of `op` meet `fault`. */
  inject(op: string, fault: Fault, n = 1): void {
    const q = this.faults.get(op) ?? [];
    for (let i = 0; i < n; i++) q.push(fault);
    this.faults.set(op, q);
  }

  clearFaults(): void {
    this.faults.clear();
  }

  pendingFaults(op: string): number {
    return this.faults.get(op)?.length ?? 0;
  }

  /** Runs `create` unless a fault says otherwise; records the call. */
  protected async guarded(
    op: string,
    req: FakeRequest,
    create: () => Response | Promise<Response>,
  ): Promise<Response> {
    const fault = this.faults.get(op)?.shift();
    const record = (status: number | "network") =>
      this.calls.push({
        op,
        method: req.method,
        path: req.path,
        body: req.body,
        headers: req.headers,
        status,
      });
    if (fault && !fault.afterCreate) {
      if (fault.kind === "network") {
        record("network");
        throw new TypeError("fetch failed");
      }
      record(fault.status);
      return json(fault.status, fault.body, fault.headers);
    }
    const res = await create();
    if (fault) {
      if (fault.kind === "network") {
        record("network");
        throw new TypeError("fetch failed");
      }
      record(fault.status);
      return json(fault.status, fault.body, fault.headers);
    }
    record(res.status);
    return res;
  }

  /** Answer one request, or null for a path this fake does not serve. */
  abstract route(req: FakeRequest): Promise<Response | null>;

  callsOf(op: string): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

function flattenForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

const fakes: FakeGateway[] = [];
let realFetch: typeof fetch | null = null;

/** Route requests for `fake.host` to `fake`. Installs the `fetch` replacement once. */
export function installFake(fake: FakeGateway): void {
  fakes.push(fake);
  if (realFetch) return;
  realFetch = globalThis.fetch;
  const passThrough = realFetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fake = [...fakes].reverse().find((f) => href.startsWith(f.host));
    if (!fake) return passThrough(input, init);
    const url = new URL(href);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (v, k) => (headers[k] = v),
    );
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = flattenForm(text);
      }
    }
    const res = await fake.route({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: url.pathname,
      headers,
      text,
      body,
    });
    return (
      res ??
      json(404, { error: { message: `no fake for ${init?.method ?? "GET"} ${url.pathname}` } })
    );
  }) as typeof fetch;
}

export function uninstallFakes(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  fakes.length = 0;
}
