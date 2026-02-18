# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 27)

- HTTP server on configured `server.port` (default `8787`)
- Eva opens a WebSocket client to configured `quickvision.wsUrl` (default `ws://localhost:8000/infer`)
  - reconnects automatically with exponential backoff (`250ms` -> `5000ms` cap)
- WebSocket endpoint at configured `server.eyePath` (default `/eye`)
  - sends a `hello` message on connect
  - accepts **binary frame envelopes** (`frame_binary`) for camera frames
  - validates binary metadata + image length before forwarding to QuickVision
  - tracks `frame_id -> ui client` routes with 5s TTL eviction
  - routes QuickVision `detections` (and frame-scoped `error`) back to the originating client
  - forwards non-frame messages (for example `insight`) to the active UI client
  - applies insight relay guardrails for `insight` messages:
    - optional relay enable/disable (`insightRelay.enabled`)
    - relay cooldown (`insightRelay.cooldownMs`)
    - clip-id dedupe window (`insightRelay.dedupeWindowMs`)
  - forwards JSON `command` messages from UI to QuickVision (used for temporary `insight_test` trigger)
  - returns `QV_UNAVAILABLE` immediately when QuickVision is not connected
  - cleans up all in-flight `frame_id` routes when a UI client disconnects

### Current limitation

- Only **one UI client** is supported at a time.
- A second concurrent UI connection receives `SINGLE_CLIENT_ONLY` and is closed.

## Runtime modes

Eva supports two run modes.

### 1) External mode (status quo, default)

- `subprocesses.enabled` is `false` by default.
- You start QuickVision + VisionAgent manually, then start Eva.
- Eva behaves exactly like pre-subprocess iterations.

### 2) Subprocess mode (one command boots the stack)

- Set `subprocesses.enabled=true` in `eva.config.local.json`.
- Eva will:
  1. start VisionAgent and wait for `GET /health` = 200
  2. start QuickVision and wait for `GET /health` = 200
  3. start Eva server
- On shutdown (`Ctrl+C` / `SIGTERM`), Eva stops QuickVision + VisionAgent (no orphan daemons).

## Configuration (cosmiconfig + zod)

Eva loads configuration from the package root with this priority:

1. `eva.config.local.json` (optional local override)
2. `eva.config.json` (committed default)

Current schema:

```json
{
  "server": {
    "port": 8787,
    "eyePath": "/eye"
  },
  "quickvision": {
    "wsUrl": "ws://localhost:8000/infer"
  },
  "insightRelay": {
    "enabled": true,
    "cooldownMs": 10000,
    "dedupeWindowMs": 60000
  },
  "subprocesses": {
    "enabled": false,
    "visionAgent": {
      "enabled": true,
      "cwd": "packages/vision-agent",
      "command": ["npm", "run", "dev"],
      "healthUrl": "http://127.0.0.1:8790/health",
      "readyTimeoutMs": 30000,
      "shutdownTimeoutMs": 5000
    },
    "quickvision": {
      "enabled": true,
      "cwd": "packages/quickvision",
      "command": ["python", "-m", "app.run"],
      "healthUrl": "http://127.0.0.1:8000/health",
      "readyTimeoutMs": 60000,
      "shutdownTimeoutMs": 10000
    }
  }
}
```

## One-time prerequisites

### VisionAgent

```bash
cd packages/vision-agent
nvm install node
nvm use node
npm install
cp vision-agent.secrets.local.example.json vision-agent.secrets.local.json
# then edit vision-agent.secrets.local.json with a valid openaiApiKey
```

### QuickVision

```bash
cd packages/quickvision
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

## External mode run (manual daemons)

1. Start VisionAgent:

```bash
cd packages/vision-agent
npm run dev
```

2. Start QuickVision:

```bash
cd packages/quickvision
source .venv/bin/activate
python -m app.run
```

3. Start Eva:

```bash
cd packages/eva
npm run dev
```

## Subprocess mode run (one command)

1. Copy local subprocess config:

```bash
cd packages/eva
cp eva.config.local.example.json eva.config.local.json
```

2. (If needed) update QuickVision command to your venv python in `eva.config.local.json`:

```json
{
  "subprocesses": {
    "quickvision": {
      "command": ["/absolute/path/to/packages/quickvision/.venv/bin/python", "-m", "app.run"]
    }
  }
}
```

3. Start stack from Eva:

```bash
cd packages/eva
npm run dev
```

4. Verify:

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8787/
```

## Build

```bash
npm run build
```

## Troubleshooting

- `ModuleNotFoundError: No module named 'uvicorn'` when Eva starts QuickVision:
  - QuickVision deps are not installed in the Python runtime used by `subprocesses.quickvision.command`.
  - Fix by activating/installing `.venv`, or point command to `.venv/bin/python` explicitly.
