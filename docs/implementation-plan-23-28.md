
Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md 

ASSUMPTION:

* Iterations 0–22 are complete (per `docs/implementation-plan-10-22.md`).
* Eva currently boots by loading config and calling `startServer(...)` directly in `packages/eva/src/index.ts` .
* Eva config today includes only `server`, `quickvision.wsUrl`, and `insightRelay` .
* QuickVision already exposes `GET /health` and `WS /infer` .
* VisionAgent already exposes `GET /health` .
* QuickVision has a stable python entrypoint in `packages/quickvision/app/run.py` (used via `python -m app.run`) .
* VisionAgent has a stable dev entrypoint `npm run dev` (tsx) .

────────────────────────────────────────────────────────────
GOAL (NEW)
────────────────────────────────────────────────────────────
Refactor Eva so it can (optionally) start and manage these as subprocesses:

* `packages/vision-agent` (Node daemon)
* `packages/quickvision` (Python FastAPI daemon)

Requirements:

* Default behavior should remain compatible: if subprocess management is disabled, Eva behaves exactly as today (connects to external QuickVision via `quickvision.wsUrl`) .
* When enabled, Eva:

  * spawns VisionAgent + QuickVision
  * waits for both to become healthy
  * starts Eva server
  * on shutdown, stops both subprocesses (no orphans)

────────────────────────────────────────────────────────────
SUBPROCESS SUPERVISION (LOCKED — don’t bikeshed)
────────────────────────────────────────────────────────────

* Use Node’s built-in `child_process.spawn` (no PM2, no docker-compose, no systemd required for this workflow).
* Readiness check is **HTTP health polling**:

  * VisionAgent: `GET /health` 
  * QuickVision: `GET /health` 
* Shutdown is SIGTERM with timeout → SIGKILL fallback (Linux-first; best effort elsewhere).

────────────────────────────────────────────────────────────
CONFIGURATION (LOCKED — config files, no env-var configuration)
────────────────────────────────────────────────────────────

* Extend `packages/eva/eva.config.json` (schema in `packages/eva/src/config.ts`)  with a **new optional** `subprocesses` block.
* Keep defaults such that **subprocesses are OFF unless explicitly enabled** (use `eva.config.local.json` for personal/dev setups).

Proposed new config shape (added to Eva Zod schema):

* `subprocesses.enabled: boolean` (default false)
* `subprocesses.visionAgent`:

  * `enabled: boolean` (default true)
  * `cwd: string` (relative to repo root, e.g. `packages/vision-agent`)
  * `command: string[]` (e.g. `["npm","run","dev"]`)
  * `healthUrl: string` (e.g. `http://127.0.0.1:8790/health`)
  * `readyTimeoutMs: number` (default 30_000)
  * `shutdownTimeoutMs: number` (default 5_000)
* `subprocesses.quickvision`:

  * `enabled: boolean` (default true)
  * `cwd: string` (e.g. `packages/quickvision`)
  * `command: string[]` (e.g. `["python","-m","app.run"]`)
  * `healthUrl: string` (e.g. `http://127.0.0.1:8000/health`)
  * `readyTimeoutMs: number` (default 60_000)  (YOLO load can be slow)
  * `shutdownTimeoutMs: number` (default 10_000)

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS (SMALL DIFFS) — START AT 23
────────────────────────────────────────────────────────────

Iteration 23 — Eva config: add subprocess settings (no behavior change)
Goal:

* Add config support for subprocess management without changing runtime behavior by default.

Deliverables:

* Update `packages/eva/src/config.ts` to include `subprocesses` schema defaults .
* Add an example local override file:

  * `packages/eva/eva.config.local.example.json` (committed)
  * (user copies to `eva.config.local.json` to enable subprocesses)

Implementation details:

* Do NOT require edits to existing `eva.config.json` content; defaults handle missing `subprocesses` .
* In schema, validate:

  * `command` must be a non-empty array of non-empty strings
  * `healthUrl` must be valid http(s) URL
  * timeouts must be positive integers

Acceptance:

* Builds pass:

  * `cd packages/eva && npm run build`
* Manual:

  * With only `eva.config.json` present, Eva still starts exactly as before .

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 24 — Add subprocess utility (ManagedProcess + health polling)
Goal:

* Introduce a small reusable subprocess manager in Eva.

Deliverables:

* Add `packages/eva/src/subprocess/ManagedProcess.ts`:

  * spawn process (cwd, args, env passthrough)
  * prefix logs (`[vision-agent]`, `[quickvision]`)
  * `waitForHealthy()` that polls `healthUrl` until 200 or timeout
  * `stop()` that SIGTERMs then SIGKILLs after `shutdownTimeoutMs`
* Add `packages/eva/src/subprocess/health.ts` (or keep inline):

  * tiny `sleep(ms)` helper
  * polling loop with interval (e.g. 250ms)

