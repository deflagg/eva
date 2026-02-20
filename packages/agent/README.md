# Agent

Node/TypeScript service for EVA text + insight generation.

## Current behavior (Iteration 46)

- Loads config via `cosmiconfig` + `zod`.
- Resolves `memory.dir` relative to the loaded config file path.
- Exposes `GET /health`.
- Exposes deterministic stub `POST /insight`:
  - requires `Content-Type: application/json`
  - enforces `insight.maxBodyBytes`
  - validates minimal payload shape (`frames` non-empty)
  - returns stable `summary` + `usage` response shape.

## Configuration

Config search order (package root):

1. `agent.config.local.json` (optional, gitignored)
2. `agent.config.json` (committed defaults)

Default config (`agent.config.json`):

```json
{
  "server": { "port": 8791 },
  "memory": { "dir": "../eva/memory" },
  "insight": { "maxBodyBytes": 8388608 },
  "secretsFile": "agent.secrets.local.json"
}
```

## Secrets

`agent.secrets.local.json` is gitignored and reserved for API keys in later iterations.

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

## Insight stub check

```bash
curl -sS -X POST http://127.0.0.1:8791/insight \
  -H 'content-type: application/json' \
  -d '{
    "clip_id":"clip-1",
    "trigger_frame_id":"frame-2",
    "frames":[{"frame_id":"frame-1","ts_ms":1700000000000,"mime":"image/jpeg","image_b64":"ZmFrZQ=="}]
  }'
```
