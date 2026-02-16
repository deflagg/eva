# Progress

## Iteration 0 — Scaffold + protocol docs + build scripts

**Status:** ✅ Completed (2026-02-15)

### Completed
- Created locked repo structure under `packages/`.
- Added protocol documentation and JSON schema in `packages/protocol`.
- Added Eva TypeScript scaffold (`.nvmrc`, package scripts, tsconfig, stub src files).
- Added QuickVision FastAPI scaffold (requirements + app stubs).
- Added UI Vite + React + TypeScript scaffold (package scripts, config, stub src files).
- Added root `README.md` with run instructions and env var defaults.

### Verification
- Eva dependencies install and TypeScript build pass.
- Eva and UI dev servers both start successfully (verified via `timeout 8s npm run dev`).
- UI dependencies install and production build pass.
- QuickVision Python files compile (`python3 -m compileall app`).
- QuickVision runtime startup could not be verified in this host because `python3-venv`/`uvicorn` are not available in the sandbox environment.

### Notes
- No lint/test suites are configured yet.
- Functional WebSocket behavior starts in Iteration 1+.

## Iteration 1 — Eva: WS endpoint /eye + hello + echo (no QV yet)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Implemented WebSocket upgrade handling on Eva using `ws` bound to the Node `http` server.
- Added strict WS path routing for `/eye`.
- On WS connect, Eva sends protocol `hello` (`role: "eva"`).
- Eva now echoes valid incoming JSON messages back to the same client.
- Eva now handles invalid JSON with protocol error message:
  - `type: "error"`
  - `code: "INVALID_JSON"`
- Added protocol helpers and Zod message schemas for `hello` and `error`.
- Updated Eva README with Iteration 1 behavior.

### Verification
- `cd packages/eva && npm run build` passes.
- Manual WS check passes (hello + echo + invalid JSON error) via local Node script using `ws`.

### Notes
- No lint/test suite exists yet; verification is build + manual test.
- QuickVision relay is intentionally not implemented in this iteration.

## Iteration 2 — UI: connect to Eva + status + log panel (no camera yet)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Replaced UI placeholder page with a WebSocket-driven diagnostics page.
- Added browser WebSocket client utility in `src/ws.ts`:
  - connect/disconnect lifecycle
  - incoming JSON parsing
  - send JSON helper
- UI now auto-connects to `ws://localhost:8787/eye` on load.
- UI displays connection status: `connecting | connected | disconnected`.
- Added log panel showing:
  - system events (connect/disconnect/errors)
  - outgoing messages
  - incoming messages
- Added controls:
  - **Send test message** (sends JSON to Eva)
  - **Reconnect**
  - **Clear logs**
- Updated UI README with Iteration 2 behavior.

### Verification
- `cd packages/ui && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- Dev servers start successfully for manual verification:
  - `cd packages/eva && npm run dev`
  - `cd packages/ui && npm run dev`

### Manual test steps
1. Start Eva (`packages/eva`, `npm run dev`).
2. Start UI (`packages/ui`, `npm run dev`).
3. Open `http://127.0.0.1:5173/`.
4. Confirm status becomes `connected`.
5. Confirm log panel shows Eva `hello` message.
6. Click **Send test message**.
7. Confirm sent message appears as `[outgoing]` and echoed payload appears as `[incoming]`.

### Notes
- Camera capture is intentionally not implemented until Iteration 5.
- No automated UI integration test exists yet; this iteration uses manual browser verification.

## Iteration 3 — QuickVision: WS /infer + hello + echo (no YOLO yet)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Added QuickVision WebSocket endpoint at `/infer`.
- On connect, QuickVision sends protocol `hello` with `role: "quickvision"`.
- QuickVision now echoes valid JSON payloads received over `/infer`.
- Added invalid JSON handling for `/infer` with protocol error:
  - `type: "error"`
  - `code: "INVALID_JSON"`
- Expanded `app/protocol.py` with explicit Pydantic models and helpers for `hello` and `error` messages.
- Updated QuickVision README with Iteration 3 behavior.

### Verification
- `cd packages/quickvision && python3 -m compileall app` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.

### Manual test steps
1. Start QuickVision:
   - `cd packages/quickvision`
   - `python -m venv .venv`
   - `source .venv/bin/activate`
   - `pip install -r requirements.txt`
   - `uvicorn app.main:app --reload --port 8000`
