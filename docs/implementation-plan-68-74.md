````md
## docs/implementation-plan-68-74.md — Rename Agent→Executive + Single-Writer Working Memory Events + /respond Uses Recent Events + Rename vector_db→long_term_memory_db

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

# GOAL

1) Naming matches mental model:
* EVA is the overall “brain/agent.”
* The Node service currently at `packages/eva/agent` is EVA’s **executive function** (tool-loop, /respond, memory writes).
→ Rename it to `packages/eva/executive`.

2) “Recent events” becomes answerable from EVA chat:
* Persist live events into a working-memory journal.
* Executive reads the last N minutes of **all** non-chat events (future-proof for many event types) and injects them into the /respond memory context.

3) Avoid JSONL corruption:
* Use a **single-writer** model: only Executive writes working memory logs to disk.
* EVA gateway forwards events to Executive over HTTP; Executive serializes all memory writes through its existing write queue.

4) Rename long-term store folder:
* Change `packages/eva/memory/vector_db/**` to `packages/eva/memory/long_term_memory_db/**`
* LanceDB lives under: `packages/eva/memory/long_term_memory_db/lancedb`

---

# CURRENT STATE (FACTS)

* UI “Recent events” are displayed from `detections.events[]` coming over the EVA `/eye` WebSocket.
* EVA `/text` calls the executive `/respond` with `{ text, session_id }`.
* Executive builds memory context from SQLite + LanceDB + core cache JSONs, but NOT from “recent live events”.
* Executive writes chat memory artifacts to `packages/eva/memory/working_memory.log` (JSONL) under a serial write queue.
* `.gitignore` currently ignores `packages/eva/memory/vector_db/**` (will be renamed).

---

# DECISIONS (LOCKED)

* Persisted memory stays under `packages/eva/memory/`. Do NOT move it.
* Executive is the only writer of the working memory journal on disk.
* All non-chat sensory/system events are stored as a single generic envelope in working memory:

```json
{
  "type": "wm_event",
  "ts_ms": 1730000000000,
  "source": "vision",
  "name": "roi_dwell",
  "severity": "medium",
  "track_id": 3,
  "summary": "roi_dwell track_id=3 roi=front_door dwell_ms=1200",
  "data": { "roi": "front_door", "dwell_ms": 1200, "conf": 0.92 }
}
````

* Executive /respond reads last N minutes of `wm_event` entries (not just vision), caps by count + token budget, and injects into the memory context.

* Rename `vector_db` → `long_term_memory_db` for the on-disk long-term store folder, keeping LanceDB under `.../lancedb/`.

* Provide a one-time migration for existing local data:

  * if `packages/eva/memory/vector_db/` exists and `.../long_term_memory_db/` does not, rename the directory once at startup.

* Keep config filenames + cosmiconfig namespace as-is for now to reduce churn:

  * Keep `agent.config.json` / `agent.config.local.json` names even after folder rename.
  * Keep `cosmiconfigSync('agent', ...)` unchanged for now.
  * Service may still report `service: "agent"` on /health for now (optional to rename later).

---

# TARGET LAYOUT

Persisted data (after rename):

```text
packages/eva/memory/
├── persona.md
├── experience_tags.json
├── working_memory.log              # JSONL (gitignored)
├── short_term_memory.db            # SQLite (gitignored)
├── cache/                          # gitignored
│   ├── personality_tone.json
│   ├── core_experiences.json
│   └── core_personality.json
└── long_term_memory_db/            # gitignored (RENAMED from vector_db)
    └── lancedb/
```

Executive code (renamed from agent; folder-name clarity included):

```text
packages/eva/executive/
└── src/
    ├── memcontext/
    │   ├── tone.ts
    │   ├── live_events.ts          # new helper to read recent wm_event entries
    │   └── long_term/
    │       └── lancedb.ts
    └── server.ts
