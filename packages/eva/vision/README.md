# Vision

Python daemon that performs **scene-change detection** and emits `frame_events`.

This service no longer runs YOLO/tracking/object detectors.

## Current behavior (Iteration 127)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends protocol `hello` on connect (`role: "vision"`)
  - expects binary frame envelopes (`frame_binary` metadata + JPEG bytes)
  - responds once per frame with `frame_events` (same `frame_id`)
  - `events[]` contains zero or more `scene_change` events
- Insight path:
  - keeps clip buffer (pre/trigger/post frames)
  - optionally downsamples + persists clip assets under `packages/eva/memory/working_memory_assets/<clip_id>/`
  - calls Agent via HTTP (`insights.agent_url`) using `asset_rel_path` references
  - emits protocol `insight` on success

## Scene-change algorithm knobs

Configured in `settings.yaml` / `settings.local.yaml` under `scene_change`:

- `enabled`
- `downsample.max_dim`
- `ema_alpha`
- `pixel_threshold`
- `cell_px`
- `cell_active_ratio`
- `min_blob_cells`
- `score_threshold`
- `min_persist_frames`
- `cooldown_ms`
- `severity.medium_score`
- `severity.high_score`

Practical tuning guidance:

- **Too chatty / false positives**
  - increase `pixel_threshold`
  - increase `score_threshold`
  - increase `min_persist_frames`
  - increase `cooldown_ms`
- **Missing obvious changes**
  - decrease `pixel_threshold`
  - decrease `score_threshold`
  - decrease `min_persist_frames`
- **Blobs too coarse/fine**
  - adjust `cell_px` (larger = coarser)
  - adjust `cell_active_ratio`

## Other config sections

- `insights.*` controls clip building + Agent call behavior.
- `surprise.*` controls auto-insight triggering from events.

## Run (dev)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

Alternative:

```bash
uvicorn app.main:app --reload --port 8000
```