2. Connect with a WS client to `ws://localhost:8000/infer`.
3. Confirm first message is `hello` (`role: "quickvision"`).
4. Send a valid JSON payload; confirm it is echoed back unchanged.
5. Send invalid JSON; confirm protocol error with `code: "INVALID_JSON"`.

### Notes
- YOLO inference is intentionally not implemented until Iteration 7.
- Runtime startup was not re-verified inside this sandbox because FastAPI/Uvicorn are not installed in the host environment.

## Iteration 4 — Eva: connect to QuickVision and relay UI ↔ QV (single client only)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Added QuickVision WebSocket client implementation in `packages/eva/src/quickvisionClient.ts`.
- Eva now opens a WS client connection to `QUICKVISION_WS_URL` at startup.
- Eva `/eye` endpoint now relays messages:
  - UI message (valid JSON) -> QuickVision
  - QuickVision response -> active UI client
- Retained protocol JSON parse validation on incoming UI messages:
  - invalid JSON -> `error` with `code: "INVALID_JSON"`
- Added temporary single-client guard for Iteration 4:
  - only one active UI WS client allowed
  - second client gets `SINGLE_CLIENT_ONLY` error and is closed
- Added `QV_UNAVAILABLE` error when UI sends messages while QuickVision is disconnected.
- Updated Eva README to document relay behavior and the Iteration 4 single-client limitation.

### Verification
- `cd packages/eva && npm run build` passes.
- End-to-end relay verified with local WS mock:
  - `UI -> Eva -> QuickVision -> Eva -> UI` round-trip succeeded.
- Single-client limitation verified:
  - second concurrent UI connection receives `SINGLE_CLIENT_ONLY` and closes.

### Manual test steps
1. Start QuickVision (`uvicorn app.main:app --reload --port 8000`).
2. Start Eva (`npm run dev` in `packages/eva`).
3. Start UI (`npm run dev` in `packages/ui`).
4. Open one UI tab and click **Send test message**.
5. Confirm message appears in logs as outgoing and incoming (relayed through QuickVision echo endpoint).
6. Open a second UI tab; confirm it is rejected with `SINGLE_CLIENT_ONLY`.

### Notes
- Multi-client routing is intentionally deferred to Iteration 9.
- QuickVision reconnect/backoff behavior is intentionally deferred to Iteration 8.

## Iteration 5 — UI: webcam capture + frame encoding + send frames (still echo response)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Added real camera workflow in UI:
  - `Start camera` / `Stop camera` controls
  - live `<video>` preview using `getUserMedia`
- Added JPEG frame capture pipeline in `src/camera.ts`:
  - draw current video frame to hidden `<canvas>`
  - encode as JPEG blob
  - convert to base64 bytes (no `data:` prefix)
- Added protocol `frame` message type in `src/types.ts`.
- Implemented frame streaming loop in UI:
  - sends protocol `frame` messages with `frame_id`, dimensions, mime, and `image_b64`
- Implemented required backpressure behavior (v1):
  - at most one in-flight frame at a time
  - waits for matching response `frame_id`
  - drops in-flight frame on timeout (`500ms`) and continues
- Added frame stats in UI:
  - sent / acknowledged / timed out / last ack latency / in-flight indicator
- Added log sanitization so large `image_b64` payloads are summarized instead of flooding logs.
- Updated UI README with Iteration 5 behavior.

### Verification
- `cd packages/ui && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Relay smoke test (mock QuickVision + Eva + WS client) passes for `frame` round-trip with matching `frame_id`.
- Dev servers start:
  - `cd packages/eva && npm run dev`
  - `cd packages/ui && npm run dev`

### Manual test steps
1. Start QuickVision (`uvicorn app.main:app --reload --port 8000`).
2. Start Eva (`npm run dev` in `packages/eva`).
3. Start UI (`npm run dev` in `packages/ui`) and open `http://127.0.0.1:5173/`.
4. Click **Start camera** and allow camera permissions.
5. Click **Start streaming**.
6. Confirm frame counters increase (`sent` and `acknowledged`) and UI remains responsive.
7. Stop QuickVision temporarily and confirm frame timeouts increase (backpressure timeout behavior).
8. Restart QuickVision and confirm frames resume.

### Notes
- This iteration still relies on QuickVision echo behavior (no detections yet).
- Overlay rendering is intentionally deferred to Iteration 6.

## Iteration 6 — UI overlay + QuickVision dummy detections

**Status:** ✅ Completed (2026-02-15)

