# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 9)

- HTTP server on `EVA_PORT` (default `8787`)
- Eva opens a WebSocket client to `QUICKVISION_WS_URL` (default `ws://localhost:8000/infer`)
  - reconnects automatically with exponential backoff (`250ms` -> `5000ms` cap)
- WebSocket endpoint at `/eye`
  - sends a `hello` message on connect
  - accepts **binary frame envelopes** (`frame_binary`) for camera frames
  - validates binary metadata + image length before forwarding to QuickVision
  - tracks `frame_id -> ui client` routes with 5s TTL eviction
  - routes QuickVision `detections` (and frame-scoped `error`) back to the originating client
  - returns `QV_UNAVAILABLE` immediately when QuickVision is not connected
  - cleans up all in-flight `frame_id` routes when a UI client disconnects

### Current limitation

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
