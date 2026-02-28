## docs/implementation-plan-171-176.md

Implement the system below in **SMALL ITERATIONS** so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one
* keep progress in `progress.md`

---

## ASSUMPTION (BASED ON YOUR CURRENT FEATURE BRANCH BASELINE)

Your branch `feature/eva-161-170-stream-caption` is now the baseline. It has:

* **stream receipt ACK** (`frame_received`) and UI in-flight clearing is no longer tied to Vision `frame_events`
* **Eva broker** (`packages/eva/src/broker/frameBroker.ts`)
* **Captioner service** (`packages/eva/captioner/...`) and Tier-1 scene caption events
* **Vision still contains SceneChangeEngine + scene-change config** (the existing Vision code path uses `SceneChangeEngine.process_frame(...)` and settings include `scene_change.*`, plus `surprise.weights.scene_change`) — this is what we’re replacing.

Goal here: **replace the blob/scene-change Tier-0 entirely** with **Motion Gate** in Eva:

* grayscale downsample (64×64)
* MAD diff vs previous
* below threshold → do nothing
* above threshold → trigger Tier-1 once per motion episode (hysteresis + cooldown)

---

## DESIGN OVERVIEW

### New Tier-0: Motion Gate (runs inside Eva)

* Runs on **every accepted frame** (after broker ingest).
* Computes a tiny motion score (MAD) from a 64×64 grayscale thumbnail.
* Uses hysteresis + cooldown so it triggers once per “episode”.

### Tier-1 captions

* Triggered by Motion Gate (not Vision scene_change).
* Still “latest-wins” (no backlog).

### Vision after this track

* Vision remains alive for **Tier-2 deep insights** and any future upgrades, but **no longer emits scene_change blobs**.

### UI after this track

* No blob overlays.
* Replace with a simple motion indicator (optional) + rely on captions for “what’s happening”.

---

# IMPLEMENTATION ITERATIONS — START AT 171

## Iteration 171 — Add Motion Gate utility (no wiring)

**Goal**

* Implement Motion Gate in a dedicated module with deterministic behavior and no runtime changes yet.

**Deliverables**

1. Add `packages/eva/src/broker/motionGate.ts`:

   * `MotionGateConfig`:

     * `thumbW` (default 64)
     * `thumbH` (default 64)
     * `triggerThreshold`
     * `resetThreshold`
     * `cooldownMs`
     * optional `minPersistFrames`
   * `MotionGate` class:

     * `process({ tsMs, jpegBytes }): { mad: number; triggered: boolean }`
2. Choose decode/downsample dependency:

   * Preferred: `sharp` (fast + clean):

     * decode JPEG
     * resize(64, 64)
     * grayscale
     * raw bytes output
   * Add `sharp` to `packages/eva/package.json` deps (pinned).
3. Keep this iteration **pure** (no server/config changes).

**Acceptance**

* `cd packages/eva && npm i && npm run build`
* (Optional quick harness) add a tiny `npx tsx` snippet in module comments to show MAD changes across two images.

Stop; update `progress.md`.

---

## Iteration 172 — Wire Motion Gate into Eva frame ingest + surface MAD for tuning

**Goal**

* Motion Gate runs on every accepted frame in Eva.
* Operator/UI can see MAD and whether a trigger happened.

**Deliverables**

1. Config plumbing (Eva):

   * `packages/eva/src/config.ts`
   * `packages/eva/eva.config.json`
   * `packages/eva/eva.config.local.example.json`
   * Add:

     ```json
     "motionGate": {
       "enabled": true,
       "thumbW": 64,
       "thumbH": 64,
       "triggerThreshold": 12,
       "resetThreshold": 8,
       "cooldownMs": 1500,
       "minPersistFrames": 2
     }
     ```
2. Runtime wiring (Eva):

   * `packages/eva/src/server.ts`
   * On binary frame receipt, **after broker accepts**:

     * run motion gate
     * store `lastMotion = { ts_ms, mad, triggered }`
3. Surface to UI for tuning (minimal moving parts):

   * Extend `frame_received` payload to optionally include:

     * `motion: { mad: number, triggered: boolean }`
   * Update:

     * `packages/protocol/schema.json`
     * `packages/protocol/README.md`
     * `packages/eva/src/protocol.ts`
     * `packages/ui/src/types.ts`
     * UI parsing in `packages/ui/src/main.tsx` (store/display latest MAD)

