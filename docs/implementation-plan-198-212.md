````md
# docs/implementation-plan-198-212.md — Audio Input (WS `/audio`) + Audio Runtime (VAD + Wake + Voice Lock + Local Whisper) + Vision Presence Events (Working Memory)

Implement in **SMALL ITERATIONS** so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration.

Each iteration must end with:
- build/typecheck passing (or explicit manual test steps included)
- short change summary + files changed
- clear run instructions
- update `docs/progress.md` (create it if missing)
- STOP after each iteration for review

---

## ASSUMPTION (CURRENT BASELINE)

Current working stack (verified in repo):
- UI streams `frame_binary` to Eva WS `/eye`
- Eva forwards frames to Vision WS `/infer`
- Vision forwards `scene_caption` events to Executive `POST /events` (working memory ingest)
- UI chat → Eva HTTP `/text` → Executive `POST /respond`
- TTS works via Eva HTTP `/speech`

Notes:
- Executive service lives in `packages/eva/executive`, but Eva TS config calls it `agent` (baseUrl points to `http://127.0.0.1:8791`) in `eva.config.json`.

Audio goal: add **speech-to-text input** without disturbing vision pipeline.

---

## GOAL (END STATE)

- Browser mic audio streams to Eva **WS `/audio`**
- Eva forwards audio frames to **Audio Runtime** (Python, WS-first)
- Audio Runtime:
  1) VAD segments utterances
  2) Gating (exact behavior):
     - If utterance has wake word **“Eva”** → ACCEPT regardless of camera
     - Else → ACCEPT only if a **fresh `presence_update`** exists in working memory within `presence_window_ms` AND indicates `in_view && facing`
  3) Conversation ACTIVE state + timeout
  4) Speaker lock-on in ACTIVE mode (voice embedding) to ignore other voices
  5) Local Whisper STT transcribes accepted utterances
- Audio Runtime sends `speech_transcript` to Eva
- Eva calls Executive `/respond` and pushes `text_output` to UI

---

## DESIGN RULES (LOCKED)

1) Audio is NOT processed in browser (no Whisper/VAD/voiceprints in UI).
2) Audio uses its own WS endpoint `/audio` (separate from `/eye`).
3) Reuse existing agent flow:
   - transcript → Executive `/respond` → `text_output`
4) Transport: PCM16 mono @ 16kHz, 20ms frames.
5) Minimal protocol churn, but complete:
   - Add audio envelope + ack + transcript message schemas so TS stays type-safe.
6) Presence gating uses working memory as source of truth:
   - Vision emits `presence_update` to Executive `/events` → stored as `wm_event` in `working_memory.log`.
   - Audio Runtime gates by querying Executive for “presence within window”.
7) Presence telemetry must NOT bloat LLM context:
   - Executive must exclude `wm_event` where `name === "presence_update"` from `/respond` replay.
8) PyTorch alignment:
   - If Audio Runtime installs torch/torchaudio for speaker embeddings, pin to Vision ranges:
     - `torch>=2.6,<2.7`
     - `torchaudio>=2.6,<2.7`
     - (only if needed) `torchvision>=0.21,<0.22`
9) Clock domain:
   - Presence freshness uses **server-side timestamps** (Vision/Executive clocks).
   - Audio gating uses Executive’s `/presence` response (`age_ms`) and does NOT rely on browser `ts_ms` for correctness.

---

## THIRD-PARTY TOOLS (SPECIFIC, FULLY FUNCTIONAL)

### Wake word (REAL keyword spotter)
Default: **Picovoice Porcupine**
- Python package: `pvporcupine>=3.0,<4.0`
- Requires:
  - AccessKey (secret; `settings.local.yaml` or env)
  - Keyword file for “Eva” (`.ppn`) from Picovoice Console
- Implementation includes a PCM buffering adapter to match `porcupine.frame_length`.

### VAD
- Python package: `webrtcvad>=2.0,<3.0`
- 20ms frames @ 16kHz PCM16

### STT (Local Whisper)
- Python package: `faster-whisper>=1.0,<2.0`
- Default model: `small.en`
- Defaults: `device=cpu`, `compute_type=int8`
- Cache dir: `packages/eva/memory/models/whisper`

### Speaker embedding (voice lock)
- Python package: `speechbrain>=1.0,<2.0`
- Model: `speechbrain/spkrec-ecapa-voxceleb`
- Requires torch/torchaudio pinned to Vision ranges

