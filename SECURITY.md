# Security policy

Two Minute Billing handles money and customer data, so we take reports seriously and are grateful
for them.

## Reporting a vulnerability

Email **security@gox.ai**. Please do not open a public issue, pull request or discussion for a
security problem.

Include what you can of:

- what the issue is and what an attacker could do with it
- the steps or a proof of concept to reproduce it
- the version or commit you tested, and whether it was self-hosted or the hosted service
- how you would like to be credited, if at all

We will acknowledge your report, keep you updated while we fix it, and agree a disclosure date with
you. Please give us a reasonable chance to release a fix before disclosing it publicly.

## Scope

In scope: this repository's engine, dashboard, hosted checkout and customer portal, API and SDK.

Out of scope: vulnerabilities in third-party services we integrate with (report those to the
provider), denial of service through sheer volume, and findings that need an already-compromised
account or machine.

When testing, use your own self-hosted instance or a test business. Never access, change or delete
data that is not yours.

## Supported versions

Security fixes go into the latest release. Upgrade to it to receive them.
