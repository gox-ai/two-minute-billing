import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));
const db = fileURLToPath(new URL("./db", import.meta.url));
const dashboardLib = fileURLToPath(new URL("./dashboard/lib", import.meta.url));

export default defineConfig({
  resolve: {
    // Regex aliases, @db before @ so '@db/...' isn't captured by '@/'.
    alias: [
      { find: /^@db\//, replacement: db + "/" },
      // Dashboard route tests: the dashboard's own '@/lib/…' (src/ has no lib/).
      { find: /^@\/lib\//, replacement: dashboardLib + "/" },
      { find: /^@\//, replacement: src + "/" },
    ],
  },
  test: {
    // Dummy env so config.ts validates without a real DB (unit tests never connect).
    env: {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/tmbilling",
      API_KEY_SECRET: "test-secret-at-least-16-chars-long",
      NODE_ENV: "test",
    },
    include: ["test/**/*.test.ts"],
  },
});
