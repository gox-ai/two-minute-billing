/**
 * Gate: operator sessions honour BOTH deadlines — absolute 7 days, inactivity
 * 30 minutes.
 *
 * Exercises `resolveSession` directly rather than over HTTP. These assertions are about
 * clock arithmetic, and driving them through a running server would mean either waiting
 * out real time or trusting that the dev server had reloaded the code under test.
 *
 * Run: pnpm tsx scripts/verify-session-lifetime.ts
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { sessions, users } from "@db/schema";
import { login, resolveSession, signup } from "@/modules/auth/service";
import { config } from "@/platform/config";

/**
 * This suite MAKES its own operator instead of borrowing the seed's login.
 *
 * It ran in `verify:all`, which does `db:migrate` → `db:reset` → `geo:seed` and never
 * `pnpm seed` — and `db:reset` truncates `users`. So the suite could not pass in a clean
 * run at all: measured 2026-08-27, `verify:all` reported it as FAILED with "no such user
 * <seed login>" on a fresh database, which is every CI run.
 *
 * Seeding globally in `verify-all.sh` would have been the wrong fix. Suites here are
 * hermetic on purpose — each seeds its own data — and a suite that reads shared seed state
 * passes only by accident of ordering, which is exactly the hazard the sharded runner was
 * built to avoid. So this one signs up, like `verify:auth` does.
 */
const uniq = Date.now();
const LOGIN = { email: `session-lifetime-${uniq}@example.com`, password: "Sparrow-Lantern-9134" };

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

const sessionHash = (t: string) => createHash("sha256").update(t).digest("hex");

type SessionRow = typeof sessions.$inferSelect;

/** The row behind a token, or undefined once it has been deleted. */
const rowFor = async (token: string): Promise<SessionRow | undefined> =>
  (
    await systemDb
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sessionHash(token)))
      .limit(1)
  )[0];

/** Same, for the steps that have just created the session and require it to exist. */
const mustRow = async (token: string): Promise<SessionRow> => {
  const r = await rowFor(token);
  if (!r) throw new Error("expected a session row");
  return r;
};

await signup({
  email: LOGIN.email,
  password: LOGIN.password,
  organizationName: "Session Lifetime Gate",
});
const [operator] = await systemDb.select().from(users).where(eq(users.email, LOGIN.email)).limit(1);
if (!operator) throw new Error(`signup did not create ${LOGIN.email}`);

console.log(
  `\nsession lifetime — idle ${config.SESSION_IDLE_MINUTES}m, absolute ${config.SESSION_ABSOLUTE_TTL_HOURS}h\n`,
);

// ── A. a fresh session resolves, and starts on the IDLE window ─────────────────
console.log("§A  a new session");
{
  const { token } = await login(LOGIN.email, LOGIN.password);
  const row = await mustRow(token);
  const windowMin = Math.round((row.expiresAt.getTime() - Date.now()) / 60_000);
  check("resolves", (await resolveSession(token)) !== null);
  check(
    "expiresAt is the idle window, not the absolute one",
    windowMin === config.SESSION_IDLE_MINUTES,
    `${windowMin}m`,
  );
  await systemDb.delete(sessions).where(eq(sessions.id, row.id));
}

// ── B. idle expiry ─────────────────────────────────────────────────────────────
console.log("\n§B  idle beyond the window");
{
  const { token } = await login(LOGIN.email, LOGIN.password);
  const row = await mustRow(token);
  // Wind the idle deadline back past now, leaving createdAt alone: this is a session
  // that is well inside its absolute life but has not been touched.
  await systemDb
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(sessions.id, row.id));
  check("is rejected", (await resolveSession(token)) === null);
  await systemDb.delete(sessions).where(eq(sessions.id, row.id));
}

// ── C. the absolute ceiling still applies to an ACTIVE session ─────────────────
console.log("\n§C  active, but past the absolute ceiling");
{
  const { token } = await login(LOGIN.email, LOGIN.password);
  const row = await mustRow(token);
  // Idle deadline healthy (as it would be for someone still clicking), but signed in
  // longer ago than the ceiling allows. Refreshing on use must not confer immortality.
  await systemDb
    .update(sessions)
    .set({
      createdAt: new Date(Date.now() - (config.SESSION_ABSOLUTE_TTL_HOURS + 1) * 3600_000),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .where(eq(sessions.id, row.id));
  check("is rejected", (await resolveSession(token)) === null);
  check("and the row is deleted, not left to be re-checked", (await rowFor(token)) === undefined);
}

// ── D. using a session pushes the idle deadline forward ────────────────────────
console.log("\n§D  refresh on use");
{
  const { token } = await login(LOGIN.email, LOGIN.password);
  const row = await mustRow(token);
  // Age it past the throttle but keep it live, so a refresh is both due and legal.
  const aged = new Date(Date.now() + 5 * 60_000);
  await systemDb.update(sessions).set({ expiresAt: aged }).where(eq(sessions.id, row.id));

  check("still resolves", (await resolveSession(token)) !== null);
  const after = await mustRow(token);
  check(
    "idle deadline moved forward",
    after.expiresAt.getTime() > aged.getTime(),
    `${Math.round((after.expiresAt.getTime() - Date.now()) / 60_000)}m remaining`,
  );
  check(
    "createdAt is untouched, so the ceiling did not move",
    after.createdAt.getTime() === row.createdAt.getTime(),
  );

  // A second resolve moments later must NOT write again — that throttle is what keeps
  // session auth off the write path on every request.
  const before2 = (await mustRow(token)).expiresAt.getTime();
  await resolveSession(token);
  check(
    "a second call within the throttle does not rewrite",
    (await mustRow(token)).expiresAt.getTime() === before2,
  );

  await systemDb.delete(sessions).where(eq(sessions.id, row.id));
}

console.log(failures === 0 ? "\n✅ session lifetime OK\n" : `\n❌ ${failures} failure(s)\n`);
await closeDb();
process.exit(failures === 0 ? 0 : 1);
