# docs/implementation-plan-161-170.md

Implement the system below in **SMALL ITERATIONS** so diffs stay small and reviewable. Do **NOT** do big refactors. Do **NOT** “get ahead” of the current iteration. Each iteration must end with:

* build/typecheck passing (or explicit “no tests yet; manual test steps included”)
* short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review/feedback
* keep progress in `progress.md`

## Background

Today the UI is *transactional*: it sends a frame and waits for `frame_events(frame_id)` to clear the in-flight slot. That makes stream throughput equal to “how fast Vision responds.” That’s the coupling we’re removing.

**New architecture goal:** make the stream “continuous” by ACKing **receipt** immediately in Eva, and letting Vision + Tier-1 Captioner publish updates asynchronously.

## Design overview

### New message type: `frame_received` (Eva → UI)

A receipt ACK, not a processing ACK.

```json
{
  "type": "frame_received",
  "v": 2,
  "frame_id": "uuid",
  "ts_ms": 1700000000000,
  "accepted": true,
  "queue_depth": 12,
  "dropped": 0
}
```

* `accepted=false` when Eva drops the frame (buffer full, size limit, etc).
* UI uses this to clear in-flight quickly and avoid timeouts.
* Vision `frame_events` remains the carrier for overlays + detector events.

### Broker rules (Eva)

* Maintain a bounded **ring buffer** of recent frames (count + age; optional max bytes).
* Forward frames to Vision *best-effort* (sampling allowed).
* Run Tier-1 captioning **latest-wins**, triggered by:

  * Vision `scene_change` events (preferred), and/or
  * periodic heartbeat while streaming (fallback), and/or
  * “Vision unavailable” fallback triggers.

### Tier-1 output format

Emit a single human-friendly event:

```json
{
  "name": "scene_caption",
  "ts_ms": 1700000000000,
  "severity": "low",
  "data": {
    "text": "A person sitting at a desk with a laptop.",
    "model": "Salesforce/blip-image-captioning-base",
    "latency_ms": 820
  }
}
```

**Persistence rule:** only `scene_caption` should be forwarded to Executive `/events`. Raw `scene_change` stays UI-visible (overlay) but is not persisted to working memory (to avoid telemetry spam).

---

# Implementation Iterations — Start at 161

## Iteration 161 — Protocol + runtime plumbing for `frame_received` (no UI behavior change)

**Goal**

* Add the new message type end-to-end, but UI still ACKs frames on `frame_events` for one iteration.

**Deliverables**

1. **Protocol docs/schema**

   * `packages/protocol/schema.json`: add `frame_received` definition + include in top-level union
   * `packages/protocol/README.md`: document semantics and example
2. **Eva protocol typing**

   * `packages/eva/src/protocol.ts`: add `FrameReceivedMessageSchema` (Eva→UI only; *do not* add to Vision inbound union)
3. **UI protocol typing**

   * `packages/ui/src/types.ts`: add `FrameReceivedMessage` + include in `ProtocolMessage` union
4. **Eva emits receipt**

   * `packages/eva/src/server.ts`: on binary frame receipt (after envelope decode succeeds), send `frame_received` immediately.
   * If Vision is disconnected, still emit `frame_received` (accepted=true if broker accepts; do not hard-fail).

**Acceptance**

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual: stream frames; logs show `frame_received` arriving; stream behavior unchanged (still waits for `frame_events` to clear in-flight).

Stop; update `progress.md`.

---

## Iteration 162 — UI switches ACK to `frame_received` (decouple stream from Vision)

**Goal**

* Clear in-flight on `frame_received`, not on `frame_events`.

**Deliverables**

1. `packages/ui/src/main.tsx`

   * Add `isFrameReceivedMessage(...)`
   * Change in-flight clearing to happen when:

     * `frame_received.frame_id === inFlight.frameId`
   * Update UI stat labels/log text from “ack latency” → “receipt latency” (optional but recommended for clarity).
2. Handle `accepted=false`:

   * Increment a new counter: `framesDroppedByBroker` (or reuse timedOut but better as separate).
   * Do not treat `accepted=false` as a timeout.

**Acceptance**

* Streaming works even if Vision is stopped:

  * no more 500ms timeouts storms
  * receipt count increments