```

---

# IMPLEMENTATION ITERATIONS (START AT 68)

## Iteration 68 — Mechanical rename: `packages/eva/agent` → `packages/eva/executive`

Goal:

* Rename module folder to match mental model.

Deliverables:

1. `git mv packages/eva/agent packages/eva/executive`
2. Update path references across repo:

   * any scripts that `cd packages/eva/agent`
   * any docs mentioning `packages/eva/agent`
   * any tooling configs referencing old folder path
   * any EVA startup/spawn logic that points at that folder (if present)

Acceptance:

* `cd packages/eva/executive && npm run build`
* `cd packages/eva && npm run build`
* Start Executive and verify:

  * `GET http://127.0.0.1:<port>/health` returns ok

Stop; update progress.md.

---

## Iteration 69 — Clarify code naming: create `src/memcontext/` and move tone + LanceDB adapter (code only)

Goal:

* Reduce confusion between “memory data” vs “memory code”.

Deliverables:

1. Create:

   * `packages/eva/executive/src/memcontext/`
   * `packages/eva/executive/src/memcontext/long_term/`
2. Move:

   * `packages/eva/executive/src/memory/tone.ts`
     → `packages/eva/executive/src/memcontext/tone.ts`
   * `packages/eva/executive/src/vectorstore/lancedb.ts`
     → `packages/eva/executive/src/memcontext/long_term/lancedb.ts`
3. Update imports in `packages/eva/executive/src/server.ts`:

   * `./memory/tone.js` → `./memcontext/tone.js`
   * `./vectorstore/lancedb.js` → `./memcontext/long_term/lancedb.js`
4. Keep `.js` extension in import specifiers (ESM style).

Acceptance:

* `cd packages/eva/executive && npm run build`
* `GET /health` still reports memory paths under `packages/eva/memory/...`

Stop; update progress.md.

---

## Iteration 70 — Rename on-disk long-term folder: `vector_db` → `long_term_memory_db` (with safe migration)

Goal:

* Rename persisted long-term store folder and update all references.

Deliverables:

1. Update LanceDB adapter directory constant:

   * In `packages/eva/executive/src/memcontext/long_term/lancedb.ts`

     * change relative dir from `vector_db/lancedb` → `long_term_memory_db/lancedb`

2. Update reset scripts (now under executive):

   * `scripts/reset-common.mjs`:

     * rename `vectorDbDir` → `longTermMemoryDbDir`
     * change path join from `memoryDir/vector_db` → `memoryDir/long_term_memory_db`
   * `scripts/reset-all.mjs`:

     * delete + recreate `long_term_memory_db/**` instead of `vector_db/**`
     * update log strings accordingly

3. Update `.gitignore`:

   * replace `packages/eva/memory/vector_db/**` with `packages/eva/memory/long_term_memory_db/**`

4. Update Executive README (now at `packages/eva/executive/README.md`):

   * replace references to `packages/eva/memory/vector_db/lancedb`
   * with `packages/eva/memory/long_term_memory_db/lancedb`

5. One-time migration on startup (safe for local dev):

   * In Executive startup (near where lancedb dir is derived/used):

     * if `packages/eva/memory/vector_db` exists AND `packages/eva/memory/long_term_memory_db` does NOT exist:

       * rename `vector_db` → `long_term_memory_db`
     * log one line: migrated legacy vector_db → long_term_memory_db
   * If rename fails, log a warning and continue (no crash).

Acceptance:

* `cd packages/eva/executive && npm run build`
* If legacy data exists locally:

  * start Executive once and confirm directory renamed on disk
* Run reset-all and confirm it recreates:

  * `packages/eva/memory/cache/`
  * `packages/eva/memory/long_term_memory_db/`

Stop; update progress.md.

---

## Iteration 71 — Single writer: add Executive `/events` ingest endpoint that appends `wm_event` entries

Goal:

* Executive is the only writer to `working_memory.log`.
* EVA gateway (and later other modules) send events via HTTP; Executive serializes writes with its existing queue.

Deliverables:

1. Add `POST /events` endpoint in `packages/eva/executive/src/server.ts`

Request schema (versioned):

```json
{
  "v": 1,
  "source": "vision",
  "events": [
    { "name":"roi_dwell", "ts_ms": 1730000000000, "severity":"medium", "track_id":3, "data": { "roi":"front_door" } }
  ],
  "meta": { "frame_id":"optional", "model":"optional" }
}
```

Validation:

