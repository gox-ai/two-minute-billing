# auth — dashboard login, sessions, RBAC

> Source: `src/modules/auth/` · Routes: `src/api/auth-routes.ts` · Schema: `db/schema/users.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
Human authentication and authorization for the operator dashboard (distinct from API-key auth, which
lives in `tenancy`/`platform/auth`). Manages users, password credentials, sessions, invites, and the
role-based permission check used across dashboard server actions.

## Responsibilities
- Sign up (creates the org + first user + API key), log in / log out, resolve the current session.
- Password reset + change.
- Invite additional users into an organization with a role.
- Roles and permissions: the catalogue (`permissions.ts`), five fixed roles and custom roles
  (`roles.ts`). Every API route declares one key (`requirePerm`); the server refuses to boot otherwise.

## Data model
`db/schema/users.ts`:
- `users` — email, scrypt password hash, `google_sub` + `email_verified_at` (0194), and
  `last_organization_id` (a PREFERENCE, never an authorization — see below).
- `memberships` — the join table, UNIQUE on (organization, user). **A user belongs to MANY
  organizations**; the role is per-membership, so the same person can be an owner in one and
  read-only in another.
- `sessions` — org-scoped: a session acts in exactly one of the user's organizations at a time.
- `password_reset_tokens` (0194) — single-use, short-lived, SHA-256 only.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `signup` | create org + owner user + initial API key (in-process: importer, seed, fixtures) |
| `beginPasswordSignup` / `completePasswordSignup` | self-serve sign-up (0354, `signup.ts`): mail a link; spending it creates the org, owner and session |
| `completeGoogleSignup` · `signGoogleSignupTicket` | self-serve sign-up with a verified Google identity, carried in a 15-minute signed ticket |
| `login` / `logout` / `resolveSession` | session lifecycle |
| `loginWithGoogle` | sign in a VERIFIED Google identity — never provisions (0194); an unknown address throws `GoogleSignupRequired` while SIGNUP_ENABLED (0354) |
| `listMemberships` / `switchOrganization` | multi-org: enumerate, and move the session (0194) |
| `changePassword` / `resetPassword` | credential management |
| `requestPasswordReset` / `resetPasswordWithToken` | self-serve reset (0194) |
| `inviteUser` | add a user to an org with a role |
| `permissionsOf` | a member's effective permission keys (fixed or custom role) |
| `listRoles` / `createRole` / `updateRole` / `deleteRole` | custom roles (`roles.ts`) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /auth/signup` | whether sign-up is offered (`enabled`, `sandbox`) |
| `POST /auth/signup` | self-serve sign-up (0354): password → 202 and an email, same for every address; `google_ticket` → 201 session. 403 unless SIGNUP_ENABLED |
| `POST /auth/signup/confirm` | spend the emailed link: create org + owner, 201 session |
| `POST /auth/login` · `POST /auth/logout` | session |
| `GET /auth/me` | current user |
| `POST /auth/change_password` | rotate password |
| `GET /auth/organizations` | the caller's memberships, current one flagged (0194) |
| `POST /auth/switch_organization` | move the session — validates membership, ROTATES the token (0194) |
| `POST /auth/forgot_password` | **uniform 200 always**; throttled per IP and per RECIPIENT (0194) |
| `POST /auth/reset_password` | spend a reset token; revokes EVERY session for the account (0194) |
| `GET /auth/google` · `POST /auth/google/exchange` · `POST /auth/google/one-tap` | Google sign-in (0194) — see `src/api/google-oauth.ts` |
| `POST /auth/invite` | invite a teammate |
| `POST /auth/me/release_notes_seen` | move the What's-new highwater for the caller (0237) |
| `POST /auth/me/product_tour_seen` | mark the product tour finished or dismissed for the caller (0500) |
| `PATCH /auth/me` | the caller's name and theme (0327) |
| `GET\|POST\|DELETE /auth/me/avatar` | upload capability; store a profile photo; remove it (0327) |
| `GET /auth/sessions` | the caller's live sessions, this browser first (0327) |
| `DELETE /auth/sessions/:id` · `POST /auth/sessions/revoke_others` | sign out one other browser, or all of them (0327) |
| `POST /auth/login/mfa` | finish any sign-in that stopped at the second factor |
| `GET /auth/mfa` · `POST /auth/mfa/enroll` · `POST /auth/mfa/confirm` · `POST /auth/mfa/disable` | second factor: status, start setup (or change app), confirm, turn off |
| `POST /auth/mfa/recovery_codes` · `POST /auth/mfa/recovery_codes/acknowledge` | regenerate recovery codes; "I've saved them" (0326) |
| `POST /auth/login/mfa/passkey-options` · `POST /auth/login/mfa/passkey` | finish the second step with a passkey, bound to the sign-in's challenge (0330) |
| `POST /auth/passkey/options` · `POST /auth/passkey/verify` | "Sign in with a passkey" — no email or password; counts as 2FA (0330) |
| `POST /auth/mfa/passkeys/options` · `POST /auth/mfa/passkeys` · `PATCH`/`DELETE /auth/mfa/passkeys/:id` · `DELETE /auth/mfa/totp` | add, rename, remove a passkey; remove the app while a passkey keeps 2FA on — the last method needs `?confirm_turn_off=true` (0330) |
| `POST /auth/mfa/reset/cancel` | stop a support 2FA reset from its emailed link — public, token-authorised, throttled (0328) |
| `GET /auth/organization/security` · `POST /auth/organization/security/require_two_factor` | the organization's "Require two-factor authentication" — admin only; ON needs your own 2FA (0329) |
| `GET /auth/trusted_browsers` · `DELETE /auth/trusted_browsers/:id` · `POST /auth/trusted_browsers/forget_all` | browsers that skip the sign-in code (0329) |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** tenancy (creates org + API key on signup).
- **Downstream (called by):** the dashboard (server-side session + `can`).

