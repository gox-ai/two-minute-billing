/**
 * First-org bootstrap for a self-hosted install, from env (or `<NAME>_FILE` secrets that the
 * image's entrypoint resolves). Idempotent, and it can never mint a second org: once a
 * database has users, only the named owner's existing org is touched.
 *
 *   TMBILLING_INIT_ADMIN_EMAIL     unset = skip the whole step
 *   TMBILLING_INIT_ORG_NAME        required on creation
 *   TMBILLING_INIT_ADMIN_PASSWORD  required on creation; never changes an existing password
 *   TMBILLING_INIT_API_KEY         optional `sk_live_…` / `sk_test_…` to install as a write key
 *
 * Logs name emails and key prefixes only.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { createOwnerAccount } from "@/modules/auth/service";
import { rejectPassword } from "@/modules/auth/password-policy";
import { insertApiKey } from "@/modules/tenancy/service";
import { hashApiKey, type Livemode } from "@/platform/api-key";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { apiKeys, memberships, users } from "@db/schema";

const log = createLogger("selfhost-bootstrap");

export class BootstrapError extends Error {
  override name = "BootstrapError";
}

export interface BootstrapInput {
  email?: string;
  organizationName?: string;
  password?: string;
  apiKey?: string;
}

export type BootstrapOutcome =
  | { kind: "skipped_no_email" }
  | { kind: "skipped_existing_install" }
  | { kind: "created"; organizationId: string; keyInstalled: boolean }
  | { kind: "existing_owner"; organizationId: string; keyInstalled: boolean };

const KEY_FORMAT = /^sk_(live|test)_[A-Za-z0-9_-]{32,}$/;

/** The key's mode, or a refusal. `sk_all_` is the dashboard credential and never accepted. */
export function parseBootstrapKey(raw: string): Livemode {
  const m = KEY_FORMAT.exec(raw);
  if (!m) {
    throw new BootstrapError(
      "TMBILLING_INIT_API_KEY must look like sk_live_<32+ characters> or sk_test_<32+ characters>.",
    );
  }
  return m[1] as Livemode;
}

export function bootstrapInputFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapInput {
  const v = (k: string) => env[k]?.trim() || undefined;
  return {
    email: v("TMBILLING_INIT_ADMIN_EMAIL")?.toLowerCase(),
    organizationName: v("TMBILLING_INIT_ORG_NAME"),
    // Not trimmed: a password is what it is.
    password: env.TMBILLING_INIT_ADMIN_PASSWORD || undefined,
    apiKey: v("TMBILLING_INIT_API_KEY"),
  };
}

export async function bootstrapOrg(input: BootstrapInput): Promise<BootstrapOutcome> {
  const { email } = input;
  if (!email) return { kind: "skipped_no_email" };
  const keyMode = input.apiKey ? parseBootstrapKey(input.apiKey) : null;

  const [existing] = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // Checked before the transaction: the breach lookup is a network call.
  if (!existing) await checkCreationInput(input, email);

  return systemDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tmbilling.bootstrap'))`);
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    let organizationId: string;
    let kind: "created" | "existing_owner";
    if (user) {
      const [owned] = await tx
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.role, "owner"),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (!owned) {
        throw new BootstrapError(
          `${email} exists but owns no organization. Unset TMBILLING_INIT_ADMIN_EMAIL or name an owner.`,
        );
      }
      organizationId = owned.organizationId;
      kind = "existing_owner";
      if (input.password) {
        log.info("TMBILLING_INIT_ADMIN_PASSWORD is used only on creation; remove it", {
          event: "bootstrap_password_ignored",
          email,
        });
      }
    } else {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
      if (n > 0) {
        log.warn("users exist and none has this email: nothing created", {
          event: "bootstrap_skipped_existing_install",
          email,
        });
        return { kind: "skipped_existing_install" } as const;
      }
      const { org } = await createOwnerAccount(tx, {
        email,
        password: input.password!,
        name: "Admin",
        organizationName: input.organizationName!,
      });
      organizationId = org.organization.id;
      kind = "created";
      log.info("organization and owner created", {
        event: "bootstrap_org_created",
        email,
        organizationId: org.organization.id,
      });
    }

    let keyInstalled = false;
    if (input.apiKey && keyMode) {
      const hashed = hashApiKey(input.apiKey);
      const prefix = input.apiKey.slice(0, 12);
      const [held] = await tx
        .select({ organizationId: apiKeys.organizationId })
        .from(apiKeys)
        .where(eq(apiKeys.hashedKey, hashed))
        .limit(1);
      if (held && held.organizationId !== organizationId) {
        throw new BootstrapError(
          `TMBILLING_INIT_API_KEY (${prefix}…) belongs to another organization.`,
        );
      }
      if (!held) {
        await insertApiKey(
          tx,
          organizationId,
          { prefix, hashed },
          {
            livemode: keyMode,
            kind: "api",
            scope: "write",
            name: "Bootstrap key",
            expiresAt: null,
          },
        );
        keyInstalled = true;
        log.info("bootstrap API key installed", { event: "bootstrap_api_key_created", prefix });
      }
    }
    return { kind, organizationId, keyInstalled };
  });
}

/** Refusals name the setting and the rule, never the password. */
async function checkCreationInput(input: BootstrapInput, email: string): Promise<void> {
  if (!input.organizationName) {
    throw new BootstrapError(
      "TMBILLING_INIT_ORG_NAME is required to create the first organization.",
    );
  }
  if (!input.password) {
    throw new BootstrapError(
      "TMBILLING_INIT_ADMIN_PASSWORD is required to create the first owner. deploy/docker/init-env.sh generates one.",
    );
  }
  const rejected = await rejectPassword(input.password, email);
  if (rejected)
    throw new BootstrapError(
      `TMBILLING_INIT_ADMIN_PASSWORD is refused: ${rejected.replace(/\.$/, "")}.`,
    );
}
