# assistant-docs — the docs index the assistant and MCP tools search

> Source: `src/modules/assistant-docs/` · Routes: none (used by `search_docs`, `get_api_reference`) · Schema: `db/schema/assistant-docs.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
The assistant's references, in one Postgres full-text index: help pages, API reference pages,
module READMEs, the dashboard map (each screen in sections by card, `ui`) and the
published source (one section per top-level function or component, `code`). API operations come
exactly from the OpenAPI document. With the platform OpenAI key, every search is **hybrid**:
keyword and meaning (contextual embeddings) side by side, merged by rank. The help is one source
of three: it does not describe every setting, the screens and the code do.

## Responsibilities
- `chunk.ts` (pure): frontmatter, MDC syntax out, split at `##`/`###`, long sections at
  paragraphs, page URL + heading anchor as the docs site builds them.
- `index-docs.ts`: collect `docs-site/content/help/**` (help + API reference) and
  `src/modules/*/README.md` (without the changelog); rebuild when the content hash changes,
  in one transaction under an advisory lock. Runs in the background after the API starts.
- `search.ts`: OR over the question's words (keyword-only: plus the synonym list, to find pages), ranked by cover density
  with length normalization, +0.2 for a section holding every word; one result per page;
  help 1.0, API reference 0.45, engine 0.4. Code, engine notes and screens rank by the share of
  the question's words a section covers plus the symbol name (code) or the single best control
  label (a screen), from a wider first cut (500); a capitalised registry constant counts half.
  `apiOperation` / `findApiOperations` read the OpenAPI document with `$ref`s resolved.

- `section-notes.json`: per help section and per screen section (`screen:<route>`), one sentence
  placing it and the phrases people use when it is their answer: where is, take me to, how do I,
  a problem, keywords (contextual retrieval). Indexed in `notes` (weight D) and embedded with the
  section. Maintained with `scripts/docs-section-notes.ts` (coverage, `--todo`, `--merge`,
  `--write` with the platform model, printing its calls and tokens; a failed call stops the run
  and still merges what earlier calls drafted); a stale or missing note only loses the boost.
- `vectors.ts`: embeds every section, help and screens with their notes (`text-embedding-3-small`,
  the platform key only, never an organization's key), stored once per distinct text in
  `assistant_doc_vectors`, held in memory and reloaded when the index changes: ~4,300 sections ×
  1,536 floats (~27 MB) and ~17,400 code sections × 256 (the model's shortened vectors, ~18 MB;
  512 measured no better). The query is embedded once and cut to 256 for code. The embedding
  settings are part of the index hash, so a new model or length re-embeds.
  Every embedding call is recorded in `assistant_embedding_usage` (`recordEmbeddingUsage`, fire
  and forget, never throws): one row per index run (no organization) and one per search query
  (the asking organization when the caller passes `organizationId`, else none), with tokens and
  the list-price cost (`embed-cost.ts`). Never part of an organization's allowance.
  `searchDocs` merges keyword and nearest sections by reciprocal rank (k = 60): pages by rank in
  each list, the section within a page by combined rank; a page found only by meaning needs
  cosine ≥ 0.3, and the nearest sections are ordered at their source's weight (`meaningScore`). Keyword-only when the key is unset, `ASSISTANT_DOCS_VECTORS=off`, `vectors: false` or the embedding call fails
  (2.5 s timeout). MCP calls are hybrid too since OpenAI is on the sub-processor list.
- `map.ts`: a one-line-per-page map of the help (title + first sentence of its description) for
  the assistant's instructions, so it searches in the help's own words.
- `code.ts` (pure): source → sections at declarations and route registrations; `terms` holds
  split identifiers and string literals. Indexed: `src/`, `dashboard/{app,components,lib}`,
  `db/schema` — never tests, generated files, the OpenAPI file or the import module.
- The dashboard map: `scripts/generate-dashboard-map.ts` (Babel AST; TypeScript 7 has no JS
  API) → `dashboard-map.generated.json`, gated by `verify:dashboard-map`. Reads label props on any
  element, option and data arrays (`label`/`title`/`heading` keys), row builders
  (`configRow("Excess payments", …)`) and components two imports deep; drops labels on more
  than one screen in six (shared chrome). Every label has a kind: control, option, heading, crumb
  or title. Breadcrumbs (`Crumb[]` props) and the page title are dropped; card and section titles
  go to `headings`, never controls. An element names a catalogue with
  `data-map-options="<source>"` (closed list `OPTION_SOURCES`: gateways, integrations, email
  types, release-note types), and its labels go to `options`. `verify:dashboard-map` also runs
  `scripts/dashboard-map-audit.ts`: no control that is chrome or a heading only, code-like, or
  absent from the files the screen renders and the catalogue it declares.

## Data model
`assistant_doc_chunks` (generated `search` tsvector: title A, heading and terms B, body C, notes
D; GIN index; `embed_hash`), `assistant_doc_index` (one row: content hash, which covers the notes
file) and `assistant_doc_vectors` (hash of model + embedded text → float32 vector). Platform
tables: system connection only. `assistant_embedding_usage` (0511): kind index | query,
organization (nullable), inputs, input tokens, `cost_fixed12`; RLS on, system connection only.

## Invariants & gotchas
- A directory missing on disk (a slim image) is skipped, not an error; the index then holds
  what exists.
- Excerpts come from `ts_headline` with its `<b>` tags stripped.
- Search quality is gated: `verify:assistant-docs` § B (40 questions, page in the top 3), § D
  (sections), § E: 186 questions in users' own words (`scripts/fixtures/assistant-docs-golden.json`,
  146 written without seeing the notes, tagged by billing model) and § F: 62 product questions
  whose answer is a control (`assistant-capability-golden.json`: subscription, one-time, usage,
  AI and general; every form people ask in; tune on the "own" third only), with floors per mode
  that only go up. Change the
  weights, notes or fusion only with that gate green, in both modes. The verify runner keeps docs
  search keyword-only (`ASSISTANT_DOCS_VECTORS=off`); `VERIFY_DOCS_HYBRID=1` runs it hybrid
  (re-embeds on a fresh database, about $0.14).
