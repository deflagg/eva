## docs/implementation-plan-183-197.md — Rewrite WS-first Vision inside Captioner, then rename + delete legacy Vision

Implement in **SMALL ITERATIONS**. No big-bang refactor. Each iteration ends with:

* build/typecheck passing (or explicit manual steps)
* short change summary + files changed
* run instructions
* update `progress.md`
* stop for review

---

## ASSUMPTION (CURRENT BRANCH)

Branch: `feature/eva-161-170-stream-caption`

Current services:

* Eva (TS): motion gate + broker + WS gateway
* Vision (Python, WS `/infer`): buffers frames, can trigger insights via Executive `/insight`
* Captioner (Python, HTTP `/caption`): BLIP caption only

---

## GOAL (NEW)

* Make **Captioner become the only Python “Vision” service**, and make it **WS-first**:

  * WS `/infer` is primary
  * produces `frame_events` with `scene_caption`
  * computes semantic `surprise`
  * triggers insights via Executive `/insight`
  * forwards caption events to Executive `/events`
* Keep **current Vision service** untouched until the end.
* Only final iterations:

  * rename `packages/eva/captioner` → `packages/eva/vision`
  * remove the old `packages/eva/vision` service

---

## DESIGN RULES (LOCKED)

* **Don’t copy** old Vision modules into captioner. Re-implement cleanly:

  * new config schema (single canonical shape)
  * new WS handler + frame buffer + insight trigger logic
* Use the existing protocol message shapes and binary envelope format (protocol v2) so UI/Eva don’t need protocol churn.
* Captioner becomes WS-first: HTTP endpoints either removed later or kept *only* as debug-only with minimal code.

---

# ITERATIONS (START AT 183)

## Iteration 183 — Captioner: WS-first `/infer` skeleton + clean protocol implementation (no caption, no insight)

**Goal**

* Captioner can accept a WS connection and decode binary frames.

**Deliverables**

1. `packages/eva/captioner/app/protocol.py` (new, written clean)

   * Implement:

     * binary frame envelope decode (length-prefixed JSON meta + jpeg bytes)
     * message builders for `hello`, `frame_events`, `error`
     * minimal `command` parsing (`name` string)
2. `packages/eva/captioner/app/main.py`

   * Add `@app.websocket("/infer")`
   * On connect: send `hello(role="vision")`
   * On binary frame: decode and immediately emit `frame_events` with `events: []` (pipeline proof)
   * On invalid payload: emit `error`
3. Update `packages/eva/captioner/README.md`

   * Add WS-first note + `/infer` usage

**Acceptance**

* `cd packages/eva/captioner && python3 -m compileall app`
* Run captioner: `python -m app.run`
* Confirm WS handshake works and returns `hello` + `frame_events`

Stop; update `progress.md`.

---

## Iteration 184 — Captioner: replace ad-hoc dynaconf reads with a single validated config model (new canonical settings)

**Goal**

* One canonical config object drives the new WS-first behavior (no legacy scattered keys).

**Deliverables**

1. `packages/eva/captioner/app/config.py` (new)

   * Load dynaconf once, map into a typed config object (pydantic/dataclasses)
   * Canonical config sections (example):

     * `server.host/port`
     * `executive.base_url`, `executive.timeout_ms`
     * `attention.window_ms`
     * `caption.*` (BLIP settings)
     * `semantic.*` (CLIP settings)
     * `insight.*` (clip sizing, assets dir, cooldowns)
2. Rewrite `packages/eva/captioner/settings.yaml` to match the canonical schema

   * Remove keys that won’t exist in final design (don’t keep “just in case” keys)

**Acceptance**

* Captioner boots and `/health` (if present) shows loaded config summary
* Compileall passes

Stop; update `progress.md`.

---

## Iteration 185 — Captioner: implement FrameBuffer + attention state machine (still no caption)

**Goal**

* Captioner buffers frames and supports motion-triggered attention windows.

**Deliverables**

1. `packages/eva/captioner/app/frame_buffer.py` (new)

   * Ring buffer of recent frames:

     * `frame_id`, `ts_ms`, `jpeg_bytes`, `width`, `height`
   * APIs:

     * `add_frame(meta, jpeg)`
     * `get_clip(trigger_frame_id, pre_frames, post_frames)` (returns available frames)
