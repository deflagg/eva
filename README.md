# Eva + QuickVision + UI

This repository hosts four components:

- `packages/eva` — TypeScript daemon (HTTP/WebSocket gateway)
- `packages/quickvision` — Python FastAPI daemon (vision inference service)
- `packages/vision-agent` — Node daemon (clip insight summaries via pi-ai tool calling)
- `packages/ui` — Vite + React web client

Protocol docs/schema are in `packages/protocol`.

## Defaults

- Eva: `http://localhost:8787`
- QuickVision: `http://localhost:8000`
- UI dev server: `http://127.0.0.1:5173`

## Configuration files

### Eva (cosmiconfig + zod)

- `packages/eva/eva.config.json` (committed)
- `packages/eva/eva.config.local.json` (optional local override, gitignored)

### QuickVision (Dynaconf)

- `packages/quickvision/settings.yaml` (committed)
- `packages/quickvision/settings.local.yaml` (optional local override, gitignored)

### VisionAgent (cosmiconfig + zod)

- `packages/vision-agent/vision-agent.config.json` (committed)
- `packages/vision-agent/vision-agent.config.local.json` (optional local override, gitignored)
- `packages/vision-agent/vision-agent.secrets.local.json` (required local secrets file, gitignored)
- `packages/vision-agent/vision-agent.secrets.local.example.json` (example)

### UI runtime config

- `packages/ui/public/config.json` (committed)
- `packages/ui/public/config.local.json` (optional local override, gitignored)

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
python -m app.run
```

Alternative (still supported):

```bash
uvicorn app.main:app --reload --port 8000
```

### 3) VisionAgent (TypeScript + pi-ai)

```bash
cd packages/vision-agent
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

Implemented through **Iteration 13** (QuickVision insight plumbing: frame ring buffer, `insight_test` command trigger, VisionAgent HTTP call, and insight relay).