Implementation details:

* Use Node global `fetch` for health polling (no new deps).
* Linux-first process tree kill:

  * spawn with `detached: true`
  * on stop, if pid exists and platform != win32: `process.kill(-pid, 'SIGTERM')`
  * fallback: `child.kill('SIGTERM')`

Acceptance:

* Builds pass:

  * `cd packages/eva && npm run build`
* Manual smoke:

  * Add a tiny local script or use VisionAgent as the first real target in next iteration.

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 25 — Eva spawns VisionAgent (gated by config)
Goal:

* When `subprocesses.enabled=true`, Eva starts VisionAgent and waits for health before starting Eva server.

Deliverables:

* Update `packages/eva/src/index.ts` to:

  * load config as today 
  * if subprocesses enabled:

    * start VisionAgent subprocess first
    * wait for `GET http://127.0.0.1:8790/health` to return 200 
  * then call `startServer(...)`

Implementation details:

* Convert `index.ts` to an async `main()` with a top-level call:

  * `main().catch(...)` to print a clear fatal error and `process.exit(1)`
* Use config-driven command:

  * VisionAgent dev command is `npm run dev` 

Acceptance:

* Builds pass:

  * `cd packages/eva && npm run build`
* Manual run (subprocess mode):

  1. Copy example → local override:

     * `cp packages/eva/eva.config.local.example.json packages/eva/eva.config.local.json`
     * ensure it sets `subprocesses.enabled=true`
  2. `cd packages/vision-agent && npm i` (one-time)
  3. `cd packages/eva && npm run dev`
  4. Confirm VisionAgent is up:

     * `curl http://127.0.0.1:8790/health` returns ok 

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 26 — Eva spawns QuickVision (gated by config)
Goal:

* In subprocess mode, Eva starts QuickVision and waits for health before starting Eva server.

Deliverables:

* Extend `packages/eva/src/index.ts` subprocess boot to include QuickVision:

  * start VisionAgent (as Iteration 25)
  * start QuickVision
  * wait for `GET http://127.0.0.1:8000/health` 200 
  * then start Eva server

Implementation details:

* Use the stable python entrypoint:

  * command: `python -m app.run` 
* Keep Eva’s existing QuickVision WS URL config (`ws://localhost:8000/infer`) unchanged .
* Do NOT modify QuickVision; it already exposes `/health` and `/infer` .

Acceptance:

* Builds pass:

  * `cd packages/eva && npm run build`
* Manual run (subprocess mode):

  1. QuickVision one-time setup (venv + deps) per repo README / existing workflow.
  2. `cd packages/eva && npm run dev`
  3. Confirm QuickVision is up:

     * `curl http://127.0.0.1:8000/health` returns ok 
  4. Run UI and verify detections still flow.

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 27 — Graceful shutdown (no orphan daemons)
Goal:

* Ctrl+C (SIGINT) / SIGTERM stops Eva server and both subprocesses cleanly.

Deliverables:

* In `packages/eva/src/index.ts`:

  * keep references to:

    * the `Server` returned by `startServer(...)`
    * the ManagedProcess instances
  * register handlers:

    * `process.on('SIGINT', ...)`
    * `process.on('SIGTERM', ...)`
  * shutdown order:

    1. close Eva server (`server.close(...)`) so WS stops accepting
    2. stop QuickVision subprocess
    3. stop VisionAgent subprocess
    4. exit

Implementation details:

* Ensure shutdown handler is idempotent (only runs once).
* Add clear logs:

  * `[eva] shutting down...`
  * `[eva] stopping quickvision...`
  * `[eva] stopping vision-agent...`

Acceptance:

* Manual:

  * Start Eva in subprocess mode.
  * Ctrl+C.
  * Confirm both ports are freed:

    * `curl http://127.0.0.1:8000/health` fails (connection refused)
    * `curl http://127.0.0.1:8790/health` fails (connection refused)

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────

Iteration 28 — Docs: “one command boots the stack”
Goal:

* Make the new workflow obvious and repeatable.

Deliverables:

* Update `packages/eva/README.md`:

  * external mode (status quo): start QuickVision + VisionAgent manually, then Eva
  * subprocess mode: copy `eva.config.local.example.json` → `eva.config.local.json`, then `npm run dev`
  * list prerequisites (VisionAgent secrets file, QuickVision venv, etc.)
* (Optional) update root README with the same summary.

Acceptance:

* A new user can follow README and get:

  * Eva + QuickVision + VisionAgent running from one command (after one-time deps install).

Stop after iteration; update progress.md.

────────────────────────────────────────────────────────────
CODING RULES (same as prior plan)
────────────────────────────────────────────────────────────

* Don’t implement future iterations early.
* Keep changes minimal. Prefer adding small new files over rewriting.
* After each iteration: list changed files + exact commands to run + manual tests.
* If you add a dependency, keep it minimal and justified.