* Vision events still appear when Vision is running.

Stop; update `progress.md`.

---

## Iteration 163 — Eva adds a bounded frame broker (ring buffer + drop policy)

**Goal**

* Eva can accept frames at UI speed without unbounded memory growth.

**Deliverables**

1. New module:

   * `packages/eva/src/broker/frameBroker.ts`
   * Keep it simple:

     * internal deque of `{ frame_id, ts_ms, width, height, jpegBytes, receivedAtMs }`
     * eviction:

       * evict anything older than `maxAgeMs`
       * evict oldest until `<= maxFrames`
       * (optional) enforce `maxBytes`
2. Config

   * `packages/eva/src/config.ts` + `packages/eva/eva.config.json`:

     ```json
     "stream": {
       "broker": { "enabled": true, "maxFrames": 200, "maxAgeMs": 15000, "maxBytes": 0 }
     }
     ```

     * `maxBytes: 0` means disabled for now (keeps first pass simple).
3. Eva runtime

   * On binary frame ingress:

     * push into broker
     * set `accepted` based on push result
     * emit `frame_received` with `queue_depth` and `dropped`
     * if not accepted: skip Vision forwarding for that frame

**Acceptance**

* With a tiny `maxFrames` (e.g., 5), you can observe `accepted=false` and stable behavior (no crash, no runaway RAM).
* Builds pass.

Stop; update `progress.md`.

---

## Iteration 164 — Vision forwarding becomes best-effort (sampling + routing rules)

**Goal**

* Vision processing no longer controls stream cadence.
* Reduce Vision load via sampling.

**Deliverables**

1. Config:

   ```json
   "stream": {
     "visionForward": { "enabled": true, "sampleEveryN": 2 }
   }
   ```
2. Eva server:

   * Only forward frames to Vision when:

     * broker accepted the frame
     * `visionForward.enabled`
     * `(forwardCounter % sampleEveryN === 0)`
3. Routing correctness

   * If you continue to use `FrameRouter.take(frame_id)`:

     * Only call `frameRouter.set(frame_id, ws)` for frames you actually forwarded
     * Otherwise Vision replies will be dropped (expected)
   * Alternative (optional, but clean for single-client):

     * stop using `FrameRouter.take` for `frame_events` and just `sendJson(activeUiClient, message)` since only one UI client can connect anyway.

**Acceptance**

* With `sampleEveryN=2`, overlays/events still appear (less frequently), stream stays smooth.
* No “no route for frame_id … dropping Vision response” spam for forwarded frames.

Stop; update `progress.md`.

---

## Iteration 165 — Add `packages/eva/captioner` service skeleton (deterministic)

**Goal**

* Create the Tier-1 service container without ML complexity.

**Deliverables**

1. New package:

   * `packages/eva/captioner/app/main.py`, `app/run.py`, `app/settings.py`
   * `settings.yaml`, `requirements.txt`, `README.md`
2. Endpoints:

   * `GET /health`
   * `POST /caption`

     * accepts `Content-Type: image/jpeg`
     * returns deterministic payload:
       `{ "text": "caption-stub", "latency_ms": 1, "model": "stub" }`
3. Guardrails:

   * max body bytes (match your other services’ pattern)
   * clear errors on wrong content-type

**Acceptance**

* `cd packages/eva/captioner && python3 -m compileall app`
* Manual curl to `/caption` works with a jpeg file.

Stop; update `progress.md`.

---

## Iteration 166 — Captioner: real GPU caption model + tuned defaults for ~1s

**Goal**

* Turn `/caption` into a real fast captioner.

**Default model recommendation for Tier-1**

* `Salesforce/blip-image-captioning-base` (caption-first, predictable, fast-ish; good Tier-1 behavior)

**Deliverables**

1. Dependencies in `requirements.txt`:

   * torch + torchvision (CUDA if available), transformers, pillow
2. Startup:

   * load model + processor once
   * select device (`cuda` preferred if available)
3. Inference:

   * resize to `max_dim` (default 384)
   * keep output short (`max_new_tokens` or equivalent)
   * return timing + model id
4. Config (`settings.yaml`):

   ```yaml
   caption:
     enabled: true
     model_id: Salesforce/blip-image-captioning-base
     device: cuda
     max_dim: 384
     max_new_tokens: 24
   ```

