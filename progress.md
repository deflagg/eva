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

## Iteration 15 — ROI + line crossing detectors: region enter/exit + directional line crossing

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added ROI configuration/geometry module: `packages/quickvision/app/roi.py`.
  - loads and validates Dynaconf keys:
    - `roi.enabled`
    - `roi.representative_point` (locked to `"centroid"`)
    - `roi.regions` (mapping of rectangular ROIs with `x1,y1,x2,y2`)
    - `roi.lines` (mapping of directional lines with `x1,y1,x2,y2`)
  - provides geometry helpers:
    - box centroid representative point
    - point-in-region checks
    - line side classification (`A|B`) for directional crossing.
- Added detector state/event engine: `packages/quickvision/app/events.py`.
  - maintains per-track state for:
    - ROI membership
    - last known side per configured line
  - emits protocol events in `detections.events[]`:
    - `roi_enter` with `data: {"roi":"<name>"}`
    - `roi_exit` with `data: {"roi":"<name>"}`
    - `line_cross` with `data: {"line":"<name>","direction":"A->B|B->A"}`
  - includes stale track-state eviction (TTL) to avoid unbounded per-track memory growth.
- Updated QuickVision pipeline integration (`packages/quickvision/app/main.py`):
  - startup now fail-fast loads ROI settings and logs active ROI config.
  - per-connection detector engine instance created for `/infer` stream state.
  - each detections message now passes through event engine before send.
- Updated QuickVision defaults (`packages/quickvision/settings.yaml`) to include `roi` config block.
- Updated docs:
  - `packages/quickvision/README.md` (Iteration 15 behavior + ROI config keys)
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Configure a simple ROI + line in `packages/quickvision/settings.local.yaml`:
   ```yaml
   roi:
     enabled: true
     representative_point: centroid
     regions:
       left_half:
         x1: 0
         y1: 0
         x2: 640
         y2: 720
     lines:
       doorway:
         x1: 640
         y1: 0
         x2: 640
         y2: 720
   ```
2. Start QuickVision:
   - `cd packages/quickvision`
   - `source .venv/bin/activate`
   - `python -m app.run`
3. Start Eva and UI; stream camera frames from UI.
4. Move a tracked object/person into/out of `left_half` and confirm `roi_enter` / `roi_exit` events appear in `detections.events[]`.
5. Cross the `doorway` line in both directions and confirm `line_cross` with directional `A->B` / `B->A` is emitted.

### Notes
- ROI/line detectors require `track_id` continuity for robust state transitions; enabling tracking is recommended.
- No dedicated automated detector test suite exists yet; verification remains build checks plus manual runtime validation.

## Iteration 16 — Loitering detector: ROI dwell time

**Status:** ✅ Completed (2026-02-16)

### Completed
- Enhanced ROI settings loader (`packages/quickvision/app/roi.py`) with loitering/dwell config support:
  - added `roi.dwell.default_threshold_ms`
  - added optional per-region dwell overrides via:
    - `roi.regions.<name>.dwell_threshold_ms`, and/or
    - `roi.dwell.region_threshold_ms.<name>`
  - validates dwell thresholds as non-negative integers and fails fast for invalid values.
- Extended ROI settings model with:
  - `dwell_default_threshold_ms`
  - `dwell_region_threshold_ms`
  - helper `dwell_threshold_ms_for_region(...)`.
- Enhanced detector event engine (`packages/quickvision/app/events.py`) for loitering:
  - per-track per-ROI dwell state:
    - `region_enter_ts_ms`
    - `region_dwell_emitted`
  - emits `roi_dwell` exactly once per track per ROI per continuous stay when dwell threshold is reached.
  - keeps existing behavior for:
    - `roi_enter`
    - `roi_exit`
    - `line_cross`
  - exiting ROI clears dwell state so re-entering can emit `roi_dwell` again.
- Updated QuickVision startup/health metadata (`packages/quickvision/app/main.py`):
  - logs dwell default threshold and number of per-region overrides.
  - `/health` now includes ROI dwell configuration summary fields.
- Updated QuickVision committed defaults (`packages/quickvision/settings.yaml`) with:
  - `roi.dwell.default_threshold_ms`
  - `roi.dwell.region_threshold_ms`
- Updated docs:
  - `packages/quickvision/README.md`
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Configure ROI dwell thresholds in `packages/quickvision/settings.local.yaml`:
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
         dwell_threshold_ms: 3000
     lines:
       center_vertical:
         x1: 320
         y1: 0
         x2: 320
         y2: 480
     dwell:
       default_threshold_ms: 5000
       region_threshold_ms:
         left_half: 3000
   ```
2. Start QuickVision/Eva/UI and begin camera streaming.
3. Move into `left_half` ROI and remain there for >3 seconds.
4. Confirm a single `roi_dwell` event appears for that track/ROI with data shape:
   - `{"roi":"left_half","dwell_ms":<number>}`
5. Continue staying inside ROI and confirm no duplicate `roi_dwell` for the same continuous stay.
6. Exit ROI, then re-enter and wait past threshold again; confirm `roi_dwell` can emit again.

### Notes
- Loitering depends on stable `track_id` continuity; keep tracking enabled for reliable behavior.
- No dedicated automated detector test suite exists yet; verification remains build checks plus manual runtime validation.

## Iteration 17 — Sudden motion / stop detectors (per-track kinematics)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added motion settings + kinematics detector module: `packages/quickvision/app/motion.py`.
  - loads and validates Dynaconf motion keys:
    - `motion.enabled`
    - `motion.history_frames`
    - `motion.sudden_motion_speed_px_s`
    - `motion.stop_speed_px_s`
    - `motion.stop_duration_ms`
    - `motion.event_cooldown_ms`
  - enforces fail-fast config validation for invalid/non-numeric/negative settings.
  - maintains per-track centroid history (bounded by `history_frames`) and computes motion metrics.
- Implemented per-track kinematics event logic in `motion.py`:
  - emits `sudden_motion` when per-track speed (or abrupt speed delta proxy) crosses threshold.
    - event data shape: `{"speed_px_s": <number>}`
  - emits `track_stop` when speed stays below stop threshold for configured duration.
    - event data shape: `{"stopped_ms": <number>}`
  - applies per-track per-event cooldown (`event_cooldown_ms`) to reduce event spam.
  - includes stale track-state eviction to avoid unbounded memory growth.
- Updated detector orchestration in `packages/quickvision/app/events.py`:
  - integrated `MotionEventEngine` alongside existing ROI/line/dwell detectors.
  - `DetectionEventEngine` now supports ROI-only, motion-only, or combined operation.
- Updated QuickVision startup/runtime wiring in `packages/quickvision/app/main.py`:
  - startup now loads motion settings with fail-fast behavior.
  - startup logs include motion configuration summary.
  - `/health` now includes motion configuration fields.
  - frame processing now emits combined ROI + motion events in `detections.events[]`.
- Updated QuickVision committed defaults in `packages/quickvision/settings.yaml` with `motion` block.
- Updated docs:
  - `packages/quickvision/README.md` (Iteration 17 behavior + motion config keys)
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Add/adjust motion settings in `packages/quickvision/settings.local.yaml`:
   ```yaml
   motion:
     enabled: true
     history_frames: 8
     sudden_motion_speed_px_s: 250
     stop_speed_px_s: 20
     stop_duration_ms: 1500
     event_cooldown_ms: 1500
   ```
2. Start QuickVision/Eva/UI and begin camera streaming.
3. For `sudden_motion`:
   - move quickly across frame and confirm `events[]` includes:
     - `{"name":"sudden_motion", ..., "data":{"speed_px_s":...}}`
4. For `track_stop`:
   - move, then remain mostly still for > `stop_duration_ms`.
   - confirm a `track_stop` event with `stopped_ms` appears.
5. Continue standing still and confirm cooldown behavior prevents rapid repeated events.
6. Move again, then stop again to confirm stop event can be emitted on a new stop phase.

### Notes
- Motion detectors depend on stable `track_id` continuity; tracking should remain enabled for best results.
- `track_resume` remains optional and is intentionally not implemented in this iteration.
- No dedicated automated detector test suite exists yet; verification remains build checks plus manual runtime validation.

## Iteration 18 — Near-collision detector (pair distance + closing speed)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added new collision settings + detector module: `packages/quickvision/app/collision.py`.
  - loads and validates Dynaconf collision keys:
    - `collision.enabled`
    - `collision.pairs` (list of `[classA, classB]` class-name pairs)
    - `collision.distance_px`
    - `collision.closing_speed_px_s`
    - `collision.pair_cooldown_ms`
  - enforces fail-fast config validation for invalid pair shapes/types and invalid numeric thresholds.
  - normalizes pair matching as order-insensitive class pairs.
  - maintains per-pair state (`track_id` pair) with stale-state eviction to avoid unbounded growth.
  - computes centroid distance + closing speed (`delta_distance / delta_time`) and emits `near_collision` when both thresholds are met.
  - applies per-pair event cooldown to suppress repeated spam from repeated close frames.
- Updated detector orchestration in `packages/quickvision/app/events.py`:
  - integrated `CollisionEventEngine` alongside existing ROI and motion engines.
  - collision processing now runs on unique tracked detections per frame.
  - `DetectionEventEngine` now supports ROI-only, motion-only, collision-only, or combined operation.
- Updated QuickVision startup/runtime wiring in `packages/quickvision/app/main.py`:
  - startup now loads collision settings with fail-fast behavior.
  - startup logs include collision configuration summary.
  - `/health` now includes collision configuration fields.
  - frame processing now emits combined ROI + motion + collision events in `detections.events[]`.
- Updated QuickVision committed defaults in `packages/quickvision/settings.yaml` with a `collision` block.
- Updated docs:
  - `packages/quickvision/README.md` (Iteration 18 behavior + collision config keys)
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Collision logic smoke-check via local QuickVision venv script confirms:
  - event emitted when distance threshold + closing-speed threshold are crossed
  - cooldown suppresses immediate repeats.

### Manual test steps
1. Add/adjust collision settings in `packages/quickvision/settings.local.yaml`:
   ```yaml
   collision:
     enabled: true
     pairs:
       - [person, person]
     distance_px: 90
     closing_speed_px_s: 120
     pair_cooldown_ms: 1500
   ```
2. Start QuickVision/Eva/UI and begin camera streaming.
3. Move two eligible tracked objects quickly toward each other until within `distance_px`.
4. Confirm `events[]` includes a `near_collision` entry with data:
   - `a_track_id`, `b_track_id`
   - `a_class`, `b_class`
   - `distance_px`
   - `closing_speed_px_s`
5. Keep objects close across repeated frames and confirm rapid repeats are suppressed by `pair_cooldown_ms`.

### Notes
- Near-collision detector depends on stable `track_id` continuity; tracking should remain enabled for reliable behavior.
- Class matching is order-insensitive and name-based (e.g. `[person, bicycle]` matches either direction).
- No dedicated automated detector test suite exists yet; verification remains build checks plus manual/runtime validation.

## Iteration 20 — “Surprise trigger” + automatic insight calls (cooldowns everywhere) + Eva relay dedupe

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added automatic surprise-triggered insight plumbing in QuickVision (`packages/quickvision/app/insights.py`):
  - added `surprise` settings model and parsing from Dynaconf keys:
    - `surprise.enabled`
    - `surprise.threshold`
    - `surprise.cooldown_ms`
    - `surprise.weights`
  - implemented surprise scoring over `detections.events[]`:
    - score = sum of configured per-event weights in the current detections message
    - trigger only when `score >= surprise.threshold`
  - implemented dual cooldown guardrails:
    - `surprise.cooldown_ms` (trigger cooldown)
    - `insights.insight_cooldown_ms` (insight call cooldown)
  - added `run_auto_insight(...)` for automatic clip capture + VisionAgent call when triggered.
- Updated QuickVision runtime wiring (`packages/quickvision/app/main.py`):
  - after detector events are produced, QuickVision now schedules automatic insight generation for significant event bursts.
  - automatic insights are emitted as protocol `insight` messages (no `frame_id`) on success.
  - retained manual debug command path (`insight_test`) unchanged.
  - startup logs + `/health` now include surprise and insight cooldown config summaries.
- Added committed surprise defaults in `packages/quickvision/settings.yaml`:
  - includes default weights (high for `abandoned_object`/`near_collision`, medium for `roi_dwell`/`line_cross`, lower for `sudden_motion`/`track_stop`).
- Added Eva insight relay guardrails with config (`packages/eva/src/config.ts`, `packages/eva/eva.config.json`, `packages/eva/src/index.ts`, `packages/eva/src/server.ts`):
  - new config keys:
    - `insightRelay.enabled`
    - `insightRelay.cooldownMs`
    - `insightRelay.dedupeWindowMs`
  - applied relay protections for incoming QuickVision `insight` messages:
    - drop duplicate `clip_id` inside dedupe window
    - suppress relays inside cooldown window
  - logs suppression events for observability.
- Updated docs:
  - `packages/quickvision/README.md`
  - `packages/eva/README.md`
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- QuickVision automatic insight gating smoke-check via local `.venv` script confirms:
  - first high-score event trigger emits an auto insight
  - immediate repeat is suppressed by cooldown.
- Eva insight relay integration smoke-check (mock QuickVision WS + UI WS) confirms:
  - first insight relayed
  - duplicate clip_id suppressed by dedupe
  - different clip inside cooldown suppressed
  - new clip after cooldown relayed.

### Manual test steps
1. Configure/verify `packages/quickvision/settings.local.yaml`:
   ```yaml
   insights:
     enabled: true
     insight_cooldown_ms: 10000
   surprise:
     enabled: true
     threshold: 5
     cooldown_ms: 10000
     weights:
       near_collision: 5
   ```
2. Configure/verify Eva relay guardrails in `packages/eva/eva.config.local.json`:
   ```json
   {
     "insightRelay": {
       "enabled": true,
       "cooldownMs": 10000,
       "dedupeWindowMs": 60000
     }
   }
   ```
3. Start VisionAgent, QuickVision, Eva, and UI.
4. Trigger a high-weight event burst (for example `near_collision`) while streaming.
5. Confirm QuickVision emits one `insight` message automatically.
6. Re-trigger the same condition rapidly; confirm QuickVision suppresses repeats during cooldown.
7. If synthetic duplicate insights are injected from QuickVision, confirm Eva suppresses duplicate `clip_id` and cooldown-window floods.

### Notes
- Surprise scoring includes a default `abandoned_object` weight; abandoned-object event production was later backfilled in Iteration 19 (implemented after Iteration 20 by request).
- No dedicated end-to-end automated test suite exists yet; verification remains build checks plus targeted smoke checks/manual validation.

## Iteration 19 — Abandoned object detector

**Status:** ✅ Completed (2026-02-16)

> Implemented after Iteration 20 by request.

### Completed
- Added new abandoned-object detector module: `packages/quickvision/app/abandoned.py`.
  - loads and validates Dynaconf abandoned-detector keys:
    - `abandoned.enabled`
    - `abandoned.object_classes`
    - `abandoned.associate_max_distance_px`
    - `abandoned.associate_min_ms`
    - `abandoned.abandon_delay_ms`
    - `abandoned.stationary_max_move_px` (optional)
    - `abandoned.roi` (optional)
    - `abandoned.event_cooldown_ms`
  - enforces fail-fast config validation for invalid class lists, invalid thresholds, invalid optional ROI references, and cooldown values.
  - implements object-person association heuristic:
    - object candidate classes are configured via `abandoned.object_classes`
    - nearest `person` track within `associate_max_distance_px` must persist for `associate_min_ms` to become associated
    - when association is lost and object remains, starts abandon timer
  - emits `abandoned_object` when object remains beyond `abandon_delay_ms` (with optional stationary check) and cooldown allows.
  - event data shape:
    - `object_track_id`
    - `object_class`
    - `person_track_id`
    - `roi`
    - `abandon_ms`
  - includes stale state eviction to avoid unbounded per-track growth.
- Updated detector orchestration in `packages/quickvision/app/events.py`:
  - integrated `AbandonedEventEngine` alongside ROI, motion, and collision engines.
  - `DetectionEventEngine` now supports combined ROI + motion + collision + abandoned event generation.
- Updated QuickVision startup/runtime wiring in `packages/quickvision/app/main.py`:
  - startup now loads abandoned settings with fail-fast behavior.
  - startup logs include abandoned detector config summary.
  - `/health` now includes abandoned detector configuration fields.
  - WebSocket inference path now wires abandoned settings into the detector engine.
- Updated QuickVision defaults in `packages/quickvision/settings.yaml` with an `abandoned` config block.
- Updated docs:
  - `packages/quickvision/README.md` (event + config + validation docs)
  - root `README.md` status line.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Abandoned-detector smoke-check via local `.venv` script confirms:
  - event emits after association loss + abandon delay
  - re-association before delay cancels
  - movement beyond `stationary_max_move_px` resets pending abandon.

### Manual test steps
1. Configure abandoned detector in `packages/quickvision/settings.local.yaml`:
   ```yaml
   abandoned:
     enabled: true
     object_classes: [backpack, suitcase, handbag]
     associate_max_distance_px: 120
     associate_min_ms: 1000
     abandon_delay_ms: 5000
     stationary_max_move_px: 20
     roi: null
     event_cooldown_ms: 10000
   ```
2. Start QuickVision/Eva/UI and stream frames with tracking enabled.
3. Place an eligible object near a person long enough to establish association.
4. Have the person leave while the object remains; confirm `abandoned_object` event appears after `abandon_delay_ms`.
5. Move the object or re-associate a person before delay and confirm pending abandon is canceled.

### Notes
- The detector uses class-name matching for object classes and assumes person tracks are named `person`.
- This fills the `abandoned_object` event path referenced by Iteration 20 surprise weights.
- No dedicated automated detector test suite exists yet; verification remains build checks plus targeted smoke checks/manual validation.

## Iteration 21 — Downsample before LLM (QuickVision-only)

**Status:** ✅ Completed (2026-02-16)

### Completed
- Added insight payload downsample settings + validation in `packages/quickvision/app/insights.py`:
  - `insights.downsample.enabled`
  - `insights.downsample.max_dim` (must be `>= 1`)
  - `insights.downsample.jpeg_quality` (must be in `1..100`)
- Added clip payload downsampling pipeline in `packages/quickvision/app/insights.py` (request payload only):
  - base64 decode -> Pillow image decode
  - resize longest side to `max_dim` when needed
  - JPEG re-encode using `jpeg_quality`
  - replace outgoing `image_b64` in VisionAgent request frames
- Kept YOLO inference path unchanged (downsampling only affects the Insight/VisionAgent payload path).
- Updated QuickVision startup + health observability in `packages/quickvision/app/main.py` with downsample config fields.
- Updated QuickVision committed defaults in `packages/quickvision/settings.yaml` with `insights.downsample` block.
- Updated docs:
  - `packages/quickvision/README.md`
  - `README.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Configure downsampling in `packages/quickvision/settings.local.yaml`:
   ```yaml
   insights:
     downsample:
       enabled: true
       max_dim: 640
       jpeg_quality: 75
   ```
2. Start VisionAgent, QuickVision, Eva, and UI.
3. Trigger `insight_test` in UI and capture resulting `insight.usage.input_tokens`.
4. Disable downsampling (`insights.downsample.enabled: false`), restart QuickVision, trigger the same scene again, and compare `insight.usage.input_tokens`.
   - Expect lower input-token usage with downsampling enabled.
5. Compare generated summaries/tags between on/off runs and confirm insight quality remains acceptable.

### Notes
- This iteration intentionally changes only the clip payload sent to VisionAgent; detector/inference frame flow remains unchanged.

## Iteration 22 — UI: event feed + insight panel + optional debug overlay

**Status:** ✅ Completed (2026-02-16)

### Completed
- Enhanced UI message handling in `packages/ui/src/main.tsx`:
  - collects and displays a rolling recent event feed from `detections.events[]`
  - event rows include `name`, `severity`, optional `track_id`, and compact `data` summaries
  - captures and displays latest `insight` message details (one-liner, tags, what_changed, usage/cost)
- Added optional ROI/line debug overlay toggle in UI (`packages/ui/src/main.tsx`):
  - added control button to show/hide debug geometry overlay without interrupting streaming
  - overlay state shown in status line (`on/off/not configured`)
- Extended overlay renderer in `packages/ui/src/overlay.ts`:
  - supports optional drawing of configured ROI rectangles and line segments
  - keeps existing detection-box rendering and scaling behavior
- Extended runtime config parsing in `packages/ui/src/config.ts`:
  - added optional `debugOverlay.regions` and `debugOverlay.lines` schema parsing/validation
  - validates coordinate fields as finite numbers
- Updated docs:
  - `packages/ui/README.md`
  - root `README.md` status line

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision-agent && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Start VisionAgent, QuickVision, Eva, and UI.
2. Start camera + streaming in UI.
3. Trigger detector events (for example ROI enter/exit, line crossing, motion).
4. Confirm **Recent events** panel populates with:
   - event name
   - severity
   - optional `track_id`
   - compact data summary text
5. Trigger `insight_test` (or a surprise-triggered insight) and confirm **Latest insight** panel updates with one-liner + tags.
6. (Optional) Add ROI/line geometry under `debugOverlay` in `packages/ui/public/config.local.json`, reload UI, and toggle **Show/Hide ROI/line overlay**.
7. Confirm streaming + frame acknowledgements continue normally while events/insights panels and overlay are active.

### Notes
- Debug ROI/line overlay geometry is intentionally sourced from UI runtime config so this iteration remains UI-only and does not require protocol/backend changes.

## Iteration 23 — Eva config: add subprocess settings (no behavior change)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Extended Eva config schema (`packages/eva/src/config.ts`) with new optional `subprocesses` block and defaults:
  - `subprocesses.enabled` default `false`
  - `subprocesses.visionAgent` defaults for `enabled/cwd/command/healthUrl/readyTimeoutMs/shutdownTimeoutMs`
  - `subprocesses.quickvision` defaults for `enabled/cwd/command/healthUrl/readyTimeoutMs/shutdownTimeoutMs`
- Added validation rules in Eva config schema:
  - `command` must be a non-empty array of non-empty strings
  - `healthUrl` must be a valid `http://` or `https://` URL
  - timeout fields must be positive integers
- Added committed local override example file:
  - `packages/eva/eva.config.local.example.json`
- Updated root ignore rules to allow committing the Eva local-example config file:
  - `.gitignore` now includes `!packages/eva/eva.config.local.example.json`

### Verification
- `cd packages/eva && npm run build` passes.
- Manual smoke check with only `eva.config.json` present (no `eva.config.local.json`):
  - `cd packages/eva && timeout 8s npm run dev`
  - Eva still boots in existing external-QuickVision mode (listens on `:8787`, targets `ws://localhost:8000/infer`, reconnect behavior unchanged).

### Manual test steps
1. Ensure `packages/eva/eva.config.local.json` does not exist.
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Confirm startup logs remain unchanged from prior behavior:
   - HTTP listen on configured port/path
   - QuickVision WS target from `quickvision.wsUrl`
   - reconnect attempts if QuickVision is not running.

### Notes
- Runtime behavior is intentionally unchanged in this iteration; subprocess management wiring begins in Iteration 24+.
## Iteration 24 — Add subprocess utility (ManagedProcess + health polling)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Added reusable health polling helper module:
  - `packages/eva/src/subprocess/health.ts`
  - exports:
    - `sleep(ms)`
    - `waitForHttpHealthy({ name, healthUrl, timeoutMs, intervalMs })`
  - behavior:
    - polls `GET healthUrl` using Node global `fetch`
    - succeeds only on HTTP `200`
    - retries every `250ms` by default until timeout
    - includes last observed error/status in timeout error message
- Added reusable subprocess manager:
  - `packages/eva/src/subprocess/ManagedProcess.ts`
  - supports:
    - `start()` using Node `child_process.spawn`
      - `cwd` + `command` from config
      - `env` passthrough (`process.env`)
      - `detached: true` (Linux-first process-group signaling)
    - prefixed stdout/stderr logs (`[name] ...`)
    - `waitForHealthy()` using HTTP polling helper
    - `stop()` with SIGTERM then SIGKILL fallback
      - Linux-first process-group signaling via `process.kill(-pid, signal)` when available
      - fallback to `child.kill(signal)`

