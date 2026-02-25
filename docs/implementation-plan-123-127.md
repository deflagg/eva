````md
## docs/implementation-plan-123-127.md — Vision “blobs of change” cutover (remove YOLO + tracking + ROI + detections)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

- build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
- a short change summary + files changed
- clear run instructions
- stop after each iteration to allow review before proceeding
- keep progress in `progress.md`

---

# GOAL (NEW END STATE)

Turn the Vision service into a **scene-change detector** that emits **stable “blobs of change”** events. Remove everything not needed for this solution, including:

- YOLO inference (Ultralytics)
- Torch/Torchvision deps
- tracking (ByteTrack/BoT-SORT)
- ROI / motion / collision / abandoned detectors
- detection overlays + detection protocol types
- ROI/line debug overlay concepts

Final output is **per-frame ACK** containing **events only** (no detections, no model).

---

# WHY (MENTAL MODEL)

We don’t want object identity, class labels, or track IDs for triggering. We want:

- “something changed significantly”
- a few coarse bounding boxes (“blobs”) to tell the LLM where to look
- consistent triggering via debounce + cooldown

---

# TARGET PROTOCOL (v2)

All protocol messages bump to `v: 2` (binary frame meta too).

**Vision → Eva → UI** per frame:

```json
{
  "type": "frame_events",
  "v": 2,
  "frame_id": "<uuid>",
  "ts_ms": 1700000000000,
  "width": 1280,
  "height": 720,
  "events": [
    {
      "name": "scene_change",
      "ts_ms": 1700000000000,
      "severity": "low|medium|high",
      "data": {
        "score": 3.2,
        "reason": "pixel",
        "blobs": [
          { "x1": 0.12, "y1": 0.18, "x2": 0.35, "y2": 0.76, "area_cells": 42, "density": 0.19 }
        ]
      }
    }
  ]
}
````

Notes:

* `events` may be empty, but **Vision must still respond once per frame_id** (UI backpressure depends on it).
* No `detections`, no `model`, no `track_id`.

---

# SCENE CHANGE ALGORITHM (BLOBS)

Frame pipeline:

1. Decode JPEG → RGB → downsample (max_dim, preserve aspect) → grayscale uint8.
2. Maintain EMA background: `bg = (1-α)*bg + α*curr`.
3. `diff = abs(curr - bg)` → threshold to mask: `diff > pixel_threshold`.
4. Pool mask into coarse grid (`cell_px`): cell_ratio = mean(mask[cell]).
5. Active cell if cell_ratio >= cell_active_ratio.
6. BFS cluster active cells (8-neighbor) into blobs.
7. Drop blobs < min_blob_cells.
8. Score = sum(blob_area_cells * blob_density).
9. Trigger `scene_change` only when:

   * score >= score_threshold for min_persist_frames consecutive frames
   * cooldown_ms has elapsed since last emit

Severity based on score thresholds.

---

# NEW CONFIG (Dynaconf)

In `packages/eva/vision/settings.yaml` (final state keys):

```yaml
server:
  host: 127.0.0.1
  port: 8000

scene_change:
  enabled: true
  downsample:
    max_dim: 160
  ema_alpha: 0.08
  pixel_threshold: 18
  cell_px: 10
  cell_active_ratio: 0.08
  min_blob_cells: 4
  score_threshold: 1.2
  min_persist_frames: 3
  cooldown_ms: 2500
  severity:
    medium_score: 2.5
    high_score: 5.0

insights:
  enabled: true
  agent_url: http://127.0.0.1:8791/insight
  assets_dir: ../memory/working_memory_assets
  assets:
    max_clips: 200
    max_age_hours: 24
  timeout_ms: 20000
  max_frames: 6
  pre_frames: 3
  post_frames: 2
  insight_cooldown_ms: 10000
  downsample:
    enabled: true
    max_dim: 160
    jpeg_quality: 75

surprise:
  enabled: true
  threshold: 5
  cooldown_ms: 10000
  weights:
    scene_change: 5
