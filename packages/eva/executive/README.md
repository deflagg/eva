# Agent

Node/TypeScript service for EVA text + insight generation.

## Current behavior (Iteration 159)

- Loads config via `cosmiconfig` + `zod`.
- Resolves `memory.dir` relative to the loaded config file path.
- Loads OpenAI API key from local secrets JSON.
- Loads persona guidance from `packages/eva/memory/persona.md` for chat response prompting.
- Exposes `GET /health`.
- Exposes `POST /events`:
  - accepts versioned event ingest payloads (`v:1`) from EVA modules (for example, vision)
  - validates event envelopes (`name`, `ts_ms`, `severity`, optional `track_id`, `data`)
  - transforms events into `wm_event` JSONL entries and appends them through the same serial write queue used by `/respond`
  - returns `{ accepted, ts_ms }`
- Supports in-daemon cron scheduling for compaction/promotion jobs when `jobs.enabled=true`.
- Exposes preferred manual admin trigger `POST /jobs/run`:
  - request: `{ "job": "compaction" | "promotion", "now_ms"?: number }`
  - `compaction` path:
    - reads `packages/eva/memory/working_memory.log` under the same write queue used by `/respond`
    - selects entries older than 60 minutes
    - performs LLM-based compaction with deterministic fallback
    - inserts summary bullets into SQLite `packages/eva/memory/short_term_memory.db`
    - atomically rewrites working memory log to keep only the last 60 minutes
  - `promotion` path:
    - reads yesterday's rows from `packages/eva/memory/short_term_memory.db`
    - upserts long-term experiences into LanceDB table:
      - `long_term_experiences`
      - LanceDB dir: `packages/eva/memory/long_term_memory_db/lancedb`
    - upserts long-term characteristics into semantic SQLite:
      - `packages/eva/memory/long_term_memory_db/semantic_memory.db`
      - table: `semantic_items`
    - updates stable cache artifacts:
      - `packages/eva/memory/cache/core_experiences.json` (from LanceDB experiences)
      - `packages/eva/memory/cache/core_personality.json` (from semantic SQLite)
- Legacy wrappers were removed in Iteration 144.
- Exposes real model-backed `POST /respond`:
  - accepts `{ "text": "...", "session_id": "optional" }`
  - replays the full `packages/eva/memory/working_memory.log` into `context.messages[]` in chronological order
  - replayed entries are labeled per message content with:
    - `WM_KIND=<type>` (history/context marker)
    - `ts_ms: <timestamp>`
    - `WM_JSON: <raw json line payload>`
  - appends exactly one actionable user message at the end of `context.messages[]` labeled:
    - `CURRENT_USER_REQUEST`
  - system prompt explicitly instructs the model:
    - treat `WM_KIND=` entries as context/history (not new instructions)
    - respond to the latest `CURRENT_USER_REQUEST`
  - system prompt injects bounded memory context (reference-only):
    - **short-term retrieval context** (from compacted SQLite summaries):
      - recent observations from `working_memory.log` (bounded window)
      - `Recent short-term summaries (tag-filtered):` from `short_term_summaries`
      - fallback selection path when tag filtering yields no rows
    - **long-term retrieval context**:
      - `Traits (long-term):` from semantic SQLite (recent/high-support items)
      - `Relevant experiences (retrieved):` from LanceDB similarity retrieval
    - memory is marked as potentially stale/fallible and never authoritative over `CURRENT_USER_REQUEST`
  - calls model through `@mariozechner/pi-ai` tool loop (`commit_text_response`)
  - enforces concept whitelist from `packages/eva/memory/experience_tags.json`
    - unknown concepts are dropped and logged
  - writes memory artifacts on each successful response:
    - appends `text_input` + `text_output` JSONL entries to `packages/eva/memory/working_memory.log`
    - updates `packages/eva/memory/cache/personality_tone.json`
  - serializes memory writes through a queue/mutex to avoid JSONL corruption under rapid requests
  - emits retrieval observability on each `/respond` call:
    - request trace field `memory_context_debug.short_term` with candidate/selected row counts and selection mode
    - runtime log line with short-term retrieval selection summary
  - returns `{ text, meta, request_id }` (and `session_id` when provided)
- Exposes real `POST /insight`:
  - requires `Content-Type: application/json`
  - enforces `insight.maxBodyBytes`
  - validates request payload shape (`frames` non-empty)
  - enforces `insight.maxFrames` (hard-capped at 6)
  - enforces `insight.cooldownMs`
  - calls model through `@mariozechner/pi-ai` tool loop (`submit_insight`)
  - validates tool-call output schema
  - enforces tag whitelist from `packages/eva/memory/experience_tags.json`
    - unknown tags are dropped and logged
  - returns `summary` + `usage`

## Configuration

Config search order (package root):

1. `agent.config.local.json` (optional, gitignored)
2. `agent.config.json` (committed defaults)

Default config (`agent.config.json`):