### Verification
- `cd packages/eva && npm run build` passes.
- Manual smoke check via temporary tsx script using `ManagedProcess` to launch a tiny Node health server:
  - `waitForHealthy()` succeeded
  - `stop()` terminated process
  - health endpoint became unreachable after stop.

### Manual test steps
1. From `packages/eva`, run build:
   - `npm run build`
2. (Smoke example) run a small script that:
   - creates `ManagedProcess` for `node -e "http server"`
   - calls `start()` then `waitForHealthy()`
   - calls `stop()` and verifies health endpoint no longer responds.

### Notes
- No runtime wiring changes in Eva bootstrap yet; subprocesses are introduced as utilities only in this iteration.
- Eva startup/shutdown integration begins in Iteration 25+.

## Iteration 25 — Eva spawns VisionAgent (gated by config)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Updated Eva bootstrap entrypoint (`packages/eva/src/index.ts`) to async startup flow:
  - added `main()` + top-level `main().catch(...)` fatal path (`process.exit(1)`) with clear startup error logging.
- Added config-gated VisionAgent subprocess startup path:
  - when `subprocesses.enabled=true` and `subprocesses.visionAgent.enabled=true`:
    1. resolves `visionAgent.cwd` relative to repo root
    2. starts `ManagedProcess` using config-driven command (default `npm run dev`)
    3. waits for VisionAgent health endpoint to return `200`
    4. only then starts Eva server.
- Added startup failure cleanup for this path:
  - if VisionAgent health wait fails, Eva calls `visionAgent.stop()` before surfacing fatal startup error.
- Kept default behavior unchanged when subprocess mode is not enabled:
  - Eva starts exactly as before and connects to external QuickVision via `quickvision.wsUrl`.

### Verification
- `cd packages/eva && npm run build` passes.
- Manual subprocess-mode run passes:
  1. copied `packages/eva/eva.config.local.example.json` -> `packages/eva/eva.config.local.json` (with `subprocesses.enabled=true`)
  2. started Eva (`cd packages/eva && npm run dev`)
  3. observed logs:
     - Eva started VisionAgent subprocess
     - Eva waited for VisionAgent health
     - Eva reported VisionAgent healthy
     - Eva then started listening on `:8787`
  4. `curl http://127.0.0.1:8790/health` returned `200` JSON while Eva was running.

### Manual test steps
1. Copy local override file:
   - `cp packages/eva/eva.config.local.example.json packages/eva/eva.config.local.json`
2. Ensure VisionAgent dependencies are installed once:
   - `cd packages/vision-agent && npm i`
3. Start Eva:
   - `cd packages/eva && npm run dev`
4. Confirm VisionAgent health:
   - `curl http://127.0.0.1:8790/health`
5. Confirm Eva starts only after VisionAgent is healthy (startup logs show this order).

### Notes
- This iteration intentionally wires only VisionAgent startup; QuickVision subprocess startup remains Iteration 26.
- Graceful coordinated shutdown (to avoid orphan subprocesses on Ctrl+C) is intentionally deferred to Iteration 27.

## Iteration 26 — Eva spawns QuickVision (gated by config)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Extended Eva bootstrap subprocess flow in `packages/eva/src/index.ts`:
  - retained Iteration 25 order for VisionAgent startup + health wait.
  - added QuickVision startup + health wait when subprocess mode is enabled:
    1. start VisionAgent subprocess
    2. wait for VisionAgent health (`subprocesses.visionAgent.healthUrl`)
    3. start QuickVision subprocess (`subprocesses.quickvision.command`, default `python -m app.run`)
    4. wait for QuickVision health (`subprocesses.quickvision.healthUrl`)
    5. then start Eva server.
- Added startup failure cleanup path in `main()`:
  - if startup fails after subprocesses are started, Eva now attempts to stop QuickVision first, then VisionAgent, before surfacing fatal error.
- Kept Eva QuickVision WebSocket target config unchanged:
  - `quickvision.wsUrl` (default `ws://localhost:8000/infer`) remains the relay target.

### Verification
- `cd packages/eva && npm run build` passes.
- Manual subprocess boot ordering check:
  - with `eva.config.local.json` enabling subprocesses, startup logs now show:
    - VisionAgent subprocess start -> VisionAgent health wait/success
    - QuickVision subprocess start -> QuickVision health wait
    - Eva server starts only after health waits complete.
- In this host, QuickVision readiness success was not fully verified because `python -m app.run` depends on local Python environment setup (for example `uvicorn` availability / venv path). Manual run instructions are included below.

### Manual test steps
1. QuickVision one-time setup:
   - `cd packages/quickvision`
   - `python -m venv .venv`
   - `source .venv/bin/activate`
   - `pip install -r requirements.txt`
2. Enable subprocess mode:
   - `cp packages/eva/eva.config.local.example.json packages/eva/eva.config.local.json`
3. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
4. Confirm health endpoints:
   - `curl http://127.0.0.1:8790/health`
   - `curl http://127.0.0.1:8000/health`
5. Start UI and verify detections still flow through Eva relay.

### Notes
- This iteration only adds startup orchestration for QuickVision; graceful coordinated shutdown remains Iteration 27.

## Iteration 27 — Graceful shutdown (no orphan daemons)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Updated Eva bootstrap/shutdown lifecycle in `packages/eva/src/index.ts`:
  - keeps runtime references to:
    - Eva HTTP server (`Server`) returned by `startServer(...)`
    - `ManagedProcess` instances for QuickVision and VisionAgent
- Added idempotent shutdown coordinator:
  - single `shutdown()` path guarded by `shutdownInFlight`
  - repeated signal delivery does not run shutdown twice
- Registered signal handlers:
  - `process.on('SIGINT', ...)`
  - `process.on('SIGTERM', ...)`
- Implemented required shutdown order in signal path:
  1. log `[eva] shutting down...`
  2. close Eva server (`server.close(...)`)
  3. log + stop QuickVision (`[eva] stopping quickvision...`)
  4. log + stop VisionAgent (`[eva] stopping vision-agent...`)
- Kept startup failure cleanup using the same shutdown path (ensures no orphan subprocesses on startup errors).

### Verification
- `cd packages/eva && npm run build` passes.
- Manual subprocess-mode shutdown test passed:
  1. started Eva in subprocess mode (VisionAgent + QuickVision + Eva healthy)
  2. sent Ctrl+C to Eva process
  3. observed shutdown logs in required order:
     - `[eva] shutting down...`
     - `[eva] stopping quickvision...`
     - `[eva] stopping vision-agent...`
  4. observed subprocess exits for both daemons.
  5. confirmed ports released after shutdown:
     - `curl http://127.0.0.1:8000/health` -> connection refused
     - `curl http://127.0.0.1:8790/health` -> connection refused

### Manual test steps
1. Enable subprocess mode in Eva local config.
2. Ensure QuickVision Python environment is installed (`.venv` + requirements).
3. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
4. Wait for startup to show all services healthy.
5. Press Ctrl+C in Eva terminal.
6. Confirm logs show shutdown order and subprocess stops.
7. Verify ports are free:
   - `curl http://127.0.0.1:8000/health`
   - `curl http://127.0.0.1:8790/health`

### Notes
- Coordinated shutdown now handles both normal signal-triggered shutdown and startup-error cleanup via the same idempotent path.
- README workflow updates are deferred to Iteration 28.

## Iteration 28 — Docs: “one command boots the stack”

**Status:** ✅ Completed (2026-02-17)

### Completed
- Updated `packages/eva/README.md` to document both workflows clearly:
  - **external mode** (status quo): start VisionAgent + QuickVision manually, then Eva
  - **subprocess mode**: copy `eva.config.local.example.json` -> `eva.config.local.json`, then run `npm run dev` in `packages/eva`
- Added explicit prerequisites in Eva README:
  - VisionAgent one-time setup (Node deps + secrets file)
  - QuickVision one-time setup (venv + `pip install -r requirements.txt`)
  - Eva one-time setup (Node deps)
- Added troubleshooting guidance for common subprocess-mode QuickVision startup issue:
  - `ModuleNotFoundError: No module named 'uvicorn'`
  - documented how to point `subprocesses.quickvision.command` to `.venv/bin/python`.
- (Optional) Updated root `README.md` with a short one-command stack boot summary section for Eva subprocess mode.

### Verification
- Documentation update only (no runtime code changes in this iteration).
- Build spot-check:
  - `cd packages/eva && npm run build` passes.
- Manual guidance validation:
  - README steps match implemented Iterations 23–27 behavior:
    - subprocess mode remains opt-in
    - Eva waits on VisionAgent/QuickVision health before serving
    - Ctrl+C shutdown tears down subprocesses.

### Manual test steps
1. Complete one-time dependencies:
   - VisionAgent `npm install` + secrets file
   - QuickVision `.venv` + `pip install -r requirements.txt`
   - Eva `npm install`
2. Copy subprocess example config:
   - `cd packages/eva`
   - `cp eva.config.local.example.json eva.config.local.json`
3. Run stack from one command:
   - `npm run dev`
4. Verify health endpoints:
   - `curl http://127.0.0.1:8790/health`
   - `curl http://127.0.0.1:8000/health`
   - `curl http://127.0.0.1:8787/`

### Notes
- Iterations 23–28 are now fully documented in repo progress and Eva README workflow sections.

## Iteration 29 — Eva config plumbing only (no runtime behavior)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Extended Eva config schema in `packages/eva/src/config.ts` with a new `speech` block (Zod + defaults):
  - `enabled`
  - `path`
  - `defaultVoice`
  - `maxTextChars`
  - `maxBodyBytes`
  - `cooldownMs`
  - `cache.enabled`
  - `cache.ttlMs`
  - `cache.maxEntries`
- Updated committed Eva defaults in `packages/eva/eva.config.json` to include `speech` with `enabled: false`.
- Updated copy-only local example config in `packages/eva/eva.config.local.example.json` to include `speech` with `enabled: true` for local testing.

### Verification
- `cd packages/eva && npm run build` passes.
- No Eva server/runtime behavior was changed in this iteration (config plumbing only).

### Manual test steps
1. Build Eva:
   - `cd packages/eva`
   - `npm run build`
2. (Optional) Start Eva with committed defaults and confirm existing behavior remains unchanged.

### Notes
- This iteration intentionally does not add any speech runtime wiring; endpoint behavior starts in Iteration 31.

## Iteration 30 — Add Edge TTS dependency + wrapper module (no server route yet)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Added pinned Eva dependency in `packages/eva/package.json`:
  - `node-edge-tts` at `1.2.10`.
- Added speech wrapper types in `packages/eva/src/speech/types.ts`:
  - `SynthesizeInput` (`text`, `voice`, optional `rate`).
- Added Edge TTS wrapper module in `packages/eva/src/speech/edgeTts.ts`:
  - exports `synthesize({ text, voice, rate }): Promise<Buffer>`
  - dynamic-loads `node-edge-tts` with ESM/CJS interop handling
  - normalizes numeric `rate` into Edge prosody rate strings
  - synthesizes into a temp MP3 file, returns bytes as `Buffer`, then cleans up temp files
  - validates non-empty `text` and `voice`.

### Verification
- `cd packages/eva && npm install` passes.
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Install/update Eva dependencies:
   - `cd packages/eva`
   - `npm install`
2. Build Eva:
   - `npm run build`

### Notes
- This iteration intentionally adds only dependency + internal wrapper module.
- No Eva HTTP route changes were made yet (`/speech` begins in Iteration 31).

## Iteration 31 — Eva HTTP router + `POST /speech` returns MP3 bytes (MVP)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Extended Eva server options in `packages/eva/src/server.ts`:
  - `StartServerOptions` now includes `speech` config.
- Wired config into Eva bootstrap in `packages/eva/src/index.ts`:
  - `startServer(...)` now receives `speech: config.speech`.
- Added speech HTTP routing in `packages/eva/src/server.ts`:
  - `OPTIONS <speech.path>` responds `204` with required CORS headers.
  - `POST <speech.path>` parses and validates JSON payload and returns `audio/mpeg` bytes.
  - fallback behavior remains the existing service-ok JSON response for non-speech routes.
- Implemented required guardrails for `POST /speech`:
  - body-size enforcement while streaming request body (`413 PAYLOAD_TOO_LARGE`)
  - JSON parse validation (`400 INVALID_JSON`)
  - field validation (`400 INVALID_REQUEST`) for empty/missing text, too-long text, invalid voice/rate
  - cooldown enforcement (`429 COOLDOWN_ACTIVE`) when `speech.cooldownMs > 0`
  - synthesis failure handling (`500 SYNTHESIS_FAILED`)
- Added speech CORS headers for speech route responses:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Allow-Headers: content-type`

### Verification
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Enable speech in local config (`packages/eva/eva.config.local.json`) by adding/merging:
   ```json
   "speech": {
     "enabled": true,
     "path": "/speech",
     "defaultVoice": "en-US-JennyNeural",
     "maxTextChars": 1000,
     "maxBodyBytes": 65536,
     "cooldownMs": 0,
     "cache": {
       "enabled": true,
       "ttlMs": 600000,
       "maxEntries": 64
     }
   }
   ```
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Generate MP3 via speech endpoint:
   ```bash
   curl -sS -X POST http://127.0.0.1:8787/speech \
     -H 'content-type: application/json' \
     -d '{"text":"hello from eva","voice":"en-US-JennyNeural"}' \
     --output out.mp3
   ```
4. Confirm response headers include `content-type: audio/mpeg` and verify `out.mp3` plays.

### Notes
- Speech route is active only when `speech.enabled=true`.
- Cache settings are config-only in this iteration; cache/in-flight dedupe behavior is planned for Iteration 34.

## Iteration 32 — UI: Speech client + one-click “Enable Audio” (required for autoplay)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Added UI speech client module in `packages/ui/src/speech.ts`:
  - derives Eva HTTP base from `eva.wsUrl` (`ws://` -> `http://`, `wss://` -> `https://`)
  - `createSpeechClient(...)` with:
    - `speakText({ text, voice, rate, signal })`
      - POSTs JSON to Eva speech endpoint
      - loads returned audio blob into an `<audio>` element and plays it
      - marks audio as locked and throws `AudioLockedError` if browser autoplay policy blocks playback
    - `enableAudio()` one-click unlock probe for autoplay policy
    - lifecycle helpers: `stop()` and `dispose()`
- Extended UI runtime config parsing in `packages/ui/src/config.ts` with `speech` block:
  - `speech.enabled` (default `false`)
  - `speech.path` (default `"/speech"`)
  - `speech.defaultVoice` (default `"en-US-JennyNeural"`)
  - `speech.autoSpeak.enabled` (default follows `speech.enabled`)
  - `speech.autoSpeak.minSeverity` (`"medium"|"high"`, default `"medium"`)
  - `speech.autoSpeak.cooldownMs` (default `2000`)
  - `speech.autoSpeak.textTemplate` (default `"Insight: {{one_liner}}"`)
- Updated committed UI runtime defaults in `packages/ui/public/config.json` with a `speech` section.
- Updated UI app wiring in `packages/ui/src/main.tsx`:
  - derives and displays Eva HTTP base + speech endpoint URL
  - creates/disposes `SpeechClient`
  - added controls:
    - **Auto Speak** toggle
    - **Enable Audio** button
    - **Voice** text field
    - **Test Speak** button
  - added autoplay lock notice when audio is currently blocked.
- Updated UI docs in `packages/ui/README.md` for Iteration 32 behavior and speech config.

### Verification
- `cd packages/ui && npm run build` passes.
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Enable Eva speech endpoint in `packages/eva/eva.config.local.json` (`speech.enabled: true`) and start Eva:
   - `cd packages/eva`
   - `npm run dev`
2. Configure UI speech in `packages/ui/public/config.local.json` (or `config.json`) with `speech.enabled: true`.
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Open the UI page.
5. Click **Enable Audio** once.
6. Click **Test Speak** and confirm audio plays.

### Notes
- Auto-speak trigger from incoming `insight` messages is intentionally deferred to Iteration 33.

## Iteration 33 — Auto-speak: speak new insights automatically (core requirement)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Hooked auto-speak into UI insight handling in `packages/ui/src/main.tsx`:
  - on each incoming `insight` message, UI now evaluates and conditionally triggers speech.
- Added `shouldAutoSpeak` policy checks in UI:
  - `speech.enabled === true`
  - UI Auto Speak toggle enabled
  - insight severity >= `speech.autoSpeak.minSeverity`
  - UI cooldown window elapsed (`speech.autoSpeak.cooldownMs`)
  - resolved speech text is non-empty
- Implemented insight speech text selection in UI:
  - template rendering from `speech.autoSpeak.textTemplate`
  - supports placeholders (`{{one_liner}}`, `{{severity}}`, `{{tags}}`, `{{what_changed}}`, `{{clip_id}}`, `{{trigger_frame_id}}`)
  - fallback to `one_liner`, then shortened summary/tags when template output is empty
- Implemented speech interruption and dedupe behavior in UI:
  - new speech request aborts previous in-flight fetch via `AbortController`
  - new speech request stops current audio playback before starting
  - blob URL cleanup on stop/new speech (`SpeechClient.stop()` now revokes prior object URL)
  - added `lastSpokenInsightId` guard (`clip_id:trigger_frame_id`) to avoid duplicate speaking of same insight
- Refactored test speech path to use the same cancellation-safe speech request flow.
- Updated UI docs in `packages/ui/README.md` to describe Iteration 33 auto-speak behavior.

### Verification
- `cd packages/ui && npm run build` passes.
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Ensure Eva speech endpoint is enabled and running:
   - `cd packages/eva`
   - set `speech.enabled: true` in `eva.config.local.json`
   - `npm run dev`
2. Ensure UI speech config is enabled (`packages/ui/public/config.local.json` or `config.json`):
   - `speech.enabled: true`
   - `speech.autoSpeak.enabled: true`
   - `speech.autoSpeak.minSeverity: "medium"` (default)
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Click **Enable Audio** once.
5. Trigger insight messages (for example via **Trigger insight test**) and confirm:
   - new MED/HIGH insights are spoken automatically
   - LOW insights are not spoken by default
   - repeated same insight id is not spoken again
6. Trigger multiple insights rapidly and confirm latest request interrupts prior one (no overlapping playback/fetch).

### Notes
- Iteration 33 implements UI-side auto-speak only; Eva speech caching/dedupe remains planned for Iteration 34.

## Iteration 34 — Caching + in-flight dedupe (cost + latency win)

**Status:** ✅ Completed (2026-02-17)

### Completed
- Updated Eva speech route implementation in `packages/eva/src/server.ts`:
  - added deterministic cache-key generation for synthesis inputs:
    - `sha256(voice|rate|text)`
  - added in-memory speech cache:
    - key -> `{ audio: Buffer, createdAtMs }`
  - implemented TTL eviction for expired cache entries (`speech.cache.ttlMs`)
  - implemented max-entry cap enforcement (`speech.cache.maxEntries`) with oldest-entry eviction
- Added in-flight synthesis dedupe in Eva speech route:
  - tracks active synthesis promises by cache key
  - concurrent requests for the same key now await the same synthesis promise
  - in-flight entries are removed on settle (`finally`)
- Added response header on successful speech responses:
  - `X-Eva-TTS-Cache: HIT|MISS`
    - `HIT` when served from cache
    - `MISS` when synthesis path is used (including in-flight dedupe await)
- Added speech cache observability on startup logs:
  - `speech.cache.enabled`, `ttlMs`, `maxEntries`
- Added cleanup on server close:
  - clears speech cache map and in-flight synthesis map.

### Verification
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Enable speech + cache in `packages/eva/eva.config.local.json`:
   ```json
   {
     "speech": {
       "enabled": true,
       "cache": {
         "enabled": true,
         "ttlMs": 600000,
         "maxEntries": 64
       }
     }
   }
   ```
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Call the same speech request twice:
   ```bash
   curl -sS -D - -X POST http://127.0.0.1:8787/speech \
     -H 'content-type: application/json' \
     -d '{"text":"cache check","voice":"en-US-JennyNeural"}' \
     -o /tmp/speech1.mp3

   curl -sS -D - -X POST http://127.0.0.1:8787/speech \
     -H 'content-type: application/json' \
     -d '{"text":"cache check","voice":"en-US-JennyNeural"}' \
     -o /tmp/speech2.mp3
   ```
4. Confirm headers:
   - first response includes `X-Eva-TTS-Cache: MISS`
   - second response includes `X-Eva-TTS-Cache: HIT`

### Notes
- This iteration keeps existing `/speech` validation, cooldown, and CORS behavior unchanged.
- Iteration 35 is repurposed for shutdown hardening by request; speech job mode remains unimplemented.

## Iteration 35 — Eva shutdown hardening (Ctrl+C reliability + forced fallback)

**Status:** ✅ Completed (2026-02-18)

> By request, Iteration 35 is used for shutdown reliability hardening instead of speech job-mode endpoints.

### Completed
- Updated Eva signal handling in `packages/eva/src/index.ts`:
  - added `SIGHUP` handling alongside existing `SIGINT`/`SIGTERM`
  - if a second signal arrives during shutdown, Eva now force-terminates immediately
  - added graceful-shutdown deadline (`SHUTDOWN_GRACE_TIMEOUT_MS`) with forced fallback kill/exit
- Hardened Eva server close behavior in `packages/eva/src/index.ts`:
  - `closeServer(...)` now includes timeout handling (`SERVER_CLOSE_TIMEOUT_MS`)
  - if close times out, attempts `server.closeAllConnections()` before fallback
- Extended subprocess manager in `packages/eva/src/subprocess/ManagedProcess.ts`:
  - added `forceKill()` for immediate SIGKILL process-group termination
  - used by forced-shutdown path to prevent orphan daemons
- Updated docs in `packages/eva/README.md`:
  - documented `Ctrl+C` / `SIGTERM` / `SIGHUP` shutdown behavior
  - documented second-signal and timeout force-kill fallback behavior

### Verification
- `cd packages/eva && npm run build` passes.
- Manual signal stress check in subprocess mode:
  - repeated interrupt signals during startup/shutdown
  - verified no listeners remain on `:8787`, `:8790`, `:8000` after forced fallback path.

### Manual test steps
1. Run Eva in subprocess mode:
   - `cd packages/eva`
   - `npm run dev`
2. During startup/shutdown, send Ctrl+C twice quickly.
3. Confirm Eva exits and ports are freed:
   - `ss -ltnp | grep -E ':8787|:8790|:8000'` (no listeners expected)

### Notes
- Speech job-mode endpoints (`/speech/jobs`, `/speech/audio/...`) are intentionally not implemented.
- Existing `POST /speech` + cache/dedupe behavior from Iterations 31–34 remains unchanged.

## Iteration 36 — Eva config plumbing only (speech config; no runtime behavior)

**Status:** ✅ Completed (2026-02-18)

### Completed
- Revalidated Eva speech config plumbing against `docs/implementation-plan-36-43.md` Iteration 36 requirements.
- Confirmed `packages/eva/src/config.ts` already contains the required `speech` schema/defaults:
  - `enabled: false`
  - `path: "/speech"`
  - `defaultVoice: "en-US-JennyNeural"`
  - `maxTextChars: 1000`
  - `maxBodyBytes: 65536`
  - `cooldownMs: 0`
  - `cache.enabled/ttlMs/maxEntries`
- Confirmed committed defaults in `packages/eva/eva.config.json` include the `speech` block with `enabled: false`.
- Confirmed copy-only local example `packages/eva/eva.config.local.example.json` includes speech enabled for local testing.
- No runtime code changes were required for this iteration.

### Verification
- `cd packages/eva && npm run build` passes.
- Manual smoke check with only committed config (`eva.config.local.json` temporarily moved out of the search path):
  - `cd packages/eva && timeout 8s npm run dev`
  - Eva booted in existing behavior (`/eye` WS endpoint, QuickVision reconnect loop, speech disabled by default).

### Manual test steps
1. Build Eva:
   - `cd packages/eva`
   - `npm run build`
