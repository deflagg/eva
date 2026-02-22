## docs/implementation-plan-95-97.md — Insight clips as working-memory assets (store frames on disk + send asset refs)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

1. Vision saves **only the frames used for insight clips** (surprise-triggered clips) under:

* `packages/eva/memory/working_memory_assets/`

2. Vision sends **references** to those saved frames in the HTTP request to Executive `/insight` (no base64 in HTTP).

3. Executive `/insight` loads the referenced files from `working_memory_assets`, calls the model, and writes a `wm_insight` entry that includes **asset references**.

4. Remove deprecated aliases / legacy naming that you don’t want (no migration shims).

---

# DECISIONS (LOCKED)

* **Hard cutover**: `/insight` request payload will no longer accept `image_b64`. Only asset references.
* Asset references are **relative paths** under `working_memory_assets/` (e.g. `"clipId/01-frame.jpg"`).
* Vision stores the **exact bytes used for the insight call** (downsampled JPEG if downsample is enabled).
* Executive must enforce a **path traversal guard** (only read files inside `working_memory_assets`).
* Do not start storing “all frames”; only insight clips.

---

# CURRENT STATE (FACTS)

* Executive `/insight` currently validates frames with `image_b64` and the README even documents a base64 curl example.
* Vision’s `settings.yaml` and `Vision` README still mention the deprecated alias `insights.vision_agent_url`.
* Vision python modules still throw “QuickVision config error …” in several places.
* Eva TS server still emits user-facing “QuickVision is not connected.” text for `QV_UNAVAILABLE` in a couple places.

---

# IMPLEMENTATION ITERATIONS (START AT 95)

## Iteration 95 — Hard cutover: store insight clip frames + send asset refs to Executive `/insight`

Goal:

* Insight transport becomes “asset refs over HTTP”.
* Working-memory assets exist on disk and are referenced from `wm_insight`.

Deliverables:

### 1) Create the working-memory assets directory + git hygiene

1. Ensure this directory exists at runtime:

* `packages/eva/memory/working_memory_assets/`

2. Add gitignore:

* ignore everything under `packages/eva/memory/working_memory_assets/**`

3. Optional: commit a placeholder file:

* `packages/eva/memory/working_memory_assets/.gitkeep`

### 2) Executive: change `/insight` request schema to accept asset refs (no base64)

File: `packages/eva/executive/src/server.ts`

1. Replace `ClipFrameSchema` shape:

* remove `image_b64`
* add `asset_rel_path: string` (required)

2. Add constants:

* `WORKING_MEMORY_ASSETS_DIRNAME = 'working_memory_assets'`
* derive `assetsDirPath = path.join(config.memoryDirPath, WORKING_MEMORY_ASSETS_DIRNAME)`

3. On server startup (or inside StartAgentServer) ensure:

* `mkdirSync(assetsDirPath, { recursive: true })`

4. When handling `/insight`:

* for each frame:

  * resolve full path: `resolved = path.resolve(assetsDirPath, frame.asset_rel_path)`
  * guard: `resolved.startsWith(path.resolve(assetsDirPath) + path.sep)` (or equivalent safe check)
  * read bytes
  * base64 encode internally for the OpenAI request

5. Error handling:

* missing file → 400 with code like `INSIGHT_ASSET_MISSING`
* traversal violation → 400 with code like `INSIGHT_ASSET_INVALID_PATH`

### 3) Executive: include asset refs in `wm_insight` entries

File: `packages/eva/executive/src/server.ts`

1. Extend `WorkingMemoryWmInsightEntry` with:

* `assets: Array<{ frame_id?: string; ts_ms?: number; mime: 'image/jpeg'; asset_rel_path: string }>`

2. When writing the `wm_insight` JSONL line:

* store the `frames` asset refs as `assets` on the entry

### 4) Executive docs: update insight check example

File: `packages/eva/executive/README.md`

