---
title: Two-factor authentication and passkeys for you and your team
date: 2026-10-08
type: Security
tags: Accounts, Security, Team
summary: Protect each sign-in with an authenticator app or a passkey. Make it necessary for all your organization.
---

Enable two-factor authentication on [Your account](/account#two-factor). Then each sign-in asks for
a second proof. This applies when you sign in with a password and when you sign in with Google.

- **Passkeys.** Use your fingerprint, face or screen lock as the second step. You can also sign in
  with only a passkey. You do not type a password.
- **Authenticator apps.** Scan the QR code with an authenticator app. When you sign in, enter the
  6-digit code from the app. Each code operates one time only.
- **Recovery codes.** You get ten recovery codes. Each code operates one time only. Use a code if
  you lose your phone. You can download the codes and make a new set at any time.
- **Trusted browsers.** Select "Don't ask again on this browser" to skip the code for 30 days.
  When you change your password or disable two-factor authentication, the dashboard forgets all
  trusted browsers.

## Make two-factor authentication necessary for your organization

An admin can enable **Require two-factor authentication** in [Settings](/settings#security).

- **Grace period.** Each teammate has seven days to enable two-factor authentication. The dashboard
  and an email remind them before the deadline.
- **Status of each teammate.** The Team list shows who has two-factor authentication, who must
  enable it, and the deadline.
- **API keys.** When this setting is on, only teammates with two-factor authentication can make
  new API keys. Existing keys continue to operate.

## You get an email for each security change

- **Security emails.** We send you an email when someone enables or disables two-factor authentication.
  We also send an email when you add or remove a method, use or replace recovery codes, or change
  your password.
- **Warning about your password.** Someone can enter your password correctly and then fail the
  second step many times. When this occurs, we send you an email. Change your password immediately.
- **If you cannot sign in.** On the code step, select "Get help signing in". Support can reset
  two-factor authentication after three days. We send you an email with a link. If you did not
  ask for the reset, use the link to cancel it.
