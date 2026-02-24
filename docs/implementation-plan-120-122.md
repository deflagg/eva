````md
## docs/implementation-plan-120-122.md — Vision ROI transition debounce (enter/exit only after stability)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

Reduce ROI boundary “flapping” by adding **transition debounce** so `roi_enter` / `roi_exit` events are emitted only when the inside/outside state is stable for a configured minimum time.

This should stop spam like:

enter → exit → enter → exit … across consecutive frames when a tracked centroid jitters near the ROI boundary.

---

# NON-GOALS

* No truncation / rate-limiting in Executive working memory in this plan.
* No per-event allowlist/filtering yet (that’s a separate feature).
* No changes to tracking, YOLO inference, or UI.
* No changes to ROI dwell, line crossing, motion, collision, abandoned detectors other than the indirect effect of fewer enter/exit flips.

---

# CURRENT STATE (FACTS)

* ROI transitions are emitted immediately in `packages/eva/vision/app/events.py`:
  * `_append_region_events()` computes `inside_now` and compares it to `inside_before`.
  * Any change emits `roi_enter`/`roi_exit` the same frame.
* ROI boundary jitter causes rapid toggling for the same track_id.

---

# DESIGN

Add config:

* `roi.transitions.min_transition_ms` (non-negative int)
  * `0` disables debounce (legacy behavior)
  * `>0` requires the candidate state to remain unchanged for at least this many ms before emitting enter/exit and committing state.

Implementation approach (time-based debounce):

For each `(track_id, region_name)` maintain:
* committed state: `regions_inside[region_name]` (already exists)
* pending candidate state: `pending_region_state[region_name]` (bool)
* pending since timestamp: `pending_region_since_ts_ms[region_name]` (int)

On each frame:
1. compute `inside_now`
2. if `inside_now == committed`:
   * clear pending state for that region (if any)
   * continue (dwell logic uses committed state)
3. else (`inside_now != committed`):
   * if pending candidate differs from `inside_now`, set pending candidate + sinceTs = current ts
   * else (candidate unchanged):
     * if `(ts_ms - sinceTs) >= min_transition_ms`, COMMIT:
       - update committed state
       - emit the corresponding event (enter/exit)
       - update ROI dwell bookkeeping (enter_ts_ms, dwell_emitted) only on commit

This turns “instant flip-flop” into “must be stable for X ms.”

---

# IMPLEMENTATION ITERATIONS (START AT 120)

## Iteration 120 — Add ROI transition debounce config plumbing (no behavior change yet)

Goal:
* Add `roi.transitions.min_transition_ms` to config loading and surface it in logs/health.

Deliverables:

1) `packages/eva/vision/settings.yaml`
Add defaults:

```yaml
roi:
  transitions:
    min_transition_ms: 250
````

(Keep it easy to disable by setting `0` in `settings.local.yaml`.)

2. `packages/eva/vision/app/roi.py`

* Extend `RoiSettings` dataclass with:

  * `transition_min_ms: int`
* Parse config:

  * read `roi.transitions.min_transition_ms` (default `250`)
  * validate as non-negative int (reuse `_as_non_negative_int`)
* Store into `_roi_settings`.

3. `packages/eva/vision/app/main.py`

* Add one line to startup log and `/health` payload showing the loaded `roi_transition_min_ms`.

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`
* Manual: start Vision and confirm startup log prints the transition value; `GET /health` includes it.

Stop; update `progress.md`.

---

## Iteration 121 — Implement ROI enter/exit debounce in DetectionEventEngine

Goal:

* Apply debounce so `roi_enter`/`roi_exit` only emit after stability for `roi.transitions.min_transition_ms`.

Deliverables:

1. `packages/eva/vision/app/events.py`

A) Extend `TrackEventState` with pending transition tracking, for example:

* `region_pending_inside: dict[str, bool] = field(default_factory=dict)`
* `region_pending_since_ts_ms: dict[str, int] = field(default_factory=dict)`

B) Update `_append_region_events(...)`:

* Read `min_transition_ms = self._roi_settings.transition_min_ms`
* If `min_transition_ms <= 0`:

  * keep legacy immediate behavior (current code path)
* Else:

  * implement the algorithm described in DESIGN:

    * commit only after candidate remains stable for `min_transition_ms`
    * emit enter/exit only on commit
    * update `region_enter_ts_ms` / `region_dwell_emitted` only on commit

C) Ensure stale state cleanup:

* When committing `roi_exit`, clear:

  * `state.region_enter_ts_ms[region_name]`
  * `state.region_dwell_emitted[region_name]`
  * pending state for that region
* When committing `roi_enter`, set:

  * `state.region_enter_ts_ms[region_name] = ts_ms`
  * `state.region_dwell_emitted[region_name] = False`
  * pending state cleared

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`
* Manual flapping test:

  1. Set `roi.transitions.min_transition_ms: 250`
  2. Put your hand at/near the ROI boundary and wiggle slightly
  3. Confirm you do NOT get repeated enter/exit spam; transitions should be far less frequent.
* Manual “real crossing” test:

  1. Move hand clearly from outside → inside and hold for > 250ms
  2. Confirm exactly one `roi_enter` emits.
  3. Move clearly inside → outside and hold for > 250ms
  4. Confirm exactly one `roi_exit` emits.

Stop; update `progress.md`.

---

## Iteration 122 — Docs + tuning guidance

Goal:

* Document the new behavior and how to tune it.

Deliverables:

1. `packages/eva/vision/README.md`
   Add a section:

* `roi.transitions.min_transition_ms`

  * what it does (debounces ROI enter/exit)
  * how to disable (`0`)
  * recommended values:

    * `150–300ms` for typical webcam FPS
    * larger if you still see flapping

2. Update any existing ROI example configs in the README to include `roi.transitions.min_transition_ms`.

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`

Stop; update `progress.md`.
