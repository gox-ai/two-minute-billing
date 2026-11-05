// Preload for pm2 CLUSTER mode — the equivalent of `--import tsx` with an absolute tsconfig.
//
// A cluster child starts in the pm2 daemon's cwd and receives the app's env only later (pm2
// unpacks it from `pm2_env` inside its wrapper). tsx's ESM hooks run on their own thread, set up
// at preload, so a bare `--import tsx` found neither the package nor tsconfig's `@/` alias:
// every dynamic `import("@/…")` failed and the worker never booted (2026-09-27). Everything here
// resolves from this file's own location instead.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";

const tsconfig = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
process.env.TSX_TSCONFIG_PATH = tsconfig; // read by the CJS hooks, which run on this thread
registerCjs();
register({ tsconfig });
