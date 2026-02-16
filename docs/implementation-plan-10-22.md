Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:
- build/lint/test passing (or explicit “no tests yet; manual test steps included”)
- a short change summary + files changed
- clear run instructions
- stop after each iteration to allow for review and feedback before proceeding to the next one.
- Keep progress in progress.md

ASSUMPTION:
- Iterations 0–9 from the prior plan are complete. (./implementaion-plan.md)
- This plan starts at Iteration 10 and continues sequentially.
- Current repo already has:
  - packages/eva
  - packages/quickvision
  - packages/ui
  - packages/protocol
  - docs/implementation-plan.md
  - progress.md
  - .gitignore

────────────────────────────────────────────────────────────
STACK CHOICES (LOCKED — don’t bikeshed)
────────────────────────────────────────────────────────────
Eva (TypeScript daemon, Linux):
- Node.js: latest stable (“Current”) at implementation time
  - /packages/eva/.nvmrc already exists
  - Dev instructions use: `nvm install node && nvm use node`
- TypeScript
- WebSockets: npm package `ws` (NOT Socket.IO)
- HTTP: Node built-in `http` (keep deps minimal)
- Validation: `zod`
- Dev runner: `tsx`
- Configuration loader: cosmiconfig (validated by zod)

QuickVision (Python daemon, FastAPI):
- Python 3.11
- FastAPI + Uvicorn (`uvicorn[standard]`)
- Ultralytics (`ultralytics`)
- Image decode: Pillow (`Pillow`) + `numpy` (avoid opencv unless necessary)
- Validation: Pydantic v2 (explicit models for protocol)
- Concurrency: inference runs in a worker thread via `asyncio.to_thread(...)`
- Configuration loader: Dynaconf (layered YAML settings)

UI (Web client):
- Vite + React + TypeScript (already exists)
- Webcam capture: `navigator.mediaDevices.getUserMedia`
- Overlay: <canvas> drawn over <video>
- Runtime configuration: public JSON fetched from `/config.json`

VisionAgent (NEW package, Node daemon, pi-mono):
- Node.js latest stable
- Uses pi-mono packages via npm:
  - `@mariozechner/pi-ai` (model selection, vision blocks, tool calling, usage/cost)
  - `@sinclair/typebox` (tool schema)
- Exposes HTTP endpoint for QuickVision:
  - POST /insight (JSON payload containing a short clip)
- Configuration loader: cosmiconfig (validated by zod)
- No env vars for API keys; read a gitignored secrets file and pass apiKey explicitly.

────────────────────────────────────────────────────────────
CONFIGURATION (LOCKED — config files, no env-var configuration)
────────────────────────────────────────────────────────────

Eva + VisionAgent (Node/TS): use cosmiconfig
- One committed config file + one optional local override (preferred if present):
  - `packages/eva/eva.config.json` (committed)
  - `packages/eva/eva.config.local.json` (gitignored)
  - `packages/vision-agent/vision-agent.config.json` (committed)
  - `packages/vision-agent/vision-agent.config.local.json` (gitignored)
- cosmiconfig should be configured with searchPlaces that check local first, then default.
- Validate config with Zod on startup; fail fast with clear error.

QuickVision (Python): use Dynaconf
- Layered YAML settings files in `packages/quickvision/`:
  - `settings.yaml` (committed)
  - `settings.local.yaml` (gitignored)
- Dynaconf should be instantiated with:
  - settings_files=["settings.yaml","settings.local.yaml"]
  - merge_enabled=True
  - environments=False
  - load_dotenv=False
- QuickVision reads config via Dynaconf `settings.<path>` only.

UI (browser runtime):
- `packages/ui/public/config.json` (committed)
- `packages/ui/public/config.local.json` (gitignored)
- UI loads config.local.json first (if 404, fallback to config.json).

Secrets:
- VisionAgent secrets must be in a gitignored JSON file:
  - `packages/vision-agent/vision-agent.secrets.local.json` (gitignored)
  - include an example file: `vision-agent.secrets.local.example.json`

Git ignore:
- Update the existing root `.gitignore` to ignore:
  - `packages/**/**/*.local.*` (or explicitly list each local file)
  - `packages/vision-agent/*.secrets.local.json`
  - `packages/ui/public/config.local.json`

