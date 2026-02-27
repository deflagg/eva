## docs/implementation-plan-145-160.md

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md

ASSUMPTION:

* Iterations 0–144 from prior plans are complete.
* Scheduler + manual trigger exist today:
  * `POST /jobs/run`
  * scheduler config + health observability
* Current code still contains schedule-coupled naming in several places (for example `hourly_compaction`, `hourly`, `daily`) even though schedules are configurable.

What you want now:

1. Remove schedule-coupled naming from code/config/API surface so behavior naming reflects purpose, not cadence.
2. Ensure changing cron cadence never implies file/module/identifier renames.
3. Keep behavior stable while migrating names in small, reviewable steps.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 145–156)
────────────────────────────────────────────────────────────3

1. Replace temporal job vocabulary (`hourly`, `daily`) with purpose vocabulary:
   * `compaction` (working-memory -> short-term)
   * `promotion` (short-term -> long-term + caches)
2. Replace schedule-coupled compaction module naming:
   * `hourly_compaction.*` -> `working_memory_compaction.*` (or equivalent purpose name)
3. Migrate config keys from schedule words to purpose words.
4. Migrate `/jobs/run` request values from schedule words to purpose words.
5. Remove legacy aliases after a compatibility window.
6. Add regression checks to prevent reintroduction of schedule-coupled naming.

────────────────────────────────────────────────────────────
DESIGN OVERVIEW
────────────────────────────────────────────────────────────

Canonical vocabulary going forward:

* **compaction job**: summarizes older working-memory entries into short-term SQLite and trims working log.
* **promotion job**: promotes short-term summaries into long-term stores/caches.

Cadence is configuration only (cron), not embedded in file/module/function names.

Canonical config shape target:

```json
"jobs": {
  "enabled": false,
  "timezone": "UTC",
  "compaction": { "enabled": true, "cron": "0 * * * *" },
  "promotion": { "enabled": true, "cron": "15 3 * * *" }
}
```

Canonical `/jobs/run` request target:

```json
{ "job": "compaction" | "promotion", "now_ms"?: number }
```

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 145
────────────────────────────────────────────────────────────

Iteration 145 — Introduce canonical internal job names (no external break yet)
Goal:

* Add canonical internal dispatcher vocabulary (`compaction`, `promotion`) while preserving existing external behavior.

Deliverables:

1. In `packages/eva/executive/src/server.ts`:
   * Introduce internal job-name type using canonical names.
   * Add mapping helpers between legacy and canonical names for transition use.
2. Ensure runtime state + scheduler callbacks can operate on canonical names internally.
3. Keep all external interfaces unchanged in this iteration.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual: run existing `/jobs/run` flows and confirm behavior unchanged.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 146 — Rename compaction prompt/tool modules to purpose-based names
Goal:

* Remove schedule-coupled module/file naming (`hourly_compaction`) from prompt/tool code.

Deliverables:

1. Add purpose-based files:
   * `packages/eva/executive/src/tools/working_memory_compaction.ts`
   * `packages/eva/executive/src/prompts/working_memory_compaction.ts`
2. Move current compaction schema/prompt logic into new files.
3. Update server imports to new file paths.
4. (Optional transition shim for one iteration) keep old files as thin re-exports to minimize risk.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual: `POST /jobs/run` compaction path still works and produces summaries.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 147 — Rename internal compaction/promotion function and type names
Goal:

* Remove schedule words from core function/type/log naming.

Deliverables:

1. In `packages/eva/executive/src/server.ts`:
   * Rename internals such as:
     * `runHourlyMemoryJob` -> `runCompactionJob`
     * `runDailyMemoryJob` -> `runPromotionJob`
     * corresponding result type names
2. Rename runtime state keys from `hourly`/`daily` to `compaction`/`promotion` internally.
3. Update log wording to canonical names.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual: run both jobs and confirm outputs unchanged except naming/log wording.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 148 — Config schema migration to `jobs.compaction` / `jobs.promotion`
Goal:

* Move config shape away from `jobs.hourly` / `jobs.daily`.

Deliverables:

1. Update `packages/eva/executive/src/config.ts`:
   * canonical keys:
     * `jobs.compaction`
     * `jobs.promotion`
2. Add temporary legacy-key compatibility loader:
   * accept old keys (`hourly`, `daily`) for one transition iteration
   * emit clear deprecation warnings when legacy keys are used.
3. Update committed config:
   * `packages/eva/executive/agent.config.json` uses canonical keys.
4. Update health payload + scheduler startup logs to show canonical config keys.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * start with canonical config -> success
  * start with legacy keys -> success + deprecation warning.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 149 — `/jobs/run` request migration to canonical job values
Goal:

* Make API caller vocabulary purpose-based.

Deliverables:

1. Update `RunJobRequestSchema` in `server.ts`:
   * canonical accepted values: `compaction | promotion`