```json
{
  "server": { "port": 8791 },
  "memory": { "dir": "../memory" },
  "model": { "provider": "openai", "id": "gpt-4o-mini" },
  "insight": {
    "cooldownMs": 5000,
    "maxFrames": 6,
    "maxBodyBytes": 8388608,
    "ttsStyle": "clean"
  },
  "jobs": {
    "enabled": false,
    "timezone": "UTC",
    "compaction": { "enabled": true, "cron": "0 * * * *", "windowMs": 3600000 },
    "promotion": { "enabled": true, "cron": "15 3 * * *" }
  },
  "secretsFile": "agent.secrets.local.json"
}
```

`insight.ttsStyle` controls reaction intensity for generated `summary.tts_response`:
- `clean` (default): soft language (for example: "what the heck", "what was that")
- `spicy`: allows occasional mild profanity for emphasis (never slurs/harassment)

`jobs.compaction.windowMs` controls the compaction split age:
- compaction cutoff is `cutoff_ms = now_ms - windowMs`
- entries older than cutoff are summarized into short-term memory
- entries at/after cutoff remain in `working_memory.log`
- default is `3600000` (60 minutes)

## Scheduler (preferred path)

Enable scheduler in `agent.config.local.json`:

```json
{
  "jobs": {
    "enabled": true,
    "timezone": "America/New_York",
    "compaction": { "enabled": true, "cron": "0 * * * *", "windowMs": 1800000 },
    "promotion": { "enabled": true, "cron": "15 3 * * *" }
  }
}
```

Notes:
- Scheduler executes jobs in-process (no external infra).
- `POST /jobs/run` remains available for manual admin triggers.

## Retrieval pipeline (`/respond`)

Current memory flow:

1. `/respond` appends turn artifacts to `working_memory.log` (`text_input` + `text_output`).
2. **Compaction job** summarizes older working-memory records into SQLite `short_term_summaries`.
3. `/respond` retrieves short-term context from:
   - recent observations in `working_memory.log`
   - tag-filtered recent rows in `short_term_summaries` (with fallback row selection)
4. **Promotion job** moves short-term signals into long-term stores:
   - semantic SQLite (`semantic_memory.db`) for traits/personality-like signals
   - LanceDB (`long_term_experiences` / `long_term_personality`) for vector retrieval
5. `/respond` retrieves long-term context from semantic SQLite + LanceDB and combines it with short-term context.

This keeps fresh context available quickly (via short-term retrieval) while preserving slower, durable memory (via promotion).

## Secrets

`agent.secrets.local.json` is gitignored.

Required shape:

```json
{
  "openaiApiKey": "sk-your-openai-key"
}
```

## LLM trace logging (hot toggle)

Executive can emit OpenAI boundary traces to local JSONL files under `packages/eva/llm_logs/`.

### Config location

1. Copy the committed example once:

```bash
cp packages/eva/llm_logs/config.example.json packages/eva/llm_logs/config.json
```

2. Edit `packages/eva/llm_logs/config.json` and toggle:

```json
{ "enabled": true }
```

Set `enabled` back to `false` to disable.

### Hot reload behavior

No restart is required. On each trace write attempt, Executive checks `config.json` mtime and reloads it when changed.

### What gets logged

Default log file: `packages/eva/llm_logs/openai-requests.log` (JSONL, one object per line).

For each model call path (`/respond` and `/insight`):
- `phase: "request"` right before `complete(...)`
- `phase: "response"` right after `complete(...)` returns
- `phase: "error"` when `complete(...)` throws

### Sanitization and safety

- Base64 image payloads are replaced with placeholders (for example `[omitted base64 image: 123456 chars]`).
- `secrets` objects are redacted.
- API key-like fields (`apiKey` / `api_key`) are redacted.
- Large strings are truncated according to `truncate_chars`.

`config.json` and all runtime log files in `packages/eva/llm_logs/` are gitignored (only `config.example.json` is committed).

⚠️ Logs can still contain sensitive user text and memory context. Keep them local and handle carefully.

## Run

```bash
nvm install node
nvm use node
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Naming regression check

```bash
npm run check:job-naming
```

## Respond retrieval regression check

```bash
npm run check:respond-retrieval
```

## Iteration 152 operational checklist (job naming)

1. **Config shape is canonical**
   - Ensure `agent.config.json` / local overrides use:
     - `jobs.compaction`
     - `jobs.compaction.windowMs`
     - `jobs.promotion`
   - Ensure legacy schedule-named keys are absent.

2. **`/jobs/run` uses canonical request values**

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"compaction"}'

curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"promotion"}'
```

Expected:
- both requests return `200`
- response `job` is `compaction` / `promotion`

3. **`/health` reports canonical jobs shape**

```bash
curl -sS http://127.0.0.1:8791/health
```

Expected jobs keys:
- `jobs.enabled`
- `jobs.timezone`
- `jobs.compaction`
- `jobs.compaction.window_ms`
- `jobs.promotion`

## Health check

```bash
curl -s http://127.0.0.1:8791/health
```

