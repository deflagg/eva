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
- Implementation plan was revised after Iteration 8; Iteration 9 now targets binary frame transport.

## Iteration 9 — Binary frame protocol

**Status:** ✅ Completed (2026-02-16)

### Completed
- Switched UI -> Eva -> QuickVision frame transport from JSON `image_b64` payloads to binary WebSocket envelopes.
- Added deterministic binary envelope format:
  - 4-byte big-endian metadata length
  - UTF-8 JSON metadata (`type: "frame_binary"`)
  - raw JPEG payload bytes
- Updated UI frame capture/send path:
  - `captureJpegFrame()` now returns raw JPEG bytes
  - added envelope encoder in `ui/src/frameBinary.ts`
  - frame send now uses `ws.send(binary)` via new `sendBinary(...)` client API
- Updated Eva frame ingress/forwarding path:
  - validates binary envelope metadata and payload length with zod
  - preserves frame routing (`frame_id -> client`) and TTL behavior from Iteration 8
  - forwards binary frame payload directly to QuickVision
  - returns `INVALID_FRAME_BINARY` / `FRAME_BINARY_REQUIRED` where applicable
- Updated Eva QuickVision client to support `sendBinary(...)`.
- Updated QuickVision `/infer` to read binary WS payloads and validate envelope metadata with Pydantic.
- Updated YOLO inference input pipeline to decode JPEG from raw bytes (removed base64 decode step).
- Updated protocol docs/schema and component READMEs for the binary frame format.

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
4. Open UI, start camera + streaming, and confirm detections continue to arrive.
5. Stop QuickVision and confirm UI receives `QV_UNAVAILABLE` errors for new frames.
6. Restart QuickVision and confirm Eva reconnects and frame streaming resumes.

### Notes
- No dedicated automated test suite exists yet; verification remains build checks + manual end-to-end validation.
- Single-client UI limitation remains in Eva (unchanged in this iteration).

## Iteration 10 — Config migration (cosmiconfig + Dynaconf + UI runtime config)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Migrated Eva runtime configuration from env/hardcoded values to config files loaded via cosmiconfig + zod:
  - added `packages/eva/eva.config.json` (committed defaults)
  - added `packages/eva/src/config.ts` with local-first search order:
    1. `eva.config.local.json`
    2. `eva.config.json`
  - updated `packages/eva/src/index.ts` to load `server.port`, `server.eyePath`, and `quickvision.wsUrl`
  - updated `packages/eva/src/server.ts` to use configurable WS path (`eyePath`) instead of hardcoded `/eye`
- Migrated QuickVision runtime configuration to Dynaconf layered YAML settings:
  - added `packages/quickvision/settings.yaml` (committed defaults)
  - added `packages/quickvision/app/settings.py` (Dynaconf instance)
  - added `packages/quickvision/app/run.py` so QuickVision can start via `python -m app.run` using configured host/port
  - updated `packages/quickvision/app/yolo.py` to read `yolo.model_source` and `yolo.device` from settings
  - added `dynaconf` dependency in `packages/quickvision/requirements.txt`
- Migrated UI WebSocket target to runtime config JSON:
  - added `packages/ui/public/config.json`
  - added `packages/ui/src/config.ts` loader (tries `/config.local.json`, falls back to `/config.json` when local file is missing/404 or dev server returns HTML fallback)
  - updated `packages/ui/src/ws.ts` to accept a URL argument (no hardcoded Eva URL)
  - updated `packages/ui/src/main.tsx` to load config before connecting WebSocket
- Updated ignores for local override and secrets-style files in root `.gitignore`.
- Updated component docs (`README.md` files) to reflect Iteration 10 config behavior and run commands.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual run steps
1. Start QuickVision using settings-based launcher:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `python -m app.run`
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Open UI and confirm it connects to the configured `eva.wsUrl` and detections still render.

### Notes
- Existing `uvicorn app.main:app --reload --port 8000` startup flow remains supported.
- Runtime behavior is intentionally unchanged from Iteration 9 except configuration source migration.

## Iteration 11 — Protocol v1 extensions: track_id + events[] + insight message + UI ack fix

**Status:** ✅ Completed (2026-02-16)

### Completed
- Extended protocol docs/schema to support detector and insight payloads:
  - updated `packages/protocol/schema.json` with:
    - optional `detection.track_id`
    - optional `detections.events[]` event envelope
    - new `insight` message schema (`clip_id`, `trigger_frame_id`, `summary`, `usage`)
  - updated `packages/protocol/README.md` with examples for `track_id`, `events[]`, and `insight`.
- Updated Eva protocol validation/types (`packages/eva/src/protocol.ts`):
  - added optional `track_id` and `events[]` on detections
  - added `insight` schema/type
  - expanded `QuickVisionInboundMessageSchema` to accept `insight` so Eva relays it instead of dropping it.