### Completed
- QuickVision `/infer` no longer echoes frame payloads.
- Added protocol frame/detections models in `quickvision/app/protocol.py` using explicit Pydantic v2 models.
- QuickVision now validates incoming `frame` messages and returns deterministic dummy `detections`:
  - fixed box based on frame dimensions (`25%..75%` x, `20%..80%` y)
  - model label `dummy-fixed-box-v1`
- Added QuickVision error responses for unsupported/non-frame payloads and invalid frame shape.
- Implemented real overlay rendering in UI:
  - new `drawDetectionsOverlay()` in `ui/src/overlay.ts`
  - draws boxes and labels on a `<canvas>` layered above `<video>`
  - uses required scaling rule:
    - `scaleX = video.clientWidth / frame.width`
    - `scaleY = video.clientHeight / frame.height`
    - rect mapped from source frame coordinates to displayed video coordinates
- Updated UI camera preview layout to include overlay canvas.
- UI now tracks and displays latest detection count/model.
- Updated UI and QuickVision READMEs for Iteration 6 behavior.

### Verification
- `cd packages/ui && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Relay integration smoke test (mock QuickVision + Eva + WS client) verifies `detections` round-trip with matching `frame_id` and deterministic box coordinates.
- Dev servers start:
  - `cd packages/eva && npm run dev`
  - `cd packages/ui && npm run dev`

### Manual test steps
1. Start QuickVision (`uvicorn app.main:app --reload --port 8000`).
2. Start Eva (`npm run dev` in `packages/eva`).
3. Start UI (`npm run dev` in `packages/ui`) and open `http://127.0.0.1:5173/`.
4. Click **Start camera** and allow permissions.
5. Click **Start streaming**.
6. Confirm a stable detection box appears over the video feed.
7. Resize the browser window and confirm box remains aligned with the video content.

### Notes
- Detections are intentionally deterministic dummy outputs in this iteration.
- Real YOLO inference is intentionally deferred to Iteration 7.

## Iteration 7 — QuickVision: real YOLOE-26 inference

**Status:** ✅ Completed (2026-02-15)

### Completed
- Replaced dummy detection generation with real YOLO inference path in `quickvision/app/yolo.py`.
- Added startup model loading from env (once per process):
  - `YOLO_MODEL_PATH` required
  - `YOLO_DEVICE` supports `auto|cpu|cuda`
  - fail-fast startup errors for missing/invalid config
- Added image decode pipeline per frame:
  - base64 decode -> JPEG bytes -> Pillow image -> numpy array
- Added async inference wrapper using `asyncio.to_thread(...)`.
- Normalized YOLO output into protocol detections shape:
  - `cls`, `name`, `conf`, `box=[x1,y1,x2,y2]`
  - coordinates clamped to frame bounds
  - response model label fixed to `"yoloe-26"`
- Updated `/infer` WS behavior:
  - validates frame payloads with Pydantic models
  - runs inference and returns `detections`
  - returns `BUSY` when a new frame arrives while inference is still running for the same connection
- Updated QuickVision and root README run instructions to include required `YOLO_MODEL_PATH`.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- QuickVision startup fail-fast verified in `.venv`:
  - missing `YOLO_MODEL_PATH` => clear startup error
  - non-existent `YOLO_MODEL_PATH` => clear startup error
  - invalid model file at `YOLO_MODEL_PATH` => clear startup error
- Inference normalization path verified with a local fake-model harness:
  - `run_inference()` returns protocol `detections` with model `"yoloe-26"` and normalized fields.

### Manual test steps
1. Ensure QuickVision venv is set up and dependencies installed.
2. Set model source:
   - local file: `export YOLO_MODEL_PATH=/absolute/path/to/yoloe-26-weights.pt`
   - or alias: `export YOLO_MODEL_PATH=yolo26n.pt`
   - optional: `export YOLO_DEVICE=cpu`
3. Start QuickVision:
   - `uvicorn app.main:app --reload --port 8000`
4. Start Eva and UI as before.
5. Start camera + streaming in UI.
6. Confirm detections are real model outputs and boxes track scene objects.

### Notes
- This iteration keeps Eva routing behavior from Iteration 4 (single UI client limitation remains).
- Eva reconnect/backoff and routing hardening remain scheduled for Iteration 8.

## Iteration 7 (follow-up patch) — YOLO model alias auto-download support

**Status:** ✅ Completed (2026-02-15)

### Completed
- Updated QuickVision model loading so `YOLO_MODEL_PATH` accepts either:
  - local filesystem path, or
  - Ultralytics model alias (e.g. `yolo26n.pt`) for auto-download/load.
