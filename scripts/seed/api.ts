/**
 * The seed's handle on one simulated business: the real HTTP API (in-process inject) and
 * Time Travel clock it runs on.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { runWithClockScope } from "@/platform/clock";
import { travelForward } from "@/modules/time-travel/service";

export const DAY = 86_400_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what} → ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

/** API responses are loosely typed JSON. */
export type Json = any;

export class Sim {
  /** The instant Time Travel has been driven to (the last tick). */
  cursor: Date;

  constructor(
    private readonly app: FastifyInstance,
    private readonly secret: string,
    readonly orgId: string,
    readonly bizId: string,
    readonly bizPublicId: string,
    genesis: Date,
  ) {
    this.cursor = genesis;
  }

  get ctx() {
    return { organizationId: this.orgId, businessId: this.bizId };
  }

  /** Run `fn` as-of `at`: the engine dates every row it writes by this clock scope. */
  async at<T>(at: Date, fn: () => Promise<T>): Promise<T> {
    return runWithClockScope({ onlyBusinessId: this.bizId, now: at }, fn);
  }

  /** Drive real billing ticks up to `to` (one per call; callers step a day at a time). */
  async travelTo(to: Date): Promise<void> {
    if (to.getTime() <= this.cursor.getTime()) return;
    await travelForward({ orgId: this.orgId, bizId: this.bizId, toTime: to, stepDays: 1 });
    this.cursor = to;
  }

  /** Call the API for this business. Throws ApiError on a non-2xx unless `allow` lists it. */
  async call(
    method: "GET" | "POST",
    path: string,
    body?: object,
    allow: number[] = [],
  ): Promise<Json> {
    const r = await this.app.inject({
      method,
      url: `/v1/businesses/${this.bizPublicId}${path}`,
      headers: {
        authorization: `Bearer ${this.secret}`,
        ...(method === "POST" ? { "idempotency-key": randomBytes(12).toString("hex") } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
    const json = r.body ? r.json() : null;
    if (r.statusCode >= 300 && !allow.includes(r.statusCode)) {
      throw new ApiError(r.statusCode, json, `${method} ${path}`);
    }
    return json;
  }
}
