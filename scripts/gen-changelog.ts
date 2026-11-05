/**
 * The public changelog (/changelog) from the dashboard's What's New notes
 * (`dashboard/content/releases/*.md`), so there is one source. Writes
 * `docs-site/data/releases.json`, newest first; run before every docs build.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "dashboard/content/releases");

const notes = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const raw = readFileSync(join(DIR, f), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!m) throw new Error(`${f}: no frontmatter`);
    const meta: Record<string, string> = {};
    for (const line of m[1]!.split("\n")) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]!] = kv[2]!.trim();
    }
    return {
      slug: f.replace(/\.md$/, ""),
      title: meta.title ?? f,
      date: meta.date ?? f.slice(0, 10),
      type: meta.type ?? "Improvement",
      tags: (meta.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      summary: meta.summary ?? "",
      // Notes link to dashboard pages ("/account"); on the public site those are dead, so keep the words.
      body: m[2]!.trim().replace(/\[([^\]]+)\]\(\/[^)]*\)/g, "$1"),
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));

writeFileSync(join(ROOT, "docs-site/data/releases.json"), `${JSON.stringify(notes, null, 2)}\n`);
console.log(`wrote ${notes.length} release notes`);