### Vision presence v1 (conservative and real)
- Python package: `opencv-python-headless>=4.10,<5.0`
- v1 definition (explicit):
  - `in_view = face_detected`
  - `facing = face_detected` (face visible proxy; not head pose yet)

---

# ITERATIONS (START AT 198)

## Iteration 198 — Eva: add `/audio` WS endpoint path + upgrade routing (no audio runtime yet)

Goal:
- Eva accepts WebSocket connections at `/audio`, separate from `/eye`.

Deliverables:
1) Config schema + file:
- `packages/eva/src/config.ts`
  - add `server.audioPath` default `/audio`
- `packages/eva/eva.config.json`
  - add `"audioPath": "/audio"` under `server`

2) Server routing:
- `packages/eva/src/server.ts`
  - current `server.on('upgrade', ...)` rejects everything except `eyePath`.
  - modify to route:
    - if pathname === `eyePath` → existing UI WS server
    - else if pathname === `audioPath` → NEW audio WS server
    - else reject
  - create a second `WebSocketServer({ noServer:true })` for audio:
    - `wssEye` (existing) + `wssAudio` (new)
  - enforce single audio WS client separately:
    - `activeUiClient` remains for /eye
    - add `activeAudioClient` for /audio

Acceptance:
- `cd packages/eva && npm run build`
- Manual:
  - connect `ws://localhost:8787/audio` → receive `hello`

Stop; update `docs/progress.md`.

---

## Iteration 199 — Protocol: add `audio_binary`, `audio_received`, `speech_transcript`, and `hello.role=audio`

Goal:
- Make audio transport + transcript message types real and type-safe across repo.

Deliverables:
1) Canonical protocol docs/schema:
- `packages/protocol/schema.json`
  - add `$defs/audio_binary_meta`
  - add `$defs/audio_received`
  - add `$defs/speech_transcript`
  - update `$defs/hello.role` to allow `"audio"`
- `packages/protocol/README.md`
  - document binary `audio_binary` envelope (same framing as frame_binary)
  - document `audio_received`
  - document `speech_transcript`

2) Eva TypeScript protocol:
- `packages/eva/src/protocol.ts`
  - add `AudioBinaryMetaSchema`
  - add `AudioReceivedMessageSchema` + `makeAudioReceived(...)`
  - add `SpeechTranscriptMessageSchema`
  - update `HelloMessageSchema.role` to include `audio`
  - add `decodeBinaryAudioEnvelope(...)` mirroring `decodeBinaryFrameEnvelope(...)`

3) UI protocol types:
- `packages/ui/src/types.ts`
  - add `AudioBinaryMeta`, `AudioReceivedMessage`
  - update `HelloMessage.role` union to include `audio`
  - (UI does not need `speech_transcript` unless you want it to display; keep it out of UI if desired.)

Envelope meta shape:
```json
{
  "type": "audio_binary",
  "v": 2,
  "chunk_id": "uuid",
  "ts_ms": 1700000000000,
  "mime": "audio/pcm_s16le",
  "sample_rate_hz": 16000,
  "channels": 1,
  "audio_bytes": 640
}
````

ACK shape:

```json
{
  "type": "audio_received",
  "v": 2,
  "chunk_id": "uuid",
  "ts_ms": 1700000000001,
  "accepted": true,
  "queue_depth": 0,
  "dropped": 0
}
```

Transcript shape:

```json
{
  "type": "speech_transcript",
  "v": 2,
  "ts_ms": 1700000000000,
  "text": "…",
  "confidence": 0.8
}
```

Acceptance:

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`

Stop; update `docs/progress.md`.

---

## Iteration 200 — Eva: accept `audio_binary` on `/audio` and emit sampled `audio_received` ACK

Goal:

* Eva parses audio frames and returns ACKs without affecting /eye.

Deliverables:

* `packages/eva/src/server.ts` (wssAudio connection handler):

  * on binary:

    * decode audio envelope (`decodeBinaryAudioEnvelope`)
    * update counters: received, dropped
    * send `audio_received` ACK:

      * ACK first frame immediately
      * then sample (every N frames, default N=10)
    * no forwarding yet
  * on JSON text: ignore for now
  * enforce single client: if `activeAudioClient` already connected, reject with error.

Clarify ACK semantics:

* `accepted=true` means Eva successfully decoded the frame (and, later, forwarded to Audio Runtime when enabled).
* `queue_depth` is `0` in this iteration (no queue yet).
* `dropped` increments if Eva rejects due to decode failure or missing runtime later (when forwarding exists).

Acceptance:

* `cd packages/eva && npm run build`
* Manual:

  * connect /audio
  * send one valid `audio_binary` → see `audio_received`

