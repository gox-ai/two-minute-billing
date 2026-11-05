/** What a one-time link mint hands the reveal dialog: shown once, never stored or put in a URL. */
export type SecretLinkResult =
  | { ok: true; label: string; secret: string }
  | { ok: false; error: string };
