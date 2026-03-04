# Eva + Vision + Audio + UI + Executive

This repository currently runs five primary components:

- `packages/eva` — TypeScript gateway daemon (HTTP + WebSocket)
- `packages/eva/vision` — Python WS-first vision runtime (`/infer`)
- `packages/eva/audio` — Python WS-first audio runtime (`/listen`)
- `packages/eva/executive` — Node executive/agent service
- `packages/ui` — Vite + React web client

Protocol docs/schema live in `packages/protocol`.

## Default local ports

- Eva: `http://127.0.0.1:8787`
- Vision: `http://127.0.0.1:8792`
- Audio: `http://127.0.0.1:8793`
- Executive: `http://127.0.0.1:8791`
- UI dev server: `http://127.0.0.1:5173`

## Configuration files

### Eva (cosmiconfig + zod)

- `packages/eva/eva.config.json` (committed)
- `packages/eva/eva.config.local.json` (optional local override, gitignored)

### Vision (Dynaconf)

- `packages/eva/vision/settings.yaml` (committed)
- `packages/eva/vision/settings.local.yaml` (optional local override, gitignored)

### Audio (Dynaconf)

- `packages/eva/audio/settings.yaml` (committed)
- `packages/eva/audio/settings.local.yaml` (optional local override, gitignored)

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
Audio runtime (`packages/eva/audio`) is started separately.

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

### 3) Audio

```bash
cd packages/eva/audio
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

### 4) Eva

```bash
cd packages/eva
nvm install node
nvm use node
npm install
npm run dev
```

### 5) UI

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
- UI streams `audio_binary` messages to Eva (`/audio`), and Eva forwards to Audio (`/listen`).
- Audio emits `speech_transcript` when utterance gating passes.

## Audio wake behavior (transcript + presence bypass)

- Wake activation is transcript-based (`wake.phrases`), not provider-based.
- Non-active gating is:
  - presence true/fresh (`preson_present && person_facing_me`) => accept without wake phrase
  - otherwise STT transcript must match configured wake phrase.
- See runbook: `docs/audio-transcript-wake-runbook.md`.

## Presence source of truth (final)

- Presence is produced in `insight.summary.presence` (`preson_present`, `person_facing_me`).
- Executive `/presence` is insight-backed (freshness over latest persisted insight), not `presence_update` telemetry.
- Vision no longer runs a dedicated OpenCV presence detector path.

## Regression guardrails

Run the static guardrail checks after presence/audio wake changes:

```bash
cd packages/eva
npm run check:presence-guardrails
npm run check:audio-wake-guardrails
```

`check:presence-guardrails` asserts:
- protocol insight schema still carries presence fields,
- Executive `/presence` remains insight-derived,
- Vision does not depend on OpenCV presence detector plumbing.

`check:audio-wake-guardrails` asserts:
- no `pvporcupine` dependency in audio runtime,
- no legacy wake provider keys in committed audio settings,
- no Porcupine credential/runtime references in active audio runtime surfaces,
- transcript wake docs/runbook stay aligned.

For manual transcript wake verification steps, see `docs/audio-transcript-wake-runbook.md`.
