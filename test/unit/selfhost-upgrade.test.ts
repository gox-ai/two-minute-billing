import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../deploy/docker/upgrade.sh");
const HELP = "docs-site/content/help/40.developers/01.getting-started/06.self-host-docker.md";

/** Stands in for docker: logs each call; psql reports `applied`; `up` fails when asked to. */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "compose version") exit 0 ;;
  *"exec -T postgres psql"*) echo "$FAKE_APPLIED"; exit 0 ;;
  *"--profile backup run"*) mkdir -p backups && : > backups/tmbilling-20261123T000000Z.dump; exit 0 ;;
  *"compose up"*) [ -z "$FAKE_UP_FAIL" ] ;;
  *"compose logs"*) echo "logs for: $*"; echo "api: schema_behind"; exit 0 ;;
  *) exit 0 ;;
esac
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

/** An origin with releases v0.1.0 and v0.2.0, and an install cloned from it at v0.1.0. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tmb-upgrade-"));
  const origin = join(dir, "origin");
  mkdirSync(join(origin, "deploy/docker"), { recursive: true });
  mkdirSync(join(origin, "db/migrations/meta"), { recursive: true });
  mkdirSync(join(origin, HELP, ".."), { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  const release = (tag: string, whens: number[], note: string) => {
    copyFileSync(SCRIPT, join(origin, "deploy/docker/upgrade.sh"));
    const entries = whens.map((when, i) => ({ tag: `000${i}_x`, when }));
    writeFileSync(
      join(origin, "db/migrations/meta/_journal.json"),
      JSON.stringify({ entries }, null, 2),
    );
    writeFileSync(join(origin, HELP), `## Upgrade\n\n### Version notes\n\n${note}\n## Back up\n`);
    git(origin, "add", "-A");
    git(origin, "update-index", "--chmod=-x", "deploy/docker/upgrade.sh");
    git(origin, "commit", "-qm", tag);
    git(origin, "tag", tag);
  };
  release("v0.1.0", [50], "");
  release("v0.2.0", [50, 150, 200], "#### v0.2.0\n\nRun the thing once.\n");
  const install = join(dir, "install");
  git(dir, "clone", "-q", origin, install);
  git(install, "-c", "advice.detachedHead=false", "checkout", "-q", "v0.1.0");
  const docker = join(install, "deploy/docker");
  writeFileSync(join(docker, ".env"), "TMBILLING_VERSION=0.1.0\nAPP_HOST=localhost\n", {
    mode: 0o600,
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  return { dir, install, docker, log: join(dir, "docker.log") };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(t.docker, "upgrade.sh"), ...args], {
    cwd: t.docker,
    encoding: "utf8",
    env: {
      PATH: `${join(t.dir, "bin")}:${process.env.PATH}`,
      HOME: t.dir,
      FAKE_LOG: t.log,
      FAKE_APPLIED: "100",
      ...env,
    },
  });
  return { ...r, out: r.stdout + r.stderr };
}
const calls = () => (existsSync(t.log) ? readFileSync(t.log, "utf8") : "");
const version = () =>
  /TMBILLING_VERSION=(.*)/.exec(readFileSync(join(t.docker, ".env"), "utf8"))?.[1];
const head = () => git(t.install, "describe", "--tags").trim();

describe("deploy/docker/upgrade.sh", () => {
  it("--version shows the installed and the newest release", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/installed: v0\.1\.0/);
    expect(r.out).toMatch(/newest:\s+v0\.2\.0/);
  });

  it("--dry-run counts the database changes, lists the manual steps and changes nothing", () => {
    const r = run(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/v0\.1\.0 → v0\.2\.0/);
    expect(r.out).toMatch(/2 changes to apply/); // 150 and 200 are newer than the recorded 100
    expect(r.out).toMatch(/v0\.2\.0:\n\s+Run the thing once\./);
    expect(version()).toBe("0.1.0");
    expect(head()).toBe("v0.1.0");
    expect(calls()).not.toMatch(/pull|compose up|backup/);
  });

  it("upgrades: backup, tag checkout, version, pull, then up --wait, in that order", () => {
    const r = run(["--yes"]);
    expect(r.status, r.out).toBe(0);
    expect(version()).toBe("0.2.0");
    expect(head()).toBe("v0.2.0");
    expect(statSync(join(t.docker, ".env")).mode & 0o777).toBe(0o600);
    const order = ["--profile backup run --rm backup", "compose pull", "compose up -d --wait"].map(
      (c) => calls().indexOf(c),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("--no-backup skips only the backup", () => {
    expect(run(["--yes", "--no-backup"]).status).toBe(0);
    expect(calls()).not.toMatch(/backup/);
    expect(version()).toBe("0.2.0");
  });

  it("is a no-op on the newest release", () => {
    run(["--yes"]);
    const r = run(["--yes"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/already on v0\.2\.0/);
  });

  it("refuses a downgrade, a local build, an unknown tag and local code changes, changing nothing", () => {
    run(["--yes"]);
    expect(run(["v0.1.0", "--yes"]).out).toMatch(/no downgrade/);
    expect(version()).toBe("0.2.0");

    writeFileSync(join(t.docker, ".env"), "TMBILLING_VERSION=local\n", { mode: 0o600 });
    expect(run(["--yes"]).out).toMatch(/a local build/);

    writeFileSync(join(t.docker, ".env"), "TMBILLING_VERSION=0.1.0\n", { mode: 0o600 });
    expect(run(["v9.9.9", "--yes"]).out).toMatch(/not a release/);

    writeFileSync(join(t.install, HELP), "edited\n");
    const dirty = run(["--yes"]);
    expect(dirty.status).toBe(1);
    expect(dirty.out).toMatch(/local code changes/);
    expect(version()).toBe("0.1.0");
  });

  it("does not count a chmod as a local code change", () => {
    chmodSync(join(t.docker, "upgrade.sh"), 0o755);
    expect(run(["--yes"]).status).toBe(0);
    expect(version()).toBe("0.2.0");
  });

  it("needs --yes without a terminal", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/run with --yes/);
    expect(version()).toBe("0.1.0");
  });

  it("on a failed start, shows init's log and the way back, and restores nothing itself", () => {
    const before = git(t.install, "rev-parse", "HEAD").trim();
    const r = run(["--yes"], { FAKE_UP_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/did not start on v0\.2\.0/);
    expect(r.out).toMatch(/logs for: .*init api/);
    expect(r.out).toMatch(/api: schema_behind/);
    expect(r.out).toContain(`git checkout ${before}`);
    expect(r.out).toMatch(/TMBILLING_VERSION=0\.1\.0/);
    expect(r.out).toMatch(/pg_restore .* < backups\/tmbilling-20261123T000000Z\.dump/);
    expect(calls()).not.toMatch(/pg_restore|compose down/);
  });
});