## Invariants & gotchas
- This is dashboard/human auth; programmatic API access uses API keys (`platform/auth`).
- The `signup` path is what the importer uses to create the import org + login + API key.
- **`last_organization_id` is a preference, never an authorization.** Every reader re-checks the
  membership still exists. Honouring it blindly would walk a user removed from an org back into it.
- **`switchOrganization` looks the org up BY MEMBERSHIP, never by id alone.** A switch that accepts
  any team id the caller names is a tenant-crossing hole. It also rotates the session token: changing which tenant a credential acts in is a privilege
  change, so the pre-switch value must stop working.
- **Google identity is the `sub`, not the address.** Email resolves an invited user ONCE, on first
  sign-in, and only when Google asserts `email_verified`. Matching on email forever would make a
  person who changes their Google address a stranger, and hand an account to whoever later acquires a
  recycled address.
- **`requestPasswordReset` always resolves void.** Unknown address, locked account, mail transport
  down — all identical. "No account with that email" is the easiest enumeration oracle to build by
  accident (SR-2026-010), and the route answers a uniform 200 on top of that.
- **A reset revokes EVERY session, including the current one.** `changePassword` deliberately spares
  the caller's session; a reset must not, because it is what someone does when they believe another
  party is in their account.

## Changelog
- **2026-11-05** — Invite emails (new and existing account, and resends) name the person who sent them: `inviterOf(actorUserId)`. A seed or script invite has no person and keeps "Someone". Account emails are sent under `accountBrand().name` (cloud: "Two Minute Billing"; self-hosted: `MAIL_FROM_NAME`, unchanged).
- **2026-11-04** — The common-password check also compares with trailing symbols/digits removed and with every symbol removed, so `Password1!`, `Admin123!` and `P@ssw0rd!` are refused (the composition rule made an exact match impossible).
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-26 (0194)** — **Google sign-in, multi-organization, and self-serve password reset.**
  - *Multi-org* was already modelled (`memberships` is a join table) but unusable: `login` took
    `LIMIT 1` with no `ORDER BY`, so a two-org user landed wherever Postgres felt like. Now
    `last_organization_id` decides, re-checked against a live membership every time, with
    `GET /auth/organizations` and `POST /auth/switch_organization` behind it.
  - *Google* is INVITE-ONLY and uses the authorization-code flow, so no JWKS signature
    implementation is needed — the id_token arrives over TLS from Google's own token endpoint on a
    request only we could make. `iss`/`aud`/`exp` are still checked; see `src/api/google-oauth.ts`
    for why the work splits between the API and the dashboard the way it does.
  - *Reset* uses the same two-credential shape as the portal (0193): a short-lived single-use token
    that travels in a link and is exchanged for a cookie by `/reset-password/s/<token>`, so the
    credential is in neither the address bar nor the DOM.
  - Gated by `pnpm verify:auth-identity` (35 checks), including a cross-tenant switch attempt.