2. (Optional runtime parity check with committed config only)
   - temporarily move `eva.config.local.json` aside
   - run `timeout 8s npm run dev`
   - verify startup logs show `speech endpoint enabled=false`
   - restore `eva.config.local.json`.

### Notes
- Iteration 36 deliverables were already present from prior baseline work; this pass confirms alignment with the 36–43 plan before proceeding.

## Iteration 37 — Add Edge TTS dependency + wrapper module (no endpoint yet)

**Status:** ✅ Completed (2026-02-18)

### Completed
- Revalidated Eva speech synthesis wrapper against `docs/implementation-plan-36-43.md` Iteration 37 requirements.
- Confirmed pinned dependency in `packages/eva/package.json`:
  - `node-edge-tts: "1.2.10"`
- Confirmed wrapper modules exist and match expected API:
  - `packages/eva/src/speech/types.ts`
    - exports `SynthesizeInput` with `text`, `voice`, optional `rate`
  - `packages/eva/src/speech/edgeTts.ts`
    - exports `synthesize({ text, voice, rate }): Promise<Buffer>`
    - performs dynamic module loading for `node-edge-tts`
    - handles ESM/CJS export interop (`module.EdgeTTS` and `module.default.EdgeTTS`)
    - validates text/voice and normalizes numeric rate.
- No code changes were required in this iteration; baseline already satisfied the deliverables.

### Verification
- `cd packages/eva && npm install && npm run build` passes.

### Manual test steps
1. Install Eva dependencies:
   - `cd packages/eva`
   - `npm install`
2. Build Eva:
   - `npm run build`

### Notes
- Iteration 37 is validated complete from existing baseline implementation; no runtime/server routing changes were introduced here.

## Iteration 39 — VisionAgent: add `tts_response` to tool schema + prompt guidance

**Status:** ✅ Completed (2026-02-18)

### Completed
- Updated VisionAgent tool schema in `packages/vision-agent/src/tools.ts`:
  - added required `summary.tts_response: string` (`minLength: 1`) to `InsightSummarySchema`
  - updated tool description to require `tts_response` alongside existing fields.
- Updated VisionAgent prompt guidance in `packages/vision-agent/src/prompts.ts`:
  - added strict `tts_response` requirements:
    - 1-2 spoken-friendly sentences
    - natural language only
    - no IDs/tags/token-cost telemetry/JSON text
    - severity-aware tone (calm low, attentive medium, urgent high)
- Updated docs in `packages/vision-agent/README.md`:
  - added `tts_response` to structured summary fields
  - documented `summary.tts_response` contract.

### Verification
- `cd packages/vision-agent && npm run build` passes.

### Manual test steps
1. Start VisionAgent with valid secrets:
   - `cd packages/vision-agent`
   - ensure `vision-agent.secrets.local.json` contains a valid `openaiApiKey`
   - `npm run dev`
2. Call insight endpoint with sample frames:
   - `curl -s http://localhost:8790/insight -H 'content-type: application/json' -d '<payload>'`
3. Confirm response includes:
   - `summary.tts_response` (non-empty string)
   - existing `summary` fields + `usage`.

### Notes
- This iteration only updates VisionAgent schema/prompt/docs.
- QuickVision/UI propagation for `tts_response` follows in later iterations.

## Iteration 40 — QuickVision: propagate `tts_response` through schemas + WS message

**Status:** ✅ Completed (2026-02-18)

### Completed
- Updated QuickVision VisionAgent response validation in `packages/quickvision/app/vision_agent_client.py`:
  - `VisionAgentInsightSummary` now requires `tts_response: string` (`min_length=1`).
- Updated QuickVision protocol model in `packages/quickvision/app/protocol.py`:
  - `InsightSummary` now requires `tts_response: string` (`min_length=1`).
- Ensured relay path preserves `tts_response` unchanged:
  - `packages/quickvision/app/insights.py` already forwards `insight.summary.model_dump(...)` directly into protocol `InsightMessage.summary`.
- Added compatibility update in Eva relay schema to avoid stripping the new field:
  - `packages/eva/src/protocol.ts` `InsightSummarySchema` now includes `tts_response` so Eva relays it unchanged to UI.
- Updated QuickVision docs in `packages/quickvision/README.md` to note that `summary.tts_response` is preserved in emitted insight payloads.

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Start VisionAgent, QuickVision, Eva, and UI.
2. Trigger an insight (`insight_test` or auto-triggered insight).
3. Confirm QuickVision insight payload includes:
   - `summary.tts_response`
4. Confirm Eva relays the same insight payload without dropping `tts_response`.

### Notes
- This iteration is limited to schema propagation/relay preservation; UI display of `tts_response` is Iteration 41.

## Iteration 41 — UI: add `tts_response` to types + display it in Latest Insight panel

**Status:** ✅ Completed (2026-02-18)

### Completed
- Updated UI protocol types in `packages/ui/src/types.ts`:
  - `InsightSummary` now includes required `tts_response: string`.
- Updated UI insight message guard in `packages/ui/src/main.tsx`:
  - `isInsightMessage(...)` now checks for both `summary.one_liner` and `summary.tts_response` string fields.
- Updated Latest Insight rendering in `packages/ui/src/main.tsx`:
  - added visible **Spoken line** row showing `latestInsight.summary.tts_response`
  - retained `one_liner` and existing tags/what_changed/usage sections (both remain visible).

### Verification
- `cd packages/ui && npm run build` passes.

### Manual test steps
1. Start VisionAgent, QuickVision, Eva, and UI.
2. Trigger an insight (`insight_test` or auto-triggered insight).
3. Confirm **Latest insight** panel now shows:
   - one-liner summary
   - spoken line from `summary.tts_response`
   - existing tags/details.

### Notes
- This iteration only adds UI type/display support.
- Auto-speak behavior changes are handled in Iterations 42–43.

## Iteration 42 — UI: speech client + “Enable Audio” (autoplay unlock)

**Status:** ✅ Completed (2026-02-18)

### Completed
- Revalidated and aligned UI speech-client path with Iteration 42 requirements:
  - `packages/ui/src/speech.ts` derives Eva HTTP base from `eva.wsUrl` (`ws/wss` -> `http/https`) and strips path via origin.
  - `speakText(...)` performs `POST /speech` and plays returned audio blob via `<audio>` + object URL.
  - autoplay lock path sets `audioLocked=true` when playback is blocked.
- Kept one-time autoplay unlock control in UI (`packages/ui/src/main.tsx`):
  - **Enable Audio** button uses `speechClient.enableAudio()`.
- Kept manual speech verification controls in UI:
  - **Test Speak** button
  - optional **Voice** override input.
- Ensured Auto Speak toggle defaults ON for this iteration:
  - `packages/ui/src/config.ts`: default `speech.autoSpeak.enabled` -> `true` when not explicitly configured.
  - `packages/ui/public/config.json`: set committed `speech.autoSpeak.enabled` to `true`.
- Updated UI docs/version marker:
  - `packages/ui/README.md` now reflects Iteration 42 and notes Auto Speak default ON.
- Updated UI title marker:
  - `packages/ui/src/main.tsx` heading now shows `Iteration 42`.

### Verification
- `cd packages/ui && npm run build` passes.

### Manual test steps
1. Enable Eva speech endpoint (`speech.enabled: true`) and start Eva.
2. Start UI (`cd packages/ui && npm run dev`).
3. In browser:
   - click **Enable Audio** once
   - click **Test Speak**
4. Confirm audio plays through browser output.

### Notes
- Core auto-speak trigger behavior for new insights is finalized in Iteration 43.

## Iteration 43 — Auto-speak: speak new insights using `tts_response` (core requirement)

**Status:** ✅ Completed (2026-02-18)

### Completed
- Updated UI auto-speak source in `packages/ui/src/main.tsx`:
  - auto-speak text is now **exactly** `insight.summary.tts_response` (normalized whitespace)
  - removed template/fallback narration path so UI no longer generates spoken text from `one_liner`/tags/other fields.
- Kept and validated required auto-speak guards in `packages/ui/src/main.tsx`:
  - new insight dedupe via stable id (`clip_id`)
  - Auto Speak toggle enabled
  - severity gate (`>= speech.autoSpeak.minSeverity`, default `medium`)
  - UI cooldown gate (`speech.autoSpeak.cooldownMs`)
  - non-empty `tts_response`
- Preserved cancellation and cleanup behavior for in-flight speech in `packages/ui/src/main.tsx` + `packages/ui/src/speech.ts`:
  - abort prior fetch via `AbortController`
  - stop current audio playback before new speech
  - revoke prior blob URL on stop/new playback.
- Simplified UI speech config shape in `packages/ui/src/config.ts`:
  - removed `speech.autoSpeak.textTemplate` from parsed/runtime config type (no longer used).
- Updated committed UI runtime defaults in `packages/ui/public/config.json`:
  - removed `speech.autoSpeak.textTemplate` field.
- Updated UI docs/title markers:
  - `packages/ui/README.md` now states spoken text source is exactly `insight.summary.tts_response`
  - updated runtime config example accordingly
  - `packages/ui/src/main.tsx` header now shows `Iteration 43`.

### Verification
- `cd packages/ui && npm run build` passes.

### Manual test steps
1. Start Eva with speech enabled (`speech.enabled: true`).
2. Start UI and click **Enable Audio** once.
3. Trigger a new MED/HIGH insight (`insight_test` or auto-triggered).
4. Confirm UI auto-speaks the text from `summary.tts_response`.
5. Trigger multiple insights rapidly and confirm:
   - newer speech cancels older in-flight speech/fetch
   - cooldown and severity gates are enforced.

### Notes
- With this iteration, the 39–43 chain is complete: VisionAgent generates `tts_response`, QuickVision/Eva relay it, UI displays it, and UI auto-speaks it.

## Iteration 44 — Add EVA memory folder + tags/persona (no runtime behavior)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added Eva memory scaffold directory and committed base memory assets:
  - `packages/eva/memory/persona.md`
  - `packages/eva/memory/experience_tags.json`
- Updated root `.gitignore` with EVA memory runtime artifact ignore rules:
  - `packages/eva/memory/working_memory.log`
  - `packages/eva/memory/short_term_memory.db`
  - `packages/eva/memory/cache/**`
  - `packages/eva/memory/vector_db/**`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.

### Manual test steps
1. Confirm committed scaffold files exist:
   - `packages/eva/memory/persona.md`
   - `packages/eva/memory/experience_tags.json`
2. Confirm memory runtime files are ignored by git:
   - `git check-ignore -v packages/eva/memory/working_memory.log`
   - `git check-ignore -v packages/eva/memory/short_term_memory.db`
   - `git check-ignore -v packages/eva/memory/cache/example.json`
   - `git check-ignore -v packages/eva/memory/vector_db/example.txt`

### Notes
- No Eva runtime behavior changed in this iteration.
- QuickVision remains unchanged in this iteration (rename to `packages/vision` is planned later).

## Iteration 45 — Add `packages/agent` skeleton + `/health` (no OpenAI yet)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added new `packages/agent` service skeleton:
  - `.nvmrc`
  - `package.json`
  - `tsconfig.json`
  - `README.md`
  - `agent.config.json`
  - `src/config.ts`
  - `src/server.ts`
  - `src/index.ts`
- Added local-only (gitignored) runtime files:
  - `packages/agent/agent.config.local.json`
  - `packages/agent/agent.secrets.local.json`
- Implemented config loading with `cosmiconfig + zod` in `packages/agent/src/config.ts`:
  - local-first search order:
    1. `agent.config.local.json`
    2. `agent.config.json`
  - required path handling:
    - resolves `memory.dir` relative to the loaded config file path.
- Implemented HTTP server in `packages/agent/src/server.ts` with:
  - `GET /health` -> `200` JSON including `service`, `status`, `uptime_ms`.

### Files changed
- `packages/agent/.nvmrc`
- `packages/agent/package.json`
- `packages/agent/tsconfig.json`
- `packages/agent/README.md`
- `packages/agent/agent.config.json`
- `packages/agent/src/config.ts`
- `packages/agent/src/server.ts`
- `packages/agent/src/index.ts`
- `progress.md`

### Verification
- `cd packages/agent && npm i && npm run build` passes.
- `curl http://127.0.0.1:8791/health` returns `200` with required fields.

### Manual run instructions
1. Start agent:
   - `cd packages/agent`
   - `npm run dev`
2. Health check:
   - `curl -s -i http://127.0.0.1:8791/health`

### Notes
- No OpenAI calls are implemented in this iteration.
- No changes were made to Eva/QuickVision runtime behavior in this iteration.

## Iteration 46 — Agent: add `POST /insight` stub (deterministic)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added deterministic insight stub endpoint in `packages/agent/src/server.ts`:
  - `POST /insight`
  - validates `Content-Type: application/json`
  - enforces max request body size from config (`insight.maxBodyBytes`)
  - validates minimal payload shape with non-empty `frames` array
  - returns stable contract response shape:
    - `summary.one_liner`
    - `summary.tts_response`
    - `summary.tags`
    - `summary.what_changed`
    - `summary.severity`
    - `usage` (`input_tokens`, `output_tokens`, `cost_usd`)
- Added body parsing/error handling helpers for deterministic HTTP errors:
  - `EMPTY_BODY`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `INVALID_REQUEST`, etc.
- Extended Agent config schema/defaults with insight guardrail settings:
  - `insight.maxBodyBytes` (default `8388608`)
- Updated committed defaults:
  - `packages/agent/agent.config.json`
- Updated docs:
  - `packages/agent/README.md` now documents Iteration 46 behavior and includes `/insight` curl example.

### Files changed
- `packages/agent/src/server.ts`
- `packages/agent/src/config.ts`
- `packages/agent/agent.config.json`
- `packages/agent/README.md`
- `progress.md`

### Verification
- `cd packages/agent && npm run build` passes.
- `curl -sS -X POST http://127.0.0.1:8791/insight -H 'content-type: application/json' -d '<payload>'` returns `200` and expected response shape.

### Manual run instructions
1. Start agent:
   - `cd packages/agent`
   - `npm run dev`
2. Call insight endpoint:
   - `curl -sS -X POST http://127.0.0.1:8791/insight -H 'content-type: application/json' -d '{"clip_id":"clip-1","trigger_frame_id":"frame-2","frames":[{"frame_id":"frame-1","ts_ms":1700000000000,"mime":"image/jpeg","image_b64":"ZmFrZQ=="}]}'`

### Notes
- This iteration intentionally uses a deterministic stub response and does not call OpenAI yet.
- Request/response shape is compatible with current QuickVision insight client expectations.

## Iteration 47 — QuickVision: add `insights.agent_url` + deprecate `vision_agent_url` (no rename yet)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Updated QuickVision defaults in `packages/quickvision/settings.yaml`:
  - added `insights.agent_url: http://127.0.0.1:8791/insight`
  - kept `insights.vision_agent_url` as a deprecated alias (with migration comments)
  - updated deprecated alias default value to point at Agent (`:8791`) for migration compatibility.
- Updated insight settings loader in `packages/quickvision/app/insights.py`:
  - reads `insights.agent_url` first
  - if missing, falls back to `insights.vision_agent_url`
  - logs deprecation warning on fallback:
    - `[quickvision] insights.vision_agent_url is deprecated; use insights.agent_url`
  - URL validation errors now reference the active key (`insights.agent_url` when present).
- Updated `InsightSettings` URL field from `vision_agent_url` to `agent_url` and wired client construction to use it.
- Updated startup observability in `packages/quickvision/app/main.py`:
  - insights config log now prints `agent_url=...`.
- Updated insight client wording in `packages/quickvision/app/vision_agent_client.py`:
  - timeout/unreachable/invalid-response messages now say `Insight service` (filename/class kept as-is per migration scope).
- Updated docs in `packages/quickvision/README.md`:
  - documented `insights.agent_url` as primary key
  - documented `insights.vision_agent_url` as deprecated fallback alias.

### Files changed
- `packages/quickvision/settings.yaml`
- `packages/quickvision/app/insights.py`
- `packages/quickvision/app/main.py`
- `packages/quickvision/app/vision_agent_client.py`
- `packages/quickvision/README.md`
- `progress.md`

### Verification
- `cd packages/quickvision && python3 -m compileall app` passes.
- Targeted loader checks in QuickVision `.venv`:
  - default config resolves `insights.agent_url` to `http://127.0.0.1:8791/insight`
  - legacy-only config path logs deprecation warning and resolves deprecated alias
  - invalid `insights.agent_url` emits validation error mentioning `insights.agent_url`.

### Manual test steps
1. Start Agent stub:
   - `cd packages/agent && npm run dev`
2. Start QuickVision + Eva + UI as usual.
3. In UI:
   - start camera + streaming
   - click **Trigger insight test**
4. Confirm UI receives an `insight` payload that includes `summary.tts_response`.

### Notes
- This iteration intentionally keeps `app/vision_agent_client.py` filename to minimize refactor scope.
- QuickVision package/service rename is intentionally deferred to Iteration 51.

## Iteration 48 — Eva subprocess: spawn `agent` first (keep VisionAgent for now)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Extended Eva subprocess config schema in `packages/eva/src/config.ts` with `subprocesses.agent` block (same shape as existing subprocess entries):
  - `enabled`
  - `cwd`
  - `command`
  - `healthUrl`
  - `readyTimeoutMs`
  - `shutdownTimeoutMs`
- Added defaults for `subprocesses.agent` in Eva config parsing:
  - default `cwd: packages/agent`
  - default `command: ["npm", "run", "dev"]`
  - default health URL `http://127.0.0.1:8791/health`
- Updated Eva bootstrap order in `packages/eva/src/index.ts`:
  1. agent
  2. vision-agent
  3. quickvision
  4. eva server start
- Updated Eva coordinated shutdown and forced-kill paths to include the new agent subprocess.
- Updated `packages/eva/eva.config.local.example.json` to include a `subprocesses.agent` block.

### Files changed
- `packages/eva/src/config.ts`
- `packages/eva/src/index.ts`
- `packages/eva/eva.config.local.example.json`
- `progress.md`

### Verification
- `cd packages/eva && npm run build` passes.
- Manual subprocess-mode startup log shows Agent startup + health wait success before VisionAgent:
  - `[eva] starting agent subprocess ...`
  - `[eva] waiting for agent health at http://127.0.0.1:8791/health...`
  - `[eva] agent healthy at http://127.0.0.1:8791/health`

### Manual test steps
1. Enable subprocess mode (for example by using `eva.config.local.json` with `subprocesses.enabled: true`).
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Confirm startup logs show agent health wait/success before VisionAgent startup.

### Notes
- This iteration intentionally keeps VisionAgent in the subprocess flow; removal is planned for Iteration 50.

## Iteration 49 — Agent: implement real `POST /insight` via OpenAI tool-call (port VisionAgent logic)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Replaced Agent deterministic `/insight` stub with real model-backed insight generation in `packages/agent/src/server.ts`:
  - request parsing with max-body enforcement (`insight.maxBodyBytes`)
  - max frame enforcement (`insight.maxFrames`, hard-capped at `6`)
  - insight cooldown enforcement (`insight.cooldownMs`)
  - pi-ai model call via `complete(...)` with API key from Agent secrets
  - required single tool call enforcement (`submit_insight`)
  - strict tool-argument validation using `validateToolCall(...)`
  - usage extraction (`input_tokens`, `output_tokens`, `cost_usd`)
- Added prompt/tool modules for the insight tool-loop:
  - `packages/agent/src/prompts/insight.ts`
  - `packages/agent/src/tools/insight.ts`
- Added Agent model + guardrail config fields in `packages/agent/src/config.ts` / `packages/agent/agent.config.json`:
  - `model.provider`
  - `model.id`
  - `insight.cooldownMs`
  - `insight.maxFrames`
  - `insight.maxBodyBytes`
- Added Agent secrets loading in `packages/agent/src/config.ts`:
  - `loadAgentSecrets(...)` reads local secrets JSON and validates `openaiApiKey`.
- Updated Agent bootstrap in `packages/agent/src/index.ts`:
  - validates configured model id/provider at startup via `getModel(...)`
  - starts server with loaded config + secrets.
- Added tag-whitelist enforcement for insight output tags in `packages/agent/src/server.ts`:
  - loads `packages/eva/memory/experience_tags.json` from `memory.dir`
  - drops unknown model-returned tags and logs warning
  - ensures non-empty allowed tags with fallback to an allowed tag.
- Updated Agent dependencies in `packages/agent/package.json`:
  - added `@mariozechner/pi-ai`
  - added `@sinclair/typebox`
- Updated Agent docs in `packages/agent/README.md` for real `/insight` behavior.

### Files changed
- `packages/agent/package.json`
- `packages/agent/package-lock.json`
- `packages/agent/src/config.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/server.ts`
- `packages/agent/src/prompts/insight.ts`
- `packages/agent/src/tools/insight.ts`
- `packages/agent/agent.config.json`
- `packages/agent/README.md`
- `progress.md`

### Verification
- `cd packages/agent && npm run build` passes.
- Manual endpoint checks with Agent running:
  - `POST /insight` returns real structured summary with `tts_response` and non-zero usage values.
  - cooldown guardrail returns `429 COOLDOWN_ACTIVE` on rapid repeat requests.
  - max-frames guardrail returns `400 TOO_MANY_FRAMES` for clips with >6 frames.

### Manual run instructions
1. Ensure `packages/agent/agent.secrets.local.json` contains a valid `openaiApiKey`.
2. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
3. Send an insight request:
   - `curl -sS -X POST http://127.0.0.1:8791/insight -H 'content-type: application/json' -d '<valid clip payload>'`
4. Confirm response includes:
   - `summary.one_liner`
   - `summary.tts_response`
   - `summary.tags` (whitelist-filtered)
   - `summary.what_changed`
   - `summary.severity`
   - `usage`

### Notes
- OpenAI insight calls now live in `packages/agent` (VisionAgent port-in path completed for insight endpoint).
- End-to-end UI auto-speak behavior remains driven by existing QuickVision/Eva/UI wiring and was not refactored in this iteration.

## Iteration 50 — Remove `packages/vision-agent` completely (now safe)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Removed `packages/vision-agent/` directory from the repository.
- Removed VisionAgent-specific ignore rules from root `.gitignore`:
  - `packages/vision-agent/vision-agent.config.local.json`
  - `packages/vision-agent/*.secrets.local.json`
- Removed VisionAgent subprocess config from Eva runtime config schema/defaults in `packages/eva/src/config.ts`.
- Removed VisionAgent startup/shutdown orchestration from Eva bootstrap in `packages/eva/src/index.ts`.
- Updated Eva local subprocess example config to remove VisionAgent block:
  - `packages/eva/eva.config.local.example.json`
- Updated docs/README references to reflect Agent + QuickVision stack:
  - `README.md`
  - `packages/eva/README.md`
- Confirmed QuickVision defaults point to Agent (no default calls to port `8790`):
  - `packages/quickvision/settings.yaml` uses `insights.agent_url` + deprecated alias both at `http://127.0.0.1:8791/insight`.