────────────────────────────────────────────────────────────
MESSAGE PROTOCOL (v1) — JSON over WS (base64 images)
────────────────────────────────────────────────────────────
Keep protocol stable. If you add fields/types, update:
- /packages/protocol/README.md   (already exists)
- /packages/protocol/schema.json (already exists)
- UI types (`packages/ui/src/types.ts`)
- QuickVision Pydantic models (`packages/quickvision/app/protocol.py`)

1) UI -> Eva (frame)
{
  "type": "frame",
  "v": 1,
  "frame_id": "<uuid>",
  "ts_ms": 1700000000000,
  "mime": "image/jpeg",
  "width": 1280,
  "height": 720,
  "image_b64": "<base64 jpeg bytes, NO data: prefix>"
}

2) Eva -> QuickVision (frame)  (same as above)

3) QuickVision -> Eva (detections)
{
  "type": "detections",
  "v": 1,
  "frame_id": "<uuid>",
  "ts_ms": 1700000000000,
  "width": 1280,
  "height": 720,
  "model": "yoloe-26",
  "detections": [
    { "cls": 0, "name": "person", "conf": 0.91, "box": [x1,y1,x2,y2] }
  ]
}

Protocol extensions (still v1, backward compatible):
A) Optional per-detection track id
- `track_id?: number`

B) Optional events array on detections
- `events?: EventEntry[]`
- EventEntry is an envelope:
  {
    "name": "<event_name>",
    "ts_ms": 1700000000000,
    "severity": "low|medium|high",
    "track_id": 17,
    "data": { ...event specific fields... }
  }

4) Any -> Any (error)
{ "type":"error", "v":1, "frame_id":"<optional>", "code":"<string>", "message":"<string>" }

5) QuickVision -> Eva (insight)  (IMPORTANT: NO frame_id field)
{
  "type": "insight",
  "v": 1,
  "clip_id": "<uuid>",
  "trigger_frame_id": "<uuid>",
  "ts_ms": 1700000000000,
  "summary": {
    "one_liner": "...",
    "what_changed": ["..."],
    "severity": "low|medium|high",
    "tags": ["..."]
  },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cost_usd": 0
  }
}

────────────────────────────────────────────────────────────
CHANGE DETECTORS TO IMPLEMENT (ALL REQUIRED)
────────────────────────────────────────────────────────────
All detectors run in QuickVision and emit events inside `detections.events[]`.

1) Line crossing / region entry/exit
- ROI regions: enter/exit
- ROI lines: directional crossing

2) Loitering (dwell time in ROI)
- Per-track dwell timers per ROI

3) Abandoned object
- Object track persists; associated person leaves; object remains -> abandoned event

4) Sudden motion / stop
- Per-track velocity/accel thresholds; stop duration

5) Near-collision
- Pairwise distances between tracks (filtered by class pairs) and closing-speed threshold

────────────────────────────────────────────────────────────
GUARDRAILS (MUST IMPLEMENT)
────────────────────────────────────────────────────────────
A) Don’t send too many frames to the LLM
- Hard max frames for insight clips: start with 6
- Enforced in QuickVision AND VisionAgent (defense-in-depth)

B) Downsample before LLM (later iteration)
- Downsample clip frames (resize + lower JPEG quality) before sending to VisionAgent
- Do NOT affect YOLO inference frames

C) Cooldown everywhere (avoid loops / spam)
- QuickVision:
  - surprise trigger cooldown
  - insight call cooldown
- Eva:
  - insight relay cooldown + dedupe by clip_id
- VisionAgent:
  - request cooldown

D) persist=True matters for tracking continuity
- When tracking enabled: use Ultralytics tracking with persist=true
- Ensure sequential processing per WS connection (no concurrent inference tasks)
- Prefer “latest-frame-wins” pending slot instead of BUSY spam when tracking is enabled