```

Everything else (yolo/tracking/roi/motion/collision/abandoned) is removed by end of plan.

---

# IMPLEMENTATION ITERATIONS (START AT 123)

## Iteration 123 — Protocol v2 cutover + new `frame_events` message end-to-end (no scene_change yet)

Goal:

* Switch UI/Eva/Vision off `detections` and onto a new per-frame `frame_events` message.
* Bump protocol version to 2 everywhere.
* Vision returns `frame_events` with `events: []` for each frame (acts as ACK).

Deliverables:

1. Python Vision protocol

* `packages/eva/vision/app/protocol.py`

  * set `PROTOCOL_VERSION = 2`
  * update all message `v` literals to 2
  * add `FrameEventsMessage` pydantic model (shape above)
  * keep `EventEntry` (with `data: dict[str, Any]`)
  * (TEMP) keep `DetectionsMessage` / `DetectionEntry` for now to avoid huge deletion in this iteration

2. Vision service emits `frame_events` ACK

* `packages/eva/vision/app/main.py`

  * remove YOLO inference call from the frame path
  * for each binary frame envelope:

    * `insight_buffer.add_frame(meta, image_bytes)` (keep)
    * send `FrameEventsMessage(... events=[])` for that frame_id
  * keep `insight_test` command behavior unchanged
  * keep send lock pattern

3. TypeScript protocol + Eva router

* `packages/eva/src/protocol.ts`

  * set `PROTOCOL_VERSION = 2`
  * add `FrameEventsMessageSchema`
  * update `VisionInboundMessageSchema` to include `frame_events` (and optionally remove `detections` from the union in this iteration)
* `packages/eva/src/server.ts`

  * switch routing logic from `message.type === 'detections'` to `message.type === 'frame_events'`
  * frame routing still uses `frame_id`
  * when `events.length > 0`, forward to agent `/events` (same as before)

4. UI acknowledges frames on `frame_events`

* `packages/ui/src/types.ts`

  * bump `v: 2` in types
  * add `FrameEventsMessage` type
  * remove `DetectionsMessage` type usage from UI (or keep types temporarily but stop using)
* `packages/ui/src/main.tsx`

  * replace `isDetectionsMessage()` with `isFrameEventsMessage()`
  * ACK in-flight frames on matching `frame_events.frame_id`

Acceptance:

* Vision:

  * `cd packages/eva/vision && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
  * `python -m app.run`
* Eva:

  * `cd packages/eva && npm i && npm run dev`
* UI:

  * `cd packages/ui && npm i && npm run dev`
* Manual:

  * Start camera + streaming.
  * Frames ACK (acked increases, fewer timeouts).
  * Event feed stays empty (expected).

Stop; update `progress.md`.

---

## Iteration 124 — Implement `SceneChangeEngine` + emit `scene_change` blobs in `frame_events`

Goal:

* Add the blob-of-change detector and start emitting `scene_change` events.

Deliverables:

1. Add new engine

* `packages/eva/vision/app/scene_change.py`

  * `SceneChangeSettings` + loader from Dynaconf
  * `SceneChangeEngine` with per-connection state:

    * background EMA image
    * persist counter
    * cooldown timestamp
  * `process_frame(ts_ms, width, height, jpeg_bytes) -> list[EventEntry]`
  * Use only Pillow + numpy (no OpenCV)

2. Add config

* `packages/eva/vision/settings.yaml`

  * add `scene_change` section defaults (as above)

3. Wire engine into WebSocket connection

* `packages/eva/vision/app/main.py`

  * instantiate `SceneChangeEngine` per WS connection (so baseline is per stream)
  * on each frame:

    * call engine
    * attach returned events to `frame_events.events`

4. Health + startup logs

* `packages/eva/vision/app/main.py`

  * `/health` includes scene_change enabled + key thresholds
  * startup prints scene_change summary

Acceptance:

* Move a hand into frame and hold:

  * one `scene_change` event (or a short burst) then quiet due to cooldown
* Stop moving:

  * events stop
* Lighting flicker:

  * at most one event; tune later

Stop; update `progress.md`.

---

## Iteration 125 — Make `scene_change` the only insight trigger + add UI blob overlay (remove detections overlay usage)

Goal:

* Insights trigger only from `scene_change`.
* UI visualizes change blobs (optional but useful), and removes all detections overlay behavior.

Deliverables:

1. Surprise weights

