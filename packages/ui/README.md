# Eva UI

React + Vite client for webcam capture and overlays.

## Current behavior (Iteration 6)

- Connects to Eva at `ws://localhost:8787/eye`
- Displays connection status (connecting/connected/disconnected)
- Shows a live log panel of inbound/outbound/system messages
- Provides camera controls:
  - **Start camera** / **Stop camera**
  - live `<video>` preview
- Captures JPEG frames from the video stream via a hidden `<canvas>`
- Sends protocol `frame` messages (`image_b64` without data URL prefix)
- Applies v1 backpressure:
  - at most **one in-flight frame**
  - waits for matching `frame_id` response or drops after `500ms`
- Draws detection boxes on an overlay `<canvas>` above the video using protocol scaling:
  - `scaleX = video.clientWidth / frame.width`
  - `scaleY = video.clientHeight / frame.height`
  - `drawRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY)`
- Shows frame counters and latest detection count/model

## Run (dev)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