2. Keep legacy request aliases (`hourly | daily`) temporarily in this iteration only:
   * map to canonical values
   * include deprecation hint in response, for example:
     * `{ deprecated_alias_used: "hourly", preferred_job: "compaction" }`
3. Ensure scheduler always calls canonical names.
4. Update docs/examples to canonical `/jobs/run` payloads.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * `POST /jobs/run {"job":"compaction"}` works
  * `POST /jobs/run {"job":"promotion"}` works
  * legacy alias still works with deprecation hint.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 150 — Hard cutover: remove legacy aliases (`hourly`/`daily`) from config + `/jobs/run`
Goal:

* Complete API/config cutover to purpose-based vocabulary.

Deliverables:

1. Remove legacy config alias support in `config.ts`.
2. Remove legacy `/jobs/run` alias handling in `server.ts`.
3. Legacy values should now fail fast with clear validation errors.
4. Update docs to reflect hard cutover.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * canonical values work
  * legacy values return validation error.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 151 — Cleanup sweep: remove legacy naming leftovers in source/docs
Goal:

* Remove remaining schedule-coupled identifiers where they imply purpose.

Deliverables:

1. Remove any temporary shim files left from Iteration 146.
2. Sweep/update remaining docs under active surfaces:
   * `packages/eva/executive/README.md`
   * relevant root/EVA docs sections
3. Keep historical references only in historical plan/progress docs as needed.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Repo grep on active source/docs shows no purpose-critical `hourly_compaction` or `jobs.hourly/jobs.daily` naming.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 152 — Add naming regression guard + operational checklist
Goal:

* Prevent future backslide into schedule-coupled naming.

Deliverables:

1. Add lightweight regression script:
   * `packages/eva/executive/scripts/check-job-naming-regressions.ts`
   * asserts canonical job/config vocabulary in prompt/server/config surfaces.
2. Add npm script in `package.json`:
   * `check:job-naming`
3. Update README checklist:
   * config shape check
   * `/jobs/run` canonical payload check
   * `/health` canonical jobs shape check.

Acceptance:

* `cd packages/eva/executive && npm run build`
* `cd packages/eva/executive && npm run check:job-naming`

Stop; update progress.md.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 153+)
────────────────────────────────────────────────────────────

Add configurable compaction split age (the boundary between entries kept in
working memory vs entries compacted into short-term summaries) without changing
default behavior.

Canonical target:

```json
"jobs": {
  "compaction": {
    "enabled": true,
    "cron": "0 * * * *",
    "windowMs": 3600000
  }
}
```

Semantics:

* `windowMs` defines the recent window retained in `working_memory.log`.
* Compaction cutoff is `cutoff_ms = now_ms - windowMs`.
* Entries older than cutoff are summarized; entries at/after cutoff are kept.
* Default remains 60 minutes when not explicitly configured.

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 153
────────────────────────────────────────────────────────────

Iteration 153 — Add config schema for compaction split age (`jobs.compaction.windowMs`)
Goal:

* Introduce config-driven split age with safe defaults and validation bounds.

Deliverables:

1. In `packages/eva/executive/src/config.ts`:
   * add `jobs.compaction.windowMs` to schema.
   * default to `3600000` (60 minutes) to preserve current behavior.
   * validate as integer milliseconds with guardrails (for example min 5 minutes, max 7 days).
2. In `packages/eva/executive/agent.config.json`:
   * include explicit `windowMs` under `jobs.compaction`.
3. Ensure parsed runtime config exposes `jobs.compaction.windowMs`.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * omit `windowMs` -> default applied (60m)
  * invalid value -> clear validation error.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 154 — Wire compaction job cutoff to config value
Goal:

* Replace hardcoded split window usage in compaction execution path.

Deliverables:

1. In `packages/eva/executive/src/server.ts`:
   * update compaction job runtime to use `config.jobs.compaction.windowMs`.
   * compute `cutoff_ms = now_ms - windowMs`.
   * keep deterministic behavior otherwise unchanged.
2. Add/adjust logs to include effective `window_ms` for observability.
3. Keep `now_ms` override behavior unchanged; only split window source changes.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * run compaction with default config -> behavior matches prior 60m split
  * run compaction with custom `windowMs` -> cutoff reflects configured value.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 155 — Expose and document effective compaction window
Goal:

* Make configured split age visible to operators.

Deliverables:

1. In `/health` payload from `server.ts`:
   * include `jobs.compaction.window_ms` (or consistent field naming style).
2. Update `packages/eva/executive/README.md`:
   * describe `jobs.compaction.windowMs`
   * explain compaction cutoff semantics and defaults
   * include one example using a non-default window.
3. Update operational checklist steps to verify window config and health output.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * `GET /health` includes configured compaction window
  * README examples are canonical and runnable.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 156 — Regression guard for configurable split age
