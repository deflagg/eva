Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:
- build/lint/test passing (or explicit “no tests yet; manual test steps included”)
- a short change summary + files changed
- clear run instructions
- stop after each iteration to allow for review and feedback before proceeding to the next one.
- Keep progress in progress.md

────────────────────────────────────────────────────────────
STACK CHOICES (LOCKED — don’t bikeshed)
────────────────────────────────────────────────────────────
Eva (TypeScript daemon, Linux):
- Node.js: latest stable (“Current”) at implementation time
  - Add /packages/eva/.nvmrc containing: node
  - Dev instructions use: `nvm install node && nvm use node`
- TypeScript
- WebSockets: npm package `ws` (NOT Socket.IO)
- HTTP: Node built-in `http` (keep deps minimal)
- Validation: `zod`
- Dev runner: `tsx`

QuickVision (Python daemon, FastAPI):
- Python 3.11
- FastAPI + Uvicorn (`uvicorn[standard]`)
- Ultralytics (`ultralytics`)
- Image decode: Pillow (`Pillow`) + `numpy` (avoid opencv unless necessary)
- Validation: Pydantic v2 (use pydantic models explicitly)
- Concurrency: inference runs in a worker thread via `asyncio.to_thread(...)`

UI (Web client):
- Vite + React + TypeScript
- Webcam capture: `navigator.mediaDevices.getUserMedia`
- Overlay: <canvas> drawn over <video>

All calls are WebSockets:
- UI <-> Eva: ws://<eva-host>:8787/eye
- Eva <-> QuickVision: ws://<quickvision-host>:8000/infer

Ports (defaults):
- Eva: 8787
- QuickVision: 8000
- UI dev server: 5173

Env vars:
- Eva:
  - EVA_PORT=8787
  - QUICKVISION_WS_URL=ws://localhost:8000/infer
- QuickVision:
  - QV_PORT=8000
  - YOLO_MODEL_PATH=<path to yoloe-26 weights file>
  - YOLO_DEVICE=auto|cpu|cuda (default: auto)
NOTE: Don’t hardcode a model filename you can’t guarantee exists. If YOLO_MODEL_PATH missing or invalid: fail fast with a clear startup error.

────────────────────────────────────────────────────────────
MESSAGE PROTOCOL (v1) — JSON over WS (base64 images)
────────────────────────────────────────────────────────────
Keep this stable. Don’t invent new fields without updating protocol docs + schemas.

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
- box coords are pixel coords in the source frame space [0..width, 0..height].

4) Any -> Any (error)
{ "type":"error", "v":1, "frame_id":"<optional>", "code":"<string>", "message":"<string>" }

5) Optional hello (debug)
{ "type":"hello", "v":1, "role":"ui|eva|quickvision", "ts_ms": <number> }

────────────────────────────────────────────────────────────
EDGE-CASE RULES (WRITE THESE INTO CODE)
────────────────────────────────────────────────────────────
Backpressure (v1, simple + robust):
- UI sends at most ONE in-flight frame at a time.
  - Send frame
  - Wait for matching detections.frame_id OR timeout (default 500ms)
  - If timeout: drop that frame_id and continue (don’t block forever)

Routing correctness:
- Eva must route detections to the originating UI client.
- Eva keeps a Map frame_id -> client_ws with TTL eviction:
  - TTL default 5 seconds
  - Evict on: detections received, client disconnect, TTL expiry
  - On eviction without detections: just drop (log once)

Disconnect behavior:
- If a UI client disconnects: delete all frame_ids mapped to that client.
- If QuickVision disconnects: Eva attempts reconnect with exponential backoff (e.g., 250ms -> 5s cap).
- While QuickVision is down: Eva responds to incoming frame messages with error {code:"QV_UNAVAILABLE"}.

QuickVision inference concurrency:
- Process frames sequentially per WS connection (v1).
- If a new frame arrives while inference running:
  - Drop it and return error {code:"BUSY"} for that frame_id.

Coordinate mapping in UI:
- UI draws boxes on a canvas overlay sized to the displayed video.
- Scaling:
  - scaleX = video.clientWidth / frame.width
  - scaleY = video.clientHeight / frame.height
  - drawRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY)

────────────────────────────────────────────────────────────
REPO LAYOUT (LOCKED) — EVERYTHING UNDER /packages
────────────────────────────────────────────────────────────
Create this structure:

/packages
  /protocol
    README.md
    schema.json

  /eva
    .nvmrc                 (contains: node)
    package.json
    tsconfig.json
    src/
      index.ts              (boot + config)
      server.ts             (http server + ws routing)
      protocol.ts           (zod schemas + types)
      quickvisionClient.ts  (ws client to QV + reconnect)
      router.ts             (frame_id -> client map, TTL handling)
    README.md

  /quickvision
    requirements.txt        (keep simple; pin minimally)
    app/
      main.py               (FastAPI app + ws endpoint + health)
      protocol.py           (pydantic models)
      yolo.py               (model load + inference helper)
    README.md

  /ui
    package.json
    vite.config.ts
    src/
      main.tsx
      ws.ts                 (ws connect + send/recv)
      camera.ts             (getUserMedia + frame capture)
      overlay.ts            (draw boxes)
      types.ts              (protocol TS types, shared w/ zod shapes)
    README.md

