/**
 * A one-line-per-page map of the help, for the assistant's instructions: the model learns the
 * help's own words (page names, what each covers) and searches with them, instead of passing
 * the member's wording straight to search. Built from the files on disk once per process.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { contentPathToUrl, parseFrontmatter } from "./chunk";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith(".md") && name !== "index.md") out.push(p);
  }
  return out;
}

const unquote = (s: string | undefined) => (s ?? "").replace(/^"|"$/g, "").trim();

/** `- Title: what it covers`, the gateway pages folded into one line. No paths: links come from search. */
export function buildDocsMap(root = ROOT): string {
  const content = join(root, "docs-site/content");
  const lines: string[] = [];
  const gateways: string[] = [];
  for (const abs of files(join(content, "help"))) {
    const rel = relative(content, abs);
    if (rel.includes("/50.api-reference/")) continue;
    const { meta } = parseFrontmatter(readFileSync(abs, "utf8"));
    const title = unquote(meta.title);
    const path = contentPathToUrl(rel).replace(/^\/help\//, "");
    if (path.startsWith("guides/connect-a-payment-gateway/")) {
      gateways.push(title);
      continue;
    }
    const what = unquote(meta.description).split(/(?<=\.)\s/)[0] ?? "";
    lines.push(`- ${title}${what ? `: ${what}` : ""}`);
  }
  if (gateways.length)
    lines.push(`- Connect a payment gateway: one setup guide each for ${gateways.join(", ")}.`);
  return lines.join("\n");
}

let cached: string | null = null;
export function docsMap(): string {
  cached ??= buildDocsMap();
  return cached;
}
