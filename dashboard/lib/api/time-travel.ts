// Typed data-access for Time Travel surface. Uses the generic apiGet /
// apiWrite from '@/lib/api'; never touches lib/api.ts.
//
// Backend shape (see src/api/time-travel-routes.ts::serialize + service.ts):
//   GET  /v1/businesses/:biz/time_travel            (status)
//   POST /v1/businesses/:biz/time_travel/start      { genesis_time }
//   POST /v1/businesses/:biz/time_travel/advance     { to_time, step_days? }
//   POST /v1/businesses/:biz/time_travel/stop       { wipe? }
//
// Time Travel is TEST-business-only and requires an all-mode API key
// (the backend 403s otherwise — surfaced to the UI as an action error).

import { apiGet, apiWrite } from "@/lib/api";

export type TimeTravelStatus = "not_enabled" | "in_progress";

/** Serializer shape from every Time Travel endpoint (see `serialize`). */
export interface TimeTravel {
  object: "time_travel";
  status: TimeTravelStatus;
  genesis_time: string | null;
  simulated_now: string | null;
  error?: string | null;
  updated_at?: string | null;
}

/** Extra fields the travel endpoint appends to the serialized machine. */
export interface TravelResult extends TimeTravel {
  steps: number;
  from: string;
  to: string;
}

/** Extra field the stop endpoint appends. */
export interface StopResult extends TimeTravel {
  wiped: number;
}

export function getTimeTravel(biz: string): Promise<TimeTravel> {
  return apiGet<TimeTravel>(`/v1/businesses/${biz}/time_travel`);
}

export function startTimeTravel(biz: string, body: { genesis_time: string }) {
  return apiWrite(`/v1/businesses/${biz}/time_travel/start`, body, "POST");
}

export function advanceTimeTravel(biz: string, body: { to_time: string; step_days?: number }) {
  return apiWrite(`/v1/businesses/${biz}/time_travel/advance`, body, "POST");
}

export function stopTimeTravel(biz: string, body?: { wipe?: boolean }) {
  return apiWrite(`/v1/businesses/${biz}/time_travel/stop`, body ?? {}, "POST");
}
