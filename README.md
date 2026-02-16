# Eva + QuickVision + UI

This repository hosts three components:

- `packages/eva` — TypeScript daemon (HTTP/WebSocket gateway)
- `packages/quickvision` — Python FastAPI daemon (vision inference service)
- `packages/ui` — Vite + React web client

Protocol docs/schema are in `packages/protocol`.

## Defaults

- Eva: `http://localhost:8787`
- QuickVision: `http://localhost:8000`
- UI dev server: `http://127.0.0.1:5173`

## Environment Variables

### Eva

- `EVA_PORT` (default `8787`)
- `QUICKVISION_WS_URL` (default `ws://localhost:8000/infer`)

### QuickVision

- `QV_PORT` (default `8000`)
- `YOLO_DEVICE` (`auto|cpu|cuda`, default `auto`)

QuickVision model source is hardcoded in `packages/quickvision/app/yolo.py` as `yolo26n.pt`.

## Development Run Instructions

### 1) Eva (TypeScript)

```bash
cd packages/eva
nvm install node
nvm use node
npm install
npm run dev
```

### 2) QuickVision (Python)

```bash
cd packages/quickvision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# optional: export YOLO_DEVICE=cpu
# optional: export YOLO_DEVICE=cuda
uvicorn app.main:app --reload --port 8000
```

### 3) UI (React + Vite)

```bash
cd packages/ui
npm install
npm run dev
```

## Status

Implemented through **Iteration 7** (real YOLO inference in QuickVision).
