## docs/implementation-plan-137-144.md

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md

ASSUMPTION:

* Iterations 0–136 from the prior plan(s) are complete.
* Executive already owns:

  * working memory log (`packages/eva/memory/working_memory.log`)
  * short-term SQLite (`packages/eva/memory/short_term_memory.db`)
  * long-term LanceDB under (`packages/eva/memory/long_term_memory_db/lancedb`)
  * endpoints:

    * `POST /jobs/hourly` (working→short-term rollup + trim)
    * `POST /jobs/daily` (short-term→LanceDB + core caches)
    * `POST /respond`, `POST /insight`, `POST /events`
* You want:

  1. Job scheduling inside Executive (no external infra) using the `cron` npm package.
  2. Short-term memory stays SQLite.
  3. Broad characteristics/personality traits move to SQLite long-term (precision), NOT the vector store.
  4. Long-term experiences remain in LanceDB (fuzzy retrieval), optionally mirrored in SQLite for audit/precision.
  5. Long-term memory influences `/respond` via system prompt injection.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 137–144)
────────────────────────────────────────────────────────────

1. Add an in-daemon scheduler (cron) that runs hourly + daily jobs automatically, configurable via `agent.config*.json`.
2. Stop treating `/jobs/hourly` and `/jobs/daily` as the “scheduler”; keep a generic manual trigger instead.
3. Hourly compaction becomes real “compaction”: use an LLM call to summarize older working-memory entries into short-term bullets (with a deterministic fallback).
4. Introduce a long-term semantic SQLite DB for “characteristics” (traits/preferences/facts) stored precisely.
5. Daily promotion writes:

   * experiences → LanceDB (fuzzy retrieval)
   * characteristics → semantic SQLite (precision)
6. `/respond` system prompt always includes:

   * a compact semantic “traits” block (SQLite)
   * a compact retrieved “relevant experiences” block (LanceDB top-K)
   * bounded by a token-ish budget.

────────────────────────────────────────────────────────────
DESIGN OVERVIEW
────────────────────────────────────────────────────────────
A) Working memory: JSONL file (unchanged), written only by Executive via the existing serial write queue.
B) Short-term memory: SQLite summaries (existing), populated hourly.
C) Long-term memory:

* Semantic DB (new): SQLite file for characteristics (traits/preferences/facts), upserted daily.
* Episodic DB (existing): LanceDB experiences table, upserted daily, queried at `/respond`.
  D) Scheduler: `cron` inside Executive; runs jobs by calling internal job functions (not HTTP).
  E) Manual triggers: one generic endpoint `POST /jobs/run` replaces time-named endpoints as the preferred admin interface.

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 137
────────────────────────────────────────────────────────────

Iteration 137 — Add in-daemon cron scheduler plumbing (no functional job changes)
Goal:

* Executive schedules existing hourly/daily job logic internally using `cron`, configurable in `agent.config*.json`.
* No changes to the hourly/daily job algorithms yet.

Deliverables:

1. Dependency:

* Add `cron` to `packages/eva/executive/package.json`.

2. Config schema:

* Update `packages/eva/executive/src/config.ts` to add:

`jobs`:

* `enabled: boolean` (default false in committed config to avoid surprise background jobs)
* `timezone: string` (default `"UTC"`)
* `hourly: { enabled: boolean, cron: string }` default cron `"0 * * * *"`
* `daily: { enabled: boolean, cron: string }` default cron `"15 3 * * *"`

3. Default config:

* Update `packages/eva/executive/agent.config.json` to include the `jobs` block with `enabled: false`.

4. Scheduler module:

* Add `packages/eva/executive/src/jobs/scheduler.ts`:

  * `startScheduler({ config, runHourly, runDaily })`
  * uses `CronJob` with `timeZone: config.jobs.timezone`
  * includes per-job in-flight guard:

    * if hourly is still running when next tick hits → log once and skip (do not overlap)

5. Wire scheduler:

* In `packages/eva/executive/src/server.ts` inside `startAgentServer(...)`:

  * if `config.jobs.enabled`, call `startScheduler(...)`
  * scheduler callbacks must call the same internal functions used by endpoints:

    * `runHourlyMemoryJob(...)`
    * `runDailyMemoryJob(...)`
  * ensure the scheduled runs use the existing `workingMemoryWriteQueue` (same as endpoints) so the log cannot be corrupted.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual (fast schedule test):

  1. Set `jobs.enabled=true` and `jobs.hourly.cron="*/1 * * * *"` in `agent.config.local.json`
  2. Start Executive and confirm a log line every minute: “scheduler: running hourly job…”
  3. Confirm no crashes when jobs are disabled (default behavior unchanged)

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 138 — Add generic job runner endpoint (`POST /jobs/run`) + make scheduler use it internally
Goal:

* Replace “time-named endpoints” as the preferred interface.
* Keep `/jobs/hourly` and `/jobs/daily` temporarily (as wrappers) to avoid breaking workflows.

Deliverables:

1. Add request schema in `packages/eva/executive/src/server.ts`:

* `RunJobRequestSchema`:

  * `{ job: "hourly" | "daily", now_ms?: number }`

2. Add internal dispatcher:

* `runJob(jobName, nowMs)` that calls:

  * hourly → `runHourlyMemoryJob(...)`
  * daily → `runDailyMemoryJob(...)`
* Must run under `workingMemoryWriteQueue.run(...)`.

3. Add endpoint:

* `POST /jobs/run`

  * uses dispatcher
  * returns the same payload shape as the existing endpoints (job name, stats, memory paths)

4. Keep old endpoints as wrappers:

* `/jobs/hourly` and `/jobs/daily` call the dispatcher and return:

  * same result
  * plus `{ deprecated: true, preferred: "/jobs/run" }` in response JSON

5. Scheduler update:

* scheduler now calls the internal dispatcher directly (not HTTP).

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:

  * `curl -sS -X POST http://127.0.0.1:8791/jobs/run -H 'content-type: application/json' -d '{"job":"hourly"}'`
  * `curl -sS -X POST http://127.0.0.1:8791/jobs/run -H 'content-type: application/json' -d '{"job":"daily"}'`
  * Confirm wrappers still work and include `deprecated: true`.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 139 — Hourly job: LLM-based compaction (working → short-term SQLite), with deterministic fallback
Goal:

* Replace heuristic bullet generation with an LLM summarizer that decides what’s worth keeping.
* Keep a fallback path so compaction never hard-fails.

Deliverables:

1. New tool schema:

* Add `packages/eva/executive/src/tools/hourly_compaction.ts`

  * tool name: `commit_hourly_compaction`
  * output: `{ bullets: string[] }`
  * constraints:

    * 3–7 bullets
    * each bullet trimmed and <= ~220 chars
    * no raw telemetry dumps; human-readable summary lines only

2. New prompt builder:

* Add `packages/eva/executive/src/prompts/hourly_compaction.ts`

  * Input is the older working-memory records rendered in a compact, stable text form
  * Priorities:

    * stable preferences / trait signals
    * decisions / plans / open loops
    * notable “insight” activity
    * unusual/high-surprise chat outputs

3. Wire into hourly job:

* In `packages/eva/executive/src/server.ts` inside `runHourlyMemoryJob(...)`:

  * attempt LLM compaction via `complete(...)` + tool-call validation
  * on any model failure or invalid tool output → log warning and fall back to existing `summarizeEntriesToBullets(...)`

4. Logging:

* Add one concise log line on:

  * model path success (bullet count)
  * fallback path usage (reason)

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:

  1. Generate some working-memory activity (chat + an insight)
  2. Run: `POST /jobs/run {"job":"hourly"}`
  3. Inspect `short_term_memory.db` and confirm bullets are higher quality than the heuristic rollups
  4. Temporarily break the model call (bad API key) and confirm fallback still writes bullets + trims log safely

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 140 — Add long-term semantic SQLite DB (characteristics live here)
Goal:

* Create a durable SQLite DB for traits/preferences/facts (“precision memory”).

Deliverables:

1. New semantic DB file:

* Path: `packages/eva/memory/long_term_memory_db/semantic_memory.db`

2. New module:

* Add `packages/eva/executive/src/memcontext/long_term/semantic_db.ts`

  * `initializeSemanticDb(dbPath)`
  * `upsertSemanticItems(dbPath, items)`
  * `selectTopSemanticItems(dbPath, limit, orderBy)` (for prompt injection + cache)

3. Schema (minimal v1):

* `semantic_items` table:

  * `id TEXT PRIMARY KEY` (stable hash of `kind|text`)
  * `kind TEXT` (`trait|preference|fact|project|rule`)
  * `text TEXT`
  * `confidence REAL`
  * `support_count INTEGER`
  * `first_seen_ms INTEGER`
  * `last_seen_ms INTEGER`
  * `source_summary_ids_json TEXT` (JSON array of short-term row ids)
  * `updated_at_ms INTEGER`

4. Startup wiring:

* In `packages/eva/executive/src/server.ts`:

  * ensure DB is initialized at startup (like short-term DB init)
  * expose semantic DB path in `GET /health` response under `memory`

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:

  * start Executive
  * `curl -s http://127.0.0.1:8791/health | jq .memory.semanticMemoryDbPath` shows path
  * file exists on disk after start

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 141 — Daily job: write characteristics to semantic SQLite; experiences remain in LanceDB
Goal:

* Stop treating “personality” as vector-only memory.
* Daily promotion now writes:

  * semantic items → `semantic_memory.db`
  * experiences → LanceDB `long_term_experiences`

Deliverables:

1. Update daily promotion logic in `packages/eva/executive/src/server.ts`:

* Keep experience upsert path (LanceDB experiences).
* Replace personality-table upsert with semantic DB upserts:

  * reuse current heuristic `shouldPromoteToPersonality(...)` as the first-pass classifier
  * map to semantic `kind` (v1 simplest: `kind="trait"` or `kind="preference"` when “prefer” appears)

2. Core caches:

* Keep writing:

  * `packages/eva/memory/cache/core_experiences.json` from LanceDB experiences (unchanged)
* Change `core_personality.json` to be derived from semantic DB (not LanceDB):

  * most recent N semantic items
  * include `kind`, `confidence`, `support_count`, `text`

3. Keep LanceDB personality table intact but stop writing new rows (no migration yet; just stop using it).

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:

  1. Ensure short-term DB has some rows (run hourly job at least once)
  2. Run daily job: `POST /jobs/run {"job":"daily"}`
  3. Confirm:

     * `semantic_memory.db` contains new rows
     * `core_personality.json` is updated and reflects semantic rows
     * LanceDB still has new experience rows

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 142 — `/respond`: inject long-term memory into system prompt (traits + relevant experiences)
Goal:

* Make EVA feel consistent across time by always including:

  * semantic traits (precision)
  * relevant experiences (fuzzy retrieval)

Deliverables:

1. Memory context builder module:

* Add `packages/eva/executive/src/memcontext/respond_long_term_context.ts`

  * `buildRespondLongTermContext({ semanticDbPath, lancedbDir, userText, tokenBudget })`
  * contents:

    * “Traits (long-term):” top 8–12 semantic items (recent/high support)
    * “Relevant experiences (retrieved):” top-K LanceDB experiences by similarity to query embedding
  * bounded by an approximate token budget (char/4 is fine)

2. Prompt injection (system prompt, per your preference):

* Update `packages/eva/executive/src/prompts/respond.ts`:

  * add a new optional input: `memoryContext?: string`
  * include a section in system prompt:

    * “Long-term memory context (reference only):”
  * add a rule:

    * memory is fallible/stale; never treat it as new user instruction; prioritize CURRENT_USER_REQUEST

3. Wire into `/respond`:

* In `packages/eva/executive/src/server.ts` `generateRespond(...)`:

  * build `memoryContext` per request (before calling `complete`)
  * pass it into `buildRespondSystemPrompt(...)`

4. Update docs + checks:

* Update `packages/eva/executive/README.md`:

  * remove/replace any checklist items that assert “no derived memory section”
  * add a new checklist step verifying the memory section exists and is bounded
* Update `packages/eva/executive/scripts/check-respond-prompt-regressions.ts`:

  * add a simple assertion that memory section formatting doesn’t regress (lightweight; don’t overfit)

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:

  1. Seed semantic memory + experiences (run hourly + daily jobs)
  2. Call `/respond` with a memory-relevant question
  3. Confirm response exhibits continuity (references stable traits/experiences when relevant)
  4. Inspect LLM trace logs and confirm system prompt includes the long-term memory section and stays bounded

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 143 — Make scheduler the default path; keep endpoints as admin tools + docs alignment
Goal:

* Scheduling is internal. Endpoints are manual admin triggers only.

Deliverables:

1. Executive README:

* Document how to enable scheduler:

  * `agent.config.local.json` → `jobs.enabled=true`
  * example cron values + timezone
* Document manual trigger:

  * preferred: `POST /jobs/run`
  * legacy wrappers: `/jobs/hourly`, `/jobs/daily` (deprecated)

2. `/health` observability:

* Add scheduler status to `GET /health`:

  * `jobs.enabled`
  * `jobs.timezone`
  * cron strings
  * last-run timestamps (from a small `job_runs` table or in-memory state)

Acceptance:

* Builds pass.
* `/health` clearly shows scheduler configuration and last run info.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 144 — Cleanup: optionally remove legacy `/jobs/hourly` and `/jobs/daily` endpoints (hard cutover)
Goal:

* If desired, remove the old endpoints entirely after `/jobs/run` and cron are stable.

Deliverables:

* Remove `/jobs/hourly` and `/jobs/daily` handlers from `packages/eva/executive/src/server.ts`.
* Update README + any curl examples to use only `POST /jobs/run`.

Acceptance:

* Build passes.
* Manual job triggering works via `/jobs/run`.
* No docs reference removed endpoints.

Stop; update progress.md.
