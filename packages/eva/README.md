# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 4)

- HTTP server on `EVA_PORT` (default `8787`)
- Eva opens a WebSocket client to `QUICKVISION_WS_URL` (default `ws://localhost:8000/infer`)
- WebSocket endpoint at `/eye`
  - sends a `hello` message on connect
  - validates incoming payloads as JSON (`INVALID_JSON` on parse errors)
  - forwards valid UI messages to QuickVision
  - forwards QuickVision responses back to the connected UI client
  - returns `QV_UNAVAILABLE` when QuickVision is not connected

### Iteration 4 limitation

- Only **one UI client** is supported at a time.
- A second concurrent UI connection receives `SINGLE_CLIENT_ONLY` and is closed.

## Environment

- `EVA_PORT` (default: `8787`)
- `QUICKVISION_WS_URL` (default: `ws://localhost:8000/infer`)

## Run (dev)

```bash
nvm install node
nvm use node
npm install
npm run dev
```

## Build

```bash
npm run build
```