Goal:

* Prevent accidental re-hardcoding of compaction split age.

Deliverables:

1. Extend `packages/eva/executive/scripts/check-job-naming-regressions.ts` OR add a new script
   (for example `check-compaction-window-regressions.ts`) to assert:
   * config schema contains `jobs.compaction.windowMs`
   * server compaction path references configured value (not only hardcoded constant)
   * README documents the config key.
2. Add npm script in `packages/eva/executive/package.json`:
   * `check:compaction-window` (if new script is used).
3. Include this check in the README operational checklist.

Acceptance:

* `cd packages/eva/executive && npm run build`
* `cd packages/eva/executive && npm run check:job-naming` (and `npm run check:compaction-window` if added)

Stop; update progress.md.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 157–160)
────────────────────────────────────────────────────────────

Wire short-term compaction summaries into `/respond` retrieval so freshly
compacted memory can influence responses before promotion runs.

Current observed gap:

* Compaction writes to `short_term_summaries` in SQLite.
* `/respond` currently builds long-term retrieval context via
  `buildRespondLongTermContext(...)`.
* A richer short-term retrieval helper exists in `server.ts`
  (`buildRespondMemoryContext(...)`) but is not currently wired into `/respond`.

Target behavior:

* `/respond` includes recent/tag-filtered short-term summaries in model context
  (bounded by token budget), in addition to existing long-term retrieval context.
* No regressions to tone/session handling, tool-call contract, or error paths.

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 157
────────────────────────────────────────────────────────────

Iteration 157 — Extract and stabilize short-term retrieval context helper
Goal:

* Make short-term context assembly a first-class, testable utility.

Deliverables:

1. Move/normalize short-term retrieval logic into a dedicated memcontext module
   (for example `src/memcontext/respond_short_term_context.ts`) OR explicitly
   promote existing helper with clear contract and comments.
2. Inputs should include at minimum:
   * user text
   * short-term DB path
   * working-memory log path (for recent-insights section if retained)
   * tag whitelist
   * token budget
3. Output should be a deterministic formatted context string + debug metadata
   (counts/selection summary) suitable for logs.
4. Keep behavior equivalent to current helper semantics (tag filtering + fallback rows).

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual: run helper path via local call or temporary debug hook and verify
  non-empty context is produced when `short_term_summaries` contains rows.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 158 — Wire short-term retrieval into `/respond` model context
Goal:

* Ensure compacted summaries are actually used during response generation.

Deliverables:

1. In `/respond` execution path (`runRespond` in `server.ts`):
   * build short-term context using Iteration 157 helper.
   * combine it with existing long-term context in `buildRespondSystemPrompt(...)`
     payload (preserve prompt structure conventions).
2. Keep token-budgeted composition explicit:
   * avoid unbounded prompt growth.
   * maintain existing long-term memory budget behavior.
3. Add trace logging fields to confirm short-term context inclusion (counts/bytes/tokens).
4. Preserve existing fallback behavior if short-term retrieval fails
   (respond should continue with long-term-only context).

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual:
  * compact known working-memory entries;
  * call `/respond` with a related question;
  * inspect trace/logs to confirm short-term context was attached.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 159 — Update docs + health/debug observability for retrieval wiring
Goal:

* Make retrieval flow and verification steps operator-visible.

Deliverables:

1. Update `packages/eva/executive/README.md` with retrieval pipeline:
   * working-memory -> compaction -> short-term SQLite -> `/respond` retrieval
   * promotion path to long-term stores.
2. Add a practical verification runbook:
   * ingest a few turns,
   * trigger/wait for compaction,
   * verify `short_term_summaries` rows,
   * call `/respond` and confirm retrieval hit indicators in logs/traces.
3. Add/expand debug logging around `/respond` retrieval selection:
   * number of candidate short-term rows,
   * number selected after tag filter,
   * fallback behavior used/not used.

Acceptance:

* `cd packages/eva/executive && npm run build`
* Manual: follow README runbook end-to-end successfully.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 160 — Regression guard for short-term retrieval integration
Goal:

* Prevent future disconnect where compaction writes but `/respond` ignores short-term memory.

Deliverables:

1. Add a lightweight regression script (or extend existing checks), e.g.:
   * `scripts/check-respond-retrieval-regressions.ts`
2. Assert at minimum:
   * `/respond` path references short-term retrieval helper/module,
   * short-term DB (`short_term_summaries`) retrieval is part of context assembly,
   * README documents short-term retrieval in respond flow.
3. Add npm script in `packages/eva/executive/package.json`:
   * `check:respond-retrieval`
4. Include this check in operational checklist docs.

Acceptance:

* `cd packages/eva/executive && npm run build`
* `cd packages/eva/executive && npm run check:job-naming`
* `cd packages/eva/executive && npm run check:respond-retrieval`

Stop; update progress.md.