- Added path-vs-alias resolution rules:
  - if value looks like a path (`/`, `\\`, `.`, `~`) => must exist as a file
  - otherwise treated as alias and passed directly to Ultralytics
- Kept fail-fast behavior with clear startup errors when load/download fails.
- Updated docs to align:
  - `docs/implementation-plan.md`
  - root `README.md`
  - `packages/quickvision/README.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Startup with alias source verified (`YOLO_MODEL_PATH=yolo26n.pt`).
- Startup fail-fast verified for missing/non-existent/invalid model sources.

### Notes
- Protocol behavior is unchanged.
- This is a compatibility + DX patch to align runtime behavior with Ultralytics usage.

## Iteration 7 (follow-up patch) — Hardcoded model source (no YOLO_MODEL_PATH)

**Status:** ✅ Completed (2026-02-15)

### Completed
- Removed model-source env config path from QuickVision runtime.
- QuickVision now hardcodes model load source to:
  - `YOLO("yolo26n.pt")`
- Kept `YOLO_DEVICE` env support (`auto|cpu|cuda`) for runtime device selection.
- Updated docs to align with hardcoded behavior:
  - `docs/implementation-plan.md`
  - root `README.md`
  - `packages/quickvision/README.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- QuickVision starts with no `YOLO_MODEL_PATH` configured.
- Invalid `YOLO_DEVICE` still fails fast with a clear startup error.

### Notes
- `YOLO_MODEL_PATH` is no longer used by QuickVision.
- Ultralytics handles local cache/download for the hardcoded alias `yolo26n.pt`.

## Iteration 7 (follow-up patch) — PyTorch/NumPy runtime compatibility

**Status:** ✅ Completed (2026-02-16)

### Completed
- Updated `packages/quickvision/requirements.txt` to use NumPy 1.x compatible with pinned PyTorch 2.2 CUDA wheels:
  - `numpy>=1.26,<2.0` (was `numpy>=2.1,<3.0`)
  - retained requested CUDA wheel source and pins:
    - `--extra-index-url https://download.pytorch.org/whl/cu118`
    - `torch==2.2.*`
    - `torchvision==0.17.*`
- Reinstalled QuickVision venv dependencies from requirements.

### Verification
- `source .venv/bin/activate && python -c 'import torch, numpy; ...'` passes.
- Confirmed runtime versions:
  - `torch 2.2.2+cu118`
  - `numpy 1.26.4`
  - CUDA available on GTX 1080.
- QuickVision startup smoke check succeeds with `YOLO_DEVICE=cuda`.

### Notes
- This resolves the NumPy 2.x ABI/runtime warning/error from QuickVision.

## Iteration 8 — Hardening: routing map + TTL + error handling

**Status:** ✅ Completed (2026-02-16)

### Completed
- Implemented a real `FrameRouter` in Eva with `frame_id -> client` mapping and TTL eviction (default `5000ms`).
- Added TTL-expiry logging for dropped/expired frame routes to avoid silent unbounded growth.
- Wired route cleanup on UI disconnect/socket error so all pending `frame_id` entries for that client are removed.
- Hardened Eva UI inbound handling:
  - JSON parse validation (`INVALID_JSON`)
  - object-shape validation (`INVALID_PAYLOAD`)
  - message-type guard (`UNSUPPORTED_TYPE`)
  - zod frame schema validation (`INVALID_FRAME`)
- Hardened Eva QuickVision inbound handling with zod schema validation for `hello|detections|error` messages.
- Added strict frame-scoped routing behavior:
  - `detections` and frame-scoped `error` resolve through router map (`take + evict`)
  - unmatched/expired frame responses are dropped with a warning log
- Added QuickVision reconnect with exponential backoff in Eva (`250ms` doubling to `5000ms` cap).
- Retained Iteration 4 single-client behavior (multi-client remains Iteration 9).
- Updated `packages/eva/README.md` to document Iteration 8 behavior.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Start QuickVision:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `uvicorn app.main:app --reload --port 8000`
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Open UI, start camera + streaming, confirm detections continue to arrive normally.
5. Stop QuickVision and confirm Eva returns `QV_UNAVAILABLE` for new frames.
6. Restart QuickVision and confirm Eva reconnects automatically (check Eva logs for reconnect backoff/success).
7. With streaming active, close the UI tab and confirm Eva logs route cleanup (pending frame routes removed).

### Notes
- No dedicated automated test suite exists yet; verification remains build checks + manual end-to-end validation.
- Iteration 9 will remove single-client restriction and use the same route map for concurrent clients.