────────────────────────────────────────────────────────────
REPO LAYOUT (ALIGNED TO CURRENT REPO)
────────────────────────────────────────────────────────────
Current packages already exist (do not move them):
/packages
  /eva
    .nvmrc
    package.json
    tsconfig.json
    src/
      index.ts
      server.ts
      quickvisionClient.ts
      protocol.ts
      router.ts              (currently exists; keep unless needed)
    README.md
    (NEW in Iteration 10)
    eva.config.json
    eva.config.local.json   (gitignored)
    src/config.ts           (cosmiconfig + zod)

  /quickvision
    requirements.txt
    README.md
    app/
      main.py
      protocol.py
      yolo.py
      (NEW in Iteration 10)
      settings.py            (Dynaconf instance)
      run.py                 (start uvicorn using settings)
      (NEW in later iterations)
      tracking.py
      roi.py
      events.py
      motion.py
      collision.py
      abandoned.py
      insights.py
      vision_agent_client.py
    (NEW in Iteration 10)
    settings.yaml
    settings.local.yaml     (gitignored)

  /ui
    package.json
    tsconfig*.json
    vite.config.ts
    index.html
    src/
      main.tsx
      ws.ts
      camera.ts
      overlay.ts
      types.ts
      (NEW in Iteration 10)
      config.ts
    README.md
    (NEW in Iteration 10)
    public/
      config.json
      config.local.json      (gitignored)

  /protocol
    README.md
    schema.json

(NEW package to add)
/packages
  /vision-agent
    .nvmrc
    package.json
    tsconfig.json
    src/
      index.ts
      server.ts
      prompts.ts
      tools.ts
      config.ts              (cosmiconfig + zod)
    README.md
    vision-agent.config.json
    vision-agent.config.local.json          (gitignored)
    vision-agent.secrets.local.json         (gitignored)
    vision-agent.secrets.local.example.json

Root:
- README.md
- progress.md
- docs/implementation-plan.md
- .gitignore (update patterns; do not remove existing ignores)

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS (SMALL DIFFS) — START AT 10
────────────────────────────────────────────────────────────

Iteration 10 — Config migration (cosmiconfig + Dynaconf + UI runtime config)
Goal:
- Replace env vars/hardcoded URLs with config file loading.
- Behavior remains identical to Iteration 9 baseline.

Deliverables:
- Eva uses cosmiconfig + zod:
  - loads eva.config.json (or eva.config.local.json if present)
- QuickVision uses Dynaconf:
  - loads settings.yaml (+ settings.local.yaml if present)
  - add python entrypoint `python -m app.run` that starts uvicorn using settings
- UI uses runtime config fetched from /public/config*.json.

Implementation details:
- Eva:
  - add `src/config.ts`:
    - configure cosmiconfig to search ONLY in packages/eva with searchPlaces:
      - eva.config.local.json first
      - eva.config.json second
    - validate with zod schema
  - modify `src/index.ts` to read:
    - server.port
    - server.eyePath (default "/eye")
    - quickvision.wsUrl
  - modify `src/server.ts` to use config eyePath (no hardcoded const)
- QuickVision:
  - add `app/settings.py` exporting Dynaconf `settings`
  - add `app/run.py` that starts uvicorn using settings.server.host/port
  - update `app/yolo.py` to read:
    - yolo.model_source
    - yolo.device
  - keep existing uvicorn command as alternative; do not break it
- UI:
  - add `public/config.json`
  - add `src/config.ts` loader (try config.local.json then config.json)
  - update `src/ws.ts` to accept a URL instead of hardcoding
  - update `src/main.tsx` to load config before connecting WS

