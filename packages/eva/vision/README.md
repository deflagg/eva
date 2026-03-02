# Vision

Vision is the WS-first Python runtime.

## Current behavior (Iteration 193)

- `GET /health` returns service/config/model health info.
- `WS /infer` (primary pipeline endpoint):
  - sends `hello` on connect with `role: "vision"`
  - accepts protocol-v2 binary frame envelopes (`frame_binary` metadata + raw JPEG bytes)
  - stores each frame in an in-memory ring buffer (bounded, eviction-based)
  - supports command `{ "type":"command", "v":2, "name":"attention_start" }`
    - activates an attention window (`attention.window_ms`)
  - while attention is active, runs BLIP caption generation
  - computes CLIP semantic embedding + surprise metrics
  - emits `frame_events`:
    - with one `scene_caption` event when caption is emitted
    - or `events: []` when caption is skipped by cooldown/dedupe/inactive attention
  - forwards each emitted `scene_caption` event to Executive `POST /events`
    - source: `"vision"`
    - event payload includes semantic fields
  - when `semantic.should_escalate=true` and insight cooldown allows:
    - builds clip from frame buffer (pre/post window)
    - waits up to `insight.post_wait_ms` for trailing post frames
    - persists clip frames to `insight.assets_dir`
    - calls Executive `POST /insight`
    - emits protocol `insight` message to WS client
  - emits protocol `error` messages for invalid payloads and runtime failures
- HTTP caption endpoint has been removed; caption generation is WS-only via `/infer`.

## `scene_caption` event payload

When emitted, the event is attached to `frame_events.events[]` as:

```json
{
  "name": "scene_caption",
  "ts_ms": 1700000000456,
  "severity": "low",
  "data": {
    "text": "a man in a black shirt",
    "model": "Salesforce/blip-image-captioning-base",
    "latency_ms": 187,
    "semantic": {
      "surprise": 0.21,
      "similarity_prev": 0.82,
      "similarity_mean": 0.79,
      "model": "openai/clip-vit-base-patch32",
      "latency_ms": 24,
      "should_escalate": false
    }
  }
}
```

## `insight` WS payload

When escalation is triggered and Executive `/insight` succeeds, Vision sends:

```json
{
  "type": "insight",
  "v": 2,
  "clip_id": "2b6398ef-5f42-4d73-93da-cf2c8f8b0e7a",
  "trigger_frame_id": "f-123",
  "ts_ms": 1700000000789,
  "summary": {
    "one_liner": "Something changed near the doorway",
    "tts_response": "I noticed motion near the doorway.",
    "what_changed": ["person entered frame"],
    "severity": "medium",
    "tags": ["motion", "entryway"]
  },
  "usage": {
    "input_tokens": 220,
    "output_tokens": 71,
    "cost_usd": 0.0023
  }
}
```

## Clip assets + retention

Clip frames are persisted at:

- `insight.assets_dir/<clip_id>/01-<frame_id>.jpg`
- `insight.assets_dir/<clip_id>/02-<frame_id>.jpg`
- ...

Retention pruning runs on clip write:

- removes clips older than `insight.retention.max_age_hours`
- enforces max clip count `insight.retention.max_clips`

## Executive client

`app/executive_client.py` provides:

- `post_events(source, events, meta)`
- `post_insight(clip_id, trigger_frame_id, frames)`

Both calls validate request/response payloads and surface transport/validation failures via typed error codes.

Event-forwarding failures are non-fatal and warning-throttled.

## `/infer` payload notes

Binary frame envelope layout (single WS binary message):

1. 4-byte big-endian metadata length
2. UTF-8 JSON metadata
3. raw JPEG bytes

Metadata JSON shape:

```json
{
  "type": "frame_binary",
  "v": 2,
  "frame_id": "<id>",
  "ts_ms": 1700000000000,
  "mime": "image/jpeg",
  "width": 1280,
  "height": 720,
  "image_bytes": 54321
}
```

Command shape:

```json
{ "type": "command", "v": 2, "name": "attention_start" }
```

## Config

Config is loaded once at startup from:

1. `settings.yaml`
2. `settings.local.yaml` (optional override)

The canonical schema is validated in `app/config.py` and currently includes:

- `server.*`
  - `host`, `port`
- `executive.*`
  - `base_url`, `timeout_ms`
- `attention.*`
  - `window_ms`
- `caption.*`
  - `enabled`, `model_id`, `device`, `max_dim`, `max_new_tokens`, `cooldown_ms`, `dedupe_window_ms`
- `semantic.*`
  - `enabled`, `model_id`, `device`, `history_size`
- `surprise.*`
  - `threshold`
- `insight.*`
  - `enabled`, `pre_frames`, `post_frames`, `max_frames`, `cooldown_ms`, `post_wait_ms`, `assets_dir`
  - `retention.max_clips`, `retention.max_age_hours`

See `settings.yaml` for committed defaults.

## Runtime modules

- Frame buffer: `app/frame_buffer.py`
- Attention window: `app/attention.py`
- Semantic embedding runtime: `app/semantic_model.py`
- Surprise scoring: `app/surprise.py`
- Clip persistence + retention: `app/clip_assets.py`
- Executive API client: `app/executive_client.py`

## `/health` WS runtime counters

`/health.ws_runtime` includes counters for:

- buffered/evicted frame counts
- attention-start command count
- emitted scene captions
- cooldown/dedupe suppressions
- semantic embeddings/errors
- last surprise values (`surprise`, `similarity_prev`, `similarity_mean`)
- insight escalation decision counts (`insight_decision_escalate_count` / `insight_decision_noop_count`)
- insight pipeline counters:
  - `insight_requested`
  - `insight_emitted`
  - `insight_cooldown_skipped`
  - `insight_busy_skipped`
  - `insight_clip_build_errors`
  - `insight_errors`
  - `last_insight_ts_ms`
  - `last_insight_clip_id`
- executive forwarding counters:
  - `executive_events_forwarded`
  - `executive_events_failed`
  - `last_executive_events_forwarded_ts_ms`

## Run (dev)

```bash
cd packages/eva/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

