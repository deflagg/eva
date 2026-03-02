## docs/implementation-plan-177-182.md — Subprocess mode boots **Captioner** (fix missing Tier-1 service)

Implement the system below in **SMALL ITERATIONS** so diffs stay small and reviewable. Do **NOT** do big refactors. Do **NOT** “get ahead” of the current iteration. Each iteration must end with:

* build/typecheck passing (or explicit “no tests yet; manual test steps included”)
* short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review/feedback
* keep progress in `progress.md`

---

## ASSUMPTION (CURRENT BRANCH STATE)

You are running `origin/feature/eva-161-170-stream-caption` (implemented through Iteration 176). Current reality:

* `packages/eva/src/index.ts` subprocess orchestration only starts **agent** + **vision**.
* `packages/eva/src/config.ts` `subprocesses` schema contains only **agent** + **vision**.
* `packages/eva/eva.config.local.example.json` only defines subprocess entries for **agent** + **vision**.
* `caption.enabled: true` only makes Eva call `POST {caption.baseUrl}/caption` when Motion Gate triggers.
* Caption call failures are **warnings** (non-fatal), so Eva stays up even if captioner is missing.
* `http://127.0.0.1:8792/health` is connection-refused because the **captioner process isn’t being started**.

---

## GOAL (NEW)

When running Eva in **subprocess mode** (`subprocesses.enabled=true`), Eva should **also** start and supervise the **Captioner** service (`packages/eva/captioner`) so Tier-1 captions work out-of-the-box.

Constraints / non-goals:

* Keep **external mode** working: if subprocess management is disabled, Eva should behave exactly as today (call whatever `caption.baseUrl` points to, warn on failure).
* No new orchestrators (no docker-compose/PM2/systemd). Keep the existing `ManagedProcess` approach.

---

## SUBPROCESS SUPERVISION (LOCKED)

Follow the existing pattern already used for agent/vision:

* Spawn via `ManagedProcess`
* Readiness = `GET /health` polling until success or timeout
* Shutdown = SIGTERM + timeout → SIGKILL fallback
* No orphan processes on Ctrl+C / SIGTERM / SIGHUP

---

# IMPLEMENTATION ITERATIONS — START AT 177

## Iteration 177 — Config: add `subprocesses.captioner` (schema + example; no runtime behavior change yet)

**Goal**

* Extend Eva config so captioner can be described/configured as a managed subprocess.

**Deliverables**

1. **Config schema**

   * Update `packages/eva/src/config.ts`:

     * Add `CaptionerSubprocessConfigSchema` (modeled after `VisionSubprocessConfigSchema`)
     * Add `subprocesses.captioner` to `SubprocessesConfigSchema`
     * Provide sensible defaults:

       * `cwd`: `packages/eva/captioner`
       * `command`: `[".venv/bin/python", "-m", "app.run"]`
       * `healthUrl`: `http://127.0.0.1:8792/health`
       * `readyTimeoutMs`: **longer** than vision (caption model load can be slow; pick something like `120_000`)
       * `shutdownTimeoutMs`: `10_000`
2. **Example local config**

   * Update `packages/eva/eva.config.local.example.json` to include:

     * `subprocesses.captioner` block with the same defaults

**Acceptance**

* `cd packages/eva && npm run build` passes
* Eva still starts in non-subprocess mode exactly as before (no behavior change intended yet)

Stop; update `progress.md`.

---

## Iteration 178 — Runtime: Eva spawns Captioner in subprocess mode (+ shutdown integration)

**Goal**

* In subprocess mode, Eva starts Captioner, waits for health, then starts the Eva server.

**Deliverables**

1. `packages/eva/src/index.ts`

   * Add a `captioner: ManagedProcess | null`
   * Startup sequence (keep it simple and consistent):

     1. agent (existing)
     2. vision (existing)
     3. **captioner** (new)
     4. Eva server
   * Wait for captioner health:

     * log: `[eva] waiting for captioner health at ...`
