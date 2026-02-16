# Eva (TypeScript daemon)

## Prerequisites

- `nvm`
- Node.js latest stable (Current)

## Setup

```bash
nvm install node
nvm use node
npm install
```

## Run

```bash
npm run dev
```

Eva serves:

- HTTP: `http://localhost:8787/`
- WebSocket: `ws://localhost:8787/eye`

## Build

```bash
npm run build
```

## Environment

- `EVA_PORT` (default `8787`)
- `QUICKVISION_WS_URL` (default `ws://localhost:8000/infer`)

## Iteration 1 behavior

- Sends a `hello` message immediately after WS connection.
- Echoes valid JSON messages back to the same client.
- Returns protocol `error` for malformed JSON or binary payloads.
