/**
 * The server entrypoint for supervisors that own `process.argv[1]`.
 *
 * `src/index.ts` auto-starts only when argv[1] is itself — right for `pnpm start` and for
 * pm2 FORK mode, and false under pm2 CLUSTER mode, where argv[1] is pm2's
 * `ProcessContainer.js` (measured: the app loads, logs nothing, listens on nothing, and pm2
 * reports it online). Sniffing for `pm_id` in the environment would tie the engine to one
 * supervisor; an entrypoint that just starts does not.
 *
 * Use this as the pm2 `script` for cluster mode. Fork mode can keep using `src/index.ts`.
 */
import { start } from "./index";

void start();
