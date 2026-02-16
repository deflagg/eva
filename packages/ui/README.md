# Eva UI

React + Vite client for webcam capture and overlays.

## Current behavior (Iteration 13)

- Loads runtime config from:
  - `/config.local.json` first (if present)
  - fallback to `/config.json`
- Connects to Eva using configured `eva.wsUrl`
- Displays connection status (connecting/connected/disconnected)
- Shows a live log panel of inbound/outbound/system messages
- Provides controls:
  - **Send test message**
  - **Trigger insight test** (sends `{"type":"command","v":1,"name":"insight_test"}`)
  - **Start camera** / **Stop camera**
  - **Start/Pause streaming**
- Captures JPEG frames from the video stream via a hidden `<canvas>`
- Sends frames as **binary WebSocket envelopes**:
  - 4-byte big-endian metadata length
  - metadata JSON (`type: "frame_binary"`)
  - raw JPEG bytes
- Applies v1 backpressure:
  - at most **one in-flight frame**
  - ACKs only on matching `detections.frame_id`
  - non-detection messages (including `error`/`insight`) do not clear in-flight state
  - drops in-flight frame after `500ms` timeout
- Draws detection boxes on an overlay `<canvas>` above the video using protocol scaling:
  - `scaleX = video.clientWidth / frame.width`
  - `scaleY = video.clientHeight / frame.height`
  - `drawRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY)`
- Shows frame counters and latest detection count/model
- Logs protocol extension payloads (for example `detections.events[]` and `insight`)

## Runtime config files

- `public/config.json` (committed)
- `public/config.local.json` (optional local override, gitignored)

Example:

```json
{
  "eva": {
    "wsUrl": "ws://localhost:8787/eye"
  }
}
```

## Run (dev)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