- **2026-08-27 (security)** — `authenticate` (platform/auth.ts) cross-checks a session against the API
  key presented on the SAME request. A session-first branch had been added that accepted any valid
  `tmb_session` as the whole credential and returned immediately, so a session's organisation
  silently overrode the organisation the presented key authorised — an ambient cookie (browser-
  attached, and forwarded by any proxy) outranked a deliberately-presented credential. The
  `dashboardActor` rule that a foreign-org session is ignored rather than trusted was already correct
  but unreachable behind the short-circuit. Now: session alone → the session is the credential (0198's
  org-follows-person is preserved); session + key in the SAME org → session still wins, actor stays
  the person; session + key in DIFFERENT orgs → the session is ignored, the key decides the org, the
  actor falls through to the literal `dashboard`, and a `session_org_mismatch` warn is logged (no
  credential material); key alone → unchanged. Caught by `verify:events`'s "a foreign org's session is
  not trusted as the actor", which was failing; the same short-circuit was also refusing
  `POST /auth/switch_organization` with a 403 (`verify:dashboard-credential`). Both suites pass.

- **2026-08-29** — **routine auth outcomes log at `info`, not `warn`.** 13 sites: failed logins,
  failed second factor / step-up, the four google sign-in refusals, the bot-challenge refusal,
  and the session revocations a password reset performs. A rejected credential is the system
  WORKING, and at `warn` they were the bulk of a level that is supposed to mean "someone should
  look" — repo-wide, warn outnumbered everything informational 2:1, which makes it unalertable.
  `account locked after repeated failed logins` deliberately STAYS at `warn`: the lock is the
  event worth acting on, not the attempts that caused it. Nothing consumes severity yet, which
  is precisely why this was worth fixing before alerts get built on top of it.

- **2026-08-30** — **team management: the Team screen could invite and nothing else.** No
  member list, no role change, no way to take access away — "remove the person who left" was a psql
  job, and an expired invite (72h) was a dead end because re-inviting answers "already a member".
  Added `listTeam` / `changeMemberRole` / `removeMember` / `resendMemberInvite` behind
  `GET|PATCH|DELETE /auth/members[/:id]` and `POST /auth/members/:id/resend_invite`, all requiring
  the `admin` permission. Notes worth keeping:
  - **Every rule lives in the service, not the route.** A guard in a route is a guard one caller has.
  - **No self-edit** (role or removal) is what actually keeps an org administrable. The
    `anotherAdminExists` count is *unreachable through these routes* — the caller is always a second
    admin — and says so in its own docblock; it exists so the invariant survives a relaxed self-edit
    rule or a second caller (CLI, support tool).
  - **A role change bites on the target's EXISTING session**, with nothing to invalidate:
    `resolveSession` re-reads the membership every request. There is a check for this, so folding the
    role into the session row will fail the suite rather than silently delay demotions.
  - **A member is addressed by `usr_…`, resolved BY MEMBERSHIP** — never by user id alone. Dropping
    that `organizationId` from the lookup was mutation-tested: three §F checks fail, one of them
    showing an outsider's role clobbered from another org (the SR-2026-008 Issue #4 shape).
  - **`status` is derived from the CREDENTIAL, not the membership.** Someone who already has an
    account is `active` the moment they are added; there is nothing for them to accept. Resend is
    refused for them on purpose — it would be a second admin-triggered path to a password.
  - **Removal keeps the USER row** (they may belong to other orgs, and their address is the actor on
    every audit row they wrote) and revokes outstanding invite tokens only when no membership is
    left, because `auth_tokens` has no org column.
  - **`inviteUser` now writes an audit row too** (`team.invite`). It was the one operator-privilege
    write with no trail at all. All four actions are attributed to the admin's email, not `system`.
  - **Deliberately NOT step-up gated**: `/auth/invite` grants a role too and has none, so gating only
    the change would be theatre. Both together, or neither.
  - **Two bugs only a real browser found**, both worth generalising: (1) the dashboard declared
    `Content-Type: application/json` on the two BODILESS writes, which Fastify refuses with an empty
    body — `app.inject` with no payload sends no content-type, so the suite was testing a request no
    browser makes. A bodiless write sends `{}` (as `apiWrite` always has) and § F now injects that
    header. (2) React 19 resets an uncontrolled `<form action>` after the action settles, *including
    on failure*, so a refused invite showed "already a member" against an empty Email field — the
    invite dialog's typed fields are controlled.
  - Gated by `pnpm verify:auth-identity` § F (**40 checks**; 74 in the suite).
