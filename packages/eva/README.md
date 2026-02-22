# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 102)

- HTTP server on configured `server.port` (default `8787`)
- Optional text endpoint (when `text.enabled=true`):
  - `OPTIONS <text.path>` (default `/text`) -> `204` + CORS
  - `POST <text.path>` forwards input to Agent `POST /respond`
    - request JSON: `{ "text": "...", "session_id": "optional", "source": "ui" }`
    - response JSON + WS payload shape: `text_output`
    - guardrails: `maxBodyBytes`, `maxTextChars`, agent timeout/error mapping
- Optional speech endpoint (when `speech.enabled=true`):
  - `POST <speech.path>` (default `/speech`) -> `audio/mpeg` bytes
    - supports request guardrails (`maxBodyBytes`, `maxTextChars`, cooldown)
    - includes `X-Eva-TTS-Cache: HIT|MISS` header
- Eva opens a WebSocket client to configured Vision URL:
  - key: `vision.wsUrl` (default `ws://localhost:8000/infer`)
- WebSocket endpoint at configured `server.eyePath` (default `/eye`)
  - sends a `hello` message on connect
  - accepts binary frame envelopes (`frame_binary`) for camera frames
  - forwards frames to Vision and routes detections/errors/insights back to UI
  - when `detections.events[]` is present, forwards events to Executive `POST /events` (fire-and-forget)
  - forwards JSON `command` messages from UI (`insight_test`)
  - returns `QV_UNAVAILABLE` when Vision is not connected

## Push alerts (high-severity)

Eva now emits push-mode alerts to the connected UI when high-severity signals arrive from Vision.

### What triggers push-mode alerts

- High insight:
  - incoming `insight` where `summary.severity === "high"`
  - Eva pushes `text_output` immediately and then `speech_output` (when speech is enabled).
- High detector event:
  - incoming `detections.events[]` entries where `event.severity === "high"`
  - Eva pushes `text_output` immediately and then `speech_output` (when speech is enabled).

### Guardrails (anti-spam)

Push alerts are independent from raw insight relay suppression.

- Cooldown: `HIGH_ALERT_COOLDOWN_MS = 10000`
- Dedupe window: `HIGH_ALERT_DEDUPE_WINDOW_MS = 60000`
- Dedupe keys:
  - insight: `insight:<clip_id>`
  - event: `event:<event_name>:<track_id|na>`

### Audio unlock in UI

Browsers can block autoplay audio until a user gesture occurs.

- In the UI, click **Enable Audio** once per tab/session.
- After unlock, incoming `speech_output` push alerts play immediately.

## Runtime modes

### 1) External mode (default)

- `subprocesses.enabled=false`
- Start Agent + Vision manually, then start Eva.

### 2) Subprocess mode (one command boots stack)

- Set `subprocesses.enabled=true`.
- Eva will:
  1. start Agent and wait for `GET /health` = 200
  2. start Vision and wait for `GET /health` = 200
  3. start Eva server
- On shutdown, Eva stops Vision + Agent.

## Configuration (cosmiconfig + zod)

Eva loads configuration from package root with priority:

1. `eva.config.local.json`
2. `eva.config.json`

Current schema (abridged):

```json
{
  "server": {
    "port": 8787,
    "eyePath": "/eye"
  },
  "vision": {
    "wsUrl": "ws://localhost:8000/infer"
  },
  "agent": {
    "baseUrl": "http://127.0.0.1:8791",
    "timeoutMs": 30000
  },
  "text": {
    "enabled": true,
    "path": "/text",
    "maxBodyBytes": 16384,
    "maxTextChars": 4000
  },
  "subprocesses": {
    "enabled": false,
    "agent": {
      "enabled": true,
      "cwd": "packages/eva/executive",
      "command": ["npm", "run", "dev"],
      "healthUrl": "http://127.0.0.1:8791/health"
    },
    "vision": {
      "enabled": true,
      "cwd": "packages/eva/vision",
      "command": [".venv/bin/python", "-m", "app.run"],
      "healthUrl": "http://127.0.0.1:8000/health"
    }
  }
}
```

Notes:
- `vision.wsUrl` is required.

## One-time prerequisites

### Agent

```bash
cd packages/eva/executive
nvm install node
nvm use node
npm install
# ensure agent.secrets.local.json contains a valid openaiApiKey
```

### Vision

```bash
cd packages/eva/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Eva

```bash
cd packages/eva
nvm install node
nvm use node
npm install
```

## External mode run

1. Start Agent:

```bash
cd packages/eva/executive
npm run dev
```

2. Start Vision:

```bash
cd packages/eva/vision
source .venv/bin/activate
python -m app.run
```

3. Start Eva:

```bash
cd packages/eva
npm run dev
```

## Subprocess mode run

1. Copy local subprocess config:

```bash
cd packages/eva
cp eva.config.local.example.json eva.config.local.json
```

2. (If needed) point Vision command to your venv python in `eva.config.local.json`:

```json
{
  "subprocesses": {
    "vision": {
      "command": ["/absolute/path/to/packages/eva/vision/.venv/bin/python", "-m", "app.run"]
    }
  }
}
```

3. Start stack from Eva:

```bash
cd packages/eva
npm run dev
```

## Build

```bash
npm run build
```
