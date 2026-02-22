## docs/implementation-plan-91-94.md — Hard cutover: remove “QuickVision” naming leftovers (NO deprecated aliases)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

Finish the rename so the repo consistently uses **Vision** (not QuickVision) in:

* Eva config keys (`vision.wsUrl` only; no `quickvision.wsUrl` fallback currently exists )
* Eva subprocess config (`subprocesses.vision` instead of `subprocesses.quickvision` currently exists )
* Eva TypeScript module names (`visionClient`, not `quickvisionClient` currently exists )
* Protocol validator/type names (`VisionInboundMessageSchema`, not `QuickVisionInboundMessageSchema` currently exists )
* Docs that users actually follow (root README + packages/eva README + local example config currently still teach `subprocesses.quickvision`   )

---

# DECISIONS (LOCKED)

* **Hard cutover. No deprecated aliases.**

  * Remove config support for `quickvision.wsUrl` entirely (it currently exists as a deprecated fallback ).
  * Rename `subprocesses.quickvision` → `subprocesses.vision` with **no** compatibility shim.
* Do **not** change network ports or endpoints:

  * Vision stays at `:8000` and WS `/infer` (as established by earlier plans ).
* Do **not** change protocol error codes (e.g. keep `QV_UNAVAILABLE` even if name is legacy) unless you explicitly decide to do a breaking protocol rev later.
* Rename changes should be “mechanical” and isolated: file rename, symbol rename, docs update, build, stop.

---

# CURRENT STATE (FACTS)

* `packages/eva/src/config.ts` still supports:

  * `quickvision.wsUrl` as a deprecated alias fallback 
  * `subprocesses.quickvision` as the subprocess key (defaults + schema) 
* `packages/eva/src/index.ts` still:

  * runs a subprocess named `quickvision` and reads `config.subprocesses.quickvision` 
  * passes `quickvisionWsUrl` into `startServer` 
* `packages/eva/src/server.ts` still:

  * has `StartServerOptions.quickvisionWsUrl` 
  * imports `createQuickVisionClient` from `./quickvisionClient.js` 
  * uses `QuickVisionInboundMessageSchema` for Vision inbound messages  
* `packages/eva/src/protocol.ts` still exports `QuickVisionInboundMessageSchema` and related types 
* Docs + examples still teach quickvision keys:

  * `packages/eva/eva.config.local.example.json` uses `subprocesses.quickvision` 
  * root `README.md` tells users to set `subprocesses.quickvision.command` 
  * `packages/eva/README.md` still documents `quickvision.wsUrl` and `subprocesses.quickvision`  

---

# IMPLEMENTATION ITERATIONS (START AT 91)

## Iteration 91 — Config hard cutover: remove `quickvision.wsUrl` support everywhere

Goal:

* Only `vision.wsUrl` exists. No fallback. No deprecation warning.

Deliverables:

1. `packages/eva/src/config.ts`

* Remove `quickvision: VisionWsConfigSchema.optional()` from `EvaConfigSchema` (currently present ).
* Make `vision` **required** (or `.default({ wsUrl: ... })` if you prefer), but do not accept `quickvision`.
* Delete the resolution/fallback logic that checks `parsed.data.quickvision` and warns .
* Update the thrown error message to mention only `vision.wsUrl`.

2. Docs alignment (required in same iteration)

* `packages/eva/README.md`:

  * Remove the “deprecated alias” line and remove the `quickvision` block from the schema snippet  .
  * Keep only `vision.wsUrl`.

Acceptance:

* `cd packages/eva && npm run build`
* Manual: start Eva with `packages/eva/eva.config.json` (already contains `vision.wsUrl` ) and confirm it boots.

Stop; update `progress.md`.

---

## Iteration 92 — Subprocess hard cutover: rename `subprocesses.quickvision` → `subprocesses.vision` (no shim)

Goal:

* Subprocess key is `vision`. No `quickvision` key exists anywhere in runtime config.

Deliverables:

1. `packages/eva/src/config.ts`

* Rename schema key:

  * `subprocesses.quickvision` → `subprocesses.vision` (currently `quickvision` ).
* Update defaults accordingly.

2. `packages/eva/eva.config.local.example.json`

* Rename the example block:

  * `subprocesses.quickvision` → `subprocesses.vision` (currently `quickvision` ).

3. Docs alignment (required)

