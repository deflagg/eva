# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 195)

- HTTP server on configured `server.port` (default `8787`)
- Optional text endpoint (when `text.enabled=true`):
  - `OPTIONS <text.path>` (default `/text`) -> `204` + CORS
  - `POST <text.path>` forwards input to Agent `POST /respond`
- Optional speech endpoint (when `speech.enabled=true`):
  - `POST <speech.path>` (default `/speech`) -> `audio/mpeg`
  - includes `X-Eva-TTS-Cache: HIT|MISS`
- Eva opens a WebSocket client to configured Vision URL:
  - key: `vision.wsUrl` (default `ws://127.0.0.1:8792/infer`)
  - this points to Python Vision service at `packages/eva/vision`
- WebSocket endpoint at configured `server.eyePath` (default `/eye`)
  - accepts binary `frame_binary` envelopes
  - forwards frames to Vision and routes `frame_events`/`error`/`insight` to UI
  - on MotionGate trigger:
    - sends `attention_start` command to Vision WS
    - force-forwards trigger frame (even if sampling would skip)
  - forwards `scene_caption` events from Vision to Executive `POST /events` (fire-and-forget)

## Runtime modes

### 1) External mode

- `subprocesses.enabled=false`
- Start Agent + Vision manually, then start Eva.

### 2) Subprocess mode

- `subprocesses.enabled=true`
- Eva starts:
  1. Agent (`subprocesses.agent`)
  2. Vision (`subprocesses.vision`)
  3. Eva server
- On shutdown, Eva stops Vision + Agent.

## Configuration (cosmiconfig + zod)

Eva loads configuration from package root with priority:

1. `eva.config.local.json`
2. `eva.config.json`

Current subprocess schema shape:

```json
{
  "subprocesses": {
    "enabled": true,
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
      "healthUrl": "http://127.0.0.1:8792/health"
    }
  }
}
```

Notes:
- `vision.wsUrl` is required.
- Runtime vision target is `ws://127.0.0.1:8792/infer`.
- Legacy pre-migration Vision implementation has been removed; `packages/eva/vision` is the only Python vision runtime.

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

```bash
cd packages/eva
npm run dev
```

Optional local override for custom vision venv path:

```json
{
  "subprocesses": {
    "vision": {
      "command": ["/absolute/path/to/packages/eva/vision/.venv/bin/python", "-m", "app.run"]
    }
  }
}
```

## Build

```bash
npm run build
```