Stop; update `docs/progress.md`.

---

## Iteration 201 — UI: mic capture + `/audio` WS client + audio envelope encoder

Goal:

* Browser streams PCM frames to Eva `/audio`.

Deliverables:

1. UI runtime config:

* `packages/ui/public/config.json`

```json
"eva": {
  "wsUrl": "ws://localhost:8787/eye",
  "audioWsUrl": "ws://localhost:8787/audio"
},
"audioInput": {
  "enabled": true,
  "sampleRateHz": 16000,
  "frameMs": 20
}
```

2. Config parser:

* `packages/ui/src/config.ts`

  * extend `UiRuntimeConfig` to include `eva.audioWsUrl` and `audioInput`
  * validate types

3. Encoder:

* `packages/ui/src/audioBinary.ts` (mirror `frameBinary.ts`)

  * `encodeBinaryAudioEnvelope({ meta, audioBytes })`

4. Mic capture + streaming:

* `packages/ui/src/main.tsx`

  * open second `WebSocket` to `audioWsUrl`
  * capture mic via WebAudio:

    * `getUserMedia({ audio:true })`
    * `AudioContext` + `ScriptProcessorNode` or `AudioWorklet` (pick one; prefer AudioWorklet if you’re willing to add 1 extra file)
    * downsample to 16k, convert float32→PCM16
    * send 20ms frames as `audio_binary`
  * log sampled ACKs (`audio_received`) to confirm flow

Acceptance:

* `cd packages/ui && npm run build`
* Manual:

  * enable mic → see `audio_received` counters/logs change

Stop; update `docs/progress.md`.

---

## Iteration 202 — Audio Runtime: WS-first skeleton (`/listen`) + run entrypoint mirroring Vision

Goal:

* New Python service exists, boots cleanly in subprocess mode.

Deliverables:

* New folder: `packages/eva/audio/`

  * `app/main.py`:

    * `GET /health`
    * `WS /listen`: accept, send `hello(role="audio")`, log received frames
  * `app/run.py`: mirror Vision’s entrypoint style (uvicorn run)
  * `app/config.py`: dynaconf loader (settings.yaml + settings.local.yaml)
  * `app/protocol.py`: decode `audio_binary` envelope (same 4-byte length prefix framing)
  * `requirements.txt` (base):

    * `fastapi>=0.115,<1.0`
    * `uvicorn[standard]>=0.32,<1.0`
    * `dynaconf>=3.2,<4.0`
    * `numpy>=1.26,<3.0`
    * `httpx>=0.27,<1.0`

Acceptance:

* `cd packages/eva/audio && python3 -m compileall app`
* Manual:

  * run `python -m app.run`
  * `GET /health` returns ok

Stop; update `docs/progress.md`.

---

## Iteration 203 — Eva ⇄ Audio Runtime WS client + forward audio frames

Goal:

* Eva forwards `/audio` binary frames to Audio Runtime `/listen`.

Deliverables:

1. Add audio client (mirror `visionClient.ts`):

* `packages/eva/src/audioClient.ts` (same reconnect behavior as Vision client)

2. Eva config:

* `packages/eva/src/config.ts`

  * add `audio.wsUrl` (default `ws://127.0.0.1:8793/listen`)
  * add `subprocesses.audio` (mirror `subprocesses.vision`)
* `packages/eva/eva.config.json`

  * add `audio.wsUrl`
  * add `subprocesses.audio` block:

    * cwd `packages/eva/audio`
    * command `['.venv/bin/python','-m','app.run']` (or whatever your venv path is)
    * health `http://127.0.0.1:8793/health`

3. Subprocess management:

* `packages/eva/src/index.ts`

  * start/stop audio subprocess just like agent/vision

4. Forwarding:

* `packages/eva/src/server.ts` (audio WS handler):

  * on `audio_binary`:

    * if audioClient connected: `audioClient.sendBinary(binaryPayload)`
    * else: mark dropped
  * emit sampled `audio_received` using accepted = (decoded && forwarded)

Acceptance:

* `cd packages/eva && npm run build`
* Manual:

  * start full stack
  * mic stream → Audio Runtime logs bytes arriving

Stop; update `docs/progress.md`.

---

## Iteration 204 — Audio Runtime: VAD utterance segmentation (`webrtcvad`) with explicit knobs

Goal:

* Continuous stream → discrete utterances.

Add deps:

* `webrtcvad>=2.0,<3.0`

Add config (settings.yaml):