- Keyword-only search ignores the notes (`ts_filter` drops weight D) and ranks exactly as before
  they existed; the note-phrase bonus applies only in hybrid search.

## Changelog
- **2026-11-15 (docs/screen-notes-model-redraft)** — The screen notes are model-drafted again (300 of
  301; one by hand): the hand-written ones from fix/show-me-targets were accurate but too short,
  and § F screen fell to 35% under its 36% keyword floor (now 37%). `docs-section-notes.ts
  --write` prints its calls and tokens, and a failed call stops the run but merges what earlier
  calls drafted.
- **2026-11-15 (fix/docs-search-guides-first)** — A page's priors apply in both lists. Hybrid
  search weighed sources in the keyword list only (`SOURCE_WEIGHT`: help 1, API 0.45, else 0.4),
  so the meaning list, crowded with near-identical operation pages, put the API reference first
  for plain how-to questions. The meaning list now orders by `meaningScore`: the source weight
  scales the cosine above the 0.3 floor of "unrelated" (one source alone keeps its order, so
  screens and code are unchanged). For an operator, developer concept pages now yield to guides
  like the rest of the developer section (×0.8). Data: the go-live checklist section was one line
  with its content in sub-steps; it now names them. Hybrid: § B 39 → 40/40, § D first 14 → 16/16,
  own words first 50 → 51%, MRR 0.581 → 0.594. Ruled out: the audience weight on the meaning list
  (§ E first 50 → 49%, held out 81 → 77), the full prior multiplying the cosine (broke two pages),
  and parent headings as keyword terms (held-out first 81 → 78).
- **2026-11-15 (test/assistant-docs-keyword-default)** — `ASSISTANT_DOCS_VECTORS=off` keeps docs
  search keyword-only even with an OpenAI key (unset = on, as before). The verify runner sets it for
  every suite unless `VERIFY_DOCS_HYBRID=1`: on a fresh database the index re-embeds every docs and
  code section, about $0.14 a run. `verify:assistant-live` keeps the embeddings.
- **2026-11-15 (fix/show-me-targets)** — The dashboard map reads what each label is: page
  chrome (a `Crumb[]` prop and the frame's title) is dropped, headings move to `headings`, and
  `data-map-options="<source>"` lists a catalogue's labels as `options` (gateways, integrations,
  email types, release-note types). `verify:dashboard-map` audits every screen
  (`dashboard-map-audit.ts`): no chrome, heading-only, code or unrendered control. 276 screen
  notes rewritten by hand.
- **2026-11-12 (fix/billy-quality)** — The synonym list (people's words → the help's terms)
  widens the OR query in keyword-only mode only, and never feeds ranking: as a ranking input it
  cost own-words accuracy (§ E first 18% → 24% without it in ranking), and with embeddings the
  meaning search covers it. Ranking takes
  `audience` (operator: guides first; developer: the API first; unset: no preference) instead of
  reading developer words in the query.
