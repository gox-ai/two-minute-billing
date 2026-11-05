import type { HubSpotClient, Connection } from "../client";
import type { HubSpotSettings } from "../settings";
import type { SyncOutcome } from "./links";

/** What every handler gets: the authenticated client, its connection, and parsed preferences. */
export interface SyncContext {
  client: HubSpotClient;
  conn: Connection;
  settings: HubSpotSettings;
}

/** Push one local record. May touch several HubSpot objects, so returns one outcome per object. */
export type PushHandler = (ctx: SyncContext, localId: string) => Promise<SyncOutcome[]>;

/** Pull HubSpot-side edits for linked records (phase 4); runs on autosync and Sync Now. */
export type PullHandler = (ctx: SyncContext) => Promise<SyncOutcome[]>;
