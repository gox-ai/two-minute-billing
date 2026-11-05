# docs/ — canonical documentation set

**Fixed set — don't add new docs.** Put new content in the closest existing one (per CLAUDE.md).
Per-module docs live next to the code: `src/modules/<name>/README.md`.

## Read order for a new session (human or AI agent)

1. [`/CLAUDE.md`](../CLAUDE.md) — working rules + locked decisions.
2. [`PROGRESS.md`](./PROGRESS.md) — **single source of truth**: status, roadmap ("Next up"), changelog.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the system is built: ADRs, domain model, flows, module graph.
4. [`GUIDE.md`](./GUIDE.md) — how to build in it: conventions, golden path, hard rules, module map.

## The docs

| Doc | Job |
|---|---|
| [`PROGRESS.md`](./PROGRESS.md) | Status + roadmap + dated changelog. Update at the end of every session. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Architecture spec: locked decisions, tenancy/RLS, ledger, billing clock, adapter interface, domain model and vocabulary, billing-math conformance. |
| [`GUIDE.md`](./GUIDE.md) | Implementation manual: environment, hard rules, golden path for features, verify suite, platform helper APIs. |
| [`PARITY.md`](./PARITY.md) | Capability matrix: feature → status → gaps; migration-readiness snapshot. |
| [`MIGRATION.md`](./MIGRATION.md) | Migrating onto tmbilling: operator how-to first, program plan (gates M0–M6) after. |
| [`INDIA-LAUNCH.md`](./INDIA-LAUNCH.md) | The India/INR launch: GST + place of supply, the RBI e-mandate rails and their AFA rules, per-gateway webhook coverage audits (§4b RazorPay, §4c Stripe), phase plan and open questions. |
| [`RELEASE.md`](./RELEASE.md) | The 1.0 cut line — what ships and what does not. Deploy/operate is § A. |
| [`../deploy/README.md`](../deploy/README.md) | **Operator run book** — provisioning, pm2, nginx, probes, alerting, release + rollback. |
| [`architecture/`](./architecture/) | **Machine-readable module graph** (`architecture.json` — edit it, then `pnpm docs:generate`) + interactive HTML visualizations (regenerate with `python3 docs/architecture/visualize-architecture.py`). |
| [`../docs-site/`](../docs-site/) | **The PUBLIC documentation site** — written for customers and integrators, not for us. Static HTML, no framework; `pnpm docs-site:build`. Facts are generated from the engine, prose is hand-written in `content/webhook-notes.ts`, and a gate fails when a resource family has no explanation. |
| [`references/`](./references/) | **Third-party reference material, verbatim** — vendor documentation we check our behaviour against, not docs we write (e.g. `RAZORPAY REPORT.md`). Never edit them: an edited copy stops being evidence. Cite them by path + section, and remember they are the vendor's *claims* — a probe against the vendor's API is stronger evidence. |
| [`archive/`](./archive/) | Superseded docs (BLUEPRINT, CATALOG-DESIGN, early-phase trackers) **plus PROGRESS.md's rolled-off history**: `PROGRESS-done-2026-08.md` (completed "Next up" items) and `CHANGELOG-*.md`. History only — never update. |

## Where things live (cheat sheet)

- **What's next / what happened** → PROGRESS.md
- **Why it's built this way** → ARCHITECTURE.md
- **How to build X** → GUIDE.md + the nearest module's `src/modules/<name>/README.md`
- **Do we have capability X** → PARITY.md
- **Workflows for agents** → `.claude/skills/` (ui, fix-bug, add-feature, verify, db-ops)
