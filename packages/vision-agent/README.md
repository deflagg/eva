# VisionAgent

Node daemon for clip-level insight summaries via pi-ai tool calling.

## Current behavior (Iteration 12)

- Validates configured provider/model at startup (fail-fast on invalid model config)
- HTTP `GET /health`
- HTTP `POST /insight`
  - accepts a short clip payload (`frames[]` with base64 JPEG images)
  - sends frames to configured model via `@mariozechner/pi-ai`
  - forces structured tool call output (`submit_insight`) with:
    - `one_liner`
    - `tts_response`
    - `what_changed[]`
    - `severity`
    - `tags[]`
  - returns:
    - `summary`
    - `usage` (`input_tokens`, `output_tokens`, `cost_usd`)

### `summary.tts_response` contract

- required non-empty string
- 1-2 spoken-friendly sentences
- no tags/IDs/telemetry/cost text
- severity-aware tone (calm for low, urgent for high)

## Guardrails

- Max request body bytes (`guardrails.maxBodyBytes`) -> `413 PAYLOAD_TOO_LARGE`
- Max frames (`guardrails.maxFrames`, hard-capped at 6) -> `400 TOO_MANY_FRAMES`
- Cooldown between insight requests (`guardrails.cooldownMs`) -> `429 COOLDOWN_ACTIVE`

## Configuration (cosmiconfig + zod)

VisionAgent loads config from package root, local override first:

1. `vision-agent.config.local.json` (optional, gitignored)
2. `vision-agent.config.json` (committed default)

Default config (`vision-agent.config.json`):

```json
{
  "server": {
    "port": 8790
  },
  "model": {
    "provider": "openai",
    "id": "gpt-4o-mini"
  },
  "guardrails": {
    "cooldownMs": 5000,
    "maxFrames": 6,
    "maxBodyBytes": 8388608
  },
  "secretsFile": "vision-agent.secrets.local.json"
}
```

## Secrets

VisionAgent reads API key from a local secrets JSON file.

- Required: `vision-agent.secrets.local.json` (gitignored)
- Example: `vision-agent.secrets.local.example.json`

Example:

```json
{
  "openaiApiKey": "sk-your-openai-key"
}
```

## Run (dev)

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

## Example requests

Health:

```bash
curl -s http://localhost:8790/health
```

Insight:

```bash
curl -s http://localhost:8790/insight \
  -H 'Content-Type: application/json' \
  -d '{
    "clip_id": "clip-1",
    "trigger_frame_id": "frame-2",
    "frames": [
      { "frame_id": "frame-1", "mime": "image/jpeg", "image_b64": "<base64-jpeg>" },
      { "frame_id": "frame-2", "mime": "image/jpeg", "image_b64": "<base64-jpeg>" }
    ]
  }'
```
