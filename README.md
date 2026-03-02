# Eva + Vision + UI + Executive

This repository currently runs four primary components:

- `packages/eva` — TypeScript gateway daemon (HTTP + WebSocket)
- `packages/eva/vision` — Python WS-first vision runtime (`/infer`)
- `packages/eva/executive` — Node executive/agent service
- `packages/ui` — Vite + React web client

Protocol docs/schema live in `packages/protocol`.

## Default local ports

- Eva: `http://127.0.0.1:8787`
- Vision: `http://127.0.0.1:8792`
- Executive: `http://127.0.0.1:8791`
- UI dev server: `http://127.0.0.1:5173`

## Configuration files

### Eva (cosmiconfig + zod)

- `packages/eva/eva.config.json` (committed)
- `packages/eva/eva.config.local.json` (optional local override, gitignored)

### Vision (Dynaconf)

- `packages/eva/vision/settings.yaml` (committed)
- `packages/eva/vision/settings.local.yaml` (optional local override, gitignored)

### Executive (cosmiconfig + zod)

- `packages/eva/executive/agent.config.json` (committed)
- `packages/eva/executive/agent.config.local.json` (optional local override, gitignored)
- `packages/eva/executive/agent.secrets.local.json` (required local secrets file, gitignored)

### UI runtime config

- `packages/ui/public/config.json` (committed)
- `packages/ui/public/config.local.json` (optional local override, gitignored)

## One-command stack boot (Eva subprocess mode)

After one-time dependency setup, boot Agent + Vision + Eva from one command:

```bash
cd packages/eva
npm run dev
```

If your Python path differs, override `subprocesses.vision.command` in `eva.config.local.json`.

## Development run instructions

### 1) Executive

```bash
cd packages/eva/executive
nvm install node
nvm use node
npm install
npm run dev
```

### 2) Vision

```bash
cd packages/eva/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

### 3) Eva

```bash
cd packages/eva
nvm install node
nvm use node
npm install
npm run dev
```

### 4) UI

```bash
cd packages/ui
npm install
npm run dev
```

## Runtime flow (high level)

- UI streams `frame_binary` messages to Eva (`/eye`).
- Eva emits immediate `frame_received` ingress ACKs.
- MotionGate trigger in Eva sends `attention_start` and force-forwards trigger frame to Vision WS.
- Vision emits `frame_events` (`scene_caption`) and `insight` messages.
- Eva forwards `scene_caption` events to Executive `/events` (fire-and-forget).