- **2026-11-11 (perf/billy-fast)** — Repeated searches are free. `searchDocs` keeps up to 500
  results in memory, keyed by the index version (the vectors' hash when hybrid, else the
  content hash, read at most once a minute), the question, sources, limit and paths; a rebuild in
  the same process clears it (`clearSearchCache`). Query embeddings are kept by text (500): one
  embeddings call per distinct question, however many sources search it. A cached search records
  no embedding use (nothing was spent). `warmDocVectors` loads the vectors after the API's start
  build, so the first question does not wait ~seconds for them.
- **2026-11-10 (fix/show-me-gaps)** — The map reads templated action labels (`Create ${lower}`)
  from the props each page passes, the file's constants and literal union types, and keeps only
  the ternary branch a screen renders. Unreadable templates print `warning: file:line` (3, all
  data). Gate: unit `dashboard-map-actions`, `verify:dashboard-map`.
- **2026-11-10 (fix/show-me-target)** — The dashboard map reads form action bars
  (`ACTION_FRAMES`: submit label at the call site with each ternary branch, the slot button, the
  save default, the frame's Cancel) into an "Action bar" group, exempt from the common-label
  filter; `FormCard` is a card. Gate: unit `dashboard-map-actions`, `verify:dashboard-map`.
- **2026-11-09 (feat/ai-spend-embeddings)** — Embedding use is recorded (0511
  `assistant_embedding_usage`): one row per `ensureDocVectors` run and one per query embedding,
  with `usage.tokens` and the cost at the price list's `text-embedding-3-small` price ($0.02 per
  1M). `searchDocs` takes `organizationId`; the assistant and MCP tools pass it. Fire and forget:
  a failed record is logged (`assistant_embedding_usage_failed`), never fails a search or a run.
- **2026-11-09 (feat/billy-show-me)** — The dashboard map groups each screen's controls by the
  card they render in (a component's labels count where the page renders it), and screens index
  one section per card (small cards share one, a big one splits at 40). `screens.ts` reads the map
  at runtime (`screenForPath`: the screen a dashboard path shows). `searchDocs` takes `paths`.
- **2026-11-09 (feat/billy-code-first)** — Screens and code are first-class sources, not a
  fallback for the help. The dashboard map reads options, row labels and nested components
  (1,465 → 5,680 labels); screens split into sections of 30 controls with written search notes;
  every section is embedded (code at 256 floats); code, engine notes and screens rank by coverage.
  § F: 62 product questions in mixed forms (where, take me to, how do I, a problem, keywords)
  across subscription, one-time, usage and AI billing. Screen in the top 3: 31% → 56% (held out
  24% → 54%); the control in code top 5: 6% → 16–18%. § E grew to 186 (26 one-time, usage and AI
  questions); its scores held. `searchDocs` defaults to help + API; code needs cosine ≥ 0.45.
- **2026-11-09 (later)** — MCP searches use hybrid search (OpenAI listed at `/sub-processors`).
  `scripts/docs-section-notes.ts --write` drafts notes for new or changed sections with the
  platform model and merges them (tested on 3 sections: one call, under a cent).
- **2026-11-09** — Hybrid search (feat/docs-retrieval, 0509 + 0510). Research: contextual
  retrieval, keyword + embeddings merged by rank. 927 help sections got search notes; a 160-question
  own-words test set joined the suite. Own words, keyword-only → hybrid: right section first
  19% → 42%, section top 3 28% → 64%, page top 3 52% → 83%, MRR@5 0.242 → 0.525 (held out:
  24 → 51 first, 62 → 101 page top 3 of 120). Doc-worded checks unchanged (21/21). Measured
  alternatives: notes as keywords only plateaued at ~29% first; a local embedding model tied
  OpenAI's (paired McNemar p ≥ 0.45) but is English-only. Full embed: 35 s, $0.016.
- **2026-11-08** — Found in a real-client MCP test against production. API reference pages
  indexed their first section as the slot marker `#docs` (186 empty sections): the opening section
  is now the operation (method, path, summary, request fields), slot markers are stripped and
  sample responses dropped. `rescore` picks the section: a heading (or a page's title) naming the
  question's own words wins, generic words and synonyms count less, developer pages and the
  webhook event list yield to guides unless the question is about the API, index pages and page
  openings give way. `INDEX_VERSION` is in the content hash, so chunker changes rebuild the index.
  Three guide headings now use the words people search for. Section probe: right section first
  26/28 (was 9/28), top 3 28/28 (was 13/28). Gate: `verify:assistant-docs` 18/18 (§ D sections).
- **2026-11-07** — 0506: `ui` and `code` sources and a `terms` column in the search vector.
  21,458 sections (165 screens, 17,228 code). NUL bytes stripped (two source files hold them).
  Gate: `verify:assistant-docs` 14/14 incl. where-do-I questions 8/8.
- **2026-11-06** — Created (0504, feat/mcp-server). 4,053 sections from 670 files. 40/40.