- Updated QuickVision Pydantic protocol models (`packages/quickvision/app/protocol.py`):
  - optional `DetectionEntry.track_id`
  - optional `DetectionsMessage.events`
  - new `EventEntry`, `InsightSummary`, `InsightUsage`, and `InsightMessage` models.
- Updated UI protocol types (`packages/ui/src/types.ts`) for the new fields/messages.
- Fixed UI in-flight ACK gating (`packages/ui/src/main.tsx`):
  - ACK now occurs only when `message.type === "detections"` and `frame_id` matches the in-flight frame
  - non-detection messages (including `error` and `insight`) no longer clear in-flight state.
- Updated READMEs (`README.md`, `packages/eva/README.md`, `packages/quickvision/README.md`, `packages/ui/README.md`) to reflect Iteration 11 behavior.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Start QuickVision:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `python -m app.run`
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Inject a fake `insight` message from QuickVision to Eva (no `frame_id`) and confirm UI logs it without clearing in-flight frame state.
5. Inject a fake `detections` payload with `events[]` and confirm UI logs the events payload and continues normal rendering.

### Notes
- No dedicated automated test suite exists yet; verification remains build checks + manual end-to-end validation.

## Iteration 12 — Add VisionAgent daemon (pi-mono) with guardrails

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added new `packages/vision-agent` package:
  - `.nvmrc`
  - `package.json`
  - `tsconfig.json`
  - `README.md`
  - `vision-agent.config.json`
  - `vision-agent.secrets.local.example.json`
  - `src/index.ts`
  - `src/config.ts`
  - `src/server.ts`
  - `src/prompts.ts`
  - `src/tools.ts`
- Implemented config loading for VisionAgent with cosmiconfig + zod:
  - local-first search order:
    1. `vision-agent.config.local.json`
    2. `vision-agent.config.json`
  - validated config schema includes:
    - `server.port`
    - `model.provider`
    - `model.id`
    - `guardrails.cooldownMs`
    - `guardrails.maxFrames` (hard-capped at 6)
    - `guardrails.maxBodyBytes`
    - `secretsFile`
- Implemented secrets loading from gitignored local JSON file:
  - reads `openaiApiKey` from configured `secretsFile`
  - no env-var API key usage in VisionAgent runtime path.
- Implemented HTTP server endpoints:
  - `GET /health`
  - `POST /insight`
- Implemented required guardrails on `POST /insight`:
  - request max body size (`413 PAYLOAD_TOO_LARGE`)
  - max frames (`400 TOO_MANY_FRAMES`)
  - request cooldown (`429 COOLDOWN_ACTIVE`)
- Implemented pi-ai model call with explicit API key passed in request options.
- Implemented structured tool-call output path:
  - tool schema defined via TypeBox (`submit_insight`)
  - prompt instructs model to call the tool exactly once
  - tool arguments validated with `validateToolCall(...)`
  - response returns structured `summary` + `usage`.
- Updated root docs (`README.md`) to include VisionAgent in component list/config/run instructions.
- Updated root `.gitignore` to explicitly include `packages/vision-agent/vision-agent.config.local.json` along with existing local/secrets ignore patterns.

### Verification
- `cd packages/vision-agent && npm install` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps / results
1. Start VisionAgent:
   - `cd packages/vision-agent`
   - create `vision-agent.secrets.local.json` with `openaiApiKey`
   - `npm run dev`
2. Health endpoint:
   - `curl http://localhost:8790/health`
   - ✅ returned `200` with service/model/guardrails metadata.
3. Max frames guardrail:
   - POST `/insight` with 7 frames
   - ✅ returned `400 TOO_MANY_FRAMES`.
4. Cooldown guardrail:
   - POST `/insight` twice quickly
   - ✅ second request returned `429 COOLDOWN_ACTIVE`.
5. Max body bytes guardrail:
   - POST oversized payload
   - ✅ returned `413 PAYLOAD_TOO_LARGE`.

### Notes
- Full happy-path `POST /insight` (<=6 frames -> 200 structured summary) requires a valid OpenAI API key in `vision-agent.secrets.local.json`.
- Current implementation intentionally keeps endpoint contract minimal (`summary`, `usage`) for QuickVision integration in later iterations.

## Iteration 13 — QuickVision insights plumbing: ring buffer + clip builder (max 6) + call VisionAgent (manual trigger)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added QuickVision insight plumbing modules:
  - `packages/quickvision/app/insights.py`
    - per-connection frame ring buffer
    - clip selection around trigger frame (pre/trigger/post)
    - max-frames enforcement (`<=6`)
    - post-frame collection bounded by timeout
    - insight cooldown enforcement
  - `packages/quickvision/app/vision_agent_client.py`
    - async HTTP client to VisionAgent using `httpx`
    - request/response validation with Pydantic models
    - normalized client errors for timeout/unreachable/invalid-response paths