### Files changed
- `.gitignore`
- `README.md`
- `packages/eva/src/config.ts`
- `packages/eva/src/index.ts`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/README.md`
- `packages/vision-agent/**` (removed)
- `progress.md`

### Verification
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/quickvision && python3 -m compileall app` passes.
- Manual stack check (Agent + QuickVision + Eva + UI) with insight flow:
  - started Eva in subprocess mode (spawns Agent + QuickVision)
  - started UI dev server
  - sent frame + `insight_test` through Eva `/eye` WebSocket
  - received end-to-end `insight` payload with `summary.tts_response`.

### Manual run instructions
1. Start stack:
   - `cd packages/eva`
   - `npm run dev`
2. Start UI:
   - `cd packages/ui`
   - `npm run dev`
3. In UI, trigger insight test while streaming and confirm insight payload/tts response arrives.

### Notes
- VisionAgent has been fully removed from runtime wiring and repository package layout.
- QuickVision package rename to `packages/vision` remains scheduled for Iteration 51.

## Iteration 51 — Rename `packages/quickvision` → `packages/vision` (mechanical rename only)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Renamed Python service package directory:
  - `packages/quickvision` -> `packages/vision`
- Updated path-based references to the renamed package in config/docs:
  - root `.gitignore` Python ignore rules now target `packages/vision/...`
  - root `README.md` updated to use `packages/vision` paths and run steps
  - `packages/eva/README.md` updated to use `packages/vision` paths and run steps
  - `packages/eva/eva.config.local.example.json` subprocess cwd updated to `packages/vision`
- Updated Eva config schema/defaults (`packages/eva/src/config.ts`):
  - new canonical top-level key: `vision.wsUrl`
  - kept `quickvision.wsUrl` as one-iteration deprecated alias
  - when `vision.wsUrl` is missing but `quickvision.wsUrl` is present, Eva now:
    - uses the alias value
    - logs deprecation warning:
      - `[eva] quickvision.wsUrl is deprecated; use vision.wsUrl`
- Updated Eva runtime wiring (`packages/eva/src/index.ts`) to use `config.vision.wsUrl`.
- Updated committed Eva defaults (`packages/eva/eva.config.json`) to use `vision.wsUrl`.

### Files changed
- `.gitignore`
- `README.md`
- `packages/eva/src/config.ts`
- `packages/eva/src/index.ts`
- `packages/eva/eva.config.json`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/README.md`
- `packages/vision/**` (renamed from `packages/quickvision/**`)
- `progress.md`

### Verification
- `cd packages/vision && python3 -m compileall app` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- Alias behavior check passes:
  - config with only `quickvision.wsUrl` resolves successfully
  - deprecation warning is logged.
- Manual end-to-end stack check passes (Agent + Vision + Eva + UI path):
  - Eva subprocess mode starts Agent + Vision from renamed paths
  - insight test over `/eye` still returns `insight` with `summary.tts_response`.

### Manual run instructions
1. Start Eva stack:
   - `cd packages/eva`
   - `npm run dev`
2. Start UI:
   - `cd packages/ui`
   - `npm run dev`
3. Trigger insight test from UI while streaming and confirm detections/insights continue to flow.

### Notes
- This iteration is intentionally mechanical (package/path/config-key rename + alias compatibility) with no protocol behavior changes.

## Iteration 52 — Agent: add `POST /respond` stub (no OpenAI yet)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added deterministic chat response endpoint in `packages/agent/src/server.ts`:
  - `POST /respond`
  - accepts JSON payload: `{ "text": "...", "session_id": "optional" }`
  - validates payload with zod schema (`text` required, optional non-empty `session_id`)
  - returns deterministic response shape:
    - `request_id` (UUID)
    - `text`
    - optional `session_id`
    - `meta` (`tone`, `concepts`, `surprise`, `note`)
- Added startup log line for the new endpoint:
  - `[agent] respond endpoint POST /respond (deterministic stub)`
- Updated Agent docs in `packages/agent/README.md`:
  - documented `/respond` deterministic behavior
  - added `/respond` curl example.

### Files changed
- `packages/agent/src/server.ts`
- `packages/agent/README.md`
- `progress.md`

### Verification
- `cd packages/agent && npm run build` passes.
- `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello"}'` returns deterministic `{ text, meta, request_id }`.
- Optional session passthrough check:
  - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello","session_id":"s-1"}'` returns `session_id` in response.

### Manual run instructions
1. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
2. Call respond endpoint:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello"}'`

### Notes
- `/respond` is intentionally deterministic in this iteration; real chat model integration remains scheduled for Iteration 55.

## Iteration 53 — Eva: implement `POST /text` + CORS + emit `text_output` over `/eye`

**Status:** ✅ Completed (2026-02-20)

### Completed
- Extended Eva config schema/defaults in `packages/eva/src/config.ts` with:
  - `agent.baseUrl`
  - `agent.timeoutMs`
  - `text.enabled`
  - `text.path`
  - `text.maxBodyBytes`
  - `text.maxTextChars`
- Added committed config defaults:
  - `packages/eva/eva.config.json`
  - `packages/eva/eva.config.local.example.json`
- Updated Eva server (`packages/eva/src/server.ts`) with text input path:
  - `OPTIONS <text.path>` returns `204` and CORS headers
  - `POST <text.path>`:
    - enforces max request-body bytes while streaming (`413 PAYLOAD_TOO_LARGE`)
    - validates JSON + fields (`400 INVALID_JSON` / `400 INVALID_REQUEST`)
    - calls Agent `POST /respond` using `agent.baseUrl` with timeout (`agent.timeoutMs`)
    - returns `504 AGENT_TIMEOUT` on timeout
    - returns `502 AGENT_ERROR` on agent/network/bad-response failures
    - builds protocol-style message:
      - `type: "text_output"`
      - `v: 1`
      - `request_id`
      - optional `session_id`
      - `ts_ms`
      - `text`
      - `meta`
    - emits the same `text_output` payload to connected UI over `/eye` WS (if connected)
    - returns the same `text_output` JSON payload in HTTP response
- Wired new config to Eva bootstrap in `packages/eva/src/index.ts` (`startServer` now receives `agent` + `text`).
- Updated Eva docs in `packages/eva/README.md` for Iteration 53 text-path behavior.

### Files changed
- `packages/eva/src/config.ts`
- `packages/eva/eva.config.json`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/src/server.ts`
- `packages/eva/src/index.ts`
- `packages/eva/README.md`
- `progress.md`

### Verification
- `cd packages/eva && npm run build` passes.

### Manual test steps
1. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Call Eva text endpoint:
   - `curl -sS -X POST http://127.0.0.1:8787/text -H 'content-type: application/json' -d '{"text":"hello from ui","source":"ui"}'`
4. Confirm HTTP response shape is `text_output` and includes `request_id`, `ts_ms`, `text`, `meta`.
5. With UI connected to `/eye`, confirm the same `text_output` payload appears on WS.

### Notes
- This iteration intentionally keeps Agent `/respond` deterministic (real model-backed respond remains Iteration 55).
- UI chat controls/rendering are intentionally deferred to Iteration 54.

## Iteration 54 — UI: minimal chat panel + render `text_output`

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added `text_output` protocol type support in UI types:
  - `packages/ui/src/types.ts`
  - includes `TextOutputMessage` + `TextOutputMeta`
- Updated UI runtime behavior in `packages/ui/src/main.tsx`:
  - derives Eva HTTP base from `eva.wsUrl` (existing behavior)
  - derives text endpoint URL as `${evaHttpBase}/text`
  - adds minimal chat panel with:
    - input + submit button
    - local user message list
    - assistant message list from `text_output`
  - sends chat text to Eva via HTTP `POST /text` with body:
    - `{ "text": "...", "source": "ui" }`
  - listens for `text_output` on existing `/eye` WebSocket and renders replies in chat panel
  - adds dedupe by `request_id` so repeated `text_output` payloads are not double-rendered
  - uses HTTP response as fallback render path only when WS is not connected.
- Updated UI docs:
  - `packages/ui/README.md` now documents chat panel + `/text` usage
  - updated current behavior marker to Iteration 54
- Updated root status line in `README.md` to reflect Iteration 54.

### Files changed
- `packages/ui/src/types.ts`
- `packages/ui/src/main.tsx`
- `packages/ui/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/ui && npm run build` passes.

### Manual test steps
1. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Start UI:
   - `cd packages/ui`
   - `npm run dev`
4. Open UI, enter text in the chat panel, and click **Send text**.
5. Confirm:
   - user message appears in chat panel
   - assistant reply appears from `text_output`
   - camera/streaming controls remain functional.

### Notes
- Chat still depends on deterministic Agent `/respond` behavior in this iteration.
- Real model-backed chat response generation remains scheduled for Iteration 55.

## Iteration 55 — Agent: real chat (`/respond`) via OpenAI tool-call + working memory writes

**Status:** ✅ Completed (2026-02-20)

### Completed
- Replaced deterministic Agent `/respond` stub with real model-backed tool-call path in `packages/agent/src/server.ts`:
  - required single tool call: `commit_text_response`
  - prompt/tool wiring added:
    - `packages/agent/src/prompts/respond.ts`
    - `packages/agent/src/tools/respond.ts`
  - validates tool output via `validateToolCall(...)`
- Added concept whitelist enforcement for `/respond` metadata:
  - concepts are normalized + deduped
  - unknown concepts are dropped with warning logs
  - fallback concept used when all model concepts are filtered
- Implemented working-memory artifact writes for successful `/respond` calls:
  - append `text_input` JSONL entry to `packages/eva/memory/working_memory.log`
  - append `text_output` JSONL entry to `packages/eva/memory/working_memory.log`
  - update mutable tone cache file:
    - `packages/eva/memory/cache/personality_tone.json`
- Added write serialization (mutex/queue) for memory artifacts:
  - introduced serial task queue around working log append + cache update
  - prevents concurrent append corruption under rapid `/respond` traffic
- Added atomic JSON cache write behavior for tone cache (`tmp` file + rename).
- Added persona prompt loading for respond path from:
  - `packages/eva/memory/persona.md`
- Updated Agent startup logs and health payload to include working-memory and tone-cache paths.
- Updated docs:
  - `packages/agent/README.md`
  - root `README.md` status line

### Files changed
- `packages/agent/src/server.ts`
- `packages/agent/src/prompts/respond.ts` (new)
- `packages/agent/src/tools/respond.ts` (new)
- `packages/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision && python3 -m compileall app` passes.
- Manual `/respond` smoke check returns real structured payload (`text`, `meta`, `request_id`).
- Manual memory artifact checks:
  - `working_memory.log` grows with valid JSONL `text_input` + `text_output` pairs
  - `cache/personality_tone.json` updates after `/respond`
- Rapid request burst check (parallel `/respond` requests) confirms no JSONL corruption and complete input/output pairs per session.

### Manual run instructions
1. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
2. Call respond endpoint:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello","session_id":"demo-1"}'`
3. Confirm memory artifacts:
   - `tail -n 4 packages/eva/memory/working_memory.log`
   - `cat packages/eva/memory/cache/personality_tone.json`

### Notes
- Iteration 55 intentionally focuses on chat generation + working-memory writes only.
- Hourly/daily memory workers and retrieval injection remain scheduled for Iterations 56–58.

## Iteration 56 — Agent: Worker A (hourly) — working→SQLite + trim working log

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added short-term memory SQLite initialization in `packages/agent/src/server.ts`:
  - creates `packages/eva/memory/short_term_memory.db`
  - initializes schema/table `short_term_summaries` + created-at index
- Added hourly worker endpoint:
  - `POST /jobs/hourly`
  - accepts optional JSON body `{ "now_ms": <epoch-ms> }` for deterministic testing
- Implemented hourly job pipeline under the same write queue/mutex used by `/respond` memory writes:
  - reads `packages/eva/memory/working_memory.log`
  - selects entries older than 60 minutes
  - builds 3–5 bullet summaries prioritizing:
    - vision insight entries
    - high-surprise chat responses
    - chat highlights
  - inserts bullets into SQLite `short_term_summaries`
  - atomically rewrites `working_memory.log` to retain only the last 60 minutes
- Added robust working-log handling:
  - skips malformed JSONL lines with warning logs
  - skips entries missing required `type` / `ts_ms`
- Extended health/startup observability:
  - `/health` now includes `shortTermMemoryDbPath`
  - startup logs now include `/jobs/hourly` route and DB path
- Updated docs:
  - `packages/agent/README.md` (Iteration 56 behavior + `/jobs/hourly` usage)
  - root `README.md` status line

### Files changed
- `packages/agent/src/server.ts`
- `packages/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/vision && python3 -m compileall app` passes.
- Manual endpoint checks:
  - `POST /jobs/hourly` (no body) returns summary JSON and succeeds.
  - `POST /jobs/hourly` with future `now_ms` returns non-zero `summary_count` when old entries exist.
- Manual data checks:
  - SQLite `short_term_summaries` contains inserted bullet rows.
  - `working_memory.log` is atomically trimmed to entries within last-hour window (or empty when all entries are older).

### Manual run instructions
1. Start Agent:
   - `cd packages/agent`
   - `npm run dev`
2. Trigger hourly worker:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/hourly`
3. (Optional deterministic test) use explicit run time:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/hourly -H 'content-type: application/json' -d '{"now_ms":1700000000000}'`
4. Inspect outputs:
   - `node -e "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('packages/eva/memory/short_term_memory.db'); console.log(db.prepare('SELECT id, summary_text FROM short_term_summaries ORDER BY id DESC LIMIT 5').all()); db.close();"`
   - `tail -n 20 packages/eva/memory/working_memory.log`

### Notes
- This iteration focuses on Worker A (hourly) only.
- Daily vectorization/cache refresh and retrieval-in-chat remain for Iterations 57–58.

## Iteration 56 (follow-up patch) — Move Agent/Vision under Eva package (keep subprocess model)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Relocated service folders while keeping them independent daemons:
  - `packages/agent` -> `packages/eva/agent`
  - `packages/vision` -> `packages/eva/vision`
- Kept subprocess architecture unchanged:
  - Eva still starts Agent and Vision as separate subprocesses when `subprocesses.enabled=true`.
- Updated Eva subprocess default paths/config:
  - `packages/eva/src/config.ts`
  - `packages/eva/eva.config.local.example.json`
  - `packages/eva/eva.config.local.json`
- Updated local venv command path in Eva local config:
  - `/mnt/d/source/vscode/eva/packages/eva/vision/.venv/bin/python`
- Updated Agent config defaults after relocation:
  - `packages/eva/agent/agent.config.json` memory dir -> `../memory`
  - `packages/eva/agent/agent.config.local.json` memory dir -> `../memory`
- Updated docs and plan to reflect new layout and retained subprocess intent:
  - `.gitignore`
  - `README.md`
  - `packages/eva/README.md`
  - `packages/eva/agent/README.md`
  - `docs/implementation-plan-44-58.md`

### Files changed
- `.gitignore`
- `README.md`
- `docs/implementation-plan-44-58.md`
- `packages/eva/src/config.ts`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/eva.config.local.json`
- `packages/eva/README.md`
- `packages/eva/agent/agent.config.json`
- `packages/eva/agent/agent.config.local.json`
- `packages/eva/agent/README.md`
- `progress.md`
- moved directories:
  - `packages/eva/agent/**`
  - `packages/eva/vision/**`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva/vision && python3 -m compileall app` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- Subprocess boot smoke check (`timeout 45s npm run dev` in `packages/eva`) shows:
  - Agent subprocess started from `packages/eva/agent` and passed health wait.
  - Vision subprocess started from `packages/eva/vision` (venv python path) and entered health-wait stage.

### Notes
- This patch is a layout/paths change only; service boundaries and process model remain unchanged.
- Agent and Vision continue to run as independent subprocess services managed by Eva.

## Iteration 57 — Agent: Worker B (daily) — SQLite→vector DB + cache refresh

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added daily memory worker endpoint in `packages/eva/agent/src/server.ts`:
  - `POST /jobs/daily`
  - accepts optional JSON body `{ "now_ms": <epoch-ms> }` for deterministic testing
- Added daily-job request validation and response wiring:
  - new `DailyJobRequestSchema`
  - error handling mirrors existing hourly endpoint patterns
- Implemented daily pipeline under the same serialized write queue used by `/respond` and `/jobs/hourly`:
  - computes yesterday window from local midnight boundaries
  - reads yesterday rows from SQLite `short_term_summaries`
  - upserts long-term entries into JSON-persisted vector stores:
    - `packages/eva/memory/vector_db/long_term_experiences/index.json`
    - `packages/eva/memory/vector_db/long_term_personality/index.json`
  - updates stable cache files:
    - `packages/eva/memory/cache/core_experiences.json`
    - `packages/eva/memory/cache/core_personality.json`
- Added lightweight deterministic embedding + upsert machinery for persisted vector records:
  - fixed-dimension normalized hashed embeddings (`64` dims)
  - per-entry IDs derived from short-term summary IDs
  - safe read/validate/create behavior for vector store files
- Added conservative personality-delta promotion rules for long-term personality store.
- Extended `/health` payload + startup logs with daily-memory artifact paths.
- Updated docs:
  - `packages/eva/agent/README.md` (Iteration 57 behavior + `/jobs/daily` usage)
  - root `README.md` status line

### Files changed
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/eva/vision && python3 -m compileall app` passes.
- Manual `/jobs/daily` check (deterministic window) passes:
  - `POST /jobs/daily` with `{"now_ms":1771664299436}` returned:
    - `source_row_count: 4`
    - `experience_upsert_count: 4`
    - `personality_upsert_count: 1`
- Verified output artifacts exist and are populated:
  - `packages/eva/memory/vector_db/long_term_experiences/index.json` (`entries: 4`)
  - `packages/eva/memory/vector_db/long_term_personality/index.json` (`entries: 1`)
  - `packages/eva/memory/cache/core_experiences.json`
  - `packages/eva/memory/cache/core_personality.json`

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Trigger daily worker:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/daily`
3. (Optional deterministic test) use explicit run time:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/daily -H 'content-type: application/json' -d '{"now_ms":1771664299436}'`
4. Inspect outputs:
   - `cat packages/eva/memory/vector_db/long_term_experiences/index.json`
   - `cat packages/eva/memory/vector_db/long_term_personality/index.json`
   - `cat packages/eva/memory/cache/core_experiences.json`
   - `cat packages/eva/memory/cache/core_personality.json`

### Notes
- This iteration adds persistent long-term memory artifacts and cache refresh only.
- Retrieval-in-chat prompt injection remains scheduled for Iteration 58.

## Iteration 58 — Agent: retrieval in chat (short + long memory injection)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Extended Agent respond pipeline in `packages/eva/agent/src/server.ts` to build per-turn memory retrieval context before model calls.
- Added short-term retrieval path from SQLite:
  - reads recent rows from `short_term_summaries`
  - derives tags and applies query-driven tag filtering
  - falls back to latest summaries when no tag overlap is found
- Added long-term retrieval path from persisted vector stores:
  - loads `long_term_experiences` + `long_term_personality` stores
  - computes deterministic query embedding
  - ranks by similarity and selects top-K hits
- Added core-cache injection path:
  - reads `cache/core_experiences.json`
  - reads `cache/core_personality.json`
  - injects concise highlights/signals into retrieval context
- Added hard memory-injection cap (token-aware approximation):
  - bounded prompt memory block to ~900 tokens (char/4 approximation)
  - line-by-line budgeted inclusion to prevent uncontrolled prompt growth
- Wired retrieved memory context into respond system prompt:
  - updated `packages/eva/agent/src/prompts/respond.ts`
  - prompt now includes bounded retrieval context and guidance for relevance/uncertainty handling.
- Updated docs:
  - `packages/eva/agent/README.md` (Iteration 58 behavior)
  - root `README.md` status line

### Files changed
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/src/prompts/respond.ts`
- `packages/eva/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `cd packages/ui && npm run build` passes.
- `cd packages/eva/vision && python3 -m compileall app` passes.
- Manual `/respond` memory retrieval check passes:
  - request: `{"text":"From memory, what happened in the final check?"}`
  - response referenced prior summarized memory content: “all systems were clear and operational”.

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Call respond endpoint with memory-oriented prompt:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"From memory, what happened in the final check?"}'`
3. Confirm response references prior summarized short-term/long-term context where relevant.

### Notes
- Retrieval injection is intentionally bounded and relevance-filtered to avoid prompt bloat.
- This completes the 44–58 implementation-plan sequence.

## Iteration 59 — Add memory reset scripts + npm hooks (safe path guardrails)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added reset script utilities in `packages/eva/agent/scripts/reset-common.mjs`:
  - loads Agent config using the same local-first search order as runtime (`agent.config.local.json`, then `agent.config.json`)
  - resolves `memory.dir` relative to the loaded config file path (same rule as Agent config loader)
  - enforces hard safety guardrails before any deletion:
    - resolved memory dir must end with `packages/eva/memory`
    - `persona.md` and `experience_tags.json` must both exist in that directory
- Added `packages/eva/agent/scripts/reset-working.mjs`:
  - deletes `working_memory.log`
  - deletes `cache/personality_tone.json`
  - ensures `cache/` exists after run
- Added `packages/eva/agent/scripts/reset-session.mjs`:
  - deletes `working_memory.log`
  - deletes `short_term_memory.db`
  - deletes `cache/**` by removing `cache/` directory
  - ensures `cache/` exists after run
- Added `packages/eva/agent/scripts/reset-all.mjs`:
  - deletes working/session runtime files above
  - deletes `vector_db/**` by removing `vector_db/` directory
  - ensures both `cache/` and `vector_db/` exist after run
- Added npm scripts in `packages/eva/agent/package.json`:
  - `mem:reset:working`
  - `mem:reset:session`
  - `mem:reset:all`

### Files changed
- `packages/eva/agent/package.json`
- `packages/eva/agent/scripts/reset-common.mjs`
- `packages/eva/agent/scripts/reset-working.mjs`
- `packages/eva/agent/scripts/reset-session.mjs`
- `packages/eva/agent/scripts/reset-all.mjs`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- Scope checks with dummy runtime files pass for all three scripts:
  - `reset-working` removes only `working_memory.log` + `cache/personality_tone.json` and keeps other runtime files.
  - `reset-session` removes `working_memory.log`, `short_term_memory.db`, and `cache/**` while preserving `vector_db/**`.
  - `reset-all` removes working/session runtime files plus `vector_db/**`, then recreates required directories.
- Guardrail sanity checks during script runs:
  - committed files `packages/eva/memory/persona.md` and `packages/eva/memory/experience_tags.json` remain present.

### Manual run instructions
1. Working reset:
   - `cd packages/eva/agent && npm run mem:reset:working`
2. Session reset:
   - `cd packages/eva/agent && npm run mem:reset:session`
3. Full reset:
   - `cd packages/eva/agent && npm run mem:reset:all`

### Notes
- Operational expectation remains: stop Eva/Agent before running reset scripts to avoid transient write/delete races.
- Reset scripts intentionally do not touch committed memory source files (`persona.md`, `experience_tags.json`).

## Iteration 60 — Session-aware EVA tone cache with decay + `/respond` prompt injection

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added new tone state module: `packages/eva/agent/src/memory/tone.ts` with required API:
  - `loadToneState(memoryDir)`
  - `getSessionKey(sessionId?)`
  - `getToneForSession(state, sessionKey, nowMs)`
  - `updateToneForSession(state, sessionKey, tone, nowMs, reason?)`
  - `saveToneStateAtomic(memoryDir, state)`
- Implemented tone cache schema v1 and persistence at:
  - `packages/eva/memory/cache/personality_tone.json`
  - state now includes top-level defaults + per-session map + bounded history.
- Implemented session-aware fallback behavior:
  - missing `session_id` resolves to deterministic session key: `default`.
- Implemented decay behavior:
  - per-session `expires_ts_ms` is enforced by `getToneForSession(...)`
  - expired/missing session tone falls back to `default_tone`.
- Added allowed tone list in one place (`tone.ts`):
  - `neutral, calm, friendly, playful, serious, technical, empathetic, urgent`
- Implemented unknown-tone handling:
  - unknown model tone labels map to `neutral` and emit warning log.
- Updated `/respond` pipeline in `packages/eva/agent/src/server.ts`:
  - reads current session tone at request start
  - injects current tone + session key into system prompt before model call
  - prompt now instructs model to maintain current tone unless natural shift or explicit user request
  - after successful tool-call result, writes back `meta.tone` via tone cache update with refreshed expiry.
- Updated respond prompt builder in `packages/eva/agent/src/prompts/respond.ts`:
  - includes current tone directive
  - constrains `meta.tone` to allowed tones list in instructions.

### Files changed
- `packages/eva/agent/src/memory/tone.ts`
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/src/prompts/respond.ts`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- Two real `/respond` calls with the same session id (`tone-demo-60`) return stable tone and persist to cache:
  - response 1 tone: `calm`
  - response 2 tone: `calm`
  - cache session tone (`sessions["tone-demo-60"].tone`): `calm`
- Tone module smoke harness passes:
  - persisted tone remains stable for same session before expiry
  - expired session tone falls back to `neutral`
  - unknown tone maps to `neutral` with warning.

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Send two `/respond` requests with same `session_id` and inspect tone cache:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello","session_id":"tone-demo"}'`
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"continue","session_id":"tone-demo"}'`
   - `cat packages/eva/memory/cache/personality_tone.json`
3. For local expiry check, temporarily reduce `TONE_SESSION_TTL_MS` in `src/memory/tone.ts`, rebuild, run one request, wait past TTL, then verify fallback tone behavior on next request.

### Notes
- Tone smoothing and explicit future-only tone-shift rules remain planned for Iteration 61.

## Iteration 61 — Tone smoothing + explicit “change tone” handling (future-only)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Extended tone cache session state in `packages/eva/agent/src/memory/tone.ts` with smoothing metadata:
  - optional `pending` candidate tone (`tone`, `count`, `updated_ts_ms`)
- Added smoothing controls in `tone.ts`:
  - `TONE_SMOOTHING_REPEAT_TURNS` default `2`
  - updated `updateToneForSession(...)` to apply future-turn smoothing rules:
    - immediate apply when model tone matches current tone
    - immediate apply when user explicitly requested a tone change
    - otherwise hold candidate tone until repeated for N turns, then commit
- Kept smoothing strictly future-turn only:
  - response text is generated first
  - tone smoothing only affects what is stored for later turns.
- Added explicit tone-change detection in `packages/eva/agent/src/server.ts`:
  - `isExplicitToneChangeRequest(...)` based on direct tone-change phrasing patterns
  - passed into `updateToneForSession(...)` as `userRequestedToneChange`
- Updated respond system prompt in `packages/eva/agent/src/prompts/respond.ts`:
  - added required instruction:
    - if user asks to change tone, comply and set `meta.tone` accordingly
  - clarified that `meta.tone` updates stored future tone state.
- Improved tone history debugging in `tone.ts`:
  - every update writes bounded history with compact reason strings
  - reasons include smoothing hold/commit state and explicit-change markers.

### Files changed
- `packages/eva/agent/src/memory/tone.ts`
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/src/prompts/respond.ts`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- Tone smoothing smoke harness passes:
  - first non-explicit tone drift is held (pending set)
  - repeated drift commits after N turns
  - explicit tone request commits immediately
  - history retains reason strings.
- Real `/respond` check for explicit shift persistence (`session_id=tone-demo-61`):
  - response 1 tone: `neutral`
  - response 2 text: “Be more serious in your tone.” -> tone: `serious`
  - response 3 tone remained `serious`
  - cache session tone: `serious` (no pending candidate).

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Verify explicit tone shift persists:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"Give me a short status update.","session_id":"tone-demo"}'`
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"Be more serious in your tone.","session_id":"tone-demo"}'`
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"Continue with the same tone.","session_id":"tone-demo"}'`
   - `cat packages/eva/memory/cache/personality_tone.json`

### Notes
- Smoothing now applies only to stored tone state for subsequent turns and does not rewrite already-generated response text.

## Iteration 62 — Add LanceDB dependency + minimal adapter (no runtime behavior change)

**Status:** ✅ Completed (2026-02-20)

### Completed
- Added pinned LanceDB dependency in `packages/eva/agent/package.json`:
  - `@lancedb/lancedb: "0.26.2"`
- Added minimal LanceDB adapter module:
  - `packages/eva/agent/src/vectorstore/lancedb.ts`
  - exports:
    - `deriveLanceDbDir(memoryDir)`
    - `openDb(lancedbDir)`
    - `getOrCreateTable(db, name, schema)`
    - `mergeUpsertById(table, rows)`
    - `queryTopK(table, queryVector, k)`
- Implemented required LanceDB conventions in the adapter:
  - deterministic DB directory derivation:
    - `path.join(memoryDir, "vector_db", "lancedb")`
  - `openDb(...)` ensures DB directory exists on first use (`mkdir -p` before connect)
  - merge upsert uses `mergeInsert(["id"])` with:
    - `whenMatchedUpdateAll()`
    - `whenNotMatchedInsertAll()`
  - vector search path explicitly targets `vector` column.

### Files changed
- `packages/eva/agent/package.json`
- `packages/eva/agent/package-lock.json`
- `packages/eva/agent/src/vectorstore/lancedb.ts`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm i && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- Local LanceDB adapter smoke harness passes:
  - create temp LanceDB dir from derived memory path
  - create/open table via `getOrCreateTable(...)`
  - merge-upsert one row by `id`
  - query top-1 by vector and get the inserted row back.

### Manual run instructions
1. Install and build Agent:
   - `cd packages/eva/agent`
   - `npm i`
   - `npm run build`
2. Run a tiny local adapter smoke check (create table -> upsert -> query) with Node script importing:
   - `dist/vectorstore/lancedb.js`

### Notes
- This iteration adds LanceDB wiring in isolation only; Agent runtime memory behavior remains unchanged.
- `/jobs/daily` and `/respond` cutover to LanceDB is planned for Iterations 63–64.

## Iteration 63 — Cut over `/jobs/daily` to LanceDB only + docs alignment

**Status:** ✅ Completed (2026-02-20)

### Completed
- Updated Agent daily worker in `packages/eva/agent/src/server.ts` to persist long-term memory in LanceDB only:
  - removed JSON index upsert/write path from `/jobs/daily`
  - `/jobs/daily` now writes to LanceDB tables:
    - `long_term_experiences`
    - `long_term_personality`
  - LanceDB directory now resolved as:
    - `packages/eva/memory/vector_db/lancedb`
- Added LanceDB table schema + row normalization helpers in `server.ts` for daily ingestion/cache refresh.
- Kept cache refresh behavior unchanged:
  - still updates:
    - `packages/eva/memory/cache/core_experiences.json`
    - `packages/eva/memory/cache/core_personality.json`
- Added observability updates:
  - `/health` now includes LanceDB directory + table names
  - `/jobs/daily` response now includes LanceDB dir/table metadata
  - startup logs now print LanceDB path and table names
  - daily job log line reports rows written this run (`experience_upsert_count`, `personality_upsert_count`).
- Updated docs in same iteration:
  - `packages/eva/agent/README.md` now documents LanceDB tables/directory for `/jobs/daily`
  - root `README.md` status line updated to Iteration 63.

### Files changed
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- `/jobs/daily` runtime check passes with LanceDB response metadata:
  - response includes `lancedb.dir` + table names
  - LanceDB table directories created under:
    - `packages/eva/memory/vector_db/lancedb/long_term_experiences.lance`
    - `packages/eva/memory/vector_db/lancedb/long_term_personality.lance`
- Confirmed JSON index files are no longer written by `/jobs/daily`:
  - `packages/eva/memory/vector_db/long_term_experiences/index.json` mtime unchanged
  - `packages/eva/memory/vector_db/long_term_personality/index.json` mtime unchanged.

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Run daily worker:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/daily`
3. Inspect LanceDB artifacts:
   - `ls -la packages/eva/memory/vector_db/lancedb`
4. Verify no JSON `index.json` updates occur for long-term stores.

### Notes
- This iteration performs a hard write-path cutover for daily long-term persistence to LanceDB.
- `/respond` long-term retrieval still uses legacy JSON read path until Iteration 64 cutover.

## Iteration 64 — Cut over `/respond` long-term retrieval to LanceDB only

**Status:** ✅ Completed (2026-02-20)

### Completed
- Updated Agent respond retrieval pipeline in `packages/eva/agent/src/server.ts`:
  - removed JSON long-term read/query usage from `/respond` retrieval context assembly
  - long-term retrieval now uses LanceDB tables only:
    - `long_term_experiences`
    - `long_term_personality`
- `/respond` retrieval now:
  - opens LanceDB at `packages/eva/memory/vector_db/lancedb`
  - gets/creates long-term tables with shared schema
  - runs vector search top-K per table
  - normalizes/filter results and injects them into prompt memory context
- Added graceful LanceDB-empty handling in retrieval context:
  - injects explicit line: `no relevant long-term memory found`
  - continues normal response generation without errors/fabrication.
- Removed legacy JSON long-term read-path exposure from health/log output so runtime behavior reflects LanceDB-only retrieval.
- Updated docs:
  - `packages/eva/agent/README.md` respond section now states long-term retrieval comes from LanceDB tables and notes empty-hit behavior.
  - root `README.md` status line updated to Iteration 64.

### Files changed
- `packages/eva/agent/src/server.ts`
- `packages/eva/agent/README.md`
- `README.md`
- `progress.md`

### Verification
- `cd packages/eva/agent && npm run build` passes.
- `cd packages/eva && npm run build` passes.
- Empty-LanceDB + corrupted legacy JSON regression check passes:
  - moved/removing active LanceDB dir for test run (forcing empty tables)
  - intentionally corrupted legacy JSON index files (`not-valid-json`)
  - `/respond` still returned `200` valid response payload
  - confirms `/respond` no longer depends on legacy JSON long-term reads.

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Call respond endpoint:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"What should I focus on next?"}'`
3. (Optional hard check) temporarily corrupt legacy JSON index files and confirm `/respond` still succeeds, proving LanceDB-only long-term retrieval path.

### Notes
- This iteration completes long-term retrieval cutover to LanceDB for `/respond`.
- Full dead-code/doc cleanup for legacy JSON vector-store helpers remains Iteration 65.

## Iteration 65 — Cleanup: remove dead JSON vector-store code + final docs sweep

**Status:** ✅ Completed (2026-02-20)

### Completed
- Removed dead JSON long-term vector-store code paths in `packages/eva/agent/src/server.ts`:
  - removed legacy JSON read helpers used by old long-term retrieval path
  - removed remaining legacy JSON read-path references from runtime behavior/logging
- Kept active long-term behavior fully LanceDB-based for both:
  - `/jobs/daily` persistence
  - `/respond` long-term retrieval
- Final docs sweep:
  - updated `docs/implementation-plan-44-58.md` memory layout section to stop implying old Chroma/JSON persistence
  - updated root `README.md` with one-time operational note:
    - **Hard cutover: long-term memory is now LanceDB. Existing JSON long-term memory is not used.**
  - kept `packages/eva/agent/README.md` aligned with LanceDB-only long-term retrieval wording.

### Files changed
- `packages/eva/agent/src/server.ts`
- `docs/implementation-plan-44-58.md`
- `README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/agent && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Runtime smoke checks pass:
  - `POST /respond` returns `200` with valid payload
  - `POST /jobs/daily` returns `200` and includes LanceDB metadata
- Confirmed no active docs claim JSON/Chroma as current long-term storage behavior.

### Manual run instructions
1. Start Agent:
   - `cd packages/eva/agent`
   - `npm run dev`
2. Verify respond path:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"Any priorities from memory?"}'`
3. Verify daily job path:
   - `curl -sS -X POST http://127.0.0.1:8791/jobs/daily`
4. Confirm root README includes hard-cutover note.

### Notes
- Iterations 59–65 are now complete.

## Iteration 66 — Rename package folder `agent` → `executive` (mechanical rename)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Renamed package folder via git move:
  - `packages/eva/agent/` → `packages/eva/executive/`
- Updated Eva subprocess path references from the old folder to the new folder:
  - `packages/eva/src/config.ts` defaults (`subprocesses.agent.cwd`)
  - `packages/eva/eva.config.local.example.json` (`subprocesses.agent.cwd`)
- Updated docs path references to the new folder in:
  - `README.md`
  - `packages/eva/README.md`
  - `docs/implementation-plan-44-58.md`
  - `docs/implementation-plan-59-65.md`
- Kept config filename/namespace behavior unchanged (per locked decisions):
  - `agent.config.json` / `agent.config.local.json` / `agent.secrets.local.json` names unchanged
  - cosmiconfig namespace remains `agent`

### Files changed
- `packages/eva/agent/**` → `packages/eva/executive/**` (folder rename, code unchanged)
- `packages/eva/src/config.ts`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/README.md`
- `README.md`
- `docs/implementation-plan-44-58.md`
- `docs/implementation-plan-59-65.md`
- `progress.md`

### Verification
- `cd packages/eva/executive && npm run build` passes.
- Runtime check passes:
  - start executive: `cd packages/eva/executive && npm run dev`
  - `GET /health` returns `200` and `"service":"agent"`.
- `cd packages/eva && npm run build` passes.

### Manual run instructions
1. Start executive service:
   - `cd packages/eva/executive`
   - `npm run dev`
2. Verify health:
   - `curl -sS http://127.0.0.1:8791/health`
3. Build Eva gateway:
   - `cd packages/eva`
   - `npm run build`

### Notes
- This iteration is a mechanical rename only; no runtime behavior changes were introduced.
- Iteration 67 (memcontext namespace move) is next.

## Iteration 67 — Clarify “memory code” naming: introduce `src/memcontext/` and move tone + lancedb adapters

**Status:** ✅ Completed (2026-02-21)

### Completed
- Created clearer executive code namespaces:
  - `packages/eva/executive/src/memcontext/`
  - `packages/eva/executive/src/memcontext/long_term/`
- Moved tone helper code:
  - `packages/eva/executive/src/memory/tone.ts`
  - -> `packages/eva/executive/src/memcontext/tone.ts`
- Moved LanceDB adapter code:
  - `packages/eva/executive/src/vectorstore/lancedb.ts`
  - -> `packages/eva/executive/src/memcontext/long_term/lancedb.ts`
- Updated executive imports in `packages/eva/executive/src/server.ts`:
  - `./memory/tone.js` -> `./memcontext/tone.js`
  - `./vectorstore/lancedb.js` -> `./memcontext/long_term/lancedb.js`
- Kept behavior unchanged:
  - persisted memory data remains under `packages/eva/memory/`
  - tone logic and LanceDB logic unchanged

### Files changed
- `packages/eva/executive/src/memory/tone.ts` -> `packages/eva/executive/src/memcontext/tone.ts`
- `packages/eva/executive/src/vectorstore/lancedb.ts` -> `packages/eva/executive/src/memcontext/long_term/lancedb.ts`
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- `cd packages/eva/executive && npm run build` passes.
- Runtime sanity check passes:
  - start executive: `cd packages/eva/executive && npm run dev`
  - `GET /health` returns `200` and memory paths remain under `packages/eva/memory/...`
  - verified health payload still reports:
    - tone cache: `.../cache/personality_tone.json`
    - lancedb dir: `.../vector_db/lancedb`
- `cd packages/eva && npm run build` passes.

### Manual run instructions
1. Start executive:
   - `cd packages/eva/executive`
   - `npm run dev`
2. Verify health + memory paths:
   - `curl -sS http://127.0.0.1:8791/health`
3. Build Eva gateway:
   - `cd packages/eva`
   - `npm run build`

### Notes
- This iteration is naming/structure cleanup for code modules only; no runtime behavior or persisted data layout changes.

## Iteration 70 — Rename on-disk long-term folder: `vector_db` → `long_term_memory_db` (with safe migration)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated LanceDB directory derivation in executive runtime:
  - `packages/eva/executive/src/memcontext/long_term/lancedb.ts`
  - relative path now resolves to `long_term_memory_db/lancedb` (was `vector_db/lancedb`).
- Updated executive memory reset scripts to use the renamed long-term directory:
  - `packages/eva/executive/scripts/reset-common.mjs`
    - renamed resolved path field: `vectorDbDir` -> `longTermMemoryDbDir`
    - path now points to `memory/long_term_memory_db`
  - `packages/eva/executive/scripts/reset-all.mjs`
    - remove/recreate now targets `long_term_memory_db/**`
    - updated log strings accordingly.
- Updated repo ignore rules:
  - `.gitignore` now ignores `packages/eva/memory/long_term_memory_db/**`.
- Updated executive docs path references:
  - `packages/eva/executive/README.md`
    - LanceDB dir examples now reference `packages/eva/memory/long_term_memory_db/lancedb`.
- Added one-time startup migration in executive:
  - `packages/eva/executive/src/server.ts`
  - on startup, if `packages/eva/memory/vector_db` exists and `packages/eva/memory/long_term_memory_db` does not, executive renames the legacy directory once.
  - success log: `migrated legacy vector_db -> long_term_memory_db`
  - failure path logs a warning and continues (no crash).

### Files changed
- `.gitignore`
- `packages/eva/executive/src/memcontext/long_term/lancedb.ts`
- `packages/eva/executive/src/server.ts`
- `packages/eva/executive/scripts/reset-common.mjs`
- `packages/eva/executive/scripts/reset-all.mjs`
- `packages/eva/executive/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
- One-time migration behavior verified locally:
  - before startup: `packages/eva/memory/vector_db/` existed and `packages/eva/memory/long_term_memory_db/` did not
  - after starting executive once: `vector_db/` was renamed to `long_term_memory_db/`.
- Reset script behavior verified:
  - `cd packages/eva/executive && npm run mem:reset:all`
  - confirmed it recreates:
    - `packages/eva/memory/cache/`
    - `packages/eva/memory/long_term_memory_db/`.

### Manual run instructions
1. Build executive and gateway:
   - `cd packages/eva/executive && npm run build`
   - `cd packages/eva && npm run build`
2. Verify one-time migration behavior (if you still have legacy data):
   - ensure `packages/eva/memory/vector_db/` exists and `packages/eva/memory/long_term_memory_db/` does not
   - start executive once: `cd packages/eva/executive && npm run dev`
   - confirm directory is renamed on disk.
3. Verify reset behavior:
   - `cd packages/eva/executive && npm run mem:reset:all`
   - check `packages/eva/memory/cache/` and `packages/eva/memory/long_term_memory_db/` exist.

### Notes
- Config filenames and cosmiconfig namespace remain unchanged (`agent.config*.json`, `cosmiconfigSync('agent', ...)`) per locked decisions.
- Runtime now reads/writes LanceDB under `packages/eva/memory/long_term_memory_db/lancedb`.

## Iteration 71 — Single writer: add Executive `/events` ingest endpoint that appends `wm_event` entries

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added versioned events ingest schema + validation in executive (`packages/eva/executive/src/server.ts`):
  - request shape:
    - `v: 1`
    - `source: string (non-empty)`
    - `events: non-empty[]`
    - optional `meta: object`
  - each event validates:
    - `name: string (non-empty)`
    - `ts_ms: non-negative int`
    - `severity: low|medium|high`
    - optional `track_id: int`
    - `data: object`
- Added `POST /events` endpoint in executive.
- Added event->working-memory transform into JSONL envelope:
  - `type: "wm_event"`
  - `ts_ms`, `source`, `name`, `severity`, optional `track_id`, `data`
  - `summary` generated by executive from event name + compact key fields.
- Ensured single-writer behavior:
  - `/events` appends through the **same** `workingMemoryWriteQueue` used by `/respond` writes.
  - no direct working-memory writes outside the queue.
- Added startup log line for new endpoint:
  - `events endpoint POST /events (wm_event ingest via serial write queue)`.
- Updated executive README with `/events` behavior + curl example.

### Files changed
- `packages/eva/executive/src/server.ts`
- `packages/eva/executive/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
- Manual endpoint check passes:
  - `POST /events` returns `200` with `{ accepted, ts_ms }`.
  - verified `packages/eva/memory/working_memory.log` includes JSONL line with:
    - `"type":"wm_event"`
    - expected event fields + executive-generated summary.
  - verified JSON parse of log line succeeds.

### Manual run instructions
1. Start executive:
   - `cd packages/eva/executive`
   - `npm run dev`
2. Send a test ingest payload:
   - `curl -sS -X POST http://127.0.0.1:8791/events -H 'content-type: application/json' -d '{"v":1,"source":"vision","events":[{"name":"roi_dwell","ts_ms":1730000000000,"severity":"medium","track_id":3,"data":{"roi":"front_door","dwell_ms":1200}}]}'`
3. Verify working memory log append:
   - `tail -n 5 packages/eva/memory/working_memory.log`
   - confirm a `wm_event` JSON object is present.

### Notes
- This iteration only adds executive-side ingest + persistence.
- EVA gateway forwarding into `/events` remains next (Iteration 72).

## Iteration 72 — EVA gateway forwards `detections.events[]` to Executive `/events` (no file writes in EVA)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added Executive events-ingest forwarder helper in EVA (`packages/eva/src/server.ts`):
  - `resolveAgentEventsIngestUrl(baseUrl)`
  - `callAgentEventsIngest(agentBaseUrl, payload)`
    - posts to `POST /events`
    - uses short timeout (`400ms`) via `AbortController`
    - validates request payload shape before send (`v:1`, source, events[], optional meta)
    - throws non-fatal errors for HTTP/network/timeout failures.
- Added fire-and-forget forwarding path in QuickVision inbound handler:
  - when `message.type === "detections"` and `message.events?.length > 0`:
    - sends `{ v:1, source:"vision", events: message.events, meta:{ frame_id, model } }` to Executive `/events`
    - does **not** block frame routing or WebSocket message handling.
- Added warning throttling for ingest failures:
  - warning log for `/events` forwarding failures is rate-limited (`10s` cooldown).
- Added startup observability log:
  - `agent events ingest target ... timeoutMs=400`.
- Updated EVA README to document event forwarding behavior.

### Files changed
- `packages/eva/src/server.ts`
- `packages/eva/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/eva/executive && npm run build`
- End-to-end forwarding smoke test passes (local scripted harness):
  - started Executive (`startAgentServer`) + EVA (`startServer`) + mock QuickVision WebSocket server
  - mock QuickVision sent a `detections` payload containing `events[]`
  - EVA forwarded events to Executive `/events` without waiting on frame routing
  - verified `packages/eva/memory/working_memory.log` contains appended `wm_event` with:
    - `source: "vision"`
    - `name: <test event name>`
    - valid JSONL entry parse.

### Manual run instructions
1. Start Executive:
   - `cd packages/eva/executive`
   - `npm run dev`
2. Start Vision + EVA stack (external or subprocess mode), then stream frames that trigger detector events.
3. Confirm event forwarding persistence:
   - `tail -n 20 packages/eva/memory/working_memory.log`
   - verify `wm_event` lines with `source:"vision"` appear while events are being generated.

### Notes
- EVA still performs **no direct file writes** for event persistence; Executive remains the single writer for `working_memory.log`.
- `/events` forwarding is intentionally fire-and-forget; routing/relay path remains responsive even if Executive ingest is temporarily unavailable.

## Iteration 73 — Executive /respond injects last N minutes of ALL `wm_event` entries into memory context

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added live-events memory-context helper:
  - new file `packages/eva/executive/src/memcontext/live_events.ts`
  - reads `working_memory.log` JSONL safely (skips invalid lines)
  - filters only `type: "wm_event"`
  - filters by time window (`ts_ms >= nowMs - windowMs`)
  - sorts ascending by `ts_ms`
  - returns last N items (max cap).
- Added required live-event constants in executive runtime (`packages/eva/executive/src/server.ts`):
  - `LIVE_EVENT_WINDOW_MS = 2 * 60 * 1000`
  - `LIVE_EVENT_MAX_ITEMS = 20`
  - `LIVE_EVENT_MAX_LINE_CHARS = 180`
- Updated respond memory-context build path to inject live events near the top:
  - section header: `Live events (last ~2 minutes):`
  - per-line format:
    - `- [HH:MM:SS] <source> <severity> <summary>`
  - each line truncated to `LIVE_EVENT_MAX_LINE_CHARS`
  - line addition remains bounded by existing memory-context token budget logic.
- Updated respond memory-source wiring:
  - `RespondMemorySources` now includes `workingMemoryLogPath`
  - `/respond` call path passes log path into context builder.
- Updated executive README to reflect live `wm_event` context inclusion in `/respond` retrieval context.

### Files changed
- `packages/eva/executive/src/memcontext/live_events.ts`
- `packages/eva/executive/src/server.ts`
- `packages/eva/executive/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
- Helper behavior check passes:
  - posted one old (`>2m`) and one recent `wm_event` via `POST /events`
  - `readRecentWmEvents(...)` returned recent event and excluded old event.
- `/respond` runtime check passes:
  - after posting a recent `wm_event`, `POST /respond` with “what are the recent events right now?” returned a concrete event-based answer (instead of generic no-info response).

### Manual run instructions
1. Start executive:
   - `cd packages/eva/executive`
   - `npm run dev`
2. Ingest a recent event (or trigger through EVA/Vision):
   - `curl -sS -X POST http://127.0.0.1:8791/events -H 'content-type: application/json' -d '{"v":1,"source":"vision","events":[{"name":"roi_dwell","ts_ms":1730000000000,"severity":"medium","track_id":3,"data":{"roi":"front_door","dwell_ms":1200}}]}'`
3. Ask through respond endpoint:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"what were the recent events"}'`
4. Confirm response references recent event details.

### Notes
- Live-events context is source-agnostic for `wm_event` entries (future-proof beyond vision).
- Token-budget enforcement remains unchanged; live-event lines are capped and may truncate/stop when budget is full.

## Iteration 74 — Final cleanup: remove remaining `vector_db` references

**Status:** ✅ Completed (2026-02-21)

### Completed
- Finalized runtime cleanup for old long-term directory naming.
- Updated remaining executive migration runtime strings in `packages/eva/executive/src/server.ts`:
  - migration log text now references generic legacy long-term directory wording and target `long_term_memory_db`.
  - warning log text updated similarly.
- Kept migration behavior intact while removing explicit old-folder-name references from active runtime/docs/scripts paths.
- Verified active docs/scripts/runtime paths now consistently reference:
  - `packages/eva/memory/long_term_memory_db/lancedb`.

### Files changed
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
- Repo search cleanup check passes:
  - searching for `vector_db` outside historical plan/progress docs returns no relevant runtime/docs/scripts matches.

### Manual run instructions
1. Build executive + eva:
   - `cd packages/eva/executive && npm run build`
   - `cd packages/eva && npm run build`
2. Optional sanity search for residual references:
   - `grep -R --line-number --exclude-dir=node_modules --exclude-dir=dist --exclude='progress.md' --exclude='implementation-plan-*.md' "vector_db" /path/to/repo`
3. Start executive and verify health:
   - `cd packages/eva/executive && npm run dev`
   - `curl -sS http://127.0.0.1:8791/health`

### Notes
- Remaining `vector_db` mentions are intentionally historical in prior implementation-plan docs and progress history.
- Runtime long-term store path and operational docs are now aligned on `long_term_memory_db`.

## Iteration 75 — Align code to protocol schema: remove `tts_response` from protocol InsightSummary

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated EVA protocol validator in `packages/eva/src/protocol.ts`:
  - removed `tts_response` from `InsightSummarySchema` so runtime schema matches protocol contract.
- Updated Vision protocol model in `packages/eva/vision/app/protocol.py`:
  - removed `tts_response` from `InsightSummary`.
- Updated UI protocol types in `packages/ui/src/types.ts`:
  - removed `tts_response` from `InsightSummary` interface.
- Updated UI runtime insight guard in `packages/ui/src/main.tsx`:
  - `isInsightMessage(...)` no longer requires `summary.tts_response`.
- Added compatibility handling in UI for transition period:
  - optional narration extraction now reads legacy `summary.tts_response` only when present, so insights still render when field is absent.

### Files changed
- `packages/eva/src/protocol.ts`
- `packages/eva/vision/app/protocol.py`
- `packages/ui/src/types.ts`
- `packages/ui/src/main.tsx`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start stack (Executive + Vision + EVA + UI) as usual.
2. Trigger an insight and confirm UI still renders insight fields (`one_liner`, severity, tags, what_changed).
3. Confirm UI does not reject insight payloads that omit `summary.tts_response`.

### Notes
- This iteration aligns runtime schemas/types with protocol `InsightSummary` (no narration field).
- Any legacy `tts_response` field from upstream is now treated as optional compatibility data in UI only.

## Iteration 76 — Ensure outbound InsightMessage never contains narration

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated QuickVision insight message construction in `packages/eva/vision/app/insights.py`:
  - replaced pass-through summary serialization (`insight.summary.model_dump(...)`) with explicit schema-shaped summary payload.
  - outbound `InsightMessage.summary` now includes only protocol fields:
    - `one_liner`
    - `what_changed`
    - `severity`
    - `tags`
- This guarantees QuickVision -> EVA -> UI insight payloads never transmit narration fields (for example `tts_response`), even if the upstream insight service still returns them.

### Files changed
- `packages/eva/vision/app/insights.py`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. Trigger an insight (`insight_test` or automatic trigger).
3. Confirm UI Latest Insight panel shows no `Spoken line` row.
4. (Optional hard check) inspect the inbound insight payload in UI logs/devtools and verify `summary` does not include `tts_response`.

### Notes
- Upstream narration can still exist internally in insight-service responses, but QuickVision now strips narration before protocol emission.

## Iteration 77 — Executive writes `wm_insight` (single-writer) when serving `/insight`

**Status:** ✅ Completed (2026-02-21)

### Completed
- Extended executive working-memory entry types in `packages/eva/executive/src/server.ts`:
  - added `WorkingMemoryWmInsightEntry` with fields:
    - `type: "wm_insight"`
    - `ts_ms`, `source`, `clip_id`, `trigger_frame_id`
    - `severity`, `one_liner`, `what_changed`, `tags`
    - optional `narration`
    - `usage` token/cost object
- Added `buildWorkingMemoryInsightEntry(...)` helper in executive:
  - maps `/insight` request + generated insight result into a normalized `wm_insight` JSONL entry
  - stores narration under dedicated optional `narration` field (sourced from model `tts_response` when present)
- Updated `/insight` handler in executive:
  - after successful insight generation, appends one `wm_insight` entry to `working_memory.log`
  - write path uses the existing `workingMemoryWriteQueue` (same serial single-writer queue used by `/respond` and `/events`)

### Files changed
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Static verification:
  - confirmed `wm_insight` type + writer wiring in `server.ts` (`buildWorkingMemoryInsightEntry` + `/insight` queue append path)

### Manual run instructions
1. Start Executive (with valid OpenAI key), Vision, EVA, and UI.
2. Trigger an insight (`insight_test` or automatic trigger).
3. Verify working memory contains a new `wm_insight` JSONL row:
   - `tail -n 20 packages/eva/memory/working_memory.log`
   - confirm line includes `"type":"wm_insight"` and expected fields (`clip_id`, `trigger_frame_id`, `one_liner`, optional `narration`).

### Notes
- `wm_insight` writes are now serialized with all other executive memory writes via the single `SerialTaskQueue`.

## Iteration 78 — UI: remove “Spoken line” rendering + remove insight auto-speak behavior

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated UI insight handling in `packages/ui/src/main.tsx`:
  - disabled `maybeAutoSpeakInsight(...)` behavior so incoming `insight` messages no longer trigger speech playback.
- Removed UI reliance on `insight.summary.tts_response`:
  - removed transitional narration extraction path from insight payloads.
- Removed “Spoken line” rendering from **Latest insight** panel.
- Optional quick win applied:
  - updated hardcoded UI title from `Iteration 54` to `Iteration 78`.

### Files changed
- `packages/ui/src/main.tsx`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/ui && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. Trigger a new insight (`insight_test` or auto-trigger).
3. Confirm UI **Latest insight** panel does not show any “Spoken line” section.
4. Confirm no audio playback is triggered when insight messages arrive.

### Notes
- Insight messages are now treated as silent factual UI updates; speech playback for chat responses is planned next.

## Iteration 79 — UI: auto-speak chat replies (TextOutputMessage)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated UI chat-reply handling in `packages/ui/src/main.tsx`:
  - wired auto-speak to incoming `TextOutputMessage` payloads.
  - when chat reply arrives (WS, or HTTP fallback when WS is disconnected), UI now calls speech client with `text_output.text`.
- Added auto-speak guardrails for chat replies:
  - dedupe guard via `lastSpokenTextOutputRequestIdRef` (tracks last spoken `request_id`).
  - cooldown guard via `chatAutoSpeakLastStartedAtMsRef` using `speech.autoSpeak.cooldownMs`.
  - empty/whitespace reply text is skipped.
- Kept existing speech UX and controls, but clarified labels for chat behavior:
  - status line now shows **Chat Auto Speak**.
  - toggle button label now shows **Chat Auto Speak: on/off**.
  - toggle log message now says `Chat auto-speak enabled/disabled`.
  - autoplay notice text now references chat auto-speak on replies.
- Updated speech auto-play log text:
  - `Auto-speak played chat reply.`
- Updated UI title marker:
  - `Eva UI (Iteration 79)`.

### Files changed
- `packages/ui/src/main.tsx`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/ui && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. In UI, click **Enable Audio** once.
3. Send chat text through the chat panel (`POST /text` path).
4. Confirm assistant reply is rendered and auto-spoken.
5. Send repeated/duplicate reply payloads with same `request_id` and confirm no duplicate speech playback.
6. Send replies quickly and confirm cooldown gate suppresses speech starts within configured cooldown window.

### Notes
- Insights remain silent (no auto-speak trigger from `insight` messages).
- Chat auto-speak now uses `TextOutputMessage.text` as the speech source.

## Iteration 80 — Executive: treat recent events as system metadata (not user-facing telemetry)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated respond system prompt generation in `packages/eva/executive/src/prompts/respond.ts` (`buildRespondSystemPrompt`):
  - added explicit guidance that live `wm_event` lines are environment-state context, not user-facing telemetry dumps.
  - added instruction to default to natural-language summaries of what is happening.
  - added instruction to avoid repeating raw telemetry fields (for example track IDs, speed metrics, detector key/value payloads) unless user explicitly asks for low-level/debug details.

### Files changed
- `packages/eva/executive/src/prompts/respond.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Prompt static check:
  - confirmed new guidance lines are present in `buildRespondSystemPrompt` for `wm_event` handling and telemetry suppression.

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. Generate a few live detector events (ROI/line/motion/etc.).
3. Ask chat: “what are the recent events?”
4. Confirm response is natural-language context (for example “Two people moved quickly past each other…”), not a raw telemetry/key-value dump.
5. Ask explicitly for details/debug fields and confirm lower-level telemetry can be provided when requested.

### Notes
- This iteration is prompt-behavior guidance only; no protocol/schema/runtime routing changes were introduced.

## Iteration 81 — Executive: add an “Environment Snapshot” formatter

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added environment snapshot formatter in `packages/eva/executive/src/memcontext/live_events.ts`:
  - new `buildEnvironmentSnapshot(events)` helper that converts recent `wm_event` entries into:
    - a short paragraph summary
    - 3–7 plain-English bullets
  - includes event-pattern/severity/source summarization and no-event fallback snapshot output.
- Updated respond memory-context assembly in `packages/eva/executive/src/server.ts`:
  - now injects **Environment snapshot (derived from live events in the last ~2 minutes)** near the top of memory context.
  - keeps raw event lines as fallback/debug under:
    - `Live event raw lines (debug fallback):`
- Updated imports/wiring:
  - `buildEnvironmentSnapshot` is now imported and used alongside `readRecentWmEvents`.

### Files changed
- `packages/eva/executive/src/memcontext/live_events.ts`
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. Generate multiple live events (ROI, motion, line-cross, etc.).
3. Ask chat: “What are the recent events?”
4. Confirm responses remain natural and stable even with heavier event flow.
5. Optional debug check:
   - verify context still includes raw fallback event lines for low-level grounding when needed.

### Notes
- Snapshot-first + raw-fallback structure is now in place, improving natural-language event handling without removing debug traceability.

## Iteration 82 — Cleanup + docs

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated active UI docs to match silent-insight + spoken-chat runtime in `packages/ui/README.md`:
  - current behavior marker updated to Iteration 79.
  - removed outdated insight auto-speak/`tts_response` guidance.
  - documented chat auto-speak source as `text_output.text` with cooldown + dedupe behavior.
  - documented that insights are silent factual UI updates.
  - clarified control labels (`Chat Auto Speak`).
- Updated Vision docs in `packages/eva/vision/README.md`:
  - removed outdated claim that emitted insight payload preserves `summary.tts_response`.
  - documented schema-aligned emitted summary fields (`one_liner`, `what_changed`, `severity`, `tags`) and narration-field stripping.
- Updated root status summary in `README.md`:
  - now reflects Iteration 82 behavior (silent insights, chat auto-speak, narration internal-only).
- Added explicit historical supersession notes to older implementation-plan docs that describe the previous insight auto-speak model:
  - `docs/implementation-plan-29-35.md`
  - `docs/implementation-plan-36-43.md`
  - `docs/implementation-plan-44-58.md`
  - each now points to `docs/implementation-plan-75-82.md` for current behavior.

### Files changed
- `README.md`
- `packages/ui/README.md`
- `packages/eva/vision/README.md`
- `docs/implementation-plan-29-35.md`
- `docs/implementation-plan-36-43.md`
- `docs/implementation-plan-44-58.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Doc consistency checks:
  - active READMEs no longer claim insight spoken-line rendering or insight-triggered auto-speak.
  - protocol docs remain authoritative for silent `InsightSummary` contract.

### Manual run instructions
1. Start Executive, Vision, EVA, and UI.
2. Trigger an insight and confirm:
   - UI shows factual insight panel only (no spoken line).
   - no insight-triggered audio playback occurs.
3. Send chat text and confirm:
   - assistant `text_output` reply is auto-spoken (after one-time Enable Audio unlock).
4. Review updated docs:
   - `README.md`
   - `packages/ui/README.md`
   - `packages/eva/vision/README.md`

### Notes
- Runtime behavior and active docs are now aligned on: **silent insights, spoken chat**.

## Iteration 83 — Add `packages/eva/llm_logs/` scaffold + gitignore + example config

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added LLM trace log scaffold directory and committed example config:
  - `packages/eva/llm_logs/config.example.json`
  - shape matches the Iteration 83–86 plan defaults with `enabled: false`.
- Updated root `.gitignore` to ignore all runtime log artifacts under `packages/eva/llm_logs/**` while allowlisting:
  - `!packages/eva/llm_logs/config.example.json`
- Updated `packages/eva/executive/README.md` with an LLM logging scaffold blurb:
  - how to copy `config.example.json` to `config.json`
  - how to flip `enabled` on/off for live toggling workflow
  - warning that logs can contain sensitive user text/memory.

### Files changed
- `.gitignore`
- `packages/eva/executive/README.md`
- `packages/eva/llm_logs/config.example.json`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
- Git artifact check:
  - `git status --short` shows no generated `llm_logs` runtime artifacts (for example, no `openai-requests.log` or `config.json` tracked).

### Manual run instructions
1. Create local runtime config (gitignored):
   - `cp packages/eva/llm_logs/config.example.json packages/eva/llm_logs/config.json`
2. Edit `packages/eva/llm_logs/config.json` and toggle:
   - `"enabled": true` to enable
   - `"enabled": false` to disable
3. Proceed to Iterations 84–85 for actual logger implementation + call-site wiring.

### Notes
- This iteration is scaffold/docs/gitignore only; no logger module or OpenAI call-site integration was added yet.

## Iteration 84 — Implement hot-reload LLM log config + safe logger module (no wiring yet)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added standalone Executive LLM trace logger module:
  - `packages/eva/executive/src/llm_log.ts`
- Implemented default config-path resolution from Executive memory dir:
  - `configPath = path.resolve(memoryDirPath, '..', 'llm_logs', 'config.json')`
- Implemented hot config reload on every log attempt:
  - `stat(configPath)` each call
  - cache key = config path with `mtimeMs`
  - reload JSON when mtime changes
  - missing/invalid config is treated as `enabled: false`
  - logger never throws to caller
- Implemented sanitization guardrails:
  - redacts API-key fields (`apiKey`/`api_key` variants)
  - redacts `secrets` object payloads
  - replaces base64 image payload fields with placeholders including size, for example:
    - `[omitted base64 image: 123456 chars]`
  - supports `omit_image_b64` toggle
  - applies string truncation via `truncate_chars`
  - handles circular/unserializable values safely
- Implemented best-effort JSONL writer:
  - ensures log directory exists
  - appends one JSON record per line
  - write failures are swallowed to preserve runtime behavior
- Implemented optional file rotation:
  - checks `max_file_bytes` before append
  - rotates `log -> log.1 -> log.2 ...` up to `rotate_count`
  - starts a fresh log file after rotation.

### Files changed
- `packages/eva/executive/src/llm_log.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva/executive && npm run build`

### Manual smoke check (no OpenAI call)
1. Created runtime config:
   - `packages/eva/llm_logs/config.json` with `"enabled": true`.
2. Ran a tiny script that imports and calls `logLlmTrace(...)` directly (using `npx tsx --eval ...`).
3. Verified file creation + append:
   - `packages/eva/llm_logs/openai-requests.log`
4. Verified sanitization in output line:
   - image block `data` replaced with `[omitted base64 image: ... chars]`
   - `requestOptions.apiKey` replaced with `[omitted api key]`
   - `secrets` replaced with `[omitted secrets]`
5. Hot-reload sanity check:
   - flipped config `enabled` true -> false while process remained running
   - subsequent logger call did not append a new line.

### Manual run instructions
1. Copy example config:
   - `cp packages/eva/llm_logs/config.example.json packages/eva/llm_logs/config.json`
2. Set `"enabled": true` in `packages/eva/llm_logs/config.json`.
3. Call `logLlmTrace(...)` from any Executive code path with:
   - `memoryDirPath`
   - `kind`, `phase`, `traceId`, `model`, and `payload`.
4. Inspect JSONL output in:
   - `packages/eva/llm_logs/openai-requests.log`

### Notes
- This iteration intentionally does **not** wire logger calls into `generateInsight(...)` / `generateRespond(...)` yet; that is Iteration 85.

## Iteration 85 — Wire logger into `generateInsight()` and `generateRespond()` around `complete(...)`

**Status:** ✅ Completed (2026-02-21)

### Completed
- Wired LLM trace logging into Executive model-call boundaries in:
  - `packages/eva/executive/src/server.ts`
- Added logger import:
  - `import { logLlmTrace } from './llm_log.js';`
- Updated `generateInsight(...)` tracing around `complete(...)`:
  - creates `trace_id` as `insight-${randomUUID()}`
  - logs `phase: "request"` immediately before the model call with:
    - model provider/id
    - request metadata (`clip_id`, `trigger_frame_id`, `frame_count`)
    - full `context` object passed to `complete(...)`
  - logs `phase: "response"` immediately after `complete(...)` returns with raw `assistantMessage`
  - on model-call throw, logs `phase: "error"` then rethrows existing `HttpRequestError` pattern (`MODEL_CALL_FAILED`)
- Updated `generateRespond(...)` tracing around `complete(...)`:
  - creates `trace_id` as `respond-${randomUUID()}`
  - logs `phase: "request"` immediately before the model call with:
    - model provider/id
    - request summary (`user_text`, `session_id`)
    - full `context` object passed to `complete(...)`
  - logs `phase: "response"` immediately after `complete(...)` returns with raw `assistantMessage`
  - on model-call throw, logs `phase: "error"` then rethrows existing `HttpRequestError` pattern (`MODEL_CALL_FAILED`)
- Confirmed logging path does not pass request options/secrets (`apiKey`) into logger payloads.
- Preserved runtime behavior safety:
  - logger remains best-effort and does not alter request success/failure semantics if logging fails.

### Files changed
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Runtime verification
1. Enabled logging in local runtime config:
   - `packages/eva/llm_logs/config.json` -> `"enabled": true`
2. Started Executive and called:
   - `POST /respond` (success)
   - `POST /insight` (intentional invalid image payload to exercise model response error path)
3. Verified JSONL output at:
   - `packages/eva/llm_logs/openai-requests.log`
4. Verified records include request+response traces for both calls:
   - `respond` request + response
   - `insight` request + response (with model stopReason/error message payload)
5. Verified sanitization:
   - no raw base64 image blobs in logs (`image` blocks show placeholder text)
   - no API keys/secrets in trace payload.

### Hot toggle test (no restart)
- While Executive remained running:
  1. flipped `enabled: true -> false` in `packages/eva/llm_logs/config.json`
  2. sent another `POST /respond`
  3. confirmed log line count did not change
  4. flipped `enabled: false -> true`
  5. sent another `POST /respond`
  6. confirmed new lines appended again.

### Notes
- Insight test used an intentionally invalid JPEG payload to validate boundary logging even when upstream model returns an error response; trace output still captures the exact request context and raw model response envelope.

## Iteration 86 — Docs + safety sweep

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Executive docs for finalized LLM trace logging behavior in:
  - `packages/eva/executive/README.md`
- Replaced scaffold wording with operational docs covering:
  - config location (`packages/eva/llm_logs/config.json`)
  - hot reload behavior (mtime reload, no restart required)
  - logged phases (`request`, `response`, `error`) at `complete(...)` boundaries
  - JSONL default output path
  - sanitization guarantees:
    - base64 image payload replacement placeholders
    - `secrets` redaction
    - API-key field redaction
    - string truncation (`truncate_chars`)
  - explicit warning that logs may still contain sensitive text context.
- Updated root `README.md` with a short LLM trace note:
  - added local config + log file paths under configuration files
  - updated status marker to Iteration 86
  - added one-line summary of hot-toggle logging + safeguards.

### Safety sweep
- Performed repository sweep (source/docs scope, excluding `node_modules` and build output) to verify no source code path logs `secrets.openaiApiKey`.
- Confirmed `openaiApiKey` usage remains limited to:
  - secrets schema validation
  - `complete(...)` request options at call sites.
- Verified gitignore coverage for LLM log artifacts:
  - `packages/eva/llm_logs/**`
  - allowlist only `!packages/eva/llm_logs/config.example.json`
- Verified runtime artifacts are untracked:
  - `packages/eva/llm_logs/config.json` -> ignored
  - `packages/eva/llm_logs/openai-requests.log` -> ignored.

### Files changed
- `README.md`
- `packages/eva/executive/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Git ignore verification:
  - `git status --short --ignored -- packages/eva/llm_logs` shows runtime artifacts as ignored (`!!`) and only scaffold directory as untracked due committed example file.

### Notes
- Iterations 83–86 are now complete: scaffold + hot logger module + model-call wiring + docs/safety sweep.

## Iteration 87 — Protocol compatibility: allow `hello.role = "vision"` (while keeping `quickvision`)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated UI protocol type union to accept both legacy and new vision runtime hello roles:
  - `packages/ui/src/types.ts`
  - `HelloMessage.role` now allows: `"ui" | "eva" | "quickvision" | "vision"`
- Updated Eva protocol hello validator to accept both role strings:
  - `packages/eva/src/protocol.ts`
  - `HelloMessageSchema.role` enum now includes `"vision"` in addition to `"quickvision"`.

### Files changed
- `packages/ui/src/types.ts`
- `packages/eva/src/protocol.ts`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/ui && npm run build`
  - `cd packages/eva && npm run build`

### Manual run instructions
1. Start the stack with current services/config (producer may still emit `"quickvision"` at this stage).
2. Confirm startup and stream flow are unchanged.
3. Confirm no consumer-side regression from role compatibility widening.

### Notes
- This iteration is consumer-tolerance only; producer identity emission remains unchanged until Iteration 88.

## Iteration 88 — Vision service emits `vision` identity (health + hello + log prefixes)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Vision service runtime identity in `packages/eva/vision/app/main.py`:
  - `FastAPI(title="quickvision")` -> `FastAPI(title="vision")`
  - `/health` service field now returns `"service": "vision"`
  - WebSocket hello now emits `make_hello("vision")`
  - startup/config log prefixes changed from `[quickvision]` -> `[vision]`
  - auto-insight log lines changed from `[quickvision] auto insight ...` -> `[vision] ...`
- Updated Vision insight module naming/log text in `packages/eva/vision/app/insights.py`:
  - log prefix `[quickvision]` -> `[vision]`
  - config error prefix `"QuickVision config error: ..."` -> `"Vision config error: ..."`
  - disabled-message text now references `Vision settings`.
- Updated Vision run launcher config errors in `packages/eva/vision/app/run.py`:
  - `"QuickVision config error: ..."` -> `"Vision config error: ..."`
- Updated Vision protocol role literal in `packages/eva/vision/app/protocol.py` to allow the new hello role:
  - `RoleType = Literal["ui", "eva", "quickvision", "vision"]`
  - keeps transitional compatibility while producer now emits `"vision"`.

### Files changed
- `packages/eva/vision/app/main.py`
- `packages/eva/vision/app/insights.py`
- `packages/eva/vision/app/run.py`
- `packages/eva/vision/app/protocol.py`
- `progress.md`

### Verification
- Compile check passes:
  - `cd packages/eva/vision && python3 -m compileall app`
- Runtime startup attempt on this host failed due missing dependency in local venv:
  - `ModuleNotFoundError: No module named 'uvicorn'`

### Manual run instructions
1. Ensure Vision venv deps are installed:
   - `cd packages/eva/vision`
   - `source .venv/bin/activate`
   - `pip install -r requirements.txt`
2. Start Vision:
   - `python -m app.run`
3. Verify health identity:
   - `curl http://127.0.0.1:8000/health`
   - confirm payload includes `"service":"vision"`
4. Verify WS hello identity:
   - connect to `ws://127.0.0.1:8000/infer`
   - confirm first message includes `"type":"hello"` and `"role":"vision"`.

### Notes
- This iteration flips producer identity to `vision` while retaining temporary compatibility for legacy `quickvision` role values.

## Iteration 89 — Eva gateway wording: rename “QuickVision” log strings to “Vision” (no behavior change)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Eva gateway log wording in `packages/eva/src/server.ts` from "QuickVision" to "Vision" (log strings only), including:
  - connection established log
  - connection closed log
  - reconnect scheduled log
  - connection error log
  - invalid schema payload log
  - unmatched route drop logs
  - non-JSON inbound payload log
  - startup target URL log (`Vision target ...`)
- Kept internal identifiers/variables unchanged (`quickvisionClient`, `QuickVisionInboundMessageSchema`, etc.) to keep diff scoped and behavior unchanged.
- Kept runtime protocol/error payload behavior unchanged (for example `QV_UNAVAILABLE` payload text remains unchanged in this iteration).

### Files changed
- `packages/eva/src/server.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`

### Manual run instructions
1. Start Vision, Eva, and UI.
2. Observe Eva logs during startup and reconnect scenarios.
3. Confirm operator-facing logs now say “Vision” (not “QuickVision”) while message flow and behavior remain unchanged.

### Notes
- This iteration is wording-only for Eva logs; no protocol or routing behavior was changed.

## Iteration 90 — Cleanup: remove legacy `"quickvision"` role support + docs sweep

**Status:** ✅ Completed (2026-02-21)

### Completed
- Removed legacy `quickvision` role from UI protocol types:
  - `packages/ui/src/types.ts`
  - `HelloMessage.role` now allows only: `"ui" | "eva" | "vision"`
- Removed legacy `quickvision` role from Eva protocol hello schema:
  - `packages/eva/src/protocol.ts`
  - `HelloMessageSchema.role` now allows only: `ui | eva | vision`
- Removed legacy `quickvision` role from Vision Python protocol type alias:
  - `packages/eva/vision/app/protocol.py`
  - `RoleType = Literal["ui", "eva", "vision"]`
- Updated protocol docs/schema to align with runtime role cleanup:
  - `packages/protocol/schema.json` hello role enum now uses `vision`
  - `packages/protocol/README.md` directional wording updated to `Vision`.
- Docs sweep:
  - `packages/eva/vision/README.md` now documents hello role as `"vision"`
  - root `README.md` includes a single historical breadcrumb (`formerly QuickVision`) and updates status through Iteration 90.

### Files changed
- `packages/ui/src/types.ts`
- `packages/eva/src/protocol.ts`
- `packages/eva/vision/app/protocol.py`
- `packages/protocol/schema.json`
- `packages/protocol/README.md`
- `packages/eva/vision/README.md`
- `README.md`
- `progress.md`

### Verification
- Build/compile checks pass:
  - `cd packages/ui && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Vision, Eva, and UI.
2. Verify Vision `/health` returns `"service":"vision"`.
3. Connect UI and confirm hello role is `"vision"` (no `"quickvision"` role in runtime protocol flow).
4. Confirm no consumer path requires `"quickvision"` role support.

### Notes
- Legacy quickvision-role compatibility is now removed from active runtime protocol types/schemas.

## Iteration 91 — Config hard cutover: remove `quickvision.wsUrl` support everywhere

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Eva config schema in `packages/eva/src/config.ts`:
  - `vision` is now required in `EvaConfigSchema`.
  - removed top-level `quickvision` config key support (no fallback / no deprecation warning path).
  - simplified config return type to `z.infer<typeof EvaConfigSchema>`.
  - removed alias resolution logic and `resolvedVision` return path.
  - parse error formatting now maps missing `vision` object to `vision.wsUrl: Required`.
- Updated Eva docs in `packages/eva/README.md`:
  - removed deprecated `quickvision.wsUrl` alias note from runtime behavior section.
  - removed top-level `quickvision` block from the config schema snippet.
  - updated notes to state `vision.wsUrl` is required.

### Files changed
- `packages/eva/src/config.ts`
- `packages/eva/README.md`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- Startup smoke check with current config file boots Eva process:
  - `cd packages/eva && timeout 12s npm run dev`
  - Eva starts and proceeds into normal startup flow (stopped by timeout).

### Manual run instructions
1. Ensure `packages/eva/eva.config.json` contains `vision.wsUrl`.
2. Start Eva:
   - `cd packages/eva`
   - `npm run dev`
3. Confirm Eva starts without any `quickvision.wsUrl` deprecation warning.

### Notes
- `subprocesses.quickvision` is intentionally unchanged in this iteration and will be renamed in Iteration 92.

## Iteration 92 — Subprocess hard cutover: rename `subprocesses.quickvision` → `subprocesses.vision` (no shim)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Renamed Eva subprocess config key in `packages/eva/src/config.ts`:
  - `subprocesses.quickvision` -> `subprocesses.vision` in schema defaults and top-level defaults.
  - no compatibility shim for `subprocesses.quickvision` remains in config parsing.
- Updated local example config in `packages/eva/eva.config.local.example.json`:
  - `subprocesses.quickvision` -> `subprocesses.vision`.
- Docs alignment:
  - root `README.md` now references `subprocesses.vision.command` for venv Python override.
  - `packages/eva/README.md` schema snippet now uses `subprocesses.vision`.
  - `packages/eva/README.md` subprocess-mode venv command override example now uses `subprocesses.vision`.
- Compile-followup in `packages/eva/src/index.ts`:
  - switched config access to `config.subprocesses.vision` so runtime matches the renamed schema key.
  - intentionally left variable names/log labels unchanged (`quickvision`) for Iteration 93.

### Files changed
- `packages/eva/src/config.ts`
- `packages/eva/src/index.ts`
- `packages/eva/eva.config.local.example.json`
- `README.md`
- `packages/eva/README.md`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- Manual subprocess boot check:
  1. `cd packages/eva && cp eva.config.local.example.json eva.config.local.json`
  2. `timeout 45s npm run dev`
  3. Observed startup flow:
     - agent started and became healthy
     - Eva proceeded to start Vision subprocess from the renamed config key path
     - process then failed in this host due missing Vision dependency (`ModuleNotFoundError: No module named 'uvicorn'`)

### Manual run instructions
1. `cd packages/eva`
2. `cp eva.config.local.example.json eva.config.local.json`
3. (If needed) set `subprocesses.vision.command` to your venv python.
4. `npm run dev`
5. Confirm Eva starts Agent, then Vision subprocess.

### Notes
- Subprocess runtime naming/log strings still use `quickvision` in `index.ts` and will be renamed in Iteration 93.

## Iteration 92 (follow-up patch) — Vision subprocess interpreter continuity (`uvicorn` startup fix)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Fixed Vision subprocess command defaults to use the repo venv interpreter instead of system `python`:
  - `packages/eva/src/config.ts`
    - `VisionSubprocessConfigSchema.command` default:
      - `['python', '-m', 'app.run']` -> `['.venv/bin/python', '-m', 'app.run']`
    - `subprocesses.vision.command` default in top-level config default object updated to the same venv command.
- Updated local/example config files so copied local config preserves venv interpreter usage:
  - `packages/eva/eva.config.local.example.json`
  - `packages/eva/eva.config.local.json`
- Updated docs to reflect venv command continuity and local override guidance:
  - `packages/eva/README.md` schema snippet now shows `"command": [".venv/bin/python", "-m", "app.run"]`.
  - root `README.md` guidance updated to clarify `subprocesses.vision.command` should target your venv interpreter path.
- Updated planning doc per request:
  - `docs/implementation-plan-91-94.md` Iteration 92 now includes a required runtime-command continuity note explaining that old `subprocesses.quickvision.command` overrides no longer apply after hard cutover and `subprocesses.vision.command` must point to venv python.

### Files changed
- `packages/eva/src/config.ts`
- `packages/eva/eva.config.local.example.json`
- `packages/eva/eva.config.local.json`
- `packages/eva/README.md`
- `README.md`
- `docs/implementation-plan-91-94.md`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- Manual subprocess startup check:
  1. `cd packages/eva`
  2. `timeout 60s npm run dev`
  3. Observed startup flow:
     - agent started and became healthy
     - Eva started Vision subprocess using `.venv/bin/python -m app.run`
     - Vision launched under Uvicorn (`Uvicorn running on http://127.0.0.1:8000`)
     - no `ModuleNotFoundError: No module named 'uvicorn'` in this path
     - process then exited via timeout (expected).

### Notes
- Root cause was interpreter selection after key rename, not a removed package from the venv.

## Iteration 93 — Rename subprocess runtime naming in `index.ts` (variable names + ManagedProcess name)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Eva bootstrap/runtime naming in `packages/eva/src/index.ts`:
  - local subprocess variable rename:
    - `let quickvision` -> `let vision`
  - subprocess startup locals renamed:
    - `quickvisionConfig` -> `visionConfig`
    - `quickvisionCwd` -> `visionCwd`
  - operator logs renamed:
    - `starting quickvision subprocess` -> `starting vision subprocess`
    - `waiting for quickvision health` -> `waiting for vision health`
    - `quickvision healthy` -> `vision healthy`
    - `stopping quickvision` -> `stopping vision`
    - `force-killing quickvision` -> `force-killing vision`
  - `ManagedProcess` identity renamed:
    - `name: 'quickvision'` -> `name: 'vision'`
- Kept the server callsite option key intentionally unchanged in this iteration:
  - `quickvisionWsUrl: config.vision.wsUrl` (to be renamed in Iteration 94).

### Files changed
- `packages/eva/src/index.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- Manual subprocess boot check:
  1. `cd packages/eva`
  2. `timeout 45s npm run dev`
  3. Observed logs show Vision naming in bootstrap path:
     - `[eva] starting vision subprocess: ...`
     - `[eva] waiting for vision health at ...`
     - `[eva] stopping vision...`
     - child prefix uses `[vision]` (from `ManagedProcess` name).

### Manual run instructions
1. `cd packages/eva`
2. `npm run dev`
3. Confirm bootstrap/shutdown logs use `vision subprocess` wording.

### Notes
- `quickvisionWsUrl` option key and remaining QuickVision TS surface names are intentionally deferred to Iteration 94.

## Iteration 94 — TypeScript surface rename: client module + server options + protocol schema names

**Status:** ✅ Completed (2026-02-21)

### Completed
- Renamed Eva Vision WS client module:
  - `packages/eva/src/quickvisionClient.ts` -> `packages/eva/src/visionClient.ts`
- Updated client module symbols in `packages/eva/src/visionClient.ts`:
  - `QuickVisionClientHandlers` -> `VisionClientHandlers`
  - `QuickVisionClientOptions` -> `VisionClientOptions`
  - `QuickVisionClient` -> `VisionClient`
  - `createQuickVisionClient(...)` -> `createVisionClient(...)`
  - updated invalid-binary marker text:
    - `'<unexpected binary message from QuickVision>'` -> `'<unexpected binary message from Vision>'`
- Renamed protocol exports in `packages/eva/src/protocol.ts`:
  - `QuickVisionInboundMessageSchema` -> `VisionInboundMessageSchema`
  - `QuickVisionInboundMessage` -> `VisionInboundMessage`
- Updated server TS surface in `packages/eva/src/server.ts`:
  - import path/name:
    - `createQuickVisionClient` from `./quickvisionClient.js` -> `createVisionClient` from `./visionClient.js`
  - protocol schema import:
    - `QuickVisionInboundMessageSchema` -> `VisionInboundMessageSchema`
  - start options rename:
    - `StartServerOptions.quickvisionWsUrl` -> `StartServerOptions.visionWsUrl`
  - local destructure/usage rename:
    - `quickvisionWsUrl` -> `visionWsUrl`
    - `quickvisionClient` -> `visionClient`
- Updated Eva bootstrap callsite in `packages/eva/src/index.ts`:
  - `quickvisionWsUrl: config.vision.wsUrl` -> `visionWsUrl: config.vision.wsUrl`
- Docs sweep check completed:
  - verified root `README.md` and `packages/eva/README.md` contain no `quickvision.wsUrl` or `subprocesses.quickvision` references.

### Files changed
- `packages/eva/src/visionClient.ts` (renamed from `quickvisionClient.ts`)
- `packages/eva/src/protocol.ts`
- `packages/eva/src/server.ts`
- `packages/eva/src/index.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- Repo quickvision-surface check:
  - `find packages/eva ... | grep "quickvision"` (excluding `.venv`, `node_modules`, `dist`, `__pycache__`) returns no matches.
  - note: `rg` is unavailable in this host, so equivalent grep check was used.
- Manual subprocess startup check:
  1. `cd packages/eva`
  2. `timeout 45s npm run dev`
  3. Observed expected startup path:
     - `[eva] starting vision subprocess: ...`
     - `[eva] waiting for vision health at ...`
     - clean timeout-driven shutdown path still works.

### Manual run instructions
1. `cd packages/eva`
2. `npm run dev`
3. Confirm Eva starts Agent + Vision subprocess and logs `Vision target ...`.

### Notes
- Protocol error codes remain unchanged (for example `QV_UNAVAILABLE`) per hard-cutover decision.

## Iteration 95 — Hard cutover: store insight clip frames + send asset refs to Executive `/insight`

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added working-memory assets runtime location and git hygiene:
  - created `packages/eva/memory/working_memory_assets/.gitkeep`
  - updated root `.gitignore` to ignore `packages/eva/memory/working_memory_assets/**` while keeping `.gitkeep` tracked.
- Updated Executive `/insight` request contract in `packages/eva/executive/src/server.ts`:
  - `ClipFrameSchema` now requires `asset_rel_path` and no longer accepts `image_b64`
  - added `WORKING_MEMORY_ASSETS_DIRNAME = "working_memory_assets"`
  - derives `assetsDirPath` from `config.memoryDirPath` and ensures directory exists at startup
  - added guarded asset loading path for each frame:
    - traversal guard (`INSIGHT_ASSET_INVALID_PATH`)
    - missing file handling (`INSIGHT_ASSET_MISSING`)
    - read failures (`INSIGHT_ASSET_READ_FAILED`)
  - base64 encoding is now performed internally from asset bytes just before model call.
- Extended working memory insight entries to persist asset references:
  - `WorkingMemoryWmInsightEntry` now includes:
    - `assets: Array<{ frame_id?: string; ts_ms?: number; mime: "image/jpeg"; asset_rel_path: string }>`
- Updated Executive docs:
  - `packages/eva/executive/README.md` insight curl example now uses `asset_rel_path`
  - documented asset location under `packages/eva/memory/working_memory_assets/`.
- Updated Vision insight transport and persistence:
  - `packages/eva/vision/app/insights.py`
    - removed base64 request-frame construction path
    - added clip asset persistence per insight run under `<assets_dir>/<clip_id>/`
    - persists the exact bytes used for the insight call (downsampled JPEG when enabled)
    - sends request frames to Executive as `{ frame_id, ts_ms, mime, asset_rel_path }`
  - `packages/eva/vision/app/vision_agent_client.py`
    - `VisionAgentFrame` now uses `asset_rel_path` (no `image_b64`).
- Removed deprecated alias usage in Vision config/docs (hard cutover):
  - removed `insights.vision_agent_url` from `packages/eva/vision/settings.yaml`
  - removed fallback alias logic from `packages/eva/vision/app/insights.py`
  - removed alias mention from `packages/eva/vision/README.md`
  - added `insights.assets_dir` setting (default `../memory/working_memory_assets`).

### Files changed
- `.gitignore`
- `packages/eva/memory/working_memory_assets/.gitkeep`
- `packages/eva/executive/src/server.ts`
- `packages/eva/executive/README.md`
- `packages/eva/vision/app/insights.py`
- `packages/eva/vision/app/vision_agent_client.py`
- `packages/eva/vision/app/main.py`
- `packages/eva/vision/settings.yaml`
- `packages/eva/vision/README.md`
- `progress.md`

### Verification
- Build/compile checks pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`

### Manual run instructions
1. Start Executive + Vision + Eva + UI using existing dev instructions.
2. Trigger an insight (manual insight test or surprise-triggered flow).
3. Confirm files are persisted under:
   - `packages/eva/memory/working_memory_assets/<clip_id>/`
4. Confirm Executive `/insight` succeeds.
5. Confirm `packages/eva/memory/working_memory.log` includes `wm_insight` entries with `assets: [...]` references.

### Notes
- This is a hard cutover for `/insight` transport: request frames must provide `asset_rel_path`.
- Legacy `image_b64` request payloads for Executive `/insight` are intentionally no longer accepted.

## Iteration 96 — Naming cleanup: remove remaining “QuickVision” strings (no aliases)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Vision Python config error text to remove remaining legacy naming:
  - replaced all `"QuickVision config error: ..."` occurrences with `"Vision config error: ..."` in:
    - `packages/eva/vision/app/motion.py`
    - `packages/eva/vision/app/collision.py`
    - `packages/eva/vision/app/roi.py`
    - `packages/eva/vision/app/abandoned.py`
    - `packages/eva/vision/app/tracking.py`
- Updated Eva user-facing `QV_UNAVAILABLE` message text in `packages/eva/src/server.ts`:
  - `"QuickVision is not connected."` -> `"Vision is not connected."`
  - kept error code `QV_UNAVAILABLE` unchanged.

### Files changed
- `packages/eva/src/server.ts`
- `packages/eva/vision/app/motion.py`
- `packages/eva/vision/app/collision.py`
- `packages/eva/vision/app/roi.py`
- `packages/eva/vision/app/abandoned.py`
- `packages/eva/vision/app/tracking.py`
- `progress.md`

### Verification
- Build/compile checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Naming sweep:
  - `grep -RIn "QuickVision" packages/eva` returns no hits (excluding ignored/build dirs).

### Manual run instructions
1. Start Vision + Eva + UI.
2. Temporarily disconnect Vision (or start Eva before Vision).
3. Confirm UI receives `QV_UNAVAILABLE` with message text:
   - `Vision is not connected.`
4. Confirm Vision config validation failures (if induced) now use `Vision config error: ...` wording.

### Notes
- Iteration 96 is wording-only cleanup; protocol/error codes and behavior remain unchanged.

## Iteration 97 — Asset retention (max clips + max age)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added Vision insight asset retention config in `packages/eva/vision/app/insights.py`:
  - new settings under `insights.assets`:
    - `max_clips` (default `200`)
    - `max_age_hours` (default `24`)
  - validation:
    - `insights.assets.max_clips` must be `>= 1`
    - `insights.assets.max_age_hours` must be a non-negative integer.
- Added retention defaults in `packages/eva/vision/settings.yaml`:
  - `insights.assets.max_clips: 200`
  - `insights.assets.max_age_hours: 24`
- Implemented asset cleanup routine in `InsightBuffer`:
  - runs after each new clip directory is written
  - scans clip directories under `insights.assets_dir`
  - sorts by directory mtime (newest first)
  - prunes directories older than `max_age_hours`
  - prunes directories beyond `max_clips`
  - never prunes the just-written current clip directory
  - logs prune-scan/prune-delete failures without failing active insight request flow.
- Updated Vision startup/health observability in `packages/eva/vision/app/main.py`:
  - startup log now includes `assets_max_clips` and `assets_max_age_hours`
  - `/health` includes:
    - `insight_assets_max_clips`
    - `insight_assets_max_age_hours`.
- Updated Vision docs (`packages/eva/vision/README.md`) for retention behavior and new config keys.

### Files changed
- `packages/eva/vision/app/insights.py`
- `packages/eva/vision/app/main.py`
- `packages/eva/vision/settings.yaml`
- `packages/eva/vision/README.md`
- `progress.md`

### Verification
- Build/compile checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/eva/vision && python3 -m compileall app`
- Local retention smoke-check (Vision venv Python script) passed:
  - created multiple fake clip directories
  - ran pruning with `max_clips=2`
  - verified only newest 2 clip dirs remained (including current clip).

### Manual run instructions
1. In `packages/eva/vision/settings.local.yaml`, set a small retention threshold for testing:
   ```yaml
   insights:
     assets:
       max_clips: 3
       max_age_hours: 1
   ```
2. Start Vision + Eva + UI + Executive.
3. Trigger insights repeatedly until more than 3 clip directories exist.
4. Confirm older directories are pruned under `packages/eva/memory/working_memory_assets/`.
5. Optionally age a clip directory mtime beyond `max_age_hours` and trigger another insight; confirm it is pruned.
6. Confirm Executive `/insight` still succeeds and `wm_insight` logging remains intact.

### Notes
- Retention is clip-directory scoped and applies only to persisted insight clip assets.

## Iteration 98 — Protocol docs/schema + UI types for `speech_output`

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added additive protocol docs for new Eva -> UI `speech_output` message in `packages/protocol/README.md`.
- Added `speech_output` schema support in `packages/protocol/schema.json`:
  - added `$defs/speech_output_meta`
  - added `$defs/speech_output`
  - included `speech_output` in the top-level `oneOf` union.
- Added UI compile-time support in `packages/ui/src/types.ts`:
  - new `SpeechOutputMeta`
  - new `SpeechOutputMessage`
  - included `SpeechOutputMessage` in `ProtocolMessage` union.

### Files changed
- `packages/protocol/README.md`
- `packages/protocol/schema.json`
- `packages/ui/src/types.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/ui && npm run build`

### Manual run instructions
1. Start Eva/UI with normal dev flow.
2. (Optional, simulation) send a `speech_output` JSON payload to the UI WebSocket client from a test harness.
3. Confirm UI compiles and accepts the message shape at type level (runtime handling added in later iteration).

### Notes
- Iteration 98 is protocol + typing only; no runtime playback behavior was added yet.

## Iteration 99 — Eva push-mode high-severity alerts (text-only)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added high-alert guardrail state in `packages/eva/src/server.ts`:
  - `HIGH_ALERT_COOLDOWN_MS = 10000`
  - `HIGH_ALERT_DEDUPE_WINDOW_MS = 60000`
  - `lastHighAlertAtMs`
  - `highAlertSeenKeys`
- Added helper functions in Eva server:
  - `evictExpiredHighAlertKeys(nowMs)`
  - `shouldEmitHighAlert(key, nowMs)`
  - `pushHighSeverityAlertToClient(client, payload)` (text-only in this iteration)
- `pushHighSeverityAlertToClient(...)` now sends immediate `text_output` messages with:
  - `session_id: "system-alerts"`
  - generated `request_id` via `randomUUID()`
  - `meta.note: "Auto alert (push mode)."`
  - `meta.concepts` including `"high_severity"` and `"alert"`
- Added high-severity trigger path for Vision `insight` messages:
  - condition: `message.summary.severity === "high"`
  - dedupe key: `insight:${clip_id}`
  - alert text: `summary.one_liner`
- Added high-severity trigger path for Vision `detections.events[]` messages:
  - for each `event.severity === "high"`
  - dedupe key: `event:${event.name}:${event.track_id ?? "na"}`
  - alert text: `Alert: <event name>.` (+ optional track detail)
- Kept existing behavior intact:
  - `callAgentEventsIngest(...)` path is unchanged
  - insight relay suppression/dedupe/cooldown for raw insight forwarding remains unchanged
  - push alerts run as a separate path with their own cooldown/dedupe.

### Files changed
- `packages/eva/src/server.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- No dedicated automated runtime test exists yet; manual test steps included below.

### Manual run instructions
1. Start Vision + Eva + UI.
2. Trigger a high-severity insight (real flow or simulated Vision payload):
   - `{ "type":"insight", ..., "clip_id":"clip-high-1", "summary":{"severity":"high","one_liner":"Test high insight", ...} }`
3. Confirm UI receives immediate `text_output` with:
   - `session_id: "system-alerts"`
   - `meta.note: "Auto alert (push mode)."`
4. Trigger a detections payload with a high-severity event:
   - `{ "type":"detections", ..., "events":[{"name":"near_collision","severity":"high", ...}] }`
5. Confirm UI receives immediate `text_output` alert.
6. Re-send same clip/event rapidly and confirm dedupe/cooldown suppresses alert spam.

### Notes
- Iteration 99 intentionally sends text-only push alerts; `speech_output` synthesis/send is added in Iteration 100.

## Iteration 100 — Eva push-mode alerts speak immediately (`speech_output`)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Extended `pushHighSeverityAlertToClient(...)` in `packages/eva/src/server.ts`:
  1. sends `text_output` immediately (unchanged ordering)
  2. then, when `speech.enabled`, synthesizes and sends `speech_output`.
- Reused existing speech synthesis/cache plumbing via `resolveSpeechAudio(...)`:
  - uses existing in-flight dedupe and cache behavior
  - does **not** use HTTP speech cooldown gate (`tryEnterSpeechCooldown`) for push alerts.
- Added `speech_output` payload construction in Eva server:
  - `type: "speech_output"`
  - `mime: "audio/mpeg"`
  - `voice: speech.defaultVoice`
  - `rate: 1.0`
  - `audio_b64` from synthesized mp3 buffer (`Buffer -> base64`)
  - includes high-alert metadata (`trigger_kind`, `trigger_id`, `severity`).
- Preserved message ordering:
  - `text_output` is sent first
  - `speech_output` is sent when synthesis resolves.
- Added non-fatal error handling:
  - if synthesis fails, Eva logs warning (`push alert speech synthesis failed`) and keeps text alert delivery intact.

### Files changed
- `packages/eva/src/server.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva && npm run build`
- No dedicated automated runtime test exists yet; manual test steps included below.

### Manual run instructions
1. Start Vision + Eva + UI.
2. Trigger a high-severity alert source (high `insight` or high `detections.events[]`).
3. Confirm WS stream to UI now includes:
   - first: `text_output`
   - then: `speech_output` with non-empty `audio_b64`.
4. Temporarily break speech synthesis (for example, invalid TTS runtime dependency) and confirm:
   - text alert still arrives
   - Eva logs warning without crashing.

### Notes
- Iteration 100 only adds server-side `speech_output` emission; UI playback handling is implemented in Iteration 101.

## Iteration 101 — UI playback for `speech_output` (immediate alert audio)

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added compile/runtime handling for incoming `speech_output` WS messages in `packages/ui/src/main.tsx`.
- Added `isSpeechOutputMessage(...)` type guard and integrated it into WS `onMessage` flow.
- Added dedicated push-alert audio path (separate from existing chat speech client):
  - `alertAudioRef` with `new Audio()`
  - object URL lifecycle refs for alert audio source
  - playback helper `playSpeechOutputAlert(...)`
- Implemented `speech_output` playback flow:
  1. base64 decode (`audio_b64`) -> binary bytes
  2. create `Blob` with `audio/mpeg`
  3. create object URL and assign to alert audio element
  4. call `audio.play()` immediately
- Added autoplay policy handling for push-alert playback:
  - when play fails with `NotAllowedError`, sets existing `audioLocked` state to `true`
  - adds a helpful log message directing user to click **Enable Audio**.
- Added log lines for alert-audio outcomes:
  - successful playback
  - autoplay-blocked playback
  - decode/playback failures.
- Added object URL cleanup guardrails:
  - revokes previous alert audio URL before replacing
  - revokes active URL on component unmount to avoid leaks.
- Added log sanitization for inbound `speech_output` payloads:
  - `audio_b64` is summarized as length in logs instead of dumping full base64 data.

### Files changed
- `packages/ui/src/main.tsx`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/ui && npm run build`
- No dedicated automated runtime test exists yet; manual test steps included below.

### Manual run instructions
1. Start Vision + Eva + UI.
2. Open UI and click **Enable Audio** once.
3. Trigger a high-severity alert source so Eva emits `speech_output`.
4. Confirm UI plays alert audio immediately and logs playback success.
5. Reload tab without enabling audio, trigger another alert, and confirm:
  - playback is blocked by autoplay policy
  - UI logs the helpful unlock message
  - `audioLocked` shows as required.

### Notes
- Iteration 101 keeps existing `SpeechClient` chat auto-speak flow unchanged; push-alert audio is an isolated WS-driven playback path.

## Iteration 102 — Polish + docs + manual test checklist

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated protocol docs in `packages/protocol/README.md`:
  - added explicit `text_output` message documentation (shape + example)
  - updated `speech_output` section to include browser autoplay caveat and one-time audio unlock expectation.
- Added Eva push-alert behavior documentation in `packages/eva/README.md`:
  - new **Push alerts (high-severity)** section
  - documented high-severity triggers (`insight` + `detections.events[]`)
  - documented cooldown/dedupe guardrails
  - documented UI audio unlock requirement (**Enable Audio**).
- Added manual test checklist for push alerts (text + audio + guardrails) in this iteration entry.

### Files changed
- `packages/protocol/README.md`
- `packages/eva/README.md`
- `progress.md`

### Verification
- Build checks pass:
  - `cd packages/eva && npm run build`
  - `cd packages/ui && npm run build`
- No dedicated automated end-to-end push-alert test suite exists yet; manual checklist included below.

### Manual test checklist (Iteration 102)
1. ✅ High insight triggers alert + audio
   - Trigger high-severity `insight` and confirm UI receives `text_output` then `speech_output`, with immediate playback after audio unlock.
2. ✅ High detections.events triggers alert + audio
   - Trigger high-severity detector event and confirm same push flow + playback.
3. ✅ Cooldown prevents rapid spam
   - Re-trigger different high events within cooldown window and confirm push alerts are suppressed.
4. ✅ Dedupe prevents repeats for same clip/event key
   - Re-send same high insight clip/event key inside dedupe window and confirm suppression.

### Notes
- Iteration 102 is docs/polish only; runtime behavior remains as implemented in Iterations 99–101.

## Iteration 102 (follow-up) — Consistency sweep patch

**Status:** ✅ Completed (2026-02-21)

### Completed
- Protocol docs/schema consistency alignment:
  - `packages/protocol/README.md` now documents `text_output` and `speech_output` message types.
  - `packages/protocol/schema.json` now includes `text_output` in top-level `oneOf` with:
    - `$defs/text_output_meta`
    - `$defs/text_output`
- Updated stale iteration label in Eva docs:
  - `packages/eva/README.md`
  - `Current behavior (Iteration 53)` -> `Current behavior (Iteration 102)`.

### Files changed
- `packages/protocol/schema.json`
- `packages/eva/README.md`
- `progress.md`

### Verification
- Schema parse check passes:
  - `node -e "JSON.parse(fs.readFileSync('packages/protocol/schema.json','utf8'))"`
- Existing build status remains passing from Iteration 102 verification.

### Notes
- This follow-up is documentation/schema consistency only; runtime behavior is unchanged.

## Iteration 105 — Add Executive recent-insights retrieval utility

**Status:** ✅ Completed (2026-02-21)

### Completed
- Added new Executive memory-context utility module:
  - `packages/eva/executive/src/memcontext/retrieve_recent_insights.ts`
- Implemented `retrieveRecentInsights(...)`:
  - reads `working_memory.log` safely
  - filters to `type: "wm_insight"`
  - filters by inclusive time window (`sinceTsMs..untilTsMs`)
  - sorts chronologically (`ts_ms` ascending)
  - applies hard cap via `limit` (returns newest `limit` entries)
  - normalizes output into insight-oriented shape with:
    - `ts_ms`
    - `clip_id`
    - `trigger_frame_id`
    - `summary.{ one_liner, what_changed, severity, tags }`
    - optional `assets[]` when present
- Implemented `formatInsightsForPrompt(...)`:
  - compact, stable line formatting:
    - `[HH:MM:SS] (severity) one_liner`
    - `- what_changed ...`
  - supports hard caps for:
    - max insight items (`maxItems`, default 10)
    - max `what_changed` bullets per insight (`maxWhatChangedItems`, default 2)
    - max line length (`maxLineChars`, default 180)
  - adds `(+N more)` when extra `what_changed` items are truncated.

### Files changed
- `packages/eva/executive/src/memcontext/retrieve_recent_insights.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva/executive && npm run build`
- Manual utility smoke-check passes:
  - invoked `retrieveRecentInsights(...)` via `npx tsx --eval ...`
  - confirmed it returned recent `wm_insight` entries from `packages/eva/memory/working_memory.log`.

### Manual run instructions
1. Build Executive:
   - `cd packages/eva/executive`
   - `npm run build`
2. Run utility smoke-check:
   - `npx tsx --eval "import { retrieveRecentInsights, formatInsightsForPrompt } from './src/memcontext/retrieve_recent_insights.ts'; (async()=>{ const now=Date.now(); const insights=await retrieveRecentInsights({ logPath:'../memory/working_memory.log', sinceTsMs: now - 2*60*1000, untilTsMs: now, limit: 10 }); console.log('count', insights.length); console.log(formatInsightsForPrompt(insights)); })();"`

### Notes
- This iteration only adds insight retrieval/formatting utilities.
- `/respond` context wiring remains unchanged and is planned for Iteration 106.

## Iteration 106 — Switch `/respond` memory context builder to insights-only

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated Executive `/respond` memory-context assembly in:
  - `packages/eva/executive/src/server.ts`
- Removed live-event context injection from `/respond` memory block:
  - removed live `wm_event` query path (`readRecentWmEvents(...)`)
  - removed environment snapshot section
  - removed raw live-event fallback lines section
- Added insights-only context injection for `/respond`:
  - computes time window: `sinceTsMs = nowTsMs - 2 * 60 * 1000`
  - calls `retrieveRecentInsights({ sinceTsMs, untilTsMs: nowTsMs, limit: 10 })`
  - injects section header:
    - `Recent insights (last ~2 minutes):`
  - when no insights:
    - `- No insights were generated in the last ~2 minutes.`
  - when insights exist:
    - injects compact formatted lines from `formatInsightsForPrompt(...)`.
- Added respond constants in server:
  - `RESPOND_RECENT_INSIGHTS_WINDOW_MS`
  - `RESPOND_RECENT_INSIGHTS_MAX_ITEMS`

### Files changed
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva/executive && npm run build`
- Manual smoke checks pass:
  1. `/respond` request context now contains `Recent insights (last ~2 minutes):`.
  2. legacy sections are absent from request context:
     - no `Environment snapshot (derived from live events in the last ~2 minutes):`
     - no `Live event raw lines (debug fallback):`
  3. seeded a fresh `wm_insight` entry and called `/respond "what did you see"`:
     - request context included the seeded insight one-liner + what-changed bullets
     - assistant reply referenced that insight content.

### Manual run instructions
1. Build Executive:
   - `cd packages/eva/executive`
   - `npm run build`
2. Start Executive:
   - `npm run dev`
3. Trigger or seed a recent `wm_insight` in `packages/eva/memory/working_memory.log`.
4. Send chat request:
   - `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"what did you see"}'`
5. Confirm (via LLM trace request context/logs) the memory block is insight-only and contains no event snapshot/raw lines.

### Notes
- Other memory layers (short-term, long-term, core caches) remain unchanged in this iteration.
- Prompt nudge for insight-first phrasing is next in Iteration 107.

## Iteration 107 — Insight-first respond nudge + manual checklist

**Status:** ✅ Completed (2026-02-21)

### Completed
- Updated respond system prompt guidance in:
  - `packages/eva/executive/src/prompts/respond.ts`
- Added explicit insight-first instruction near memory-usage guidance:
  - when recent insights are present and user asks about recent activity (for example “what did you see” / “what happened”), summarize insights first.
- Added explicit detector-events omission rule:
  - in this mode, raw detector events are omitted and should not be summarized.
- Added manual test checklist to Executive docs:
  - `packages/eva/executive/README.md`
  - includes Test A/B/C for no-insight, single-insight, and multi-insight scenarios.
- Updated README `/respond` behavior bullet to reflect insight-first recent context source (`wm_insight` last ~2 minutes).

### Files changed
- `packages/eva/executive/src/prompts/respond.ts`
- `packages/eva/executive/README.md`
- `progress.md`

### Verification
- Build check passes:
  - `cd packages/eva/executive && npm run build`
- Manual tests executed:
  1. **Test A (no recent insights):** `/respond "what did you see"` returned a no-new-activity style answer with no fabricated activity.
  2. **Test B (one recent insight):** seeded one fresh `wm_insight`; `/respond "what did you see"` referenced that one-liner and key change details.
  3. **Test C (multiple recent insights):** seeded multiple fresh `wm_insight` entries; `/respond "what happened"` summarized multiple insights compactly.
- Request-context trace checks (LLM logs) confirmed:
  - `Recent insights (last ~2 minutes):` section present
  - expected seeded insight lines present for Test B/C.

### Manual run instructions
1. Build and run Executive:
   - `cd packages/eva/executive`
   - `npm run build`
   - `npm run dev`
2. Execute the README checklist under:
   - `## Iteration 107 manual checklist (insight-first /respond)`
3. For trace-level validation, inspect:
   - `packages/eva/llm_logs/openai-requests.log`
   - confirm respond request context contains the insight-first section.

### Notes
- This iteration changes prompt behavior and docs only; `/respond` context wiring remains as implemented in Iteration 106.

## Iteration 108 — Remove user-text wrapper (send raw user message as the user turn)

**Status:** ✅ Completed (2026-02-22)

### Completed
- Updated `/respond` user-prompt construction in:
  - `packages/eva/executive/src/prompts/respond.ts`
- Removed wrapper/instruction-style user payload assembly.
  - before: multi-line wrapper (`Generate a direct response...`, `session_id: ...`, `user_text: ...`)
  - after: returns raw `input.text` only.
- Simplified prompt input type by removing unused `sessionId` from `RespondPromptInput`.
- Updated `/respond` call site in:
  - `packages/eva/executive/src/server.ts`
  - now passes only `text: request.text` into `buildRespondUserPrompt(...)`.

### Files changed
- `packages/eva/executive/src/prompts/respond.ts`
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build + typecheck pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/executive && npm run typecheck`
- Prompt helper smoke check passes:
  - `cd packages/eva/executive && npx tsx --eval "import { buildRespondUserPrompt } from './src/prompts/respond.ts'; console.log(buildRespondUserPrompt({ text: 'what just happened' }));"`
  - output: `what just happened`
- Source sanity checks pass:
  - no remaining prompt wrapper string matches for:
    - `Generate a direct response for the user message`
    - `user_text:` in `prompts/respond.ts`

### Manual run instructions
1. Start Executive and UI stack as usual.
2. Send `/respond` input: `what just happened`.
3. Inspect request trace logs (`packages/eva/llm_logs/openai-requests.log`) and confirm user message content is exactly:
   - `what just happened`
   - with no wrapper lines (`Generate a direct response...`, `session_id:`, `user_text:`).

### Notes
- This iteration intentionally keeps system prompt/tool constraints unchanged; style rubric changes are planned for Iteration 109.

## Iteration 109 — Remove incident-report rubric + add spoken-style defaults/examples

**Status:** ✅ Completed (2026-02-22)

### Completed
- Removed the report-style behavior rule from EVA base persona in:
  - `packages/eva/memory/persona.md`
- Replaced it with a compact spoken-style default rule:
  - default 1-2 short conversational sentences
  - only expand into detailed breakdown when user asks for details or risk is genuinely high.
- Updated `/respond` system prompt template in:
  - `packages/eva/executive/src/prompts/respond.ts`
- Added explicit chat style guidance section:
  - `Response style defaults:`
  - spoken/casual short-reply default + detail expansion condition
- Added two few-shot style examples in system prompt:
  - user: `what just happened` -> concise conversational summary
  - user: `give me details` -> structured detail mode allowed
- Kept the existing rule unchanged:
  - never include internal IDs/telemetry/system internals in spoken output (via persona guidance).

### Files changed
- `packages/eva/memory/persona.md`
- `packages/eva/executive/src/prompts/respond.ts`
- `progress.md`

### Verification
- Build + typecheck pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/executive && npm run typecheck`
- Prompt template smoke check passes:
  - `cd packages/eva/executive && npx tsx --eval "import { buildRespondSystemPrompt } from './src/prompts/respond.ts'; const p=buildRespondSystemPrompt({ persona:'persona', allowedConcepts:['chat'], maxConcepts:6, currentTone:'neutral', toneSessionKey:'s', allowedTones:['neutral'] as const, memoryContext:'none' }); console.log(p.includes('Describe what changed, why it matters, and what to do next.')); console.log(p.includes('Response style defaults:')); console.log(p.includes('Style examples:'));"`
  - output:
    - `false`
    - `true`
    - `true`

### Manual run instructions
1. Start Executive/UI stack as usual.
2. Ask: `what just happened`.
3. Confirm response is conversational and does not default to report framing (e.g., avoid opening with `Recently, there was...`).
4. Ask: `give me details`.
5. Confirm a more structured breakdown is allowed in that mode.

### Notes
- Tool-call contract is unchanged: model must still call `commit_text_response` exactly once.
- Recent-insight memory shaping is unchanged in this iteration and is scheduled for Iteration 110.

## Iteration 109 (follow-up patch) — /respond no-tool-call hardening + prompt example clarification

**Status:** ✅ Completed (2026-02-22)

### Why this patch
- During manual runtime usage after Iteration 109, `/respond` intermittently returned HTTP 502 (`MODEL_NO_TOOL_CALL`).
- LLM traces showed occasional plain-text assistant output (`type: "text"`, `stopReason: "stop"`) instead of a `commit_text_response` tool call.

### Completed
- Updated style example wording in:
  - `packages/eva/executive/src/prompts/respond.ts`
- Reframed examples to describe the desired **tool `text` field value** instead of `Assistant: ...` plain-output examples.
- Added explicit reminder line in prompt examples:
  - still call `commit_text_response` exactly once.
- Added runtime fallback hardening in:
  - `packages/eva/executive/src/server.ts`
- New behavior when model omits required tool call but returns plain text blocks:
  - extract text from assistant `content[]` (`type: "text"` blocks)
  - synthesize a valid `RespondPayload` with safe fallback metadata
  - sanitize and return response instead of throwing 502.
- Preserved strict error behavior when neither tool call nor usable text content is present.

### Files changed
- `packages/eva/executive/src/prompts/respond.ts`
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build + typecheck pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/executive && npm run typecheck`
- Prompt smoke check passes:
  - confirms old `Assistant: ...` example text is absent
  - confirms new `text`-value wording is present.

### Manual run instructions
1. Restart/reload Executive.
2. Send `/respond` requests such as:
   - `what is happening`
   - `what just happened`
3. If model returns plain text instead of tool call, confirm request no longer fails with 502 and still returns a user-facing response.
4. Inspect logs for fallback warning line:
   - `respond model returned plain text without commit_text_response; using extracted text fallback...`

### Notes
- This follow-up is a stability hardening patch; it does not change memory-context formatting (still planned for Iteration 110).

## Iteration 110 — Humanize injected recent-observations context (keep raw severity/timestamps in debug logs)

**Status:** ✅ Completed (2026-02-22)

### Completed
- Updated recent-insight prompt formatting utilities in:
  - `packages/eva/executive/src/memcontext/retrieve_recent_insights.ts`
- Changed model-facing formatter (`formatInsightsForPrompt`) from report-style lines to human-shaped bullets:
  - before: `[HH:MM:SS] (severity) one_liner`
  - after: `- one_liner` + `- what_changed ...` (no timestamp/severity labels)
- Added new debug formatter (`formatInsightsForDebug`) that preserves prior structured format with:
  - timestamps
  - severity labels
  - `(+N more)` truncation marker
- Updated `/respond` memory-context assembly in:
  - `packages/eva/executive/src/server.ts`
- Replaced injected heading and empty-state phrasing:
  - before: `Recent insights (last ~2 minutes):`
  - after: `Recent observations:`
- Added debug-only raw recent-insight lines to request trace payload (not in model prompt):
  - `payload.memory_debug.recent_insights_count`
  - `payload.memory_debug.recent_insights_raw`
- Kept all other memory layers and retrieval logic unchanged.

### Files changed
- `packages/eva/executive/src/memcontext/retrieve_recent_insights.ts`
- `packages/eva/executive/src/server.ts`
- `progress.md`

### Verification
- Build + typecheck pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/executive && npm run typecheck`
- Formatter smoke check passes:
  - `cd packages/eva/executive && npx tsx --eval 'import { formatInsightsForPrompt, formatInsightsForDebug } from "./src/memcontext/retrieve_recent_insights.ts"; const sample=[{ ts_ms: Date.now(), clip_id:"c", trigger_frame_id:"f", summary:{ one_liner:"Someone looked tense and adjusted their hood.", what_changed:["They stayed mostly still, then fidgeted briefly."], severity:"medium", tags:["person"] } }]; const promptText=formatInsightsForPrompt(sample); const debugText=formatInsightsForDebug(sample); console.log(promptText); console.log("HAS_DEBUG_PATTERN_IN_PROMPT", /\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \((low|medium|high)\)/.test(promptText)); console.log("HAS_DEBUG_PATTERN_IN_DEBUG", /\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \((low|medium|high)\)/.test(debugText));'`
  - output confirms:
    - prompt formatter has no `[HH:MM:SS] (severity)` pattern
    - debug formatter retains `[HH:MM:SS] (severity)` pattern

### Manual run instructions
1. Restart/reload Executive.
2. Send `/respond` prompts like:
   - `what just happened`
   - `what is happening`
3. Inspect `packages/eva/llm_logs/openai-requests.log` and confirm model request context now includes:
   - `Recent observations:`
   - bullet-only humanized lines (no timestamp/severity labels).
4. In the same request trace payload, confirm `memory_debug.recent_insights_raw` still contains structured `[HH:MM:SS] (severity)` lines for debugging.

### Notes
- This iteration changes context shaping only; tool-call contract (`commit_text_response` exactly once) remains unchanged.

## Iteration 111 — Add prompt-regression checks + smoke checklist

**Status:** ✅ Completed (2026-02-22)

### Completed
- Added a minimal regression-check script in:
  - `packages/eva/executive/scripts/check-respond-prompt-regressions.ts`
- Added package script entry in:
  - `packages/eva/executive/package.json`
  - new command: `npm run check:respond-prompt`
- Implemented automated checks for `/respond` prompt behavior:
  1. Asserts user prompt equals raw `user_text` exactly.
  2. Asserts old wrapper text is absent from user prompt:
     - `Generate a direct response for the user message`
     - `user_text:`
  3. Asserts system prompt does **not** contain removed report rubric:
     - `Describe what changed, why it matters, and what to do next.`
  4. Asserts prompt-formatted recent observations do **not** include report-style timestamp/severity pattern:
     - `[HH:MM:SS] (severity)`
- Added smoke checklist for conversational behavior (below).

### Files changed
- `packages/eva/executive/scripts/check-respond-prompt-regressions.ts`
- `packages/eva/executive/package.json`
- `progress.md`

### Verification
- Build + typecheck + regression-check script all pass:
  - `cd packages/eva/executive && npm run build`
  - `cd packages/eva/executive && npm run typecheck`
  - `cd packages/eva/executive && npm run check:respond-prompt`
- Script output:
  - `PASS: respond prompt regression checks`

### Smoke checklist (Iteration 111)
1. `what just happened`
   - expected: 1-2 casual spoken sentences (no report framing by default).
2. `give me details`
   - expected: structured breakdown is allowed (bullets OK when asked).
3. High-severity activity present
   - expected: concise response that mentions safety/urgency first.

### Notes
- This iteration adds a lightweight automated guard and smoke checklist to reduce regressions in style/prompt assembly behavior.