* Root `README.md`: change the guidance line to `subprocesses.vision.command` (currently says `subprocesses.quickvision.command` ).
* `packages/eva/README.md`:

  * Update the schema snippet and the venv-python example to `subprocesses.vision` (currently `quickvision` ).

4. Runtime command continuity note (required)

* During hard cutover, any existing local override at `subprocesses.quickvision.command` will stop applying.
* Ensure `subprocesses.vision.command` points to the Vision venv interpreter (for this repo: `.venv/bin/python -m app.run`) so Eva does not fall back to a system `python` missing `uvicorn`.

Acceptance:

* `cd packages/eva && npm run build`
* Manual subprocess boot:

  1. `cd packages/eva && cp eva.config.local.example.json eva.config.local.json`
  2. Start stack with `npm run dev`
  3. Confirm logs show Vision subprocess started (name changes happen in Iteration 93).

Stop; update `progress.md`.

---

## Iteration 93 — Rename subprocess runtime naming in `index.ts` (variable names + ManagedProcess name)

Goal:

* Eva bootstrap no longer says “quickvision” anywhere.

Deliverables:

1. `packages/eva/src/index.ts`

* Rename local variables:

  * `let quickvision` → `let vision` (or `visionProc`)
* Update:

  * config access: `config.subprocesses.quickvision` → `config.subprocesses.vision` (currently uses `.quickvision` )
  * log strings: “starting quickvision subprocess” → “starting vision subprocess” 
  * ManagedProcess `name: 'quickvision'` → `name: 'vision'` 
  * shutdown/force-kill logs: “force-killing quickvision…” → “force-killing vision…” 

2. StartServer callsite rename prep

* Keep passing the same value (`config.vision.wsUrl`), but rename the option key to `visionWsUrl` only **after** server.ts supports it (Iteration 94).
* For this iteration, you may leave `quickvisionWsUrl: config.vision.wsUrl` intact (current state ) to keep the diff bounded.

Acceptance:

* `cd packages/eva && npm run build`
* Manual: subprocess mode boots, logs show “vision subprocess” (not quickvision).

Stop; update `progress.md`.

---

## Iteration 94 — TypeScript surface rename: client module + server options + protocol schema names

Goal:

* Remove remaining “QuickVision” names from Eva TS modules and types.

Deliverables:

1. Rename WS client module (mechanical)

* `git mv packages/eva/src/quickvisionClient.ts packages/eva/src/visionClient.ts`
* Inside the file:

  * `QuickVisionClient*` → `VisionClient*`
  * `createQuickVisionClient` → `createVisionClient` (currently `createQuickVisionClient` )
  * Update the one error string `'<unexpected binary message from QuickVision>'` to “Vision” 

2. `packages/eva/src/protocol.ts`

* Rename exports:

  * `QuickVisionInboundMessageSchema` → `VisionInboundMessageSchema` (currently `QuickVisionInboundMessageSchema` )
  * `QuickVisionInboundMessage` → `VisionInboundMessage` 

3. `packages/eva/src/server.ts`

* Update imports:

  * `createQuickVisionClient` import path + name → `createVisionClient` from `./visionClient.js` (currently imports quickvision client )
  * `QuickVisionInboundMessageSchema` → `VisionInboundMessageSchema` (currently imported )
* Rename `StartServerOptions.quickvisionWsUrl` → `visionWsUrl` (currently `quickvisionWsUrl` )
* Rename local destructure and usage:

  * `const { ..., quickvisionWsUrl, ... }` → `visionWsUrl`
  * `create*Client({ url: visionWsUrl })` (currently uses `quickvisionWsUrl`  )
  * local var `quickvisionClient` → `visionClient` (currently `quickvisionClient` )

4. `packages/eva/src/index.ts`

* Update the call to `startServer`:

  * `quickvisionWsUrl: config.vision.wsUrl` → `visionWsUrl: config.vision.wsUrl` (currently `quickvisionWsUrl` )

5. Docs sweep (required)

* Root `README.md` and `packages/eva/README.md`: ensure no mention of:

  * `quickvision.wsUrl`
  * `subprocesses.quickvision`
* It’s fine if *historical implementation-plan docs* still mention QuickVision; don’t waste time rewriting history.

Acceptance:

* `cd packages/eva && npm run build`
* Repo check (local dev):

  * `rg -n "quickvision" packages/eva` returns **0** hits (or only intentionally historical comments you explicitly keep).
* Manual: run stack; confirm Eva connects to Vision and the camera stream still works.

Stop; update `progress.md`.