* `vad.aggressiveness` (0–3, default 2)
* `vad.preroll_ms` (default 200)
* `vad.end_silence_ms` (default 400)
* `vad.min_utterance_ms` (default 300)

Deliverables:

* VAD state machine processes 20ms frames:

  * accumulate into buffer
  * start speech on consecutive voiced frames
  * end on consecutive unvoiced frames meeting end_silence_ms
  * build `utterance` bytes (PCM16 16k mono)
  * record `utterance_end_server_ts_ms = now_ms` (server time)

Acceptance:

* speak → utterance created (log start/end + duration)
* silence → no spam

Stop; update `docs/progress.md`.

---

## Iteration 205 — Audio Runtime: Porcupine wake-word detection with correct frame adapter

Goal:

* Wake word is real and reliable, no Whisper “string contains eva” hacks.

Add deps:

* `pvporcupine>=3.0,<4.0`

One-time assets:

* `packages/eva/audio/wakewords/eva.ppn` (gitignored)
* `settings.local.yaml` stores access key (gitignored) or use env `PV_ACCESS_KEY`

Config (settings.yaml):

* `wake.provider=porcupine`
* `wake.keyword_path=./wakewords/eva.ppn`
* `wake.sensitivity=0.6`
* `wake.access_key_env=PV_ACCESS_KEY` (or local file key)

Implementation detail (required):

* Porcupine requires frames of exactly `porcupine.frame_length` samples.
* Add adapter:

  * input: utterance PCM16 bytes
  * convert to int16 array
  * slide through in chunks of `frame_length` samples
  * `porcupine.process(chunk)`; if returns >=0 once → wake_detected=true

Acceptance:

* out of view/presence false:

  * “what time is it” → wake_detected=false
  * “Eva what time is it” → wake_detected=true

Stop; update `docs/progress.md`.

---

## Iteration 206 — Vision: emit `presence_update` events into working memory with emission policy (no spam)

Goal:

* Vision produces real presence events that are fresh enough for gating but not a telemetry flood.

Important: Presence is independent of caption attention; it should run whenever frames are received.

Add deps (vision):

* `opencv-python-headless>=4.10,<5.0`

Config additions:

* Update `packages/eva/vision/app/config.py` to add PresenceConfig to AppConfig (typed)
* Update `packages/eva/vision/settings.yaml` with:

  * `presence.enabled`
  * `presence.sample_every_ms` (compute cadence; default 200)
  * `presence.emit_every_ms` (keepalive while in_view; default 500)
  * `presence.emit_on_change` (default true)
  * `presence.emit_on_false_transition` (default true)

Emission policy (explicit):

* Maintain last emitted state `{in_view,facing}` and last emitted ts.
* Emit if:

  * state changed and `emit_on_change=true`, OR
  * `in_view==true` and (now - last_emit_ts) >= emit_every_ms, OR
  * transitioned to `in_view=false` and `emit_on_false_transition=true` (emit once)

Presence v1 definition (explicit):

* `in_view = face_detected`
* `facing = face_detected` (face visible proxy)

Implementation:

* `packages/eva/vision/app/presence.py`:

  * Haar cascade detect from decoded frame
* `packages/eva/vision/app/main.py`:

  * in binary frame handler (always, not attention-dependent):

    * every sample_every_ms compute presence
    * if emission policy says emit: call `executive_client.post_events(...)` with:

```json
{
  "name":"presence_update",
  "ts_ms": <server_now_ms>,
  "severity":"low",
  "data":{"in_view":true,"facing":true,"method":"opencv_haar_v1"}
}
```

NOTE (optional cleanup aligned with current code reality):

* Eva TS currently forwards `scene_caption` to `/events` too, while Vision already forwards it. This creates duplicates.
* Do NOT add `presence_update` forwarding in Eva TS. Presence forwarding should be Vision→Executive only.

Acceptance:

* Verify `working_memory.log` contains `wm_event` entries where `name === "presence_update"` (one stream, not duplicated).

Stop; update `docs/progress.md`.

---

## Iteration 207 — Executive: add `/presence` query + exclude presence_update from `/respond` replay

Goal:

* Audio Runtime can check presence freshness via Executive API.
* Presence events do not appear in LLM replay context.

Deliverables:

1. `packages/eva/executive/src/server.ts`

* Add `GET /presence?window_ms=1500`
* Implement as:

  * keep `latestPresence` updated only after successful `/events` append (presence_update only)
  * response:

    * if no presence or `age_ms > window_ms` → `{found:false, in_view:false, facing:false, age_ms:...}`
    * else → `{found:true, in_view, facing, ts_ms, age_ms}`