- **2026-09-07 (0237)** — **The What's-new highwater.** `users.release_notes_seen_count` plus
  `releaseNotesSeenCount()` / `markReleaseNotesSeen()`, surfaced on `GET /auth/me` and moved by
  `POST /auth/me/release_notes_seen`.
  - **The engine holds no opinion about the notes.** They are markdown files in the DASHBOARD's
    repo, so only that side can say how many exist or what they say. What is stored here is an
    opaque integer; every rule about unread-ness lives in `dashboard/lib/release-note-types.ts`.
  - **A COUNT, not a timestamp, and that is the design.** Notes carry a calendar DATE only, so a
    `seen_at` cannot tell "this note existed when I dismissed" from "it shipped four hours later" —
    the second note of any day would never be announced to anyone who dismissed that morning. Notes
    are append-only, so `total - seen` is the unread count and same-day publishes work.
  - **NULL vs 0 is load-bearing.** NULL = never initialised, read by the dashboard as CAUGHT UP, so
    a new operator is not met by the whole archive on day one. 0 = has acknowledged nothing.
    Migration 0237 adds the column with NO default (new rows are NULL) and backfills existing rows
    to 0 explicitly — adding it WITH a default would have filled every existing row too, because
    Postgres 11+ backfills on ADD COLUMN, silencing the launch announcement.
  - **No `Idempotency-Key`.** A per-user UI preference on the dashboard surface, not a `/v1/*`
    write, and idempotent by construction: it SETS a count rather than incrementing one. The count
    is caller-supplied (the engine cannot see the notes), zod-bounded and service-clamped; the only
    thing it can affect is that person's own badge.
- **2026-09-17** — **Google One Tap on the sign-in screen.** `POST /auth/google/one-tap` takes an
  id_token the BROWSER was handed by Google Identity Services, and `verifyGoogleOneTapToken` checks
  it before anything reads a claim. Both Google routes end in the same `issueSession`, so a One Tap
  sign-in is invite-only and lands in `login_attempts` exactly like the other two.
  - **This path DOES verify the signature, and it has to.** The 2026-08-26 entry below is right
    about the code flow and does not carry over: there the id_token reaches us over TLS from
    Google's token endpoint, so the transport is the proof of origin. Here the token is handed to
    page script, so every byte is attacker-suppliable and RS256 against Google's rotating JWKS is
    the only thing between a forged JSON blob and a session. `jose` does it rather than a
    hand-rolled verifier — this is the line that decides who is signed in.
  - **`decodeIdTokenPayload` must never be reached from this route.** It decodes and does not
    verify. Feeding a browser-supplied token to it would make the signature check optional, which
    is why the two paths have separate entry points instead of one shared "parse the token".
  - **A nonce, because the token is a bearer credential with an hour of life.** The dashboard mints
    it, holds it in an HttpOnly cookie on its own origin and clears that cookie on every outcome;
    a token whose sealed `nonce` is not the one this attempt began with is refused. Single-use is
    what makes a captured token useless.
  - **Still no second factor on any Google path.** `loginWithGoogle` returns a session directly, so
    an operator with MFA enrolled is not challenged — pre-existing since 0194 and unchanged here,
    but One Tap makes it reachable in two clicks from a cold page, which is worth deciding about.