2. `packages/eva/captioner/app/attention.py` (new)

   * Track attention active window:

     * command `attention_start` → `active_until_ms = now + window_ms`
     * helper `is_active(now)`
3. WS `/infer` updates:

   * On each frame: store into FrameBuffer
   * On command `attention_start`: activate attention

**Acceptance**

* WS command `attention_start` works
* FrameBuffer grows/evicts as expected (log counters)
* No caption output yet

Stop; update `progress.md`.

---

## Iteration 186 — Captioner: BLIP caption runtime + emit `scene_caption` during attention (WS-first)

**Goal**

* During attention, captioner emits `frame_events(scene_caption)`.

**Deliverables**

1. `packages/eva/captioner/app/caption_model.py` (new)

   * Load BLIP at startup (device auto/cuda/cpu)
   * `caption(jpeg_bytes) -> {text, latency_ms, model}`
2. WS `/infer` logic:

   * If attention active and caption cooldown allows:

     * generate caption
     * emit `frame_events` with one event:

       * `name="scene_caption"`
       * `data={ text, model, latency_ms }`
   * Add dedupe window (don’t spam identical captions)

**Acceptance**

* Attention_start → captions appear over WS
* No HTTP dependency for captions

Stop; update `progress.md`.

---

## Iteration 187 — Captioner: CLIP semantic embeddings + surprise score + insight trigger decision (still no `/insight` call)

**Goal**

* Caption event includes semantic surprise and captioner decides “should escalate.”

**Deliverables**

1. `packages/eva/captioner/app/semantic_model.py` (new)

   * Load CLIP **vision encoder** at startup
   * Compute normalized embedding vector
2. `packages/eva/captioner/app/surprise.py` (new)

   * Maintain rolling embedding history (CPU stored)
   * Compute:

     * `similarity_prev`
     * `similarity_mean`
     * `surprise = 1 - max(sim_prev, sim_mean)` (or your chosen formula)
3. Include in `scene_caption.data`:

   * `semantic: { surprise, similarity_prev, similarity_mean, model, latency_ms }`
4. Add config knobs:

   * `semantic.history_size`
   * `surprise.threshold` (decision threshold)

**Acceptance**

* Stable scene → surprise low
* Big scene change → surprise higher
* WS payload includes semantic fields

Stop; update `progress.md`.

---

## Iteration 188 — Captioner: implement ExecutiveClient + persist caption events to `/events`

**Goal**

* Caption stream becomes part of memory continuity.

**Deliverables**

1. `packages/eva/captioner/app/executive_client.py` (new)

   * Async httpx client:

     * `post_events(source, events, meta)`
     * `post_insight(...)` (stub for next iteration)
2. On every emitted `scene_caption`, captioner also posts to Executive `/events`:

   * `source: "vision"` (or `"caption"`—pick one canonical)
   * event includes semantic fields

**Acceptance**

* Executive receives caption events (verify working_memory.log grows)
* Failures are warnings, not fatal (throttled logs)

Stop; update `progress.md`.

---

## Iteration 189 — Captioner: build clip assets + call Executive `/insight` when surprise threshold exceeded

**Goal**

* Captioner fully replaces Vision’s “insight pipeline.”

**Deliverables**

1. `packages/eva/captioner/app/clip_assets.py` (new)

   * Persist clip frames under `assets_dir/<clip_id>/XX-<frame_id>.jpg`
   * Retention pruning (max clips / max age)
2. Insight trigger logic:

   * If attention active AND `surprise >= threshold` AND cooldown allows:

     * select clip frames from FrameBuffer (pre/post)
     * optionally wait briefly for post frames (bounded wait)
     * persist assets
     * call Executive `POST /insight`
     * emit `insight` message over WS
3. Config knobs:

   * `insight.pre_frames`, `post_frames`, `max_frames`
   * `insight.cooldown_ms`
   * `insight.assets_dir`, retention

**Acceptance**

* High surprise event → insight appears in UI
* Cooldown prevents repeated insight spam
* Still WS-first

Stop; update `progress.md`.

---

## Iteration 190 — Eva integration: MotionGate → Captioner WS (now acting as Vision); stop Eva HTTP caption path

**Goal**

* Eva no longer calls `POST /caption`. Motion triggers attention_start and frame forwarding to captioner WS.

