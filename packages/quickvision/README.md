# QuickVision

Python daemon that hosts YOLO inference and (optional) insight triggering.

## Current behavior (Iteration 20)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends `hello` on connect (`role: "quickvision"`)
  - expects **binary frame envelopes** for frame payloads
  - validates binary metadata (`frame_binary`) and byte-length consistency
  - decodes raw JPEG bytes with Pillow + numpy
  - runs YOLO inference in a worker thread (`asyncio.to_thread(...)`)
  - returns protocol `detections` with `model: "yoloe-26"`
  - supports optional tracking mode using Ultralytics `track(..., persist=true)`
    - includes `track_id` on detections when tracker IDs are available
  - enforces sequential per-connection inference pipeline
    - when tracking is enabled and `tracking.busy_policy=latest`, uses a single **latest-frame-wins** pending slot
    - otherwise retains BUSY-drop behavior (`error.code = "BUSY"`)
  - emits detector events inside `detections.events[]`:
    - `roi_enter` / `roi_exit` for configured regions
    - `line_cross` with direction (`A->B` / `B->A`) for configured lines
    - `roi_dwell` once per track-per-ROI after dwell threshold is reached
    - `sudden_motion` from per-track kinematics thresholding
    - `track_stop` when per-track speed remains below threshold for configured duration
    - `near_collision` when an eligible tracked pair is both close and rapidly closing
    - `abandoned_object` when an eligible object remains after person association is lost beyond delay/cooldown guardrails
  - supports temporary debug command payload:
    - `{"type":"command","v":1,"name":"insight_test"}`
- Insight plumbing (manual + automatic trigger paths):
  - keeps an in-memory frame ring buffer per WS connection
  - manual trigger (`insight_test`) still supported for debugging
  - automatic trigger path:
    - computes surprise score from `detections.events[]`
    - if score >= `surprise.threshold`, and outside cooldown windows, captures a clip and calls VisionAgent
  - enforces both cooldown layers:
    - `surprise.cooldown_ms` (trigger cooldown)
    - `insights.insight_cooldown_ms` (insight call cooldown)
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
- `tracking.enabled` (default `true`)
- `tracking.persist` (default `true`)
- `tracking.tracker` (default `bytetrack.yaml`)
- `tracking.busy_policy` (`drop` | `latest`, default `latest`)
- `roi.enabled` (default `true`)
- `roi.representative_point` (locked to `centroid`)
- `roi.regions` (mapping keyed by region name, rect coords: `x1,y1,x2,y2`)
- `roi.lines` (mapping keyed by line name, endpoints: `x1,y1,x2,y2`)
- `roi.dwell.default_threshold_ms` (default dwell threshold)
- optional per-region dwell override via either:
  - `roi.regions.<name>.dwell_threshold_ms`, or
  - `roi.dwell.region_threshold_ms.<name>`
- `motion.enabled` (default `true`)
- `motion.history_frames`
- `motion.sudden_motion_speed_px_s`
- `motion.stop_speed_px_s`
- `motion.stop_duration_ms`
- `motion.event_cooldown_ms`
- `collision.enabled` (default `true`)
- `collision.pairs` (list of `[classA, classB]` pairs)
- `collision.distance_px`
- `collision.closing_speed_px_s`
- `collision.pair_cooldown_ms`
- `abandoned.enabled` (default `true`)
- `abandoned.object_classes`
- `abandoned.associate_max_distance_px`
- `abandoned.associate_min_ms`
- `abandoned.abandon_delay_ms`
- `abandoned.stationary_max_move_px` (optional)
- `abandoned.roi` (optional region name)
- `abandoned.event_cooldown_ms`
- `insights.enabled` (default `true`)
- `insights.vision_agent_url`
- `insights.timeout_ms`
- `insights.max_frames` (hard-capped at `6`)
- `insights.pre_frames`
- `insights.post_frames`
- `insights.insight_cooldown_ms`
- `surprise.enabled` (default `true`)
- `surprise.threshold`
- `surprise.cooldown_ms`
- `surprise.weights` (event-name -> numeric weight)

### Startup behavior

QuickVision fails fast at startup if:

- `yolo.model_source` cannot be loaded/downloaded
- `yolo.device` is invalid
- `tracking.busy_policy` is invalid
- `tracking.tracker` is invalid
- `roi.representative_point` is invalid (must be `centroid`)
- `roi.regions` / `roi.lines` contain invalid geometry
- ROI dwell settings are invalid (negative/non-integer threshold or unknown region override)
- motion settings are invalid (history/threshold/cooldown must be valid numeric values)
- collision settings are invalid (pairs/thresholds/cooldown must be valid values)
- abandoned-object settings are invalid (class list/thresholds/roi/cooldown must be valid values)
- surprise settings are invalid (threshold/cooldown/weights must be valid values)
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
