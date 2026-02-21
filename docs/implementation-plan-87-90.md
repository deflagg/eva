## docs/implementation-plan-87-90.md — Rename QuickVision runtime identity → `vision` (service + protocol + logs)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

## GOAL

Rename the **runtime identity string** from `quickvision` → `vision` so that:

* Vision service `/health` returns `"service": "vision"`
* Vision service WebSocket `hello` uses `role: "vision"`
* Vision service logs use `[vision]` prefix
* Eva gateway logs stop saying “QuickVision …” and use “Vision …” instead
* Protocol remains compatible during the transition (accept both role strings for one iteration)

---

## CURRENT STATE (FACTS)

* The Python service lives at `packages/eva/vision/`, but it still identifies itself as `quickvision` via:

  * FastAPI `title="quickvision"`
  * `/health` returns `"service":"quickvision"`
  * WS hello uses `make_hello("quickvision")`
  * logs use `[quickvision]` prefix
* UI + Eva currently treat `hello.role` as including `quickvision`.
* Eva logs and some code paths still say “QuickVision”.

---

## DECISIONS (LOCKED)

* Do not change ports or endpoints:

  * Vision stays on `:8000` and WS `/infer`.
* Transitional compatibility:

  * For one iteration, Eva + UI must accept both `hello.role = "quickvision"` and `"vision"`.
* Do not change insight/event semantics—only naming and identity strings.
* Keep diffs small; avoid internal variable renames unless isolated.

---

# IMPLEMENTATION ITERATIONS (START AT 87)

## Iteration 87 — Protocol compatibility: allow `hello.role = "vision"` (without breaking “quickvision”)

Goal:

* Make consumers tolerant before we flip the producer.

Deliverables:

1. UI protocol types

   * `packages/ui/src/types.ts`
   * Update `HelloMessage.role` union to include `"vision"` while keeping `"quickvision"` for now.

2. Eva protocol validator

   * `packages/eva/src/protocol.ts`
   * Update the Hello schema role enum to accept `"vision"` as well (keep `"quickvision"`).

Acceptance:

* `cd packages/ui && npm run build`
* `cd packages/eva && npm run build`
* Run stack as-is (still emits `"quickvision"`); nothing should change.

Stop; update `progress.md`.

---

## Iteration 88 — Vision service emits `vision` identity (health + hello + log prefixes)

Goal:

* Flip the Python service to identify as `vision` everywhere.

Deliverables:

1. `packages/eva/vision/app/main.py`

   * `FastAPI(title="quickvision", ...)` → `FastAPI(title="vision", ...)`
   * `/health` `"service": "quickvision"` → `"service": "vision"`
   * `make_hello("quickvision")` → `make_hello("vision")`
   * Change startup `print("[quickvision] ...")` prefixes to `print("[vision] ...")`
   * Change auto-insight log lines `"[quickvision] auto insight ..."` to `"[vision] ..."`

2. `packages/eva/vision/app/insights.py`

   * Change any remaining log lines:

     * `print("[quickvision] ...")` → `print("[vision] ...")`
   * Update config error prefixes (recommended, small diff):

     * `"QuickVision config error: ..."` → `"Vision config error: ..."`

3. `packages/eva/vision/app/run.py`

   * Update `"QuickVision config error: ..."` strings to `"Vision config error: ..."`

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`
* Run Vision service:

  * `curl http://127.0.0.1:8000/health` returns `"service":"vision"`
  * WebSocket `/infer` hello contains `"role":"vision"`
* Run full stack (UI/Eva still compatible because Iteration 87 accepted both roles).

Stop; update `progress.md`.

---

## Iteration 89 — Eva gateway wording: rename “QuickVision” log strings to “Vision” (no behavior change)

Goal:

* Make Eva logs and operator mental model match reality.

Deliverables:

* `packages/eva/src/server.ts`

  * Update log strings only:

    * “connected to QuickVision …” → “connected to Vision …”
    * “QuickVision connection closed” → “Vision connection closed”
    * “QuickVision reconnect …” → “Vision reconnect …”
    * “non-JSON payload from QuickVision …” → “… from Vision …”
  * Keep internal variable names (`quickvisionClient`, etc.) unchanged this iteration to keep diffs tiny.

Acceptance:

* `cd packages/eva && npm run build`
* Manual: run stack, confirm Eva logs say “Vision” while everything still works.

Stop; update `progress.md`.

---

## Iteration 90 — Cleanup: remove legacy `"quickvision"` role support + docs sweep

Goal:

* After everything runs with `"vision"`, remove the legacy role to prevent drift.

Deliverables:

1. UI

   * `packages/ui/src/types.ts`
   * Remove `"quickvision"` from `HelloMessage.role` union (leave `"vision"`).

2. Eva

   * `packages/eva/src/protocol.ts`
   * Remove `"quickvision"` from Hello role enum (leave `"vision"`).

3. Docs

   * Sweep docs/READMEs for “QuickVision” references that are now misleading.
   * Optional: keep a single historical breadcrumb in root README (“formerly QuickVision”), but don’t leave it scattered.

Acceptance:

* `cd packages/ui && npm run build`
* `cd packages/eva && npm run build`
* `cd packages/eva/vision && python3 -m compileall app`
* Run stack:

  * Vision hello must be `"vision"`, not `"quickvision"`
  * No runtime depends on `"quickvision"` anymore

Stop; update `progress.md`.
