import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MFA_CODES_COOKIE, SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";

/**
 * MFA reads for the account page (audit M3).
 *
 * NOT in `app/auth-actions.ts`, and that is the point: every exported function in a
 * `'use server'` file becomes a network-invokable POST endpoint addressed by an id in the
 * public client bundle. These two only READ, so exporting them there would have created two
 * endpoints for no reason — `verify:action-guards` flagged exactly that, which is what the
 * gate is for. A server component can import a plain module directly.
 */
const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";
const MFA_SETUP_COOKIE = "tmb_mfa_setup";

async function get(path: string): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(await forwardedFor()) },
    cache: "no-store",
  });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export interface PasskeySummary {
  id: string;
  name: string;
  /** Synced to a cloud keychain, so it survives losing the device. */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MfaStatus {
  /** 2FA is on, through any method. */
  confirmed: boolean;
  /** An authenticator app is set up (2FA can be on through passkeys alone). */
  authenticatorApp: boolean;
  authenticatorAppAddedAt: string | null;
  passkeys: PasskeySummary[];
  recoveryCodesLeft: number;
  recoveryCodesSaved: boolean;
  enabledAt: string | null;
  lastUsedAt: string | null;
  /** A support reset is pending and will turn 2FA off at this time. */
  resetEffectiveAt: string | null;
}

/** The second-factor state the Security card shows. A failed read is `null`, never "off". */
export async function getMfaStatus(): Promise<MfaStatus | null> {
  const r = await get("/auth/mfa");
  if (!r.ok) return null;
  return {
    confirmed: r.json.confirmed === true,
    authenticatorApp: r.json.authenticatorApp === true,
    authenticatorAppAddedAt:
      typeof r.json.authenticatorAppAddedAt === "string" ? r.json.authenticatorAppAddedAt : null,
    passkeys: Array.isArray(r.json.passkeys)
      ? (r.json.passkeys as Array<Record<string, unknown>>).map((p) => ({
          id: String(p.id),
          name: String(p.name),
          backedUp: p.backedUp === true,
          createdAt: String(p.createdAt),
          lastUsedAt: typeof p.lastUsedAt === "string" ? p.lastUsedAt : null,
        }))
      : [],
    recoveryCodesLeft: Number(r.json.recoveryCodesLeft ?? 0),
    recoveryCodesSaved: r.json.recoveryCodesSaved === true,
    enabledAt: typeof r.json.enabledAt === "string" ? r.json.enabledAt : null,
    lastUsedAt: typeof r.json.lastUsedAt === "string" ? r.json.lastUsedAt : null,
    resetEffectiveAt: typeof r.json.resetEffectiveAt === "string" ? r.json.resetEffectiveAt : null,
  };
}

/** The authenticator setup in progress, if any: the secret to scan. */
export async function readMfaSetup(): Promise<{
  secret: string;
  otpauthUri: string;
  replacing: boolean;
} | null> {
  const raw = (await cookies()).get(MFA_SETUP_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { secret?: string; otpauthUri?: string; replacing?: boolean };
    if (!v.secret || !v.otpauthUri) return null;
    return { secret: v.secret, otpauthUri: v.otpauthUri, replacing: v.replacing === true };
  } catch {
    return null;
  }
}

/**
 * Recovery codes just minted (first setup or regenerate), until the person says they saved
 * them. Only their hashes are stored, so this cookie is the one readable copy.
 */
export async function readNewRecoveryCodes(): Promise<string[] | null> {
  const raw = (await cookies()).get(MFA_CODES_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length > 0 ? v.map(String) : null;
  } catch {
    return null;
  }
}
