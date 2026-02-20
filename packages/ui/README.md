# Eva UI

React + Vite client for webcam capture and overlays.

## Current behavior (Iteration 54)

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
  - **Auto Speak** toggle (defaults ON)
  - **Enable Audio** (one-time unlock for browser autoplay policy)
  - **Voice** input + **Test Speak** button (calls Eva `POST /speech`)
  - **Show/Hide ROI/line overlay** (when debug overlay geometry is configured)
  - **Start camera** / **Stop camera**
  - **Start/Pause streaming**
- If browser blocks `audio.play()`, UI marks audio as locked and prompts user to click **Enable Audio**
- Auto-speaks new `insight` messages when policy allows:
  - `speech.enabled=true`
  - Auto Speak toggle is on
  - insight severity >= `speech.autoSpeak.minSeverity` (`low`, `medium`, or `high`)
  - cooldown window (`speech.autoSpeak.cooldownMs`) has elapsed
  - resolved speech text is non-empty
- Auto-speak spoken text source:
  - exactly `insight.summary.tts_response`
  - UI does not generate fallback narration from other fields
- Speech interruption behavior:
  - starting a new speech aborts any in-flight fetch (`AbortController`)
  - pauses current audio playback
  - revokes prior blob URL
  - guards duplicate speaking of same insight with `lastSpokenInsightId`
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
- Shows **latest insight panel** from `insight` messages:
  - one-liner, severity, tags, change bullets, usage/cost summary
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

## Run (dev)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