* This avoids scanning JSONL on every query.

2. `packages/eva/executive/src/memcontext/working_memory_replay.ts`

* Add filter before `records.push(...)`:

  * if record.type === 'wm_event' and record.name === 'presence_update' → skip
* This prevents LLM context spam.

Acceptance:

* `curl "http://127.0.0.1:8791/presence?window_ms=1500"` shows found=true while present and fresh
* `/respond` still works and does not replay presence telemetry

Stop; update `docs/progress.md`.

---

## Iteration 208 — Audio Runtime: apply gating rule (wake OR presence-window) + Local Whisper STT

Goal:

* Audio behaves exactly as spec: no STT unless accepted; wake bypass works; presence window works.

Add deps:

* `faster-whisper>=1.0,<2.0`

Config:

* `gating.presence_window_ms` (default 1500)
* `stt.model_id=small.en`, `device=cpu`, `compute_type=int8`

Gating semantics (explicit):

* Gate decision is made at **utterance end** using Executive’s `/presence` response.
* Audio does NOT rely on browser timestamps for gating correctness.

Implementation per utterance:

1. run wake detection (Porcupine) on utterance
2. if wake_detected → accept
3. else:

   * call `GET /presence?window_ms=...`
   * accept only if `found && in_view && facing`
4. if accepted:

   * run faster-whisper STT → build `speech_transcript` JSON
   * send to Eva over Eva⇄AudioRuntime WS
5. if rejected:

   * do nothing (no STT)

Acceptance:

* out of view:

  * “what time is it” → rejected (no Whisper run)
  * “Eva what time is it” → accepted → transcript produced
* in view + facing:

  * “what time is it” → accepted → transcript produced

Stop; update `docs/progress.md`.

---

## Iteration 209 — Eva: `speech_transcript` → Executive `/respond` → UI `text_output`

Goal:

* Speech becomes a normal chat turn.

Deliverables:

* `packages/eva/src/server.ts`

  * add audioClient message handler:

    * parse JSON `speech_transcript`
    * call existing `callAgentRespond(...)` path (same as /text handler)
    * forward resulting `text_output` to active UI client (/eye)

Optional:

* emit a UI-visible `wm_event` (or UI-only message) called `speech_input` is NOT required; keep minimal.

Acceptance:

* Speak (accepted) → assistant replies in UI chat

Stop; update `docs/progress.md`.

---

## Iteration 210 — Audio Runtime: Conversation ACTIVE state machine + timeout

Goal:

* After wake/engage, user can keep talking without repeating “Eva”.

Rules (explicit):

* Enter ACTIVE when any utterance is accepted (wake or presence gate).
* While ACTIVE:

  * accept utterances without wake word AND without presence gate
  * extend active timeout on each accepted utterance
* Exit ACTIVE when `now_ms > active_until_ms`

Config:

* `conversation.active_timeout_ms` default 25000

Acceptance:

* Wake once → talk multiple turns → pause > timeout → requires wake/presence again

Stop; update `docs/progress.md`.

---

## Iteration 211 — Audio Runtime: Speaker lock-on in ACTIVE mode (SpeechBrain ECAPA; torch pinned)

Goal:

* Once engaged, ignore other voices during ACTIVE.

Add deps (audio requirements.txt):

* `speechbrain>=1.0,<2.0`
* `torch>=2.6,<2.7`
* `torchaudio>=2.6,<2.7`

Embedding details (explicit):

* Convert PCM16 → float32 in [-1,1]
* For embeddings:

  * use first `min(2000ms, utterance_duration)` of voiced audio (or whole utterance if shorter)
  * if utterance < 500ms, skip embedding check (treat as uncertain; require wake again or ignore depending on your preference—pick one and document)

Similarity:

* cosine similarity >= `speaker.similarity_threshold` (default 0.75)

Acceptance:

* Start convo → friend speaks → rejected → you speak → accepted

Stop; update `docs/progress.md`.

---

## Iteration 212 — Persist voiceprints only on intentional engagement

Goal:

* Voiceprints saved only on intentional engagement (wake or presence-gated ACTIVE entry), not ambient audio.

Deliverables:

* `voiceprints.dir=../memory/voiceprints`
* Persist:

  * embedding vector
  * createdAt, lastSeen, sampleCount
* Update with EMA blend:

  * `new = alpha*current + (1-alpha)*old`
* Load on startup:

  * so recognition survives restart

Acceptance:

* Restart stack → voice still recognized when ACTIVE

Stop; update `docs/progress.md`.
