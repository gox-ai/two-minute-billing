// tmb init: install the Agent Skills, list the settings in the example env file, say what next.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const NAMES = [
  "TMBILLING_URL",
  "TMBILLING_API_KEY",
  "TMBILLING_BUSINESS_ID",
  "TMBILLING_WEBHOOK_SECRET",
];
const EXAMPLES = [".env.example", ".env.sample", "config/.env.example"];
const SKILLS = ["skills", "add", "https://twominutebilling.com"];

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

export async function init(argv) {
  const yes = argv.includes("--yes");
  let code = 0;

  // 1. Agent Skills.
  if (argv.includes("--skip-skills")) {
    console.log("Skills: skipped.");
  } else if (yes || (await ask(`Run "npx ${SKILLS.join(" ")}" to add the Agent Skills? [y/N] `))) {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const r = spawnSync(npx, SKILLS, { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) {
      console.error(
        `init: the skills install did not complete (exit ${r.status ?? r.error?.code}).`,
      );
      code = 1;
    }
  } else {
    console.log(`Skills: not added. Run "npx ${SKILLS.join(" ")}" later.`);
  }

  // 2. The variable names, empty, in the example env file. Never the real .env.
  const file = EXAMPLES.find((f) => existsSync(f)) ?? ".env.example";
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const has = (n) => new RegExp(`^\\s*(export\\s+)?${n}\\s*=`, "m").test(text);
  const missing = NAMES.filter((n) => !has(n));
  if (missing.length) {
    const block =
      (text && !text.endsWith("\n") ? "\n" : "") +
      (text ? "\n" : "") +
      "# Two Minute Billing\n" +
      missing.map((n) => `${n}=`).join("\n") +
      "\n";
    writeFileSync(file, text + block);
    console.log(`${file}: added ${missing.join(", ")}.`);
  } else {
    console.log(`${file}: already lists the settings.`);
  }

  // 3. Next steps.
  console.log(`
Next steps:
  1. In your untracked env file (.env), set:
       TMBILLING_URL=https://api.twominutebilling.com   (Cloud; self-hosted: your API host)
       TMBILLING_API_KEY=<your sk_test_ key>
       TMBILLING_BUSINESS_ID=<your test business id>
  2. Check the connection:  tmb doctor
  3. Optional: let an assistant read the billing data (use a read-only key):
       claude mcp add --transport http billing https://mcp.twominutebilling.com/mcp/<biz_id> \\
         --header "Authorization: Bearer <read-only key>"`);
  return code;
}