**Deliverables**

1. Eva config changes:

   * `vision.wsUrl` points to captioner: `ws://127.0.0.1:8792/infer`
2. Eva runtime changes:

   * On MotionGate trigger:

     * send WS command `attention_start`
     * force-forward the trigger frame to vision WS (even if sampling would skip)
   * Remove or fully disable Eva’s HTTP caption scheduling/call path
3. Keep legacy Vision service still present but unused (do not delete yet)

**Acceptance**

* Streaming works; captions and insights come from captioner WS
* No Eva “caption pipeline warning” spam (because Eva isn’t calling HTTP caption anymore)
* `cd packages/eva && npm run build`

Stop; update `progress.md`.

---

## Iteration 191 — Runtime cleanup: stop starting legacy Vision in subprocess mode (but keep folder)

**Goal**

* One-command boot runs Eva + captioner (as vision) + executive only.

**Deliverables**

* Update `packages/eva/eva.config.json` subprocess blocks:

  * disable old `subprocesses.vision` (legacy)
  * keep `subprocesses.captioner` enabled (temporarily)
* Update docs: “captioner is acting as vision during migration”

**Acceptance**

* `npm run dev` stack boots cleanly without old vision process

Stop; update `progress.md`.

---

# CLEANUP / NO-LEGACY ITERATIONS (explicitly requested)

## Iteration 192 — Remove HTTP-first leftovers in captioner (WS-only by default)

**Goal**

* No orphan endpoints/settings from the old caption-only service.

**Deliverables**

* Remove (or gate behind `debug.enabled`) the HTTP `POST /caption` endpoint
* Remove unused caption-only config keys
* Ensure all caption functionality is driven from WS pipeline

**Acceptance**

* WS pipeline still works end-to-end
* No dead code paths left for captioning

Stop; update `progress.md`.

---

## Iteration 193 — Final rename: captioner → vision (folder + subprocess config key)

**Goal**

* The service is *actually* called Vision in the repo.

**Deliverables**

* Rename folder: `packages/eva/captioner` → `packages/eva/vision`
* Update Eva config schema + defaults:

  * replace `subprocesses.captioner` with `subprocesses.vision` (python)
* Update docs + paths (`cwd`, venv paths, etc.)

**Acceptance**

* Stack boots using `packages/eva/vision`
* Builds pass

Stop; update `progress.md`.

---

## Iteration 194 — Remove the legacy Vision service (the old one) — last destructive step

**Goal**

* No legacy/orphaned Python vision service remains.

**Deliverables**

* Delete the *old* `packages/eva/vision` implementation (now replaced by renamed captioner)
* Remove its settings/requirements/docs references
* Ensure there is only one Python vision service left

**Acceptance**

* Repo contains one Python vision service
* End-to-end run still works

Stop; update `progress.md`.

---

## Iteration 195 — Eva config/code cleanup: remove unused knobs and dead logic after refactor

**Goal**

* No leftover “caption pipeline” or old vision-forwarding policies in Eva.

**Deliverables**

* Remove unused Eva config blocks (ex: `caption.*` if no longer used)
* Delete dead code in `packages/eva/src/server.ts` related to HTTP caption worker
* Simplify logs to reflect the new flow: “motion → vision WS attention”

**Acceptance**

* `cd packages/eva && npm run build`
* Runtime logs are clean and accurate

Stop; update `progress.md`.

---

## Iteration 196 — Protocol + docs cleanup (no stale references)

**Goal**

* Docs and schema reflect reality; no “captioner service” references remain.

**Deliverables**

* Root README: remove captioner section; update ports and run instructions
* Update any protocol docs if they reference old service roles incorrectly
* Ensure `packages/protocol` docs still match message shapes used

**Acceptance**

* Docs match how you actually run it

Stop; update `progress.md`.

---

## Iteration 197 — Final sweep: delete unused files, unused settings, unused scripts

**Goal**

* No orphaned settings files, legacy example configs, or unused code remain.

**Deliverables**

* Remove stale configs (old examples, deprecated keys)
* Remove unused scripts that were only for the old flow (if any)
* Optional: add a small “smoke regression” script:

  * motion trigger → attention_start → caption emitted → high surprise → insight emitted

**Acceptance**

* Clean tree, clean run, no legacy cruft

Stop; update `progress.md`.