* `packages/eva/vision/app/insights.py`

  * set `DEFAULT_SURPRISE_WEIGHTS = { "scene_change": 5.0 }`
* `packages/eva/vision/settings.yaml`

  * `surprise.weights` contains only `scene_change`

2. Vision auto-insight trigger uses `frame_events`

* `packages/eva/vision/app/main.py`

  * where auto insight is spawned:

    * use `frame_events.frame_id` and the events list
  * keep cooldown behavior unchanged

3. UI overlay for blobs

* `packages/ui/src/overlay.ts`

  * replace detections drawing with `drawSceneChangeOverlay(video, canvas, frameEventsMessage)`
  * draw rectangles for each blob (normalized coords → pixels using message width/height and video scaling)
* `packages/ui/src/main.tsx`

  * remove detections count/model UI state
  * when receiving a `scene_change` event, render overlay blobs for ~1–2 seconds (simple TTL)

Acceptance:

* UI shows change rectangles when events occur.
* Insight auto-trigger happens when a change event occurs and threshold/cooldowns allow.

Stop; update `progress.md`.

---

## Iteration 126 — Delete YOLO + tracking + ROI + old detectors + heavy deps (torch/ultralytics)

Goal:

* Remove all unused code and dependencies now that `scene_change` works end-to-end.

Deliverables:

1. Remove Python modules not used
   Delete (or remove from tree):

* `packages/eva/vision/app/yolo.py`
* `packages/eva/vision/app/tracking.py`
* `packages/eva/vision/app/roi.py`
* `packages/eva/vision/app/motion.py`
* `packages/eva/vision/app/collision.py`
* `packages/eva/vision/app/abandoned.py`
* `packages/eva/vision/app/events.py` (DetectionEventEngine)

Then update imports/usages accordingly:

* `packages/eva/vision/app/main.py` should only load:

  * insights settings
  * scene_change settings
  * protocol + buffer

2. Remove config sections

* `packages/eva/vision/settings.yaml`

  * delete `yolo`, `tracking`, `roi`, `motion`, `collision`, `abandoned`

3. Remove deps

* `packages/eva/vision/requirements.txt`

  * remove:

    * `ultralytics`
    * torch + torchvision lines + extra-index-url
  * keep:

    * fastapi, uvicorn, pillow, numpy, pydantic, dynaconf, httpx

4. Simplify `/health`

* remove all tracking/roi/motion/collision/abandoned fields
* keep: service, status, insights flags, scene_change flags

Acceptance:

* Fresh venv install succeeds without torch/ultralytics.
* Vision runs and emits `scene_change` events as before.

Stop; update `progress.md`.

---

## Iteration 127 — Protocol cleanup + docs cleanup (remove all “detections” vocabulary)

Goal:

* Remove leftover protocol/types/doc references to detections, track_id, model, ROI overlay.

Deliverables:

1. Python protocol cleanup

* `packages/eva/vision/app/protocol.py`

  * remove `DetectionEntry` and `DetectionsMessage` entirely
  * (optional) remove `track_id` from `EventEntry` if it still exists
  * ensure only relevant message types remain (`hello`, `error`, `command`, `frame_binary`, `frame_events`, `insight`)

2. TypeScript protocol cleanup

* `packages/eva/src/protocol.ts`

  * remove DetectionEntrySchema + DetectionsMessageSchema
  * ensure unions contain `frame_events`
* `packages/ui/src/types.ts`

  * remove DetectionsMessage + DetectionEntry types

3. Eva server event ingest meta cleanup

* `packages/eva/src/server.ts`

  * remove `meta.model` usage from events ingest payload (only `frame_id` is needed)
  * ensure high-severity alert dedupe keys don’t rely on track_id

4. Docs update

* `packages/eva/vision/README.md`

  * rewrite: “Vision is a scene-change detector; no YOLO”
  * document tuning knobs
* `packages/ui/README.md`

  * remove detection overlay + ROI debug overlay language
  * document blob overlay behavior
* Root `README.md`

  * update description of Vision component
  * keep run steps the same

Acceptance:

* `npm run dev` for Eva and UI still works.
* Vision still runs with clean requirements.
* No references to `detections` remain in runtime paths.

Stop; update `progress.md`.
