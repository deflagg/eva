# Eva

TypeScript daemon for UI/WebSocket orchestration.

## Current behavior (Iteration 13)

- HTTP server on configured `server.port` (default `8787`)
- Eva opens a WebSocket client to configured `quickvision.wsUrl` (default `ws://localhost:8000/infer`)
  - reconnects automatically with exponential backoff (`250ms` -> `5000ms` cap)
- WebSocket endpoint at configured `server.eyePath` (default `/eye`)
  - sends a `hello` message on connect
  - accepts **binary frame envelopes** (`frame_binary`) for camera frames
  - validates binary metadata + image length before forwarding to QuickVision
  - tracks `frame_id -> ui client` routes with 5s TTL eviction
  - routes QuickVision `detections` (and frame-scoped `error`) back to the originating client
  - forwards non-frame messages (for example `insight`) to the active UI client
  - forwards JSON `command` messages from UI to QuickVision (used for temporary `insight_test` trigger)
  - returns `QV_UNAVAILABLE` immediately when QuickVision is not connected
  - cleans up all in-flight `frame_id` routes when a UI client disconnects

### Current limitation

- Only **one UI client** is supported at a time.
- A second concurrent UI connection receives `SINGLE_CLIENT_ONLY` and is closed.

## Configuration (cosmiconfig + zod)

Eva loads configuration from the package root with this priority:

1. `eva.config.local.json` (optional local override)
2. `eva.config.json` (committed default)

Config schema:

```json
{
  "server": {
    "port": 8787,
    "eyePath": "/eye"
  },
  "quickvision": {
    "wsUrl": "ws://localhost:8000/infer"
  }
}
```

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
