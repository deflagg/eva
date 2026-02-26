# Agent

Node/TypeScript service for EVA text + insight generation.

## Current behavior (Iteration 116)

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
- Exposes `POST /jobs/hourly`:
  - reads `packages/eva/memory/working_memory.log` under the same write queue used by `/respond`
  - selects entries older than 60 minutes
  - creates 3-5 short bullet summaries (vision insights, high-surprise chat, chat highlights)
  - inserts bullets into SQLite `packages/eva/memory/short_term_memory.db`
  - atomically rewrites working memory log to keep only the last 60 minutes
- Exposes `POST /jobs/daily`:
  - reads yesterday's rows from `packages/eva/memory/short_term_memory.db`
  - upserts long-term vectors into LanceDB tables:
    - `long_term_experiences`
    - `long_term_personality`
    - LanceDB dir: `packages/eva/memory/long_term_memory_db/lancedb`
  - updates stable cache artifacts:
    - `packages/eva/memory/cache/core_experiences.json`
    - `packages/eva/memory/cache/core_personality.json`
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
  - calls model through `@mariozechner/pi-ai` tool loop (`commit_text_response`)
  - enforces concept whitelist from `packages/eva/memory/experience_tags.json`
    - unknown concepts are dropped and logged
  - writes memory artifacts on each successful response:
    - appends `text_input` + `text_output` JSONL entries to `packages/eva/memory/working_memory.log`
    - updates `packages/eva/memory/cache/personality_tone.json`
  - serializes memory writes through a queue/mutex to avoid JSONL corruption under rapid requests
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
  "secretsFile": "agent.secrets.local.json"
}
```

`insight.ttsStyle` controls reaction intensity for generated `summary.tts_response`:
- `clean` (default): soft language (for example: "what the heck", "what was that")
- `spicy`: allows occasional mild profanity for emphasis (never slurs/harassment)

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

## Health check

```bash
curl -s http://127.0.0.1:8791/health
```

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

## Hourly worker check

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/hourly
```

Optional deterministic run timestamp for testing:

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/hourly \
  -H 'content-type: application/json' \
  -d '{"now_ms":1700000000000}'
```

## Daily worker check

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/daily
```

Optional deterministic run timestamp for testing:

```bash
curl -sS -X POST http://127.0.0.1:8791/jobs/daily \
  -H 'content-type: application/json' \
  -d '{"now_ms":1700000000000}'
```

Inspect LanceDB artifacts after a run:

```bash
ls -la packages/eva/memory/long_term_memory_db/lancedb
```

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

### Check C — No derived memory section in system prompt

1. In the same trace record(s), inspect the `systemPrompt` text.

Expected:
- system prompt does **not** contain any `Retrieved memory context ...` section
- system prompt includes WM/CURRENT interpretation rules (`WM_KIND=` vs `CURRENT_USER_REQUEST`).

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
