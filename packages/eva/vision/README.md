# Vision

Python daemon that hosts YOLO inference and (optional) insight triggering.

## Current behavior (Iteration 97)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends `hello` on connect (`role: "vision"`)
  - expects binary frame envelopes for frame payloads
  - runs YOLO inference and returns `detections`
  - supports tracking + event detectors + insight triggering
- Insight path:
  - selects clip frames (pre/trigger/post), optionally downsamples, and persists only those clip assets under `packages/eva/memory/working_memory_assets/<clip_id>/`
  - calls Agent via HTTP (`insights.agent_url`) with frame `asset_rel_path` references (no base64 in HTTP payload)
  - emits protocol `insight` on success
  - emits schema-aligned summary fields only:
    - `one_liner`, `what_changed`, `severity`, `tags`
  - strips narration-style fields (for example `tts_response`) before protocol emission
  - prunes old clip directories after each new clip write using retention settings (`insights.assets.max_clips`, `insights.assets.max_age_hours`)

## Configuration (Dynaconf)

Vision reads layered YAML config from:

- `settings.yaml` (committed defaults)
- `settings.local.yaml` (optional local override, gitignored)

Key insight settings:

- `insights.enabled`
- `insights.agent_url`
- `insights.assets_dir`
- `insights.assets.max_clips`
- `insights.assets.max_age_hours`
- `insights.timeout_ms`
- `insights.max_frames` (hard-capped at `6`)
- `insights.pre_frames`
- `insights.post_frames`
- `insights.insight_cooldown_ms`

`insights.assets_dir` defaults to `../memory/working_memory_assets` (relative to `packages/eva/vision`).

Retention defaults:
- keep newest `200` clip directories (`insights.assets.max_clips`)
- remove clip directories older than `24` hours (`insights.assets.max_age_hours`)

### ROI transition debounce

`roi.transitions.min_transition_ms` debounces ROI boundary transitions so `roi_enter` / `roi_exit` only emit after inside/outside state remains stable for at least the configured duration.

- `0` disables debounce (legacy immediate transitions)
- Recommended starting range for webcam streams: `150–300ms`
- If you still see boundary flapping, increase the value gradually (for example `350–500ms`)

Example `settings.local.yaml` ROI config:

```yaml
roi:
  enabled: true
  representative_point: centroid
  regions:
    left_half:
      x1: 0
      y1: 0
      x2: 320
      y2: 480
  lines: {}
  dwell:
    default_threshold_ms: 5000
    region_threshold_ms: {}
  transitions:
    min_transition_ms: 250
```

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
