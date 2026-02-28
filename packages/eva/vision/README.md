# Vision

Python daemon for Tier-2 insight orchestration.

## Current behavior (Iteration 176)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends protocol `hello` on connect (`role: "vision"`)
  - expects binary frame envelopes (`frame_binary` metadata + JPEG bytes)
  - responds once per frame with `frame_events` (same `frame_id`)
  - `events[]` is currently always empty (`[]`)
- Scene-change runtime has been removed:
  - no SceneChangeEngine
  - no `scene_change` config block
  - no scene-change blob emission

## Insight behavior

- Maintains clip buffer (pre/trigger/post frames)
- Optionally downsamples + persists clip assets under:
  - `packages/eva/memory/working_memory_assets/<clip_id>/`
- Calls Agent via HTTP (`insights.agent_url`) using `asset_rel_path` references
- Emits protocol `insight` on success

### Auto-insights

Auto-insight triggering from detector events is currently **disabled** in runtime (no detector events are emitted). `insight_test` remains available for manual insight runs.

## Config sections

Configured in `settings.yaml` / `settings.local.yaml`:

- `insights.*` — clip building + Agent call behavior
- `surprise.*` — retained for future trigger work (currently disabled by default)

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
