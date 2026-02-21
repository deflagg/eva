## docs/implementation-plan-59-65.md — Memory Reset Scripts + EVA Tone Cache (Real-Time) + LanceDB Long-Term Store (Hard Cutover, No Migration)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

# GOAL

1. Add **three reset scripts** to wipe EVA memory/cache at different levels (developer-friendly).
2. Make `packages/eva/memory/cache/personality_tone.json` match your intent:

   * it represents **EVA’s tone** (not the user’s)
   * it can **shift in the moment**
   * it **decays** back toward a stable default
   * it is **session-aware**
3. Replace the current JSON “vector db” with **LanceDB** (embedded DB) for long-term experiences + personality.

---

# DECISIONS (LOCKED)

* **Hard cutover. No migration.** We will delete/stop using JSON long-term stores and switch directly to LanceDB.

  * Any existing long-term memories currently stored in JSON are intentionally discarded.
* Reset scripts must **never delete** committed sources of truth:

  * `packages/eva/memory/persona.md`
  * `packages/eva/memory/experience_tags.json`
* `personality_tone.json` is **EVA state** (how EVA responds), not “detected user tone.”
* Tone is **session-scoped**, with a deterministic fallback when `session_id` is missing.
* Long-term storage provider is **LanceDB only** (no dual-write, no JSON fallback).

---

# MEMORY LAYOUT (TARGET)

```text
packages/eva/memory/
├── working_memory.log              # JSONL, last 1 hour (gitignored)
├── short_term_memory.db            # SQLite summaries (gitignored)
├── persona.md                      # committed base persona
├── experience_tags.json            # committed strict tag whitelist
├── cache/                          # gitignored
│   ├── core_personality.json
│   ├── core_experiences.json
│   ├── recent_experiences.json
│   └── personality_tone.json       # EVA tone state (session-aware, decaying)
└── vector_db/                      # gitignored
    └── lancedb/                    # LanceDB database directory
        ├── long_term_experiences   # Lance table
        └── long_term_personality   # Lance table
```

---

# TONE CACHE (SPEC)

File: `packages/eva/memory/cache/personality_tone.json`

Schema (v1):

```json
{
  "v": 1,
  "default_tone": "neutral",
  "updated_ts_ms": 1700000000000,
  "sessions": {
    "default": {
      "tone": "neutral",
      "intensity": 0.0,
      "updated_ts_ms": 1700000000000,
      "expires_ts_ms": 1700000900000,
      "history": []
    },
    "session-123": {
      "tone": "calm",
      "intensity": 0.35,
      "updated_ts_ms": 1700000000000,
      "expires_ts_ms": 1700000900000,
      "history": [
        { "ts_ms": 1700000000000, "tone": "calm", "reason": "user asked for step-by-step help" }
      ]
    }
  }
}
```

Rules:

* `tone` = EVA’s output style right now.
* If `session_id` missing in `/respond`, use session key `"default"`.
* `expires_ts_ms` enforces decay: when expired, EVA reverts to `default_tone`.
* `history` bounded (keep last ~20).
* Unknown tones from model → map to `neutral` + log warning.

Prompt injection requirement:

* Before `/respond` model call: inject **Current EVA tone** for the session + instruction to maintain it unless conversation naturally shifts or user requests a change.
* After response: update cache from model-emitted `meta.tone`.

---

# LANCEDB MODEL (v1)

Dependency (LOCKED): `@lancedb/lancedb`

Two tables:

* `long_term_experiences`
* `long_term_personality`

Column conventions (LOCKED):

* Use `vector` as the embedding column name.

Suggested columns:

* `id: string` (stable, deterministic)
* `ts_ms: int64`
* `text: string`
* `tags: list<string>` (subset of `experience_tags.json`)
* `vector: list<float32>` (dimension = existing value; 64 is OK for current hashed vectors)

Upsert semantics (LOCKED):

* Use `mergeInsert` keyed on `id` (update on match, insert on miss).

---

# IMPLEMENTATION ITERATIONS (START AT 59)

## Iteration 59 — Add 3 reset scripts + npm hooks (and recreate dirs)

Goal:

* One-command resets, no manual filesystem surgery.

Important operational note (LOCKED):

* Stop Eva/Agent before running reset scripts (or accept transient errors if something writes during deletion).

Deliverables:

* Add `packages/eva/executive/scripts/`:

  * `reset-working.mjs`

    * deletes `working_memory.log`
    * deletes `cache/personality_tone.json`
    * ensures `cache/` exists after run
  * `reset-session.mjs`

    * deletes `working_memory.log`
    * deletes `short_term_memory.db`
    * deletes all files under `cache/` (and/or deletes folder)
    * ensures `cache/` exists after run
  * `reset-all.mjs`

    * deletes everything above
    * deletes `vector_db/**` (this nukes LanceDB tables too)
    * ensures `cache/` and `vector_db/` exist after run
* Add `packages/eva/executive/package.json` scripts:

  * `mem:reset:working`
  * `mem:reset:session`
  * `mem:reset:all`
* Safety guardrails:

  * scripts must resolve `memoryDir` by reading `agent.config.json` and applying the same “resolve relative to config file path” rule used by the agent
  * scripts must refuse to run unless:

    * resolved path ends with `packages/eva/memory`, AND
    * both `persona.md` and `experience_tags.json` exist inside it
  * scripts must never delete committed files (`persona.md`, `experience_tags.json`)

Acceptance:

* `cd packages/eva/executive && npm run build`
* Create dummy runtime files and verify each script deletes only its scope and recreates needed dirs.

Stop; update progress.md.

---

## Iteration 60 — Implement tone cache as EVA tone (session-aware + decay) and use it in `/respond`

Goal:

* Tone actually affects responses, not just written to disk.

Deliverables:

* Add `packages/eva/executive/src/memory/tone.ts`:

  * `loadToneState(memoryDir)`
  * `getSessionKey(sessionId?: string): string` → returns `sessionId ?? "default"`
  * `getToneForSession(state, sessionKey, nowMs)` (default if missing/expired)
  * `updateToneForSession(state, sessionKey, tone, nowMs, reason?)`
  * `saveToneStateAtomic(memoryDir, state)` (tmp + rename)
* Update `/respond` pipeline:

  * read current EVA tone at request start
  * inject it into the respond system prompt as a short directive
  * after tool-call result, write back `meta.tone` with refreshed `expires_ts_ms`
* Define allowed tones (v1) in one place (simple enum list), e.g.:

  * `neutral, calm, friendly, playful, serious, technical, empathetic, urgent`

Acceptance:

* Two `/respond` calls with same `session_id` show stable tone persistence.
* Expiry behavior verified (temporarily set a short TTL in code for local test).

Stop; update progress.md.

---

## Iteration 61 — Tone smoothing + explicit “change tone” handling (future-only)

Goal:

* Prevent tone whiplash and support deliberate shifts.

Deliverables:

* Add smoothing rules (stored tone for *next* turn only):

  * do not change stored session tone unless:

    * user explicitly requests tone change, OR
    * model repeats the same new tone across N turns, OR
    * intensity exceeds a threshold (optional)
* Prompt instruction update:

  * “If the user asks you to change your tone, comply and set `meta.tone` accordingly.”
* Clarification (LOCKED):

  * smoothing affects the *stored* tone for the *next* turn; it does not modify the already-generated response text.
* Keep history bounded and include short “reason” strings for debugging.

Acceptance:

* Normal chat doesn’t jitter tone.
* “Be more serious” yields a consistent shift that persists.

Stop; update progress.md.

---

## Iteration 62 — Add LanceDB dependency + minimal adapter (no runtime behavior change)

Goal:

* Get LanceDB working in isolation before touching daily/retrieval logic.

Deliverables:

* Add dependency to `packages/eva/executive/package.json`:

  * `@lancedb/lancedb` (pin version)
* Add `packages/eva/executive/src/vectorstore/lancedb.ts`:

  * `openDb(lancedbDir)`
  * `getOrCreateTable(name, schema)`
  * `mergeUpsertById(table, rows)` using `mergeInsert` keyed on `"id"`
  * `queryTopK(table, queryVector, k)` using `vector` column
* Derive DB directory deterministically:

  * `lancedbDir = path.join(memoryDir, "vector_db", "lancedb")`
  * ensure dirs exist on startup or first use

Acceptance:

* `cd packages/eva/executive && npm i && npm run build`
* A tiny local dev harness can create table → insert 1 row → query it back.

Stop; update progress.md.

---

## Iteration 63 — Cut over `/jobs/daily` to LanceDB only + update docs immediately

Goal:

* Long-term persistence becomes a real DB immediately, and docs don’t lie.

Deliverables:

* In `POST /jobs/daily`:

  * remove JSON index write code entirely (delete it, don’t comment it out)
  * write long-term entries into LanceDB tables:

    * `long_term_experiences`
    * `long_term_personality`
  * keep cache refresh behavior (`core_experiences.json`, `core_personality.json`) unchanged
* Update `/health` and/or logs to include:

  * LanceDB directory path
  * counts written this run
* **Docs alignment in this same iteration (required):**

  * update `packages/eva/executive/README.md` to replace JSON index paths with LanceDB tables + directory
  * update any “vector db is JSON index” wording that is now incorrect

Acceptance:

* Run `/jobs/daily` and confirm LanceDB tables exist and grow.
* Confirm no `index.json` is produced/updated anymore.
* README accurately describes current behavior.

Stop; update progress.md.

---

## Iteration 64 — Cut over `/respond` retrieval to LanceDB only (remove JSON long-term reads)

Goal:

* All long-term retrieval comes from LanceDB. No fallback.

Deliverables:

* Remove JSON long-term load/query logic from respond retrieval.
* Replace long-term retrieval with LanceDB vector search:

  * experiences: topK hits
  * personality: topK hits (smaller K)
* Keep short-term SQLite + core caches injection unchanged.
* Ensure “LanceDB empty” behavior is graceful:

  * “no relevant long-term memory found” (don’t fabricate)

Acceptance:

* `/respond` works and uses long-term memory once LanceDB has entries.
* With empty LanceDB, `/respond` still works and doesn’t degrade badly.

Stop; update progress.md.

---

## Iteration 65 — Cleanup: delete dead JSON vector-store code + final docs sweep

Goal:

* Repo matches reality and there are no confusing leftovers.

Deliverables:

* Delete any unused JSON-vector-store helpers/modules and references.
* Confirm `docs/implementation-plan-44-58.md` (or any other doc) doesn’t claim Chroma/JSON vector persistence if that’s now false.
* Add a one-time operational note in root docs:

  * “Hard cutover: long-term memory is now LanceDB. Existing JSON long-term memory is not used.”

Acceptance:

* All builds pass.
* No docs reference JSON long-term storage as active behavior.

Stop; update progress.md.