* Replace the `/insight` curl example from `image_b64` to `asset_rel_path`
* Document where assets live: `packages/eva/memory/working_memory_assets`

### 5) Vision: save clip frames to working_memory_assets and send only asset refs

Files:

* `packages/eva/vision/app/insights.py`
* `packages/eva/vision/app/vision_agent_client.py`
* `packages/eva/vision/settings.yaml`
* `packages/eva/vision/README.md`

1. Add Vision config key (Dynaconf):

* `insights.assets_dir: ../memory/working_memory_assets`

2. In `insights.py`:

* remove base64 building in `_build_request_frame`
* add a “persist clip” step inside `_request_insight`:

  * create a per-clip folder: `${assets_dir}/${clip_id}/`
  * for each selected clip frame:

    * optionally downsample bytes (if enabled)
    * write file: `01-<frame_id>.jpg`, `02-...jpg`, etc
    * produce `asset_rel_path`: `${clip_id}/01-<frame_id>.jpg`
* build request frames as `{ frame_id, ts_ms, mime, asset_rel_path }`

3. In `vision_agent_client.py`:

* Replace `VisionAgentFrame.image_b64` with `asset_rel_path`
* Update request model accordingly

4. Remove deprecated alias from Vision config + docs (hard cutover):

* `settings.yaml`: remove `insights.vision_agent_url`
* `insights.py`: remove fallback logic for `insights.vision_agent_url`
* `vision/README.md`: remove mention of the deprecated alias

Acceptance:

* Executive:

  * `cd packages/eva/executive && npm run build`
* Vision:

  * run Vision in dev (existing instructions)
* End-to-end manual:

  1. Start Executive + Vision (stack)
  2. Trigger an insight (either real surprise, or whatever “insight test” path you already have)
  3. Confirm new files appear under `packages/eva/memory/working_memory_assets/<clip_id>/`
  4. Confirm Executive `/insight` succeeds and `working_memory.log` contains a `wm_insight` entry with `assets: [...]`

Stop; update `progress.md`.

---

## Iteration 96 — Naming cleanup: remove remaining “QuickVision” strings (no aliases)

Goal:

* No “QuickVision” user-facing strings in active code paths (error codes may remain, but message text should say “Vision”).
* Vision python config errors say “Vision config error”.

Deliverables:

### 1) Vision python: rename “QuickVision config error” strings

Files (examples; use ripgrep to find all):

* `packages/eva/vision/app/motion.py`
* `packages/eva/vision/app/collision.py`
* `packages/eva/vision/app/roi.py`
* `packages/eva/vision/app/abandoned.py`
* `packages/eva/vision/app/tracking.py`

Replace:

* `"QuickVision config error: ..."` → `"Vision config error: ..."`

### 2) Eva TS server: fix user-facing message text

File:

* `packages/eva/src/server.ts`

Keep error code `QV_UNAVAILABLE`, but change message text:

* `"QuickVision is not connected."` → `"Vision is not connected."`

Acceptance:

* `cd packages/eva && npm run build`
* `rg -n "QuickVision" packages/eva` returns 0 hits (or only intentionally historical docs you explicitly allow)

Stop; update `progress.md`.

---

## Iteration 97 — Asset retention (recommended)

Goal:

* Prevent `working_memory_assets/` from growing forever.

Deliverables:

1. Vision config keys:

* `insights.assets.max_clips` (default e.g. 200)
* `insights.assets.max_age_hours` (default e.g. 24)

2. Vision cleanup routine:

* after writing a new clip directory:

  * list clip directories, sort by mtime
  * delete dirs beyond `max_clips`
  * delete dirs older than `max_age_hours`

3. Docs:

* update `packages/eva/vision/README.md` with retention behavior

Acceptance:

* Create enough clips to exceed threshold, confirm older clip dirs get pruned.
* Verify Executive `/insight` still works.

Stop; update `progress.md`.

