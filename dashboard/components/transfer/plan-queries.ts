/**
 * The first item queries of the transfer page. A plain module: the server page loads these
 * pages and the client components ask for the same ones, so the first page is reused.
 */
import type { ItemQuery } from "@/lib/api/transfer";

/** The plan's default list: every item that changes something, or cannot be copied. */
export const PLAN_DEFAULT_QUERY: ItemQuery = { result: "changes" };
/** Blocked items stay at the top of the plan, whatever the filter. */
export const PLAN_BLOCKED_QUERY: ItemQuery = { result: "blocked", limit: 500 };
/** A run's default list: every item the apply queued. */
export const PROGRESS_DEFAULT_QUERY: ItemQuery = { status: "queued" };
