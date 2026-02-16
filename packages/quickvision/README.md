# QuickVision

Python daemon that hosts YOLO inference.

## Current behavior (Iteration 7)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends `hello` on connect (`role: "quickvision"`)
  - validates protocol `frame` payloads with Pydantic v2
  - decodes `image_b64` JPEG payloads with Pillow + numpy
  - runs YOLO inference in a worker thread (`asyncio.to_thread(...)`)
  - returns protocol `detections` with `model: "yoloe-26"`
  - if inference already running for that connection, drops new frame with `error.code = "BUSY"`

## Environment

- `QV_PORT` (default: `8000`)
- `YOLO_DEVICE` (`auto` | `cpu` | `cuda`, default: `auto`)

### Model source behavior

QuickVision model source is hardcoded in `app/yolo.py`:

- `HARD_CODED_MODEL_SOURCE = "yolo26n.pt"`

Ultralytics will load/download this model alias automatically as needed.

### Startup behavior

QuickVision fails fast at startup if:

- hardcoded model source cannot be loaded/downloaded
- `YOLO_DEVICE` is invalid

## Run (dev)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# optional:
# export YOLO_DEVICE=cpu
# export YOLO_DEVICE=cuda
uvicorn app.main:app --reload --port 8000
```
