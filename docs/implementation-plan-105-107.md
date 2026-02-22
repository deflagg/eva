## docs/implementation-plan-105-107.md — Respond context pulls WM insights only (no WM events) for last ~2 minutes

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

For now, the Executive `/respond` pipeline should:

* Pull ONLY recent **working-memory insights** from the last ~2 minutes
* Stop pulling / summarizing **working-memory events**
* Keep everything else (persona, tone, tool-call constraints, response format) the same

This is a temporary simplification so “what did you see?” reliably references the *surprise summaries* instead of noisy detector telemetry.

---

# NON-GOALS

* No schema redesign (no “unify insights/events” in this plan).
* No fallback-to-events (user explicitly wants insights only).
* No changes to Vision surprise thresholds / insight generation logic.
* No changes to UI.

---

# DEFINITIONS

* **Insight**: the WM record written when an insight is generated (one_liner / what_changed / severity / tags, plus clip_id/trigger_frame_id, and optionally asset refs if you’ve added them).
* **Event**: any WM record representing low-level detector activity (line_cross, roi_enter/exit, track_stop, etc). We will ignore these for /respond context.

---

# IMPLEMENTATION ITERATIONS (START AT 105)

## Iteration 105 — Add a “recent insights” retrieval utility in Executive

Goal:
* Create a small utility that can load and filter WM insight entries by time window.

Deliverables:

1) Add a utility module (or function in an existing memory module) in Executive, e.g.:
* `packages/eva/executive/src/memory/retrieve_recent_insights.ts`

Suggested shape:

* `retrieveRecentInsights({ sinceTsMs, untilTsMs, limit }): Promise<InsightEntry[]>`

Where `InsightEntry` includes at minimum:
* `ts_ms`
* `clip_id`
* `trigger_frame_id`
* `summary.one_liner`
* `summary.what_changed`
* `summary.severity`
* `summary.tags`
* (optional) `assets` if present in your WM

2) Add a formatter:
* `formatInsightsForPrompt(insights): string`
  * Output should be compact and stable.
  * Recommended format (newest last or newest first, pick one):
    - `[HH:MM:SS] (severity) one_liner`
    - `- what_changed item 1`
    - `- what_changed item 2`
  * Hard cap:
    * `limit` (e.g., 10)
    * and/or truncate `what_changed` lists if too long.

Acceptance:
* `cd packages/eva/executive && npm run build`
* Manual: run a local insight, confirm the utility returns at least one entry.

Stop; update `progress.md`.

---

## Iteration 106 — Switch /respond context builder to insights-only

Goal:
* Replace the “environment snapshot derived from live events” section with “recent insights” only.

Deliverables:

1) Locate the code path that builds the “Retrieved memory context” block used in `/respond` (this is the chunk you see in logs before the model call).

2) Remove/disable:
* any “live events” query
* any “event summary” / counts / raw lines section
* any tag filtering that exists only to support event snapshots

3) Insert insights-only context:
* Compute `sinceTsMs = nowTsMs - 2 * 60 * 1000`
* Call `retrieveRecentInsights({ sinceTsMs, untilTsMs: nowTsMs, limit: N })`
* If insights exist:
  * include a section like:
    * `Recent insights (last ~2 minutes):`
    * followed by `formatInsightsForPrompt(...)`
* If none exist:
  * include:
    * `No insights were generated in the last ~2 minutes.`

4) Keep other memory layers (core/long-term/short-term) untouched unless they were coupled to the event snapshot.

Acceptance:
* `cd packages/eva/executive && npm run build`
* Manual smoke:
  1) Trigger an insight (surprise clip / insight_test)
  2) Send chat: “what did you see”
  3) Confirm the model context block includes the insight and does NOT include event rollups.
  4) Confirm the assistant mentions the insight.

Stop; update `progress.md`.

---

## Iteration 107 — Make “what did you see / what happened” explicitly insight-first (prompt nudge + tests)

Goal:
* Ensure EVA consistently leads with insight content when present.

Deliverables:

1) Add a small instruction in the /respond system prompt template near the “Memory usage guidance” section:

* “If recent insights are present, summarize them first when the user asks about recent activity (e.g., ‘what did you see’ / ‘what happened’). Do not summarize raw detector events (events are omitted in this mode).”

2) Add a short manual test checklist to the Executive README (or your docs/runbook location):

* Test A: No insights in last 2 minutes
  - Ask: “what did you see”
  - Expected: “No insights were generated…” (no fabricated activity)

* Test B: One insight exists
  - Ask: “what did you see”
  - Expected: cite the one_liner + key what_changed items

* Test C: Multiple insights exist
  - Ask: “what happened”
  - Expected: list up to N insights, compactly

Acceptance:
* `cd packages/eva/executive && npm run build`
* Run the three manual tests above.

Stop; update `progress.md`.

---