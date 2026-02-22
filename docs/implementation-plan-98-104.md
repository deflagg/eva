## docs/implementation-plan-98-102.md

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md

ASSUMPTION:

* Iterations 0–97 from the prior plan(s) are complete.
* Current repo already has:

  * packages/eva
  * packages/quickvision (Vision)
  * packages/ui
  * packages/protocol
  * docs/implementation-plan-*.md
  * progress.md

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 98–102)
────────────────────────────────────────────────────────────
Push-mode high-severity alerts:

* If a high-severity *insight* arrives (Vision -> Eva), Eva should push an alert immediately to the connected client.
* If a high-severity *event* arrives inside detections.events (Vision -> Eva), Eva should push an alert immediately.
* Alerts should “speak immediately” using TTS:

  * Eva synthesizes audio (mp3) using existing server-side TTS plumbing.
  * Eva pushes the audio to the client over WS.
  * UI plays it (subject to browser autoplay policy; user can unlock audio via existing Enable Audio button).

Guardrails:

* Cooldown + dedupe for high alerts (avoid spam loops).
* Keep existing insight relay + event ingest behavior intact.

────────────────────────────────────────────────────────────
PROTOCOL NOTE (v1, backward compatible)
────────────────────────────────────────────────────────────
We will add a new WS message type:

* `speech_output` (Eva -> UI)
  This is additive; existing clients that don’t understand it can ignore it.

Optionally (recommended), also document:

* `text_output` (Eva -> UI) in packages/protocol docs/schema (UI already supports it).

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 98
────────────────────────────────────────────────────────────

Iteration 98 — Protocol docs/schema + UI types for `speech_output` (no playback yet)
Goal:

* Introduce the `speech_output` message type as an additive protocol extension.

Deliverables:

* Update protocol documentation:

  * `packages/protocol/README.md`: add a section describing `speech_output` (Eva -> UI).
* Update protocol schema:

  * `packages/protocol/schema.json`: add `$defs/speech_output` and include it in the top-level `oneOf`.
* Update UI compile-time types:

  * `packages/ui/src/types.ts`: add `SpeechOutputMessage` + include in `ProtocolMessage` union.

`speech_output` JSON shape (v1):
{
"type": "speech_output",
"v": 1,
"request_id": "<uuid>",
"session_id": "system-alerts",
"ts_ms": 1700000000000,
"mime": "audio/mpeg",
"voice": "<voice-name>",
"rate": 1.0,
"text": "Spoken alert text",
"audio_b64": "<base64 mp3 bytes>",
"meta": {
"trigger_kind": "insight" | "wm_event",
"trigger_id": "<string>",
"severity": "high"
}
}

Acceptance:

* `cd packages/ui && npm run build` passes (TypeScript typecheck/build).
* Protocol docs/schema updated (no runtime behavior changes yet).

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 99 — Eva push-mode alerts (text-only) for high insights + high detections.events
Goal:

* Implement push-mode triggering logic in Eva for high-severity signals, but only send `text_output` for now (keep diff small).

Deliverables:

* In `packages/eva/src/server.ts`:

  1. Add helper: `pushHighSeverityAlertToClient(...)` (text-only in this iteration).
  2. Trigger it from:

     * high-severity `message.type === "insight"` (Vision inbound)
     * high-severity `message.type === "detections"` where `message.events[].severity === "high"`
  3. Add dedupe + cooldown for high alerts.

Implementation details:

* Add constants/state near other cooldown state:

  * HIGH_ALERT_COOLDOWN_MS (start with 10_000)
  * HIGH_ALERT_DEDUPE_WINDOW_MS (start with 60_000)
  * lastHighAlertAtMs: number | null
  * highAlertSeenKeys: Map<string, number>
* Add helper functions:

  * evictExpiredHighAlertKeys(nowMs)
  * shouldEmitHighAlert(key, nowMs)
* Implement `pushHighSeverityAlertToClient(client, payload)`:

  * Generate request_id via `crypto.randomUUID()` (browser-side already uses crypto; Node supports global crypto too, else import)
  * Send a `text_output` message immediately with:

    * session_id: "system-alerts"
    * meta.note: "Auto alert (push mode)."
    * meta.concepts includes: ["high_severity", "alert"]