- Added `httpx` dependency to QuickVision requirements.
- Added/updated insights Dynaconf keys in `packages/quickvision/settings.yaml`:
  - `insights.enabled`
  - `insights.vision_agent_url`
  - `insights.timeout_ms`
  - `insights.max_frames`
  - `insights.pre_frames`
  - `insights.post_frames`
  - `insights.insight_cooldown_ms`
- Updated QuickVision WS handling (`packages/quickvision/app/main.py`):
  - supports temporary JSON command:
    - `{ "type":"command", "v":1, "name":"insight_test" }`
  - on `insight_test`:
    - selects latest frame as trigger
    - builds bounded clip from ring buffer
    - calls VisionAgent
    - emits protocol `insight` message (no `frame_id`) on success
- Extended protocol models for command support:
  - `packages/quickvision/app/protocol.py`: added `CommandMessage`
  - `packages/eva/src/protocol.ts`: added `CommandMessageSchema`
  - `packages/protocol/schema.json`: added `command` schema
  - `packages/protocol/README.md`: documented temporary `command` message type
- Enabled command relay path through Eva (`packages/eva/src/server.ts`):
  - forwards validated JSON `command` payloads to QuickVision
  - preserves existing binary-frame path for normal streaming
- Added temporary UI trigger control (`packages/ui/src/main.tsx`):
  - **Trigger insight test** button sends command payload through Eva
- Updated docs for Iteration 13 behavior:
  - `README.md`
  - `packages/eva/README.md`
  - `packages/quickvision/README.md`
  - `packages/ui/README.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Start VisionAgent:
   - `cd packages/vision-agent`
   - ensure `vision-agent.secrets.local.json` has a valid `openaiApiKey`
   - `npm run dev`
2. Start QuickVision:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `pip install -r requirements.txt`
   - `python -m app.run`
3. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
4. Start UI:
   - `cd packages/ui`
   - `npm run dev`
5. In UI:
   - start camera + streaming
   - click **Trigger insight test**
   - confirm `insight` message appears in UI logs.
6. Click **Trigger insight test** repeatedly and confirm cooldown suppression errors are returned until cooldown elapses.

### Notes
- This iteration intentionally uses a manual debug trigger (`insight_test`) and does not yet auto-trigger from detector events.
- Insight clip payload is still full-resolution frame data; downsampling is planned for Iteration 21.

## Iteration 14 — Tracking: Ultralytics track(persist=true) + sequential pipeline (tracking continuity guardrail)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added new QuickVision tracking config module: `packages/quickvision/app/tracking.py`.
  - validates and loads:
    - `tracking.enabled`
    - `tracking.persist`
    - `tracking.tracker`
    - `tracking.busy_policy` (`drop|latest`)
- Updated QuickVision startup (`packages/quickvision/app/main.py`) to fail fast on invalid tracking config and log active tracking settings.
- Updated YOLO inference path (`packages/quickvision/app/yolo.py`) to support tracking mode:
  - when `tracking.enabled=true`, runs `model.track(..., persist=..., tracker=...)`
  - continues using predict mode when tracking is disabled
  - maps tracker IDs from `boxes.id` to optional protocol `detection.track_id`.
- Reworked QuickVision per-connection inference flow (`packages/quickvision/app/main.py`) into a sequential single-worker pipeline.
- Implemented `busy_policy=latest` behavior (when tracking is enabled):
  - maintains a one-slot latest-frame-wins pending frame
  - overwrites pending frame while inference is running
  - processes pending frame immediately after current inference completes
- Kept existing BUSY-drop behavior when tracking is disabled or `busy_policy=drop`.
- Added default tracking settings in `packages/quickvision/settings.yaml`.
- Updated docs:
  - `packages/quickvision/README.md`
  - root `README.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Enable tracking locally:
   - create/edit `packages/quickvision/settings.local.yaml`:
     ```yaml
     tracking:
       enabled: true
       persist: true
       tracker: bytetrack.yaml
       busy_policy: latest
     ```
2. Start QuickVision:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `python -m app.run`
3. Start Eva/UI and stream frames from UI.
4. Confirm detections include stable-ish `track_id` values for moving objects.
5. While streaming, confirm QuickVision no longer emits BUSY spam under `busy_policy=latest` and continues processing newest frames.
6. Switch to `busy_policy: drop` (or disable tracking) and confirm prior BUSY-drop behavior is restored.

### Notes
- No dedicated automated test suite exists yet; verification remains build checks plus manual runtime validation.
- This iteration intentionally does not introduce detector/event logic beyond track-id continuity plumbing.