**Acceptance**

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual:

  1. Start Eva + UI
  2. Stream camera
  3. Confirm MAD reacts immediately to motion and is ~stable when still.

Stop; update `progress.md`.

---

## Iteration 173 — Replace Tier-1 trigger: motion gate drives captions (hard cutover)

**Goal**

* Tier-1 captions are triggered by Motion Gate only (not by Vision `scene_change` blobs).

**Deliverables**

1. Eva server (`packages/eva/src/server.ts`):

   * Locate the current caption trigger path (likely driven by Vision events / scene_change).
   * Replace trigger condition with:

     * `if (motionGate.triggered) scheduleCaption(latestFrame)`
2. Keep latest-wins + no backlog:

   * only 1 caption request in flight
   * keep only the newest pending frame to caption
3. Add a caption trigger cooldown (separate from motion gate cooldown):

   * Add `caption.triggerCooldownMs` to Eva config (or reuse your existing caption cooldown if it’s already there).
4. Persistence:

   * Continue persisting caption events to Executive `/events`
   * Do NOT persist motion telemetry as working memory events (MAD is debug only)

**Acceptance**

* Manual:

  1. Hold still → no repeated captions
  2. Move into frame → one caption appears within ~1s
  3. Keep moving → captions occur at most at cooldown cadence and describe current scene (no “catch up” spam)

Stop; update `progress.md`.

---

## Iteration 174 — UI: remove blob overlay + scene_change UI assumptions

**Goal**

* UI no longer references blob geometry (`blobs[]`) or draws rectangles.

**Deliverables**

1. UI runtime (`packages/ui/src/main.tsx`):

   * Remove blob overlay rendering calls and TTL timers.
   * Remove any “scene_change blob count” summaries.
   * Keep (or add) a simple motion indicator:

     * `last mad`, `last triggered` timestamp
2. Overlay module (`packages/ui/src/overlay.ts`):

   * Remove `drawSceneChangeOverlay(...)` and related blob code if unused.
   * If the overlay module is used for something else, keep it; otherwise simplify.

**Acceptance**

* `cd packages/ui && npm run build`
* Manual: stream camera, no rectangles, motion indicator updates, captions still appear.

Stop; update `progress.md`.

---

## Iteration 175 — Vision: disable SceneChangeEngine in runtime (no blobs emitted)

**Goal**

* Vision stops computing / emitting `scene_change` events entirely.

**Deliverables**

1. Vision main loop (`packages/eva/vision/app/main.py`):

   * Remove/disable `scene_change_engine.process_frame(...)` usage.
   * `frame_events.events` should be `[]` (or only non-scene-change events if you have any remaining).
2. Vision settings (`packages/eva/vision/settings.yaml`):

   * Set `scene_change.enabled: false` (temporary step before full removal).
3. Health/log output:

   * Keep logs honest: reflect that scene change is disabled.

**Acceptance**

* `cd packages/eva/vision && python3 -m compileall app`
* Manual:

  1. Start Vision + Eva + UI
  2. Confirm `frame_events.events` no longer contains `scene_change`
  3. Captions still trigger from Motion Gate

Stop; update `progress.md`.

---

## Iteration 176 — Hard cleanup: remove scene_change config + code + surprise weights

**Goal**

* Fully remove scene-change blobs from the repo’s active runtime surfaces.

**Deliverables**

1. Vision code removal:

   * Remove `scene_change.py` module (if no longer referenced).
   * Remove imports and settings loaders for `SceneChangeEngine` / `SceneChangeSettings`.
2. Vision config cleanup:

   * Remove `scene_change:` block from `packages/eva/vision/settings.yaml`
   * Remove `surprise.weights.scene_change` from config.
   * Decide what happens to auto-insight triggers in Vision:

     * If Vision relied exclusively on `scene_change` weights, document that auto-insights are now disabled or moved to a later plan (do not invent a new trigger in this iteration).
3. Docs cleanup:

   * `packages/eva/vision/README.md`
   * root `README.md`
   * Remove blob/scene-change claims and explain Tier-0 = Motion Gate.

**Acceptance**

* `cd packages/eva/vision && python3 -m compileall app`
* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual: stream camera; motion gate triggers captions; no blob codepaths exist; no scene_change config remains.

Stop; update `progress.md`.