**Acceptance**

* On your GTX 1080: repeated calls are stable and typically near your target on a 384px input (exact ms varies, but should be “fast enough to be a reflex”).
* No GPU memory growth across repeated calls.

Stop; update `progress.md`.

---

## Iteration 167 — Eva integrates Tier-1 captions (latest-wins + trigger policy + persistence)

**Goal**

* Captions show up as human-friendly events quickly, before deep insight.
* Captions are persisted to working memory via Executive `/events`.

**Deliverables**

1. Eva config:

   ```json
   "caption": {
     "enabled": true,
     "baseUrl": "http://127.0.0.1:8792",
     "timeoutMs": 1500,
     "cooldownMs": 2000,
     "periodicMs": 8000,
     "dedupeWindowMs": 15000,
     "minSceneSeverity": "medium"
   }
   ```
2. Eva scheduling policy (in `packages/eva/src/server.ts`):

   * latest-wins queue:

     * `inFlightCaption: Promise | null`
     * `pendingCaptionFrameId: string | null`
   * trigger sources:

     * Vision `frame_events` contains `scene_change` with severity >= threshold → schedule caption on that frame_id
     * periodic heartbeat: every `periodicMs`, schedule caption on the broker’s latest frame_id (if streaming active)
   * dedupe:

     * if caption text is identical to last caption within `dedupeWindowMs`, suppress emission + persistence
3. Delivery:

   * emit caption as a **synthetic `frame_events`** message carrying one `scene_caption` event

     * use the captioned frame’s `frame_id` + width/height from broker meta
   * persist caption:

     * call Executive `/events` with `{ source:"caption", events:[scene_caption], meta:{ frame_id } }`
     * keep it fire-and-forget and warning-throttled (like your existing `/events` forwarder)

**Acceptance**

* During streaming, you see `scene_caption` appear in the UI event feed within ~1s of a scene-change, and periodically even with no big changes.
* `working_memory.log` contains `wm_event` entries sourced from `"caption"`.

Stop; update `progress.md`.

---

## Iteration 168 — UI: promote captions to “current state” (not spam)

**Goal**

* Captions feel like “EVA’s current belief,” not telemetry scrolling.

**Deliverables**

1. `packages/ui/src/main.tsx`:

   * Add `latestCaption` state:

     * show a `Latest caption:` line in the UI, updated whenever a `scene_caption` arrives
2. Event feed formatting:

   * When mapping events for the feed, if `name === "scene_caption"` and `data.text` exists, use `data.text` as the summary (not key=value truncation).

**Acceptance**

* UI shows a stable “Latest caption” line that updates over time.
* Event feed stays readable.

Stop; update `progress.md`.

---

## Iteration 169 — Stop persisting raw `scene_change` telemetry (keep it UI-only)

**Goal**

* Working memory stores meaning (captions + deep insights), not raw motion blobs.

**Deliverables**

* In Eva Vision inbound handler (`frame_events`):

  * filter before forwarding to Executive `/events`:

    * drop `scene_change` (and any other low-level detector spam)
    * allowlist `scene_caption` (and future “human-level” events)
* Keep `scene_change` flowing to UI unchanged for overlay.

**Acceptance**

* Streaming generates lots of `scene_change` overlays, but `working_memory.log` grows primarily with captions + insights, not motion blobs.

Stop; update `progress.md`.

---

## Iteration 170 — Observability + regression guardrails

**Goal**

* Make it hard to accidentally re-couple streaming to Vision latency.

**Deliverables**

1. Eva observability:

   * `/health` (or startup log line) includes:

     * broker depth, drops, config limits
     * caption in-flight status + last caption latency
2. Regression script(s):

   * Add a small script (pick one package; UI is most critical):

     * `packages/ui/scripts/check-frame-ack-regressions.ts`
     * asserts the in-flight clear path keys off `frame_received`, not `frame_events`
   * wire npm script in UI `package.json`:

     * `check:frame-ack`
3. Docs:

   * Root README: explain “receipt ACK vs processing events” and how to interpret counters now.

**Acceptance**

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build && npm run check:frame-ack`

Stop; update `progress.md`.

