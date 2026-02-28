# Eva + Vision + UI + Agent

This repository hosts four components:

- `packages/eva` — TypeScript daemon (HTTP/WebSocket gateway)
- `packages/eva/vision` — Python FastAPI daemon (Tier-2 insight relay; scene-change path removed)
- `packages/eva/executive` — Node daemon (insight/text model service)
- `packages/ui` — Vite + React web client

Protocol docs/schema are in `packages/protocol`.

## Defaults

- Eva: `http://localhost:8787`
- Vision: `http://localhost:8000`
- Agent: `http://localhost:8791`
- UI dev server: `http://127.0.0.1:5173`

## Configuration files

### Eva (cosmiconfig + zod)

- `packages/eva/eva.config.json` (committed)
- `packages/eva/eva.config.local.json` (optional local override, gitignored)

### Vision (Dynaconf)

- `packages/eva/vision/settings.yaml` (committed)
- `packages/eva/vision/settings.local.yaml` (optional local override, gitignored)

### Agent (cosmiconfig + zod)

- `packages/eva/executive/agent.config.json` (committed)
- `packages/eva/executive/agent.config.local.json` (optional local override, gitignored)
- `packages/eva/executive/agent.secrets.local.json` (required local secrets file, gitignored)

### Executive LLM trace logging (hot-toggle local config)

- `packages/eva/llm_logs/config.example.json` (committed template)
- `packages/eva/llm_logs/config.json` (local runtime toggle, gitignored)
- default output: `packages/eva/llm_logs/openai-requests.log` (gitignored JSONL)

### UI runtime config

- `packages/ui/public/config.json` (committed)
- `packages/ui/public/config.local.json` (optional local override, gitignored)

## One-command stack boot (Eva subprocess mode)

After one-time dependency setup (Node deps + Vision venv + Agent secrets), you can boot Eva + Agent + Vision from one command:

```bash
cd packages/eva
cp eva.config.local.example.json eva.config.local.json
npm run dev
```

If Vision fails to start because your venv python path differs, set `subprocesses.vision.command` in `eva.config.local.json` to your venv interpreter (for example: `packages/eva/vision/.venv/bin/python -m app.run`).

## Development Run Instructions

### 1) Agent (TypeScript + pi-ai)

```bash
cd packages/eva/executive
nvm install node
nvm use node
npm install
npm run dev
```

### 2) Vision (Python)

```bash
cd packages/eva/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

Alternative (still supported):

```bash
uvicorn app.main:app --reload --port 8000
```

### 3) Eva (TypeScript)

```bash
cd packages/eva
nvm install node
nvm use node
npm install
npm run dev
```

### 4) UI (React + Vite)

```bash
cd packages/ui
npm install
npm run dev
```

## Status

Implemented through **Iteration 176**.

Key current behavior:
- Tier-0 motion detection now runs in Eva (`motionGate`) using grayscale thumbnail MAD + hysteresis/cooldown.
- Tier-1 captions are triggered by Motion Gate (not Vision scene-change events).
- Vision no longer computes/emits scene-change blobs; forwarded `frame_events` currently contain no detector events.
- UI no longer renders blob overlays; it shows latest motion telemetry (`mad`, `triggered`) and latest caption text.
- Eva emits immediate receipt ACKs (`frame_received`) on frame ingress and keeps bounded broker guardrails.
- Tier-1 `scene_caption` events are still persisted to Executive `/events` (`source: "caption"`).
- Auto-insights from detector events are currently disabled (manual `insight_test` path remains).

### Streaming ACK model: receipt ACK vs processing events

- **`frame_received`** (Eva -> UI) means Eva accepted/rejected ingress for that frame.
  - Clears UI in-flight slot.
  - Drives receipt counters/latency.
  - Includes broker metadata (`accepted`, `queue_depth`, `dropped`).
- **`frame_events`** (Vision -> Eva -> UI, plus synthetic caption events from Eva) carries processing/event output for forwarded frames.
  - Drives UI event/caption display.
  - Does **not** control stream pacing.

### Interpreting UI counters

- `Frames sent`: binary frames attempted from UI.
- `receipts`: frames accepted by Eva ingress (`frame_received.accepted=true`).
- `dropped by broker`: ingress rejections (`frame_received.accepted=false`).
- `timed out`: receipt not observed before UI timeout window.
- `last receipt latency`: time from send -> receipt ACK (Eva ingress latency), not Vision inference latency.
