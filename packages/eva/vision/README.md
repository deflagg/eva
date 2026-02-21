# Vision

Python daemon that hosts YOLO inference and (optional) insight triggering.

## Current behavior (Iteration 90)

- HTTP health endpoint at `/health`
- WebSocket endpoint at `/infer`
  - sends `hello` on connect (`role: "vision"`)
  - expects binary frame envelopes for frame payloads
  - runs YOLO inference and returns `detections`
  - supports tracking + event detectors + insight triggering
- Insight path:
  - calls Agent via HTTP (`insights.agent_url`)
  - emits protocol `insight` on success
  - emits schema-aligned summary fields only:
    - `one_liner`, `what_changed`, `severity`, `tags`
  - strips narration-style fields (for example `tts_response`) before protocol emission

## Configuration (Dynaconf)

Vision reads layered YAML config from:

- `settings.yaml` (committed defaults)
- `settings.local.yaml` (optional local override, gitignored)

Key insight settings:

- `insights.enabled`
- `insights.agent_url`
- `insights.vision_agent_url` (deprecated alias; fallback only)
- `insights.timeout_ms`
- `insights.max_frames` (hard-capped at `6`)
- `insights.pre_frames`
- `insights.post_frames`
- `insights.insight_cooldown_ms`

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