* Trigger rules:
  A) Insight trigger:

  * if insight.summary.severity === "high"
  * dedupeKey: `insight:${clip_id}` (or include trigger_frame_id)
  * alertText: insight.summary.one_liner (short)
    B) Event trigger (wm_events coming from detections.events):
  * for each evt where evt.severity === "high"
  * dedupeKey: `event:${evt.name}:${evt.track_id ?? "na"}`
  * alertText: `Alert: ${evt.name.replaceAll("_"," ")}.` (+ optional small detail)
* IMPORTANT: Do not change existing behaviors:

  * keep `callAgentEventsIngest(...)` as-is
  * keep insight relay suppression as-is for forwarding raw insight messages
  * push alerts are separate (their own cooldown/dedupe)

Acceptance:

* `cd packages/eva && npm run build` passes.
* Manual test (simulated):

  * Inject a fake insight message with severity=high (or trigger real one) and confirm UI receives a `text_output` with session_id=system-alerts.
  * Inject a fake detections message with events:[{severity:"high", name:"near_collision", ...}] and confirm a `text_output` appears.

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 100 — Eva push-mode alerts now speak immediately (send `speech_output` with mp3)
Goal:

* Extend `pushHighSeverityAlertToClient` to synthesize TTS and send `speech_output` over WS.

Deliverables:

* In `packages/eva/src/server.ts`:

  * Extend `pushHighSeverityAlertToClient`:

    1. send `text_output` immediately (unchanged)
    2. if `speech.enabled` AND client is connected:

       * call existing `resolveSpeechAudio({ text, voice, rate })` (reuse server cache + in-flight dedupe)
       * base64 encode mp3 buffer
       * send `speech_output` message

Implementation details:

* Reuse existing `resolveSpeechAudio` and do NOT reuse the HTTP speech cooldown gate:

  * High-alert spam is controlled by the alert cooldown/dedupe you added in Iteration 99.
* Speech input:

  * voice: speech.defaultVoice
  * rate: omit (or set to 1.0)
* Message ordering:

  * send `text_output` first
  * then send `speech_output` when ready
* Error handling:

  * if synth fails, log warning and continue (text alert already delivered)

Acceptance:

* `cd packages/eva && npm run build` passes.
* Manual:

  * Trigger a high alert and confirm WS now sends:

    * `text_output`
    * then `speech_output` (with audio_b64 length > 0)

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 101 — UI playback for `speech_output` (immediate alert audio)
Goal:

* When UI receives `speech_output`, it plays the mp3 immediately.

Deliverables:

* `packages/ui/src/types.ts` already includes `SpeechOutputMessage` from Iteration 98.
* Update `packages/ui/src/main.tsx`:

  * Add a type guard: `isSpeechOutputMessage(message): message is SpeechOutputMessage`
  * Add an `Audio` player dedicated to WS alert audio:

    * store in `useRef(new Audio())`
    * store and revoke object URLs to avoid leaks
  * On receipt:

    * decode base64 -> Uint8Array -> Blob(audio/mpeg)
    * set audio.src = objectURL
    * `await audio.play()`
  * Autoplay policy handling:

    * If `NotAllowedError`, set the existing `audioLocked` state to true and log a helpful message
    * The existing “Enable Audio” button already unlocks autoplay; after unlock, subsequent alerts should play

Implementation details:

* Keep it minimal and isolated:

  * Do not refactor SpeechClient; just add a small alert-audio path in main.tsx.
* Log panel:

  * add one log line when alert audio is played (or blocked)

Acceptance:

* `cd packages/ui && npm run build` passes.
* Manual:

  * Open UI, click “Enable Audio” once.
  * Trigger a high alert.
  * Confirm audio plays immediately on receiving `speech_output`.

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 102 — Polish + docs + manual test checklist
Goal:

* Ensure behavior is stable and documented.

Deliverables:

* `packages/protocol/README.md`:

  * Ensure `text_output` is documented (it’s currently used but not described).
  * Ensure `speech_output` documentation includes autoplay caveat.
* Add short “Push Alerts” section to Eva README (or docs) describing:

  * what triggers push-mode
  * how cooldown/dedupe works
  * how to unlock audio in UI
* Manual test checklist (append to progress.md for this iteration):

  * High insight triggers alert + audio
  * High detections.events triggers alert + audio
  * Cooldown prevents rapid spam
  * Dedupe prevents repeats for same clip/event key

Acceptance:

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual checklist passes.

Stop after iteration; update progress.md.
