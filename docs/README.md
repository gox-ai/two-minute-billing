# docs/ — canonical documentation set

Per-module docs live next to the code: `src/modules/<name>/README.md`.


## The docs

| Doc | Job |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Architecture spec: locked decisions, tenancy/RLS, ledger, billing clock, adapter interface, domain model and vocabulary, billing-math conformance. |
| [`GUIDE.md`](./GUIDE.md) | Implementation manual: environment, hard rules, golden path for features, verify suite, platform helper APIs. |
| [`../deploy/README.md`](../deploy/README.md) | **Operator run book** — provisioning, pm2, nginx, probes, alerting, release + rollback. |
| [`architecture/`](./architecture/) | **Machine-readable module graph** (`architecture.json`) + interactive HTML visualizations (regenerate the module graph with `python3 docs/architecture/visualize-architecture.py`). |
| [`../docs-site/`](../docs-site/) | **The public documentation site** — written for customers and integrators. A Nuxt (Docus) app; run it with `pnpm --filter tmbilling-docs dev`. The API and webhook references are generated from the engine. |


## Where things live (cheat sheet)

- **Why it's built this way** → ARCHITECTURE.md
- **How to build X** → GUIDE.md + the nearest module's `src/modules/<name>/README.md`
