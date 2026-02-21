# Eva UI

React + Vite client for webcam capture and overlays.

## Current behavior (Iteration 79)

- Loads runtime config from:
  - `/config.local.json` first (if present)
  - fallback to `/config.json`
- Connects to Eva using configured `eva.wsUrl`
- Derives Eva HTTP base from `eva.wsUrl` (`ws://` -> `http://`, `wss://` -> `https://`)
  - uses `POST /text` for chat input
  - uses configured speech path (`speech.path`, default `/speech`) for speech requests
- Displays connection status (connecting/connected/disconnected)
- Shows a live log panel of inbound/outbound/system messages
- Includes a minimal chat panel:
  - input + submit button sends text to Eva `POST /text`
  - renders local `user` messages and incoming `text_output` replies
  - listens for `text_output` on existing `/eye` WebSocket
- Provides controls:
  - **Send test message**
  - **Trigger insight test** (sends `{"type":"command","v":1,"name":"insight_test"}`)
  - **Chat Auto Speak** toggle
  - **Enable Audio** (one-time unlock for browser autoplay policy)
  - **Voice** input + **Test Speak** button (calls Eva `POST /speech`)
  - **Show/Hide ROI/line overlay** (when debug overlay geometry is configured)
  - **Start camera** / **Stop camera**
  - **Start/Pause streaming**
- If browser blocks `audio.play()`, UI marks audio as locked and prompts user to click **Enable Audio**
- Auto-speaks new **chat replies** (`text_output`) when policy allows:
  - `speech.enabled=true`
  - Chat Auto Speak toggle is on
  - `speech.autoSpeak.cooldownMs` window has elapsed
  - reply text is non-empty
  - `request_id` has not already been spoken (dedupe)
- Speech source for auto-speak:
  - exactly `text_output.text`
- Speech interruption behavior:
  - starting a new speech aborts any in-flight fetch (`AbortController`)
  - pauses current audio playback
  - revokes prior blob URL
- Insight panel behavior:
  - insights are **silent factual UI updates** (no spoken line and no insight-triggered auto-speak)
  - panel shows one-liner, severity, tags, change bullets, and usage/cost summary
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
- Shows **recent event feed** from `detections.events[]`:
  - event `name`, `severity`, optional `track_id`, and compact `data` summary
- Supports optional **debug ROI/line overlay** from UI runtime config:
  - `debugOverlay.regions` (`x1,y1,x2,y2`)
  - `debugOverlay.lines` (`x1,y1,x2,y2`)

## Runtime config files

- `public/config.json` (committed)
- `public/config.local.json` (optional local override, gitignored)

Example:

```json
{
  "eva": {
    "wsUrl": "ws://localhost:8787/eye"
  },
  "speech": {
    "enabled": true,
    "path": "/speech",
    "defaultVoice": "en-US-JennyNeural",
    "autoSpeak": {
      "enabled": true,
      "minSeverity": "medium",
      "cooldownMs": 2000
    }
  },
  "debugOverlay": {
    "regions": {
      "left_half": { "x1": 0, "y1": 0, "x2": 640, "y2": 720 }
    },
    "lines": {
      "doorway": { "x1": 640, "y1": 0, "x2": 640, "y2": 720 }
    }
  }
}
```

Notes:
- `speech.autoSpeak.minSeverity` is currently retained for compatibility and is not used by chat auto-speak logic.

## Run (dev)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