* `source`: non-empty string
* `events`: non-empty array
* each event:

  * `name`: non-empty string
  * `ts_ms`: non-negative int
  * `severity`: one of `low|medium|high`
  * `track_id`: optional int
  * `data`: object (record)

2. Transform each incoming event to a working-memory JSONL object:

* `type: "wm_event"`
* `ts_ms`, `source`, `name`, `severity`, `track_id`, `data`
* `summary`: compact string built by Executive (e.g., `name + key fields`, truncate later)

3. Append to `working_memory.log` under the SAME serial write queue used by `/respond` memory writes.

* Do not write to the log outside the queue.

4. Response:

* 200 with `{ accepted: <count>, ts_ms: <server_now_ms> }`

Acceptance:

* Start Executive.
* Curl a test event to `/events` and verify:

  * a JSONL line with `"type":"wm_event"` appears in `packages/eva/memory/working_memory.log`
  * JSON parses cleanly

Stop; update progress.md.

---

## Iteration 72 — EVA gateway forwards `detections.events[]` to Executive `/events` (no file writes in EVA)

Goal:

* EVA gateway forwards vision events to Executive; Executive persists them.

Deliverables:

1. In `packages/eva/src/server.ts` (QuickVision inbound handler):

* When `message.type === "detections"` and `message.events?.length > 0`:

  * fire-and-forget HTTP POST to Executive `/events`
  * body:

    * `v: 1`
    * `source: "vision"`
    * `events: message.events`
    * `meta: { frame_id: message.frame_id, model: message.model }` (optional)

2. Implement helper in EVA (modeled after the existing /respond call helper):

* `callAgentEventsIngest(agentBaseUrl, payload)`
* short timeout (250–500ms)
* do not block the QuickVision message loop
* failures only warn (optional: rate-limit warnings)

Acceptance:

* Start stack, stream camera, trigger events.
* Confirm `packages/eva/memory/working_memory.log` contains `wm_event` entries with `source:"vision"`.

Stop; update progress.md.

---

## Iteration 73 — Executive /respond injects last N minutes of ALL `wm_event` entries into memory context

Goal:

* Chat questions like “what are the events now” become answerable.

Deliverables:

1. Add constants (in Executive):

* `LIVE_EVENT_WINDOW_MS = 2 * 60 * 1000`
* `LIVE_EVENT_MAX_ITEMS = 20`
* `LIVE_EVENT_MAX_LINE_CHARS = 180`

2. Implement helper (new file recommended):

* `packages/eva/executive/src/memcontext/live_events.ts`

  * reads working_memory.log (JSONL)
  * parses safely (skip invalid lines)
  * filters:

    * `type === "wm_event"`
    * `ts_ms >= nowMs - LIVE_EVENT_WINDOW_MS`
  * sorts by ts_ms ascending
  * returns last `LIVE_EVENT_MAX_ITEMS`

3. In the respond memory-context builder (where it currently builds “Recent short-term summaries … / Long-term retrieval hits … / Core cache …”):

* Inject a section near the top:

```text
Live events (last ~2 minutes):
- [11:23:10] vision medium roi_dwell track_id=3 roi=front_door dwell_ms=1200
- [11:23:14] vision low sudden_motion track_id=1 conf=0.61
```

4. Enforce token budget:

* Truncate each line to `LIVE_EVENT_MAX_LINE_CHARS`
* Stop adding event lines if the memory-context token budget is reached.

Acceptance:

* Stream camera and trigger events.
* In EVA chat, ask:

  * “what were the recent events”
  * “what are the events now”
* Expected: response lists concrete recent events instead of generic “I don’t have info”.

Stop; update progress.md.

---

## Iteration 74 — Final cleanup: remove remaining `vector_db` references

Goal:

* Ensure repo references the new long-term folder name everywhere that matters now.

Deliverables:

* Update any remaining runtime docs/scripts/log strings referencing `vector_db` to `long_term_memory_db`.
* Ensure reset scripts and README reflect:

  * `packages/eva/memory/long_term_memory_db/lancedb`

Acceptance:

* Repo search finds no relevant `vector_db` references (except intentionally historical docs, if any).
* Build still passes:

  * `cd packages/eva/executive && npm run build`
  * `cd packages/eva && npm run build`

Stop; update progress.md.

