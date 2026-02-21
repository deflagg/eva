# Eva + Vision + UI + Agent

This repository hosts four components:

- `packages/eva` — TypeScript daemon (HTTP/WebSocket gateway)
- `packages/eva/vision` — Python FastAPI daemon (vision inference service)
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

If Vision fails to start because `python` is not the venv interpreter, set `subprocesses.quickvision.command` in `eva.config.local.json` to `packages/eva/vision/.venv/bin/python -m app.run`.

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

Implemented through **Iteration 86**.

Key current behavior:
- Insight protocol/UI is **silent + factual** (`one_liner`, `what_changed`, `tags`, severity/ids/usage).
- Narration text is internal-only working memory (`wm_insight.narration`, executive single-writer path).
- UI auto-speaks **chat replies** (`text_output.text`) via `/speech`.
- Executive supports hot-toggleable local LLM trace logging (`packages/eva/llm_logs/config.json`) with redaction/truncation safeguards.

> **Hard cutover note:** Long-term memory is now LanceDB. Existing JSON long-term memory is not used.