- **2026-10-01 (0322)** — `listMemberships` / `GET /auth/organizations` carry the organization's `icon_url`, so the dashboard shell draws the logo without a second read.
- **2026-10-08 (0326)** — **Second-factor hardening.**
  - `completeSignIn` is the only place a verified first factor becomes a session. Password, Google
    (redirect and One Tap) and invite acceptance all end there, so a person with 2FA gets the
    `mfa_challenge` on every door — Google sign-in used to skip it. The challenge carries the
    first factor's method, and `sessions.auth_method` / `mfa_at` record how each session was proven.
  - A TOTP code works once: `user_mfa.last_used_step` is set in the UPDATE that accepts the code,
    which only matches a later step. Applies to sign-in, confirm and step-up.
  - Setup holds the pending secret encrypted in `auth_tokens` (`mfa_setup`, 15 min), so starting
    setup never touches `user_mfa`; that also makes "Change app" safe. Recovery codes are minted on
    confirm, in the same transaction: 16 characters, scrypt-salted (`rc1$…`). Pre-0326 8-character
    SHA-256 codes still verify. Spending uses `array_remove`, so two codes spent at once both stick.
  - Turning 2FA off signs out every other session of the person (still session-only, per 2026-09-02).
  - Gated by `pnpm verify:auth-identity` § H.
- **2026-10-08 (0327)** — **Profile, appearance and active sessions on `/account`.**
  - `users.avatar_url` + `users.theme`. The photo goes through `uploadBrandImage` (owner `user`,
    asset `avatar`, folder `user_assets`), so it gets the same leading-byte check and 5 MB cap
    as brand images. Upload stores and saves in one call.
  - The theme follows the ACCOUNT: the dashboard's `ThemeSync` applies the saved value when it
    differs from the browser's, and both pickers (account page, rail menu) save it.
  - Sessions: a delete matches the id AND the caller's user, and refuses the caller's own
    session (that is "Sign out"). `last_active_at` is derived from the idle deadline, accurate
    to the 1-minute refresh throttle — no per-request write.
  - Gated by `pnpm verify:auth-identity` § I.
