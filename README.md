# Eva + QuickVision + UI

Iteration 0 scaffolding for a 3-process system:

- `packages/eva` — TypeScript daemon (Node + ws + zod)
- `packages/quickvision` — Python daemon (FastAPI + Ultralytics stack)
- `packages/ui` — Vite + React + TypeScript web UI
- `packages/protocol` — protocol docs and JSON schema

## Ports (defaults)

- Eva: `8787`
- QuickVision: `8000`
- UI dev server: `5173`

## Environment variables

### Eva

- `EVA_PORT=8787`
- `QUICKVISION_WS_URL=ws://localhost:8000/infer`

### QuickVision

- `QV_PORT=8000`
- `YOLO_MODEL_PATH=<path to yoloe-26 weights>`
- `YOLO_DEVICE=auto|cpu|cuda` (default: `auto`)

## Run Eva

```bash
cd packages/eva
nvm install node
nvm use node
npm install
npm run dev
```

## Run QuickVision

```bash
cd packages/quickvision
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Run UI

```bash
cd packages/ui
npm install
npm run dev
```

## Current status

- Iteration 0 complete: scaffolding + protocol docs/schema.
- Iteration 1 complete: Eva `/eye` WebSocket endpoint with `hello` + JSON echo + parse-error responses.
- Iteration 2 complete: UI connects to Eva, shows connection state, logs messages, and sends a test JSON payload.
- QuickVision is still a scaffold and will be expanded in upcoming iterations.
