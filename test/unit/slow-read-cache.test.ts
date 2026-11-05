import { describe, expect, it } from "vitest";
import { slowReadCache } from "../../src/platform/slow-cache";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("slowReadCache", () => {
  it("keeps a slow answer for the ttl, then computes again", async () => {
    const c = clock();
    const read = slowReadCache<string, number>({
      ttlMs: 100,
      slowMs: 10,
      maxEntries: 5,
      now: c.now,
    });
    let calls = 0;
    const slow = async () => (c.advance(20), ++calls);
    expect(await read("a", slow)).toBe(1);
    c.advance(50);
    expect(await read("a", slow)).toBe(1);
    c.advance(60);
    expect(await read("a", slow)).toBe(2);
  });

  it("never keeps a fast answer: a small book stays live", async () => {
    const c = clock();
    const read = slowReadCache<string, number>({
      ttlMs: 100,
      slowMs: 10,
      maxEntries: 5,
      now: c.now,
    });
    let calls = 0;
    const fast = async () => ++calls;
    await read("a", fast);
    await read("a", fast);
    expect(calls).toBe(2);
  });

  it("shares one computation between concurrent callers", async () => {
    const read = slowReadCache<string, number>({ ttlMs: 100, slowMs: 0, maxEntries: 5 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compute = async () => (await gate, ++calls);
    const both = Promise.all([read("a", compute), read("a", compute)]);
    release();
    expect(await both).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it("does not cache a failure", async () => {
    const read = slowReadCache<string, number>({ ttlMs: 100, slowMs: 0, maxEntries: 5 });
    await expect(read("a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await read("a", async () => 7)).toBe(7);
  });

  it("drops the oldest key past the cap", async () => {
    const c = clock();
    const read = slowReadCache<string, number>({
      ttlMs: 1000,
      slowMs: 0,
      maxEntries: 2,
      now: c.now,
    });
    let calls = 0;
    const compute = async () => ++calls;
    await read("a", compute);
    await read("b", compute);
    await read("c", compute);
    await read("a", compute);
    expect(calls).toBe(4);
  });
});
