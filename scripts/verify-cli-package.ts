/**
 * verify:cli-package — the published CLI works for someone who installs it.
 *
 * Builds cli/, packs it exactly as it would be published, installs the tarball into an empty
 * project outside this repo, and checks:
 *  - the tarball ships bin, lib, the bundled skill scripts, README and LICENSE, and nothing else,
 *  - it has no runtime dependencies,
 *  - `tmb --version` and `tmb --help` run from the installed bin, and a bundled script is
 *    reachable (`tmb doctor` with no settings exits 1 with the script's own message).
 *
 *   pnpm verify:cli-package
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli");
const work = mkdtempSync(join(tmpdir(), "tmb-cli-pkg-"));
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${detail}` : ""}`);
  if (!cond) failed++;
};
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  run("pnpm", ["-s", "cli:build"], root);
  const pkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
  const packed = run("pnpm", ["pack", "--pack-destination", work], cli).trim().split("\n");
  const tarball = packed.find((l) => l.endsWith(".tgz"))!;
  const files = run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean);

  for (const f of [
    "bin/tmb.mjs",
    "lib/listen.mjs",
    "scripts/preflight.mjs",
    "scripts/catalog.mjs",
    "scripts/clock.mjs",
    "scripts/money-check.mjs",
    "scripts/webhook-check.mjs",
    "scripts/register-webhook.mjs",
    "README.md",
    "LICENSE",
    "package.json",
  ]) {
    ok(`ships ${f}`, files.includes(`package/${f}`));
  }
  ok(
    "ships nothing outside bin, lib and scripts",
    files.every((f) =>
      /^package\/(bin|lib|scripts)\/[^/]+\.mjs$|^package\/(README\.md|LICENSE|package\.json)$/.test(
        f,
      ),
    ),
    files.join(", "),
  );
  ok(
    "no runtime dependencies",
    !pkg.dependencies && !pkg.peerDependencies && !pkg.optionalDependencies,
  );
  ok("licensed MIT", pkg.license === "MIT");

  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "cli-consumer", private: true }));
  run("pnpm", ["add", "-D", "--ignore-workspace", tarball], app);

  // Only PATH: no settings leak in from this shell.
  const env = { PATH: `${join(app, "node_modules/.bin")}:${process.env.PATH ?? ""}` };
  const tmb = (args: string[]) => spawnSync("tmb", args, { cwd: app, env, encoding: "utf8" });
  const version = tmb(["--version"]);
  ok(
    "tmb --version prints the package version",
    version.status === 0 && version.stdout.trim() === pkg.version,
    version.stderr,
  );
  const npx = spawnSync("npx", ["--no-install", "tmb", "--version"], {
    cwd: app,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  ok(
    "npx tmb --version runs the installed bin",
    npx.status === 0 && npx.stdout.trim() === pkg.version,
    npx.stderr,
  );
  const help = tmb(["--help"]);
  ok(
    "tmb --help lists the commands",
    help.status === 0 && /listen[\s\S]*trigger[\s\S]*reset/.test(help.stdout),
  );
  const doctor = tmb(["doctor"]);
  ok(
    "tmb doctor runs the bundled preflight script",
    doctor.status === 1 && doctor.stdout.includes("missing settings"),
    doctor.stdout + doctor.stderr,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n❌ CLI PACKAGE: ${failed} failed` : "\n✅ CLI PACKAGE: PASS");
process.exit(failed ? 1 : 0);
