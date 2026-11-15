// Settings come from the environment; an env file only fills in what the environment lacks.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "./api.mjs";

/** Minimal dotenv parser for Node versions without process.loadEnvFile. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.lastIndexOf(q) > 0) {
      v = v.slice(1, v.lastIndexOf(q));
      if (q === '"') v = v.replace(/\\n/g, "\n");
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load `file` (or ./.env when it exists) into process.env. A variable already set (not
 * empty) in the environment keeps its value. Returns the path loaded, or null.
 */
export function loadEnv(file) {
  const path = file ? resolve(file) : resolve(".env");
  if (!existsSync(path)) {
    if (file) throw new CliError(`env file not found: ${file}`);
    return null;
  }
  // An empty variable counts as not set.
  for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];
  const before = { ...process.env };
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
    Object.assign(process.env, before);
  } else {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8"))))
      if (!(k in before)) process.env[k] = v;
  }
  return path;
}
