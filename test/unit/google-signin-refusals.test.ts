import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName, type Table } from "drizzle-orm";

/**
 * `loginWithGoogle` refusals: an unverified address, an address with no account
 * (invite-only), and an address bound to another Google identity. Each must refuse
 * before any account is linked.
 */

const db = vi.hoisted(() => ({
  /** One result per `select()`, in call order. */
  selects: [] as unknown[][],
  /** Tables read, in order. */
  reads: [] as string[],
  updates: 0,
  signup: false,
}));

vi.mock("@/platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/db")>();
  const select = () => ({
    from: (t: Table) => {
      db.reads.push(getTableName(t));
      const rows = db.selects.shift() ?? [];
      const chain = {
        where: () => chain,
        limit: async () => rows,
      };
      return chain;
    },
  });
  const update = () => {
    db.updates++;
    return { set: () => ({ where: async () => [] }) };
  };
  return { ...actual, systemDb: { select, update } };
});

vi.mock("@/platform/edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/edition")>();
  return { ...actual, signupOffered: () => db.signup };
});

const { loginWithGoogle, AuthError, GoogleSignupRequired } = await import("@/modules/auth/service");

const input = (over: Partial<Parameters<typeof loginWithGoogle>[0]> = {}) => ({
  googleSub: "google-sub-new",
  email: "Owner@Example.com",
  emailVerified: true,
  name: "Owner",
  ...over,
});
const user = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  publicId: "usr_1",
  email: "owner@example.com",
  name: "Owner",
  googleSub: null,
  passwordHash: "x",
  lockedUntil: null,
  googlePictureUrl: null,
  ...over,
});

beforeEach(() => {
  db.selects = [];
  db.reads = [];
  db.updates = 0;
  db.signup = false;
});

describe("loginWithGoogle refusals", () => {
  it("an unverified Google email is refused before any lookup by email or link", async () => {
    db.selects = [[]]; // no user with this Google identity
    await expect(loginWithGoogle(input({ emailVerified: false }))).rejects.toThrow(
      /no verified email/,
    );
    expect(db.reads).toEqual(["users"]); // the googleSub lookup only
    expect(db.updates).toBe(0);
  });

  it("an unverified email is refused even when sign-up is offered", async () => {
    db.signup = true;
    db.selects = [[]];
    const err = await loginWithGoogle(input({ emailVerified: false })).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(GoogleSignupRequired);
    expect(db.reads).toHaveLength(1);
  });

  it("invite-only: a verified address with no account is refused, nothing linked", async () => {
    db.selects = [[], []]; // no googleSub match, no email match
    await expect(loginWithGoogle(input())).rejects.toThrow(/Ask an administrator for an invite/);
    expect(db.reads).toEqual(["users", "users"]);
    expect(db.updates).toBe(0);
  });

  it("an address bound to a different Google identity is refused, not re-bound", async () => {
    db.selects = [[], [user({ googleSub: "google-sub-other" })]];
    const err = await loginWithGoogle(input()).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toMatch(/already linked to a different Google account/);
    expect(db.updates).toBe(0);
    expect(db.reads).toHaveLength(2); // never reaches memberships
  });

  it("control: a verified, unbound address with an account is linked", async () => {
    // The link update runs, then memberships is read; an empty membership refuses after.
    db.selects = [[], [user()], []];
    await expect(loginWithGoogle(input())).rejects.toThrow(/Ask an administrator/);
    expect(db.updates).toBe(1);
    expect(db.reads).toEqual(["users", "users", "memberships"]);
  });
});
