/**
 * Static gate for the published Agent Skills (docs-site/skills/<name>/), which coding agents copy
 * code from. Stale guidance is how an agent ships a broken integration, so this fails CI on:
 *  1. frontmatter: name = directory name, spec-shaped, a description of at most 1024 chars;
 *  2. a `references/…` or `scripts/…` path a SKILL.md names that does not exist;
 *  3. an event name that is not a registered event type (the misspelled-event bug class);
 *  4. TypeScript that does not compile against sdk/index.ts (standalone .ts files, and ```ts
 *     blocks that import nothing but the SDK and node: modules);
 *  5. a script that does not parse, or does not exit 1 when its settings are missing.
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isEventType } from "../src/modules/events/registry";

const ROOT = join(import.meta.dirname, "..");
const SKILLS = join(ROOT, "docs-site/skills");
const problems: string[] = [];
const bad = (file: string, msg: string) => problems.push(`${relative(ROOT, file)}: ${msg}`);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const skillDirs = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory());
const files = walk(SKILLS);

// 1 + 2. Frontmatter and named files.
for (const name of skillDirs) {
  const md = join(SKILLS, name, "SKILL.md");
  if (!existsSync(md)) {
    bad(join(SKILLS, name), "no SKILL.md");
    continue;
  }
  const text = readFileSync(md, "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!fm) {
    bad(md, "no frontmatter");
    continue;
  }
  const field = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(fm)?.[1]?.trim();
  const fmName = field("name");
  const desc = field("description");
  if (fmName !== name) bad(md, `name "${fmName}" must equal the directory "${name}"`);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--") || name.length > 64) {
    bad(md, "name does not match the Agent Skills naming rule");
  }
  if (!desc) bad(md, "no description");
  else {
    if (desc.length > 1024) bad(md, `description is ${desc.length} chars (max 1024)`);
    // An unquoted YAML scalar cannot hold ": " or " #"; the site's parser would drop the skill.
    if (!/^["']/.test(desc) && /: | #/.test(desc))
      bad(md, 'description has ": " or " #"; quote it');
  }
  // `scripts/x.mjs` is in the skill; `scripts/x.ts` is a path in the user's repository.
  for (const m of text.matchAll(
    /`((?:references\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_.-]+\.mjs))`/g,
  )) {
    const ref = m[1]!.replace(/<[^>]+>.*$/, "");
    if (ref.endsWith("/")) continue;
    if (!existsSync(join(SKILLS, name, ref))) bad(md, `names ${m[1]}, which is not in the skill`);
  }
}

// 3. Event names: event_types arrays, `case "…":` labels, and backticked event-shaped words.
const EVENT_SHAPED =
  /^(subscription|invoice|payment|customer|credit_note|checkout|usage|credit)_[a-z_]*(created|changed|canceled|cancelled|paid|failed|updated|deleted|started|renewed|activated|paused|resumed|reactivated|generated|voided|refunded|succeeded)$/;
for (const f of files.filter((f) => /\.(md|ts|mjs)$/.test(f))) {
  const text = readFileSync(f, "utf8");
  const names = new Set<string>();
  for (const arr of text.matchAll(/"?event_types"?\s*:\s*\[([^\]]*)\]/g)) {
    for (const s of arr[1]!.matchAll(/"([a-z_]+)"/g)) names.add(s[1]!);
  }
  for (const s of text.matchAll(/case\s+["']([a-z_]+)["']\s*:/g)) names.add(s[1]!);
  for (const s of text.matchAll(/`([a-z_]+)`/g)) if (EVENT_SHAPED.test(s[1]!)) names.add(s[1]!);
  for (const n of names) if (!isEventType(n)) bad(f, `"${n}" is not an event type`);
}

// 4. TypeScript against the SDK source.
const tmp = mkdtempSync(join(tmpdir(), "agent-skills-"));
writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
const tsFiles: string[] = [];
const ALLOWED_IMPORT = /^(@two-minute-billing\/sdk|node:[a-z/]+)$/;
let n = 0;
for (const f of files) {
  if (f.endsWith(".ts")) tsFiles.push(f);
  // Framework guides need the framework's own types; their event names are still checked above.
  if (!f.endsWith(".md") || f.includes("/references/frameworks/")) continue;
  for (const m of readFileSync(f, "utf8").matchAll(/```ts[^\n]*\n([\s\S]*?)```/g)) {
    const code = m[1]!;
    const imports = [...code.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((x) => x[1]!);
    if (imports.some((i) => !ALLOWED_IMPORT.test(i))) continue; // framework glue: not checkable here
    const out = join(tmp, `block-${++n}.ts`);
    writeFileSync(out, `// ${relative(ROOT, f)}\n${code}\nexport {};\n`);
    tsFiles.push(out);
  }
}
// Names that skill snippets use from the app around them.
writeFileSync(
  join(tmp, "app-glue.d.ts"),
  `declare const app: any, express: any, requireUser: any, openai: any, account: any;
declare const customerId: string, requestId: string, seatCount: number, BIZ: string;
declare const tmb: import("@two-minute-billing/sdk").Tmbilling;
declare function api<T>(method: string, path: string, body?: unknown): Promise<T>;
declare function verify(raw: Buffer, header: string | undefined, secret: string): boolean;
declare function markEventSeen(id: string): Promise<boolean>;
declare function syncSubscription(...a: unknown[]): Promise<void>;
declare function markPaid(...a: unknown[]): Promise<void>;
declare function notifyPaymentProblem(...a: unknown[]): Promise<void>;
`,
);
writeFileSync(
  join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      // Snippets hang off the app's own router (`app: any`), so their callbacks are untyped.
      noImplicitAny: false,
      noEmit: true,
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [join(ROOT, "node_modules/@types")],
      paths: { "@two-minute-billing/sdk": [join(ROOT, "sdk/index.ts")] },
    },
    files: [join(tmp, "app-glue.d.ts"), ...tsFiles],
  }),
);
const tsc = spawnSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", join(tmp, "tsconfig.json")], {
  encoding: "utf8",
});
if (tsc.status !== 0) problems.push(`TypeScript:\n${(tsc.stdout + tsc.stderr).trim()}`);

// 5. Scripts parse, and refuse to run without their settings.
for (const f of files.filter((f) => f.endsWith(".mjs"))) {
  const check = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (check.status !== 0) {
    bad(f, `does not parse: ${check.stderr.trim()}`);
    continue;
  }
  const args = f.endsWith("clock.mjs") || f.endsWith("go-live-audit.mjs") ? ["status"] : [];
  const run = spawnSync(process.execPath, [f, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 20000,
  });
  if (run.status !== 1)
    bad(f, `with no settings it must exit 1, got ${run.status}: ${run.stderr.trim()}`);
}

const total = skillDirs.length;
if (problems.length) {
  console.log(`❌ AGENT SKILLS: ${problems.length} problem(s) in ${total} skills`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `✅ AGENT SKILLS: ${total} skills · ${tsFiles.length} TypeScript files and blocks compile · event names registered · scripts parse`,
);
