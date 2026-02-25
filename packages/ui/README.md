# Eva UI

React + Vite client for webcam streaming, scene-change visualization, and chat/speech controls.

## Current behavior (Iteration 131)

- Loads runtime config from:
  - `/config.local.json` first (if present)
  - fallback to `/config.json`
- Connects to Eva using configured `eva.wsUrl`
- Derives Eva HTTP base from `eva.wsUrl` for:
  - `POST /text` chat requests
  - speech endpoint requests (configured `speech.path`, default `/speech`)
- Displays connection state and log panel
- Camera streaming:
  - captures JPEG frames from `<video>` via hidden `<canvas>`
  - sends binary frame envelopes (`frame_binary` metadata + JPEG bytes)
  - keeps max 1 in-flight frame with timeout-based backpressure
  - ACKs in-flight frames on matching `frame_events.frame_id`
- Event display:
  - renders `scene_change` blob boxes on overlay canvas
  - overlay is short-lived (~1–2s TTL)
  - shows recent event feed entries from `frame_events.events[]`
- Insight panel:
  - shows latest `insight` summary/usage
  - no spoken insight narration line
- Chat + speech:
  - sends text via `POST /text`
  - renders `text_output` replies
  - auto-speak is limited to:
    - user chat replies, or
    - insight-triggered system utterances (`text_output.meta.trigger_kind === "insight"`)
  - raw frame/event traffic is not auto-spoken
  - manual speech test remains available

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
