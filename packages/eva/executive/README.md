# Agent

Node/TypeScript service for EVA text + insight generation.

## Current behavior (Iteration 65)

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
  - builds retrieval context before the model call from:
    - live `wm_event` entries from the last ~2 minutes (all non-chat event sources)
    - recent short-term SQLite summaries (tag-filtered)
    - top-K long-term vector hits from LanceDB tables (`long_term_experiences` + `long_term_personality`)
    - core cache files (`core_experiences.json`, `core_personality.json`)
  - if LanceDB is empty (or no relevant hits), retrieval context includes an explicit “no relevant long-term memory found” note
  - injects retrieval context into the respond prompt with a hard budget cap (approx token-aware)
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
    "maxBodyBytes": 8388608
  },
  "secretsFile": "agent.secrets.local.json"
}
```

## Secrets

`agent.secrets.local.json` is gitignored.

Required shape:

```json
{
  "openaiApiKey": "sk-your-openai-key"
}
```

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

## Insight check

```bash
curl -sS -X POST http://127.0.0.1:8791/insight \
  -H 'content-type: application/json' \
  -d '{
    "clip_id":"clip-1",
    "trigger_frame_id":"frame-2",
    "frames":[{"frame_id":"frame-1","ts_ms":1700000000000,"mime":"image/jpeg","image_b64":"<base64-jpeg>"}]
  }'
```
