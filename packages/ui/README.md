# Eva UI

React + Vite client for webcam streaming, motion/caption observability, and chat/speech controls.

## Current behavior (Iteration 176)

- Loads runtime config from:
  - `/config.local.json` first (if present)
  - fallback to `/config.json`
- Connects to Eva using configured `eva.wsUrl`
- Derives Eva HTTP base from `eva.wsUrl` for:
  - `POST /text` chat requests
  - speech endpoint requests (configured `speech.path`, default `/speech`)
- Displays connection state and log panel

### Camera streaming

- Captures JPEG frames from `<video>` via hidden `<canvas>`
- Sends binary frame envelopes (`frame_binary` metadata + JPEG bytes)
- Keeps max 1 in-flight frame with timeout-based backpressure
- ACKs in-flight frames on matching `frame_received.frame_id`

### Motion + events

- No scene-change blob overlay rendering
- Optional debug ROI/line overlay can be toggled when configured
- Shows latest motion telemetry from `frame_received.motion`:
  - `mad`
  - `triggered`
- Shows recent event feed entries and latest caption text

### Insight panel

- Shows latest `insight` summary/usage
- Shows `summary.tts_response` as visible “Spoken line”

### Chat + speech

- Sends text via `POST /text`
- Renders `text_output` replies
- Auto-speak is limited to:
  - user chat replies, or
  - insight-triggered system utterances (`text_output.meta.trigger_kind === "insight"`)
- All other system `text_output` messages are intentionally not auto-spoken
- Raw frame/event traffic is not auto-spoken
- Manual speech test remains available

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
  }
}
```

Notes:
- `speech.autoSpeak.minSeverity` is retained for compatibility and is not used by chat auto-speak logic.

## Run (dev)

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