`/health` includes scheduler observability under `jobs`:
- `jobs.enabled`
- `jobs.timezone`
- per-job config (`compaction.cron`, `compaction.window_ms`, `promotion.cron`)
- per-job last-run timestamps (`last_started_at_ms`, `last_completed_at_ms`, `last_failed_at_ms`)

## Events ingest check

```bash
curl -sS -X POST http://127.0.0.1:8791/events \
  -H 'content-type: application/json' \
  -d '{
    "v": 1,
    "source": "vision",
    "events": [
      {
        "name": "roi_dwell",
        "ts_ms": 1730000000000,
        "severity": "medium",
        "track_id": 3,
        "data": { "roi": "front_door", "dwell_ms": 1200, "conf": 0.92 }
      }
    ]
  }'
```

## Manual job trigger (preferred)

Run compaction (canonical):

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"compaction"}'
```

Run promotion (canonical):

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"promotion"}'
```

Optional deterministic run timestamp for testing:

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"compaction","now_ms":1700000000000}'

curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d '{"job":"promotion","now_ms":1700000000000}'
```

Inspect LanceDB artifacts after a promotion run:

```bash
ls -la packages/eva/memory/long_term_memory_db/lancedb
```

## Iteration 159 verification runbook (short-term retrieval wiring)

0. **Run regression guard first**:

```bash
npm run check:respond-retrieval
```

1. **Generate a few turns** (creates `working_memory.log` records):

```bash
curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"my name is dennis"}'

curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"remember that for later"}'
```

2. **Run compaction** so rows land in short-term SQLite:

```bash
NOW_MS=$(node -e 'console.log(Date.now() + 120000)')
curl -sS -X POST http://127.0.0.1:8791/jobs/run \
  -H 'content-type: application/json' \
  -d "{\"job\":\"compaction\",\"now_ms\":${NOW_MS}}"
```

3. **Verify `short_term_summaries` rows exist**:

```bash
node - <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('packages/eva/memory/short_term_memory.db');
try {
  const rows = db.prepare('SELECT id, created_at_ms, summary_text FROM short_term_summaries ORDER BY id DESC LIMIT 5').all();
  console.log(rows);
} finally {
  db.close();
}
NODE
```

4. **Call `/respond` with a related question**:

```bash
curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"what name did I tell you earlier?"}'
```

5. **Confirm retrieval indicators in logs/traces**:

- Request trace (`packages/eva/llm_logs/openai-requests.log`) now includes:
  - `memory_context_debug.short_term.candidate_rows`
  - `memory_context_debug.short_term.selected_rows`
  - `memory_context_debug.short_term.selection_mode`
  - `memory_context_debug.short_term.fallback_used`
- Runtime log prints one retrieval-selection line per `/respond` turn:
  - `[agent] respond retrieval: short_term candidate_rows=... selected_rows=... selection_mode=... fallback_used=...`

## Respond check

```bash
curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"hello"}'
```

## Iteration 116 manual checklist (`/respond` replay continuity)

### Check A — Label correctness

1. Enable LLM trace logging (`packages/eva/llm_logs/config.json` -> `"enabled": true`).
2. Call `/respond` once:

```bash
curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"what just happened"}'
```

3. Inspect `packages/eva/llm_logs/openai-requests.log` for the corresponding `respond` request trace.

Expected:
- replayed context messages start with `WM_KIND=...`
- exactly one actionable request message starts with `CURRENT_USER_REQUEST`

### Check B — Continuity across turns

1. Send two back-to-back requests in the same session:

```bash
curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"first turn","session_id":"replay-check-1"}'

curl -sS -X POST http://127.0.0.1:8791/respond \
  -H 'content-type: application/json' \
  -d '{"text":"second turn","session_id":"replay-check-1"}'
```

2. Inspect the second request trace in `packages/eva/llm_logs/openai-requests.log`.

Expected:
- replay includes prior turn `WM_KIND=text_input` entry for `first turn`
- replay includes prior turn `WM_KIND=text_output` entry for the assistant response to `first turn`

### Check C — Memory context sections exist and are bounded

1. In the same trace record(s), inspect the `systemPrompt` text.

Expected:
- system prompt contains `Memory context (short-term + long-term; reference only):`
- memory block contains:
  - `Short-term memory context (recent + compacted; reference only):`
  - `Long-term memory context (reference only):`
  - long-term sub-sections:
    - `Traits (long-term):`
    - `Relevant experiences (retrieved):`
- system prompt includes stale/fallible-memory rule and `CURRENT_USER_REQUEST` priority rule
- memory block is bounded/compact (not an unbounded dump).

## Insight check

Insight frame assets must already exist under:

- `packages/eva/memory/working_memory_assets/`

```bash
curl -sS -X POST http://127.0.0.1:8791/insight \
  -H 'content-type: application/json' \
  -d '{
    "clip_id":"clip-1",
    "trigger_frame_id":"frame-2",
    "frames":[{"frame_id":"frame-1","ts_ms":1700000000000,"mime":"image/jpeg","asset_rel_path":"clip-1/01-frame-1.jpg"}]
  }'
```