2. Shutdown / force-kill wiring

   * Ensure graceful shutdown stops captioner too (reverse order):

     * close Eva server
     * stop captioner
     * stop vision
     * stop agent
   * Ensure `forceTerminate(...)` also force-kills captioner like agent/vision

**Acceptance**

* Build:

  * `cd packages/eva && npm run build`
* Manual (subprocess mode):

  1. `cp packages/eva/eva.config.local.example.json packages/eva/eva.config.local.json`
  2. Captioner one-time setup:

     * `cd packages/eva/captioner`
     * `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
  3. `cd packages/eva && npm run dev`
  4. Confirm captioner is up:

     * `curl http://127.0.0.1:8792/health` returns `status: ok`
  5. Start UI + stream and confirm:

     * captions appear
     * Eva logs no longer spam “caption pipeline warning: connection refused”

Stop; update `progress.md`.

---

## Iteration 179 — Docs: “one command boots the stack” includes Captioner

**Goal**

* Make it obvious to future-you why caption works and how to run it.

**Deliverables**

1. Root `README.md`

   * Add Captioner as a first-class component (it’s currently missing from the “four components” list)
   * Add default port:

     * Captioner: `http://127.0.0.1:8792`
   * Update “One-command stack boot (Eva subprocess mode)” to say:

     * Eva boots **Agent + Vision + Captioner** (not just agent+vision)
   * Add a short “Captioner (Python)” section in the manual run instructions (mirroring the `packages/eva/captioner/README.md`)
2. (Optional but nice) Mention per-platform command overrides:

   * If `.venv/bin/python` differs, set `subprocesses.captioner.command` in `eva.config.local.json`

**Acceptance**

* Docs are consistent and runnable
* Build still passes:

  * `cd packages/eva && npm run build`

Stop; update `progress.md`.

---

## Iteration 180 — DX guardrail: clear warning when captions are enabled but captioner isn’t reachable

**Goal**

* Reduce “silent failure” vibes by making the *first* failure actionable.

**Deliverables**

* In `packages/eva/src/server.ts` (or at startup in `index.ts`, whichever is smaller):

  * Add a **single** startup warning (throttled) when:

    * `caption.enabled === true`
    * and `GET {caption.baseUrl}/health` is unreachable **at startup**
  * Warning should explicitly say one of:

    * “Enable subprocesses.captioner” (if subprocess mode is on), or
    * “Start captioner manually at packages/eva/captioner” (if subprocess mode is off)
  * Keep it **non-fatal** (match current “caption failures are warnings” behavior)

**Acceptance**

* Manual:

  * With captioner down, Eva prints one clear warning with fix steps (not a wall of repeated noise)
  * With captioner up, no warning is printed
* `cd packages/eva && npm run build` passes

Stop; update `progress.md`.

---

## Iteration 182 — Vision auto-insight: make it configurable and enable runtime auto trigger

**Goal**

* Remove hardcoded `auto_insights_enabled=false` behavior and allow auto-insight via settings.

**Deliverables**

1. Vision settings model

   * Update `packages/eva/vision/app/insights.py`:

     * add `insights.auto.enabled` (boolean)
     * add `insights.auto.interval_ms` (>=1)
     * include both in `InsightSettings`
2. Runtime behavior

   * Update `packages/eva/vision/app/main.py`:

     * health/startup surfaces should reflect configured auto-insight state (not hardcoded false)
     * while streaming frames, auto-trigger insight attempts on configured cadence
     * preserve manual `insight_test` path
     * keep cooldown guardrails (`insights.insight_cooldown_ms`)
3. Defaults + docs

   * Update `packages/eva/vision/settings.yaml` with committed `insights.auto.*` defaults
   * Update `packages/eva/vision/README.md` to document auto-insight config and behavior

**Acceptance**

* `cd packages/eva/vision && python3 -m compileall app` passes
* `cd packages/eva && npm run build` passes
* Runtime health reflects config:

  * `auto_insights_enabled` matches `insights.auto.enabled`
  * `auto_insight_interval_ms` matches `insights.auto.interval_ms`
* With frames streaming and auto enabled, insights are emitted without manual `insight_test`.

Stop; update `progress.md`.