- **2026-10-08 (0328)** — **Security trail, notices, and support 2FA reset.**
  - `security_events` records every 2FA, recovery-code, password and session change, plus
    failed second-step codes and resets. Append-only, no RLS, `user_id` not an FK (as
    `login_attempts`). `security-events.ts` drops metadata keys that could carry a credential.
  - Each change emails the person (when, which browser, what to do if it wasn't them). The send
    is dispatched, never awaited by the request, and a mail failure never fails the action;
    scripts and the sweep call `flushSecurityMail()`. 5 wrong second-step codes since the last
    good one, inside 15 minutes, send "Someone may have your password" — at most once a day,
    serialised with an advisory lock.
  - Support reset: `scripts/support/request-mfa-reset.ts` files one (dry run unless `--commit`)
    effective `MFA_RESET_WAIT_DAYS` later; only sha256 of the cancel token is stored; the
    `security_sweep` job (own queue, every 15 min) completes due, uncancelled requests by a
    claiming UPDATE and turns 2FA off with every session signed out. The code step and the 2FA
    card show a pending reset; `SUPPORT_EMAIL` feeds "Get help signing in".
  - Request logs never carry bodies, so codes and tokens cannot reach them — checked at trace
    level with sentinel values, zero hits. Nothing to redact.
  - Gated by `pnpm verify:auth-identity` § J.
- **2026-10-08 (0329)** — **Organization "Require two-factor authentication", and trusted browsers.**
  - `org-two-factor.ts` owns the rule. A member without 2FA keeps working until the end of the day
    (org zone) `mfa_grace_days` (7) after `mfa_required_since`; someone who joins later gets the
    rest of their join day. Past that, `authenticate` answers 403 `two_factor_required` on every
    `/v1/*` call and the team routes (`/auth/invite`, `/auth/members*`) refuse too. The allowlist
    is everything else under `/auth/*` — me, logout, mfa, sessions, organizations, profile,
    trusted browsers — so setup stays reachable. API keys are untouched.
  - Turning it on needs the caller's own confirmed 2FA (409); repeating the current state is a
    no-op, so nobody's grace restarts. Members without 2FA are emailed; the security sweep sends
    one "by tomorrow / today" reminder per member and deadline (`org_mfa_reminders` PK is the claim).
  - While required, a member cannot turn their own 2FA off (409 `organization_requires_two_factor`);
    a support reset still can. A member without 2FA cannot mint a new API key, grace or not.
  - `MFA_REQUIRED_ROLES` is **deprecated**; it still works, and the team list shows either source.
  - Trusted browsers (`trusted-browsers.ts`): a 30-day cookie on the dashboard's origin, forwarded
    as `x-tmb-trusted-browser` on the sign-in doors; only its sha256 is stored, and it is keyed to
    the person. It skips the code step and nothing else — the session gets no `mfa_at` and
    `auth_method` reads `password+trusted_browser`. Not offered after a recovery code. Forgotten on
    password change/add/reset, 2FA off (support reset included) and "sign out of other browsers".
  - Gated by `pnpm verify:auth-identity` § K.
- **2026-10-08 (0330)** — **Passkeys.** `passkeys.ts` runs the WebAuthn ceremonies
  (`@simplewebauthn/server` 13.3.3); the 2FA state they change stays in `service.ts`.
  - **`user_mfa` is the 2FA STATE now**: `confirmed_at` = on, plus the recovery codes; the app's
    `secret_enc` became nullable. Every reader of `confirmed_at` (org gate, Team list, reset
    script) counts passkey-only people unchanged. `totp_added_at` dates the app on its own.
  - **The first method — app or passkey — turns 2FA on and mints the codes** in one transaction.
    Removing the last method needs `confirm_turn_off` and IS `disableMfa`: refused while an
    organization requires 2FA, signs out other browsers, forgets trusted browsers, deletes every
    passkey. Removing one of several is `two_factor_method_removed`.
  - **Challenges live in `webauthn_challenges`**, not `auth_tokens` (a discoverable sign-in has no
    user yet). Single-use, 5 minutes, spent BEFORE verification so a failed response cannot be
    retried. Swept by `security_sweep`.
  - **Counter**: verified against 0, then judged after the signature, so only a signed assertion
    can record a regression (`passkey_counter_regression`, never emailed). Synced passkeys (0/0)
    pass; the challenge is their replay guard.
  - **A passkey sign-in is both factors**: `auth_method = 'passkey'`, `mfa_at` set, still through
    `completeSignIn`, refused while locked. As the second step a failure counts like a wrong code.
  - **Relying party = the dashboard origin**: `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` default from
    `DASHBOARD_BASE_URL`. Changing the RP ID orphans every passkey.
  - Gated by `pnpm verify:auth-identity` § L (42 checks, driven by a software authenticator).
- **2026-10-08 (0331)** — **The Google photo is the fallback avatar.** `users.google_picture_url` is
  refreshed on every Google sign-in (code flow and One Tap) and cleared when Google sends none.
  - `effectiveAvatar`: the uploaded `avatar_url`, else the Google photo, else initials. `/auth/me`
    returns the effective `avatar_url` plus `avatar_source` (`upload` | `google` | null); the Team
    list returns the effective URL.
  - `safePicture` accepts `https:` only, because the value is rendered as an `<img src>`.
  - The account card offers no Remove for a Google photo; removing an upload falls back to it.
  - `AvatarImage` defaults to `referrerPolicy="no-referrer"`; Radix shows initials if it fails.
  - Gated by `pnpm verify:auth-identity` § E (6 new checks).
- **2026-10-08 — upload limits and deleting a replaced photo.** Profile photos: 10 uploads per
  person per hour (`RATE_LIMIT_AVATAR_UPLOADS_PER_USER`). Brand images: 30 per person and 60 per
  organization per hour (`RATE_LIMIT_BRAND_UPLOADS_PER_USER` / `_PER_ORG`; an API key counts only
  against the organization). New `user` / `organization` limiter kinds; fail-open, upload-specific
  429 message. The dashboard upload proxies refuse on `Content-Length` before `formData()` buffers
  the body (cap + 64 KB multipart margin; missing length refused). A replaced or removed profile
  photo is deleted from R2 after the swap commits (`setUploadedAvatar` returns the previous one
  under a row lock); `storedKeyFor` only maps a URL on our CDN base, under our prefix, in that
  owner's own folder, so a Google photo is never touched. **Brand images are still never deleted**:
  queued and delivered emails embed the logo URL, so a delete would break an image in someone's
  inbox. Gated by `verify:auth-identity` § M and `test/unit/{object-store,upload-limit}.test.ts`.
- **2026-10-20 (0354)** — **Self-serve sandbox sign-up** (`signup.ts`). A password sign-up is held as an
  `auth_tokens` row with `purpose='signup'` and no user (the only purpose allowed a null `user_id`); the
  org, owner and session are created when the emailed link is spent, so no unverified account exists and
  nobody can hold an address they do not control. The route answers the same 202 for a known address and
  mails "sign in instead" (M9 stays closed). Google sign-up: `loginWithGoogle` throws
  `GoogleSignupRequired` for an unknown verified address while SIGNUP_ENABLED, the API returns
  `{object:"google_signup", ticket}`, and the dashboard carries the HMAC-signed ticket to `/signup`.
  The form takes country, billing volume and gateway (`organizations.country` / `signup_answers`).
  Gate: `pnpm verify:sandbox-signup` (37 checks, mutation-checked against the lock).
- **2026-10-22** — Sign-up is Cloud only: `POST /auth/signup`, `/auth/signup/confirm`, `GET /auth/signup`
  and the Google route to sign-up ask `signupOffered()` (`TMBILLING_EDITION=cloud` AND SIGNUP_ENABLED);
  the sandbox lock asks `signupSandbox()`. A closed sign-up now also refuses a confirmation link
  (403) instead of spending it. Gate: `pnpm verify:edition`.
- **2026-10-25** — `createOwnerAccount(tx, …)`: an organization, its dashboard credential, its
  owner and the membership in the caller's transaction. `signup` now writes all four in one
  transaction (they were three separate statements); the self-host bootstrap
  (`platform/selfhost/bootstrap-org.ts`) reuses it. Same rows as before.
- **2026-10-25** — `setOrganizationRequireMfa` writes `organization.two_factor.enable` / `.disable` audit rows (before/after `require_two_factor`, `grace_days`, `required_since`; actor = the admin's email). A no-op save writes nothing.
- **2026-10-25 (0389–0391)** — **Custom roles and the permission catalogue.** `permissions.ts` is the
  catalogue (73 `resource:action` keys, each with the `legacy` level that held it); a fixed role holds
  exactly `{K : legacyAllows(role, K.legacy)}`, so no fixed role gained or lost a route.
  `roles.ts` = custom role CRUD (soft delete, `version`, NFKC name check, reserved names, unknown
  keys refused, "grant only what you hold", no edit of your own role). Memberships may hold
  `role='custom'` + `custom_role_id`; `resolveSession` reads the role in the same query.
  `changeMemberRole` / `removeMember` run in one transaction under
  `pg_advisory_xact_lock(hashtext('members:'||org))` and refuse leaving no owner or no
  owner/admin (fixes a concurrent-demotion race and a last-owner removal). `can()` is gone:
  use `permissionsOf(user)`. New `role_changed` security event (with a notice email).
- **2026-11-01** — Permissions `model_prices:view` (any) and `model_prices:manage` (manager) for the model price list and your cost (Tier 3 PR 1b).
- **2026-11-02** — Access requests while sign-up is locked (0405, `signup-requests.ts`). On Cloud with `SIGNUP_ENABLED` off, `GET /auth/signup` reports `requests: true` and `POST /auth/signup_requests` stores a request (one open per address, a repeat updates it; rate-limited, Turnstile), emails `SIGNUP_REQUEST_NOTIFY_TO` and posts to the Google Chat webhook `LEAD_CHAT_WEBHOOK_URL` (neither can fail the request). Staff answer from the back-office: `sendSignupInvite` mints an `auth_tokens` `signup_invite` (`sgni_…`, 7 days, single-use) and emails `/signup/invite/s/<token>`; `GET/POST /auth/signup/invite` reads it and creates the account for that address only, with no confirmation email (the link proves the address). A taken address does not spend the link. `verify:signup-requests`.
- **2026-11-02** — An unchanged repeat access request updates nothing and tells nobody (`setWhere` on the upsert), so a double submit is one request and one lead. `POST /auth/signup_requests` and `POST /auth/signup/invite` join the pre-tenant idempotency exemptions.
- **2026-11-02 (0482)** — **Organization session policy.** `organizations.session_idle_minutes`,
  `session_absolute_ttl_hours` and `mfa_required_roles` override `SESSION_IDLE_MINUTES`,
  `SESSION_ABSOLUTE_TTL_HOURS` and `MFA_REQUIRED_ROLES`, stricter only (`session-policy.ts`: the
  shorter window, the union of roles; a looser value is refused, 400). `createSession`,
  `resolveSession` and `listSessions` read the org's windows; a deadline further off than a
  shortened window is pulled in on the next request, so a session stamped before the change can
  live at most the old window. `roleRequiresMfa(role, org)` feeds the API gate, `/auth/me` and the
  team list; a role list with the caller's own role needs the caller's 2FA (409). Routes: GET
  `/auth/organization/security` (+ policy, `deployment`, `caller_role`), POST
  `/auth/organization/security/session_policy` (audit `organization.session_policy.update`).
  Gate: `verify:settings-invoices-org` E.
- **2026-11-02 (0482)** — `sessions.last_active_at`, written with every idle refresh. Idleness is
  measured from it, so a session idle longer than a window the org shortened later is deleted on
  its next request instead of being refreshed. A row without it is measured from `expires_at`
  minus the deployment window, which is the window it was stamped with.
- **2026-11-03 (security)** — `subscriptions:lifecycle` and `invoices:collect` move from `any` to `ops`: the fixed `developer` role can no longer cancel, pause, resume or edit subscription terms, or collect/retry an invoice. Snapshot updated; `verify:permission-coverage`.
- **2026-11-04 (security, audit P2-PASSKEY)** — Step-up is enforced again on 2FA and passkey management only: enrol, disable, recovery codes, passkey add/remove and authenticator-app removal answer 403 `step_up_required` unless the session stepped up within `STEP_UP_WINDOW_MINUTES` (15). An interactive sign-in stamps `sessions.step_up_at` (a trusted-browser skip does not; an organization switch carries the stamp). `verify:auth-identity` § M.
- **2026-11-04 (0498, security)** — **An invite to an existing account waits for consent.** `inviteUser`
  inserts a PENDING membership (`memberships.accepted_at` NULL) when the address already holds a
  password or Google link; every other insert, and every row before 0498, is accepted. A pending
  row grants nothing: `resolveSession`, `switchOrganization`, `resolveLoginOrganization`,
  `listMemberships`, Google sign-in, the last-owner/admin counts, the org 2FA lists and reminders,
  test-mode recipients and price notices all read accepted rows only. Until acceptance the
  inviting org sees the email, the role, `invited`, the name the inviter typed
  (`invite_name`) and a fresh `usr_…` (`invite_id`), never the account's id, name, avatar, last
  sign-in or 2FA; audit rows use the same invite id. No token is minted: the person accepts or
  declines with their own session (`GET /auth/invitations`, `POST
  /auth/invitations/:organization/accept|decline`, `team.accept_invite` / `team.decline_invite`).
  `acceptInvite` sets a password only on an account with no credential, and spends the account's
  other invite links. 2FA grace runs from `accepted_at`. Brand-new invitees are unchanged.
- **2026-11-04 (security)** — **Owner is senior to admin.** Only an accepted owner may give the
  owner role, change an owner's role or remove an owner (`OwnerRequiredError`, 403
  `owner_required`) in `inviteUser` (with `actorUserId`), `changeMemberRole` and `removeMember`.
  No-self-edit and keep-one-owner rules unchanged. Cover: `verify:auth-identity` §A0, §F.
- **2026-11-05 (0500)** — **Product tour, offered once.** `users.product_tour_seen_at` (NULL = offer
  it; the migration stamps every existing user, so only new people see it), `productTourSeen()` /
  `markProductTourSeen()` (keeps the first time), `POST /auth/me/product_tour_seen`. `GET /auth/me`
  adds `product_tour_seen` and the first-run hints `organization_country` /
  `organization_signup_gateway` (from `accountStateOf`). Idempotency-exempt like
  `release_notes_seen`. `verify:auth-identity` § G2.