Root:
- README.md: run instructions for all 3 components + env vars
- (later) docker-compose.yml

Note: We are NOT introducing a JS monorepo manager (pnpm/turbo) initially. Each Node package (eva/ui/protocol) installs/runs independently with npm to keep diffs small. (Optional later iteration can add workspaces.)

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS (SMALL DIFFS)
────────────────────────────────────────────────────────────

Iteration 0 — Scaffold + protocol docs + build scripts
Goal:
- Create folders and minimal build/run for each component (no real functionality).
Deliverables:
- /packages/protocol/README.md describing message types + examples
- /packages/protocol/schema.json (JSON Schema for frame/detections/error)
- Root README with run instructions (even if stubs)
- Eva compiles; QuickVision starts; UI starts.
Acceptance:
- Commands work:
  - (eva) cd packages/eva && nvm install node && nvm use node && npm i && npm run dev
  - (quickvision) cd packages/quickvision && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
  - (ui) cd packages/ui && npm i && npm run dev

Iteration 1 — Eva: WS endpoint /eye + hello + echo (no QV yet)
Goal:
- Eva runs on :8787
- WS path /eye accepts connections, sends hello, echoes received JSON back
Implementation details:
- Use `ws` WebSocketServer bound to Node `http` server
- Validate incoming JSON parse errors -> send {type:"error"...}
Acceptance:
- Manual test: UI or wscat connects and sees hello + echo.

Iteration 2 — UI: connect to Eva + status + log panel (no camera yet)
Goal:
- Vite React page connects to ws://localhost:8787/eye
- Shows connected/disconnected + logs messages
Acceptance:
- Open UI, see hello, send a test message, see echo.

Iteration 3 — QuickVision: WS /infer + hello + echo (no YOLO yet)
Goal:
- FastAPI WS endpoint /infer
- Sends hello on connect
- Echoes any JSON messages
Acceptance:
- Manual test: small python ws client connects and sees hello + echo.

Iteration 4 — Eva: connect to QuickVision and relay UI ↔ QV (single client only)
Goal:
- Eva opens a WS client to QUICKVISION_WS_URL
- For each message from UI, forward to QV; forward QV responses back to UI
- Document limitation: 1 UI client supported in this iteration
Acceptance:
- UI message round-trips through QV (prove relay works).

Iteration 5 — UI: webcam capture + frame encoding + send frames (still echo response)
Goal:
- UI uses getUserMedia to show live <video>
- Capture frames via hidden canvas -> JPEG blob -> base64 (no data: prefix)
- Apply backpressure: 1 in-flight (based on matching echo or timeout)
Acceptance:
- Logs show frames being sent; system stays responsive.

Iteration 6 — UI overlay + QuickVision dummy detections
Goal:
- QuickVision stops echoing frames and instead replies with deterministic dummy detections
- UI draws boxes correctly over video using scaling rules
Acceptance:
- Stable box appears in correct location over live video.

Iteration 7 — QuickVision: real YOLOE-26 inference
Goal:
- Load model once at startup in yolo.py
- For each frame:
  - decode base64 -> bytes -> PIL Image -> numpy
  - run ultralytics model in `asyncio.to_thread(...)`
  - normalize output to protocol detections format (cls, name, conf, xyxy)
- Reply detections with model:"yoloe-26"
Acceptance:
- UI shows real detections + boxes track objects.
- Model loads once (log it).

Iteration 8 — Hardening: routing map + TTL + error handling
Goal:
- Eva introduces frame_id -> client_ws map + TTL eviction (5s)
- Proper handling of:
  - UI disconnect cleanup
  - QV unavailable: reply error immediately
  - JSON validation on both sides (zod + pydantic)
Acceptance:
- No unbounded growth; logs show evictions; no “wrong client got boxes”.

Iteration 9 — Multi-client support
Goal:
- Eva supports multiple UI clients simultaneously
- Each frame_id routes to correct client
Acceptance:
- Two browser tabs both work concurrently.

Iteration 10 — Packaging + health checks + docs
Goal:
- Add:
  - Eva GET /health: qv_connected true/false
  - QuickVision GET /health: model_loaded true/false
  - docker-compose.yml for eva + quickvision (+ ui optional)
- Update READMEs + troubleshooting section
Acceptance:
- `docker compose up` runs eva+quickvision end-to-end (UI can still be dev).

Optional Iteration 11 (only if needed) — Binary frame protocol
Goal:
- Switch from base64 JSON to binary frames for performance
- Keep metadata + payload deterministic (document it)
Acceptance:
- Same behavior, lower overhead.

Optional Later Iteration (only if desired) — JS workspaces
Goal:
- Add root package.json workspaces for packages/eva, packages/ui, packages/protocol
- Keep quickvision independent (python)
Acceptance:
- Root install + per-package dev works; no behavioral changes.

────────────────────────────────────────────────────────────
CODING RULES
────────────────────────────────────────────────────────────
- Don’t implement future iterations early.
- Keep changes minimal. Prefer adding small new files over rewriting.
- After each iteration: list changed files + exact commands to run + manual tests.
- If you add a dependency, keep it minimal and justified.
- Start at Iteration 0 NOW and proceed sequentially.
