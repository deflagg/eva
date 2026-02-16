# QuickVision

Python daemon that hosts YOLO inference and (optional) insight triggering.

## Current behavior (Iteration 13)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends `hello` on connect (`role: "quickvision"`)
  - expects **binary frame envelopes** for frame payloads
  - validates binary metadata (`frame_binary`) and byte-length consistency
  - decodes raw JPEG bytes with Pillow + numpy
  - runs YOLO inference in a worker thread (`asyncio.to_thread(...)`)
  - returns protocol `detections` with `model: "yoloe-26"`
  - if inference already running for that connection, drops new frame with `error.code = "BUSY"`
  - supports temporary debug command payload:
    - `{"type":"command","v":1,"name":"insight_test"}`
- Insight plumbing (manual trigger path):
  - keeps an in-memory frame ring buffer per WS connection
  - on `insight_test`, builds a short clip around the latest trigger frame
  - enforces insight cooldown
  - calls VisionAgent via HTTP
  - emits protocol `insight` message on success (no `frame_id` field)

## Configuration (Dynaconf)

QuickVision reads layered YAML config from:

- `settings.yaml` (committed defaults)
- `settings.local.yaml` (optional local override, gitignored)

Configured keys currently used:

- `server.host`
- `server.port`
- `yolo.model_source`
- `yolo.device` (`auto` | `cpu` | `cuda`)
- `insights.enabled` (default `false`)
- `insights.vision_agent_url`
- `insights.timeout_ms`
- `insights.max_frames` (hard-capped at `6`)
- `insights.pre_frames`
- `insights.post_frames`
- `insights.insight_cooldown_ms`

### Startup behavior

QuickVision fails fast at startup if:

- `yolo.model_source` cannot be loaded/downloaded
- `yolo.device` is invalid
- `insights.vision_agent_url` is invalid

## Run (dev)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

Alternative (still supported):

```bash
uvicorn app.main:app --reload --port 8000
```
