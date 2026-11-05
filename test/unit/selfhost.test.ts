import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPlainSql, parseBaselineCut, readJournal } from "@/platform/selfhost/schema";
import {
  BootstrapError,
  bootstrapInputFromEnv,
  parseBootstrapKey,
} from "@/platform/selfhost/bootstrap-org";
import { config } from "@/platform/config";

const ROOT = join(import.meta.dirname, "../..");

describe("the baseline cut", () => {
  it("parses the header line the builder writes", () => {
    expect(parseBaselineCut("--\n-- baseline-cut: 0377_x 1792831202000\n--\n")).toEqual({
      tag: "0377_x",
      when: 1792831202000,
    });
    expect(parseBaselineCut("-- no cut here\n")).toBeNull();
  });

  it("the committed baseline carries a cut that names a journal entry", () => {
    const cut = parseBaselineCut(readFileSync(join(ROOT, "db/baseline.sql"), "utf8"));
    expect(cut).not.toBeNull();
    const journal = readJournal(ROOT) ?? [];
    const entry = journal.find((e) => e.tag === cut?.tag);
    // The public mirror's journal starts after the cut; the full chain names the cut itself.
    if (entry) expect(entry.when).toBe(cut?.when);
    else expect(journal.every((e) => e.when > cut!.when)).toBe(true);
  });

  it("the committed baseline grants tmbilling_app what withTenant needs", () => {
    const text = readFileSync(join(ROOT, "db/baseline.sql"), "utf8");
    expect(text).toMatch(/CREATE ROLE tmbilling_app NOLOGIN/);
    expect(text).toMatch(
      /^GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"\."businesses" TO "tmbilling_app";$/m,
    );
  });

  it("refuses a psql meta-command, with its line", () => {
    expect(() => assertPlainSql("select 1;\n\\connect other\n")).toThrow(/line 2/);
    expect(() => assertPlainSql("select '\\x';\n")).not.toThrow();
  });
});

describe("the bootstrap key", () => {
  const tail = "a".repeat(32);
  it("takes the mode from the prefix", () => {
    expect(parseBootstrapKey(`sk_live_${tail}`)).toBe("live");
    expect(parseBootstrapKey(`sk_test_${tail}`)).toBe("test");
  });

  it("refuses the dashboard credential, a short key and junk, without echoing the key", () => {
    for (const bad of [`sk_all_${tail}`, "sk_live_short", `pk_live_${tail}`]) {
      let err: unknown;
      try {
        parseBootstrapKey(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BootstrapError);
      expect((err as Error).message).not.toContain(bad);
    }
  });

  it("reads env, lower-cases the email and treats empty values as unset", () => {
    expect(
      bootstrapInputFromEnv({
        TMBILLING_INIT_ADMIN_EMAIL: " Admin@Example.com ",
        TMBILLING_INIT_ORG_NAME: "",
        TMBILLING_INIT_ADMIN_PASSWORD: " keep spaces ",
      }),
    ).toEqual({
      email: "admin@example.com",
      organizationName: undefined,
      password: " keep spaces ",
      apiKey: undefined,
    });
  });
});

describe("the image entrypoint", () => {
  const entrypoint = join(ROOT, "deploy/docker/entrypoint.sh");
  const dir = mkdtempSync(join(tmpdir(), "tmb-entrypoint-"));
  const secret = join(dir, "secret");
  writeFileSync(secret, "s3cret-value\n");
  const run = (env: Record<string, string>) =>
    spawnSync(
      "sh",
      [entrypoint, "sh", "-c", 'printf "%s|%s" "$API_KEY_SECRET" "${API_KEY_SECRET_FILE:-unset}"'],
      {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      },
    );

  it("resolves <NAME>_FILE into <NAME> and drops the _FILE variable", () => {
    const r = run({ API_KEY_SECRET_FILE: secret });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("s3cret-value|unset");
  });

  it("refuses both forms at once, and an unreadable file, without printing the value", () => {
    const both = run({ API_KEY_SECRET_FILE: secret, API_KEY_SECRET: "x" });
    expect(both.status).toBe(1);
    const missing = run({ API_KEY_SECRET_FILE: join(dir, "nope") });
    expect(missing.status).toBe(1);
    expect(both.stderr + missing.stderr).not.toContain("s3cret-value");
  });

  it("leaves a name off the allowlist alone", () => {
    const r = spawnSync("sh", [entrypoint, "sh", "-c", 'printf "%s" "${NODE_ENV_FILE:-}"'], {
      env: { PATH: process.env.PATH, NODE_ENV_FILE: secret },
      encoding: "utf8",
    });
    expect(r.stdout).toBe(secret);
  });
});

describe("the compose file", () => {
  const compose = readFileSync(join(ROOT, "deploy/docker/compose.yaml"), "utf8");

  it("gives the worker its full drain before a SIGKILL (grace >= 2 x drain + 20 s)", () => {
    const worker = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  dashboard:"));
    const grace = Number(/stop_grace_period: (\d+)s/.exec(worker)?.[1]);
    expect(grace * 1000).toBeGreaterThanOrEqual(2 * config.WORKER_SHUTDOWN_TIMEOUT_MS + 20_000);
    expect(compose).toMatch(/stop_signal: SIGTERM/);
  });

  it("never runs the engine through pnpm or a shell", () => {
    const commands = [...compose.matchAll(/command: \[([^\]]*)\]/g)].map((m) => m[1]!);
    for (const c of commands) {
      if (c.includes("pg_dump")) continue;
      expect(c).toMatch(/^"node", "--import", "tsx"/);
    }
  });

  it("pins every image by digest and never uses latest", () => {
    for (const [, image] of compose.matchAll(/image: (\S+)/g)) {
      if (image!.includes("${TMBILLING_IMAGE_PREFIX")) {
        expect(image).toMatch(/:\$\{TMBILLING_VERSION:\?/);
      } else {
        expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }
  });
});
