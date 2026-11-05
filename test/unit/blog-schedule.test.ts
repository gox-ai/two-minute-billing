import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blogFiles, isScheduled, parsePublishAt } from "../../docs-site/server/lib/blog-files";

const dirs: string[] = [];
function blogDir(posts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "blog-"));
  dirs.push(dir);
  for (const [name, front] of Object.entries(posts)) {
    writeFileSync(join(dir, `${name}.md`), `---\ntitle: "${name}"\n${front}---\n\nBody.\n`);
  }
  return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("blog publishAt", () => {
  it("reads draft and publishAt from the frontmatter", () => {
    const dir = blogDir({
      live: "draft: false\n",
      draft: "draft: true\n",
      later: 'publishAt: "2026-11-10T09:00:00-05:00"\n',
    });
    const bySlug = Object.fromEntries(blogFiles(dir).map((f) => [f.slug, f]));
    expect(bySlug.live).toMatchObject({ draft: false, publishAt: undefined });
    expect(bySlug.draft).toMatchObject({ draft: true });
    expect(bySlug.later!.publishAt).toBe(Date.parse("2026-11-10T14:00:00Z"));
  });

  it("is scheduled until its time, then live", () => {
    const [f] = blogFiles(blogDir({ p: "publishAt: 2026-11-10T09:00:00Z\n" }));
    expect(isScheduled(f!, Date.parse("2026-11-10T08:59:59Z"))).toBe(true);
    expect(isScheduled(f!, Date.parse("2026-11-10T09:00:00Z"))).toBe(false);
  });

  it("refuses a time without an offset, so a schedule never follows the build's zone", () => {
    expect(() => parsePublishAt("2026-11-10T09:00:00")).toThrow(/with an offset/);
    expect(() => parsePublishAt("2026-11-10")).toThrow(/with an offset/);
    expect(() => blogFiles(blogDir({ bad: "publishAt: next tuesday\n" }))).toThrow(/bad\.md/);
  });
});