Acceptance:
- Builds pass:
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/quickvision && python3 -m compileall app`
- Manual run:
  - QV: `cd packages/quickvision && python -m app.run`
  - Eva: `cd packages/eva && npm run dev`
  - UI: `cd packages/ui && npm run dev`
- UI connects and detections still display as before.

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 11 — Protocol v1 extensions: track_id + events[] + insight message + UI ack fix
Goal:
- Extend protocol docs/schema/types to support detectors + insight output.
- Ensure UI ack logic is not broken by non-detection messages.

Deliverables:
- Update `packages/protocol/schema.json` and `packages/protocol/README.md`:
  - detection.track_id optional
  - detections.events optional (EventEntry envelope)
  - insight message type
- Update UI `packages/ui/src/types.ts` and parsing:
  - treat ACK only when message.type === "detections" AND frame_id matches in-flight
  - do NOT ack on arbitrary messages even if they include a frame_id field
- Update QuickVision `packages/quickvision/app/protocol.py` models accordingly.

Acceptance:
- Builds pass.
- Manual:
  - inject a fake insight message (no frame_id) and ensure UI doesn’t drop in-flight state
  - inject fake detections.events[] and ensure UI logs/displays it

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 12 — Add VisionAgent daemon (pi-mono) with guardrails
Goal:
- Add new package `packages/vision-agent`.
- VisionAgent accepts a short clip and returns a structured summary.
- Enforce:
  - max frames = 6
  - request cooldown
  - max request size
- Use config files + gitignored secrets (no env vars).

Deliverables:
- VisionAgent uses cosmiconfig + zod:
  - vision-agent.config.local.json preferred
- server endpoints:
  - GET /health
  - POST /insight
- Tool-call based structured output:
  - one_liner, what_changed[], severity, tags[]
- Reads OpenAI API key from `vision-agent.secrets.local.json` and passes it to pi-ai request options.

Implementation details:
- vision-agent.config.json schema:
  - server.port
  - model.provider/model.id (default openai + gpt-4o-mini)
  - guardrails: cooldownMs, maxFrames, maxBodyBytes
  - secretsFile: path to secrets JSON
- Implement request cooldown in memory:
  - reject with 429 if within cooldown window
- Enforce maxFrames:
  - reject with 400 if frames > 6
- Enforce maxBodyBytes:
  - reject with 413 if too large
- Call model via pi-ai using image blocks
- Force structured tool call:
  - define tool schema in tools.ts and instruct model to call it once

Acceptance:
- `cd packages/vision-agent && npm i && npm run build && npm run dev`
- Manual:
  - `curl /health`
  - POST /insight with <=6 frames -> 200 structured response
  - POST /insight with 7 frames -> 400
  - POST /insight twice quickly -> 429

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 13 — QuickVision insights plumbing: ring buffer + clip builder (max 6) + call VisionAgent (manual trigger)
Goal:
- QuickVision can build a 6-frame clip and call VisionAgent.
- Trigger path is manual (debug command), not detectors yet.

Deliverables:
- QuickVision modules (new under packages/quickvision/app/):
  - insights.py: ring buffer + clip selection + cooldown + call VisionAgent
  - vision_agent_client.py: httpx client with timeout
- QuickVision emits `type:"insight"` WS message upon successful VisionAgent response.

QuickVision Dynaconf keys (settings.yaml):
- insights.enabled (default false)
- insights.vision_agent_url
- insights.timeout_ms
- insights.max_frames=6
- insights.pre_frames
- insights.post_frames
- insights.insight_cooldown_ms

Implementation details:
- Add dependency: httpx
- Add a temporary WS message type for testing:
  - { "type":"command", "v":1, "name":"insight_test" }
- On insight_test:
  - pick latest frame as trigger_frame_id
  - build clip:
    - include trigger frame
    - add up to pre_frames before trigger
    - collect up to post_frames after trigger (bounded by timeout)
    - never exceed max_frames=6
  - enforce insight cooldown
  - call VisionAgent; emit insight message (NO frame_id field)

Acceptance:
- Builds pass.
- Manual:
  - stream camera frames
  - send insight_test command (WS script or temporary UI button)
  - confirm insight displayed
  - confirm cooldown suppresses rapid repeats

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 14 — Tracking: Ultralytics track(persist=true) + sequential pipeline (tracking continuity guardrail)
Goal:
- Enable track IDs for detections using Ultralytics tracking.
- Guarantee tracking continuity via sequential processing per WS connection.

Deliverables:
- Add `packages/quickvision/app/tracking.py`
- Update `packages/quickvision/app/yolo.py` to support:
  - predict mode (existing)
  - track mode (new) when settings.tracking.enabled=true
  - include track_id on detections when available

QuickVision Dynaconf keys:
- tracking.enabled (default false)
- tracking.persist (default true)
- tracking.tracker (default "bytetrack.yaml")
- tracking.busy_policy ("drop" | "latest") default "latest"

Implementation details:
- In yolo.py:
  - if tracking.enabled: use model.track(..., persist=true, tracker=...)
  - read boxes.id and set detection.track_id
- In main.py:
  - enforce sequential inference per connection
  - when tracking.enabled and busy_policy=="latest":
    - maintain a pending_frame slot:
      - if frame arrives while inference running: overwrite pending_frame
      - after inference completes: process pending_frame immediately
  - keep existing BUSY error behavior only when tracking.enabled=false or busy_policy=="drop"

Acceptance:
- Builds pass.
- Manual:
  - enable tracking in settings.local.yaml
  - confirm stable-ish track_ids in detections
  - confirm no concurrent inference tasks for a single WS stream

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 15 — ROI + line crossing detectors: region enter/exit + directional line crossing
Goal:
- Implement:
  - region entry/exit
  - line crossing with direction

Deliverables:
- Add `packages/quickvision/app/roi.py`
- Add/extend `packages/quickvision/app/events.py`:
  - per-track state for membership + last-side-of-line
  - emit events: roi_enter, roi_exit, line_cross

QuickVision Dynaconf keys:
- roi.enabled (default true)
- roi.regions: dict keyed by name
- roi.lines: dict keyed by name
- representative_point: "centroid" (lock it)

Event shapes (events[].data):
- roi_enter: { roi: "<name>" }
- roi_exit:  { roi: "<name>" }
- line_cross: { line:"<name>", direction:"A->B|B->A" }

Acceptance:
- Builds pass.
- Manual:
  - define a simple ROI (left-half rect)
  - walk in/out -> roi_enter/roi_exit
  - define a doorway line -> line_cross with direction

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 16 — Loitering detector: ROI dwell time
Goal:
- Implement loitering as dwell time inside an ROI.

Deliverables:
- events.py enhancements:
  - per-track per-ROI:
    - enter_ts_ms
    - dwell_emitted flag
  - emit roi_dwell once per track per ROI when threshold reached

QuickVision Dynaconf keys:
- roi.dwell.default_threshold_ms
- optional per-region dwell override

Event shape:
- roi_dwell data: { roi:"<name>", dwell_ms:<number> }

Acceptance:
- Builds pass.
- Manual:
  - stand inside ROI > threshold -> roi_dwell emitted once
  - exit and re-enter -> can emit again

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 17 — Sudden motion / stop detectors (per-track kinematics)
Goal:
- Implement:
  - sudden_motion
  - track_stop (optional track_resume)

Deliverables:
- Add `packages/quickvision/app/motion.py`
- Maintain per-track history: last N centroids + timestamps
- Emit events with per-track cooldown:
  - sudden_motion when speed/accel crosses threshold
  - track_stop when speed below stop threshold for stop_duration_ms

QuickVision Dynaconf keys:
- motion.enabled (default true)
- motion.history_frames
- motion.sudden_motion_speed_px_s
- motion.stop_speed_px_s
- motion.stop_duration_ms
- motion.event_cooldown_ms

Event shapes:
- sudden_motion data: { speed_px_s:<n> }
- track_stop data: { stopped_ms:<n> }

Acceptance:
- Builds pass.
- Manual:
  - move quickly -> sudden_motion
  - stop moving -> track_stop after duration

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 18 — Near-collision detector (pair distance + closing speed)
Goal:
- Implement near-collision detection between track pairs.

Deliverables:
- Add `packages/quickvision/app/collision.py`
- Compute centroid distance between eligible track pairs
- Compute closing speed via delta distance / delta time
- Emit near_collision when distance <= threshold AND closing speed >= threshold (per-pair cooldown)

QuickVision Dynaconf keys:
- collision.enabled (default true)
- collision.pairs (list of [classA,classB])
- collision.distance_px
- collision.closing_speed_px_s
- collision.pair_cooldown_ms

Event shape:
- near_collision data:
  {
    "a_track_id": <n>,
    "b_track_id": <n>,
    "a_class": "<name>",
    "b_class": "<name>",
    "distance_px": <n>,
    "closing_speed_px_s": <n>
  }

Acceptance:
- Builds pass.
- Manual:
  - move two tracks close quickly -> near_collision fires
  - repeated frames don’t spam due to cooldown

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 19 — Abandoned object detector
Goal:
- Detect abandoned objects (object remains after associated person leaves).

Deliverables:
- Add `packages/quickvision/app/abandoned.py`
- Heuristic:
  - candidate object tracks by class
  - associate object -> nearest person for >= associate_min_ms
  - if person leaves (lost or ROI exit) and object remains:
    - start timer
  - if object still present after abandon_delay_ms (and optional stationary check):
    - emit abandoned_object once

QuickVision Dynaconf keys:
- abandoned.enabled (default true)
- abandoned.object_classes
- abandoned.associate_max_distance_px
- abandoned.associate_min_ms
- abandoned.abandon_delay_ms
- abandoned.stationary_max_move_px (optional)
- abandoned.roi (optional)
- abandoned.event_cooldown_ms

Event shape:
- abandoned_object data:
  {
    "object_track_id": <n>,
    "object_class": "<name>",
    "person_track_id": <n|null>,
    "roi": "<name|null>",
    "abandon_ms": <n>
  }

Acceptance:
- Builds pass.
- Manual:
  - put down backpack, walk away -> abandoned_object after delay
  - move object / re-associate before delay -> cancels

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 20 — “Surprise trigger” + automatic insight calls (cooldowns everywhere) + Eva relay dedupe
Goal:
- Automatically call VisionAgent when significant events occur, with strict guardrails:
  - max 6 frames
  - cooldowns
  - dedupe

Deliverables:
- QuickVision:
  - surprise scoring based on emitted events
  - surprise trigger cooldown
  - insight call cooldown
  - automatic clip capture around trigger frame and call VisionAgent
- Eva:
  - insight relay cooldown + dedupe by clip_id (don’t spam UI)
- VisionAgent:
  - already enforces cooldown + max frames (defense-in-depth)

QuickVision Dynaconf keys:
- surprise.enabled
- surprise.threshold
- surprise.cooldown_ms
- surprise.weights (event_name -> weight)
- insights.enabled true
- insights.insight_cooldown_ms

Eva config keys:
- insightRelay.enabled
- insightRelay.cooldownMs
- insightRelay.dedupeWindowMs

Implementation details:
- Surprise scoring:
  - sum weights of events in the current detections message
  - if sum >= threshold and outside cooldown -> trigger insight capture
- Default weights:
  - abandoned_object: high
  - near_collision: high
  - roi_dwell: medium
  - line_cross: medium
  - sudden_motion / track_stop: low-medium
- Eva relay guard:
  - drop or coalesce insights within cooldown window
  - dedupe by clip_id for dedupeWindowMs

Acceptance:
- Builds pass.
- Manual:
  - trigger near_collision -> insight emitted once
  - repeated triggers within cooldown suppressed
  - Eva doesn’t flood UI even if QuickVision misbehaves

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 21 — Downsample before LLM (QuickVision-only)
Goal:
- Reduce payload/cost by downsampling clip frames before sending to VisionAgent.
- Do NOT affect YOLO inference frames.

Deliverables:
- In insights.py, downsampling pipeline for clip payload only:
  - decode base64 -> Pillow Image
  - resize to max_dim
  - re-encode JPEG with jpeg_quality
  - replace image_b64 in payload frames only

QuickVision Dynaconf keys:
- insights.downsample.enabled
- insights.downsample.max_dim
- insights.downsample.jpeg_quality

Acceptance:
- Builds pass.
- Manual:
  - compare request size with downsample on/off
  - insight quality remains acceptable

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 22 — UI: event feed + insight panel + optional debug overlay
Goal:
- Make system observable and debuggable.

Deliverables:
- UI displays:
  - recent events (name + severity + track_id + small data summary)
  - latest insight (one_liner + tags)
  - optional debug overlay for ROI regions/lines (toggle)

Acceptance:
- Builds pass.
- Manual:
  - see events + insights without breaking frame streaming

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────
CODING RULES
────────────────────────────────────────────────────────────
- Don’t implement future iterations early.
- Keep changes minimal. Prefer adding small new files over rewriting.
- After each iteration: list changed files + exact commands to run + manual tests.
- If you add a dependency, keep it minimal and justified.
- Start at Iteration 10 NOW and proceed sequentially.
