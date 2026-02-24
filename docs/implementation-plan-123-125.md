## docs/implementation-plan-123-125.md — ROI exit reliability under tracker ID churn (track-lost exit policy)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

Make `roi_exit` reliable even when tracker IDs are unstable (drop/re-ID) by adding a configurable **track-lost exit policy**.

Today, `roi_exit` depends on seeing the same `track_id` transition to outside state. Under tracker churn, that condition often never occurs.

---

# NON-GOALS

* No YOLO model changes.
* No tracker algorithm replacement.
* No major tracker retuning in this plan (beyond documenting guidance).
* No changes to UI rendering or transport.
* No changes to motion/collision/abandoned detector logic, except indirect downstream effects from better ROI exits.

---

# CURRENT STATE (FACTS)

* ROI transitions are computed in `packages/eva/vision/app/events.py` in `_append_region_events(...)`.
* ROI state is tracked per `track_id` via `TrackEventState`.
* With transition debounce, `roi_exit` only emits when that same track remains outside long enough to commit.
* Stale track cleanup (`_evict_stale_track_state`) currently deletes state after TTL and emits no ROI exit.
* If a track is lost/re-ID’d before outside commit, enter may be seen but exit can be missed.

---

# DESIGN

Add a second ROI transition guardrail for tracker churn:

* `roi.transitions.track_lost_exit_ms` (non-negative int)
  * `0` disables synthetic track-lost exits (legacy behavior)
  * `>0` means: if a track with committed-inside ROI state is unseen for this long, emit one `roi_exit` with reason `track_lost`, then clean up state.

Event shape (existing `events[]` envelope, no protocol version bump needed):

* `name: "roi_exit"`
* `data: { "roi": "<region_name>", "reason": "track_lost" }`

Normal observed exits stay unchanged (`data` may continue to be just `{ "roi": "..." }`).

---

# IMPLEMENTATION ITERATIONS (START AT 123)

## Iteration 123 — Config plumbing for track-lost ROI exits (no behavior change yet)

Goal:
* Add `roi.transitions.track_lost_exit_ms` config loading and surface it in logs/health.

Deliverables:

1) `packages/eva/vision/settings.yaml`
Add default:

```yaml
roi:
  transitions:
    min_transition_ms: 250
    track_lost_exit_ms: 800
```

2) `packages/eva/vision/app/roi.py`

* Extend `RoiSettings` with:
  * `transition_track_lost_exit_ms: int`
* Parse/validate:
  * `roi.transitions.track_lost_exit_ms` using `_as_non_negative_int`
* Store value in `_roi_settings`.

3) `packages/eva/vision/app/main.py`

* Startup ROI config log includes `track_lost_exit_ms`.
* `/health` includes `roi_track_lost_exit_ms`.

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`
* Manual:
  * start Vision and confirm startup log includes track-lost exit value
  * `GET /health` includes `roi_track_lost_exit_ms`

Stop; update `progress.md`.

---

## Iteration 124 — Emit synthetic `roi_exit` on track-lost timeout

Goal:
* Ensure ROI exits are emitted even when track continuity breaks.

Deliverables:

1) `packages/eva/vision/app/events.py`

A) Update stale-track cleanup flow:

* `_evict_stale_track_state(...)` should be able to append events (pass `events` + `now_ts_ms`).
* Read `track_lost_exit_ms = self._roi_settings.transition_track_lost_exit_ms`.

B) Track-lost exit behavior:

* For each stale track where unseen duration `>= track_lost_exit_ms` (and config > 0):
  * for every region with committed inside state (`state.regions_inside[region] is True`):
    * emit one `roi_exit` event with:
      * `severity: "low"`
      * `track_id` set
      * `data: { "roi": region_name, "reason": "track_lost" }`
  * clear ROI state for that track and remove it from `_tracks`.

C) Preserve legacy disable behavior:

* If `track_lost_exit_ms <= 0`, do not emit synthetic exits; keep legacy stale cleanup behavior.

D) Keep normal observed transition behavior unchanged:

* Existing debounce-based inside/outside commit logic remains as-is.

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`
* Manual test A (track churn path):
  1. Set `roi.transitions.min_transition_ms: 250`
  2. Set `roi.transitions.track_lost_exit_ms: 800`
  3. Enter ROI (get `roi_enter`)
  4. Leave in a way that often causes re-ID/loss
  5. Confirm a delayed `roi_exit` appears with `reason: "track_lost"`

* Manual test B (normal observed path):
  1. Keep same track visible while moving clearly inside -> outside
  2. Confirm normal `roi_exit` still emits (without requiring `reason`).

* Manual test C (legacy mode):
  1. Set `roi.transitions.track_lost_exit_ms: 0`
  2. Confirm synthetic `reason: "track_lost"` exits are not emitted.

Stop; update `progress.md`.

---

## Iteration 125 — Docs + tuning guide for exit reliability

Goal:
* Document semantics and tuning of debounce + track-lost exit timers.

Deliverables:

1) `packages/eva/vision/README.md`

Add/update ROI transitions section with:

* `roi.transitions.min_transition_ms`
  * observed boundary debounce
* `roi.transitions.track_lost_exit_ms`
  * synthetic exit timeout when track disappears
  * `0` disables synthetic track-lost exits

Add tuning guidance:

* Typical starting point:
  * `min_transition_ms: 150–300`
  * `track_lost_exit_ms: 500–1500`
* If exits are missing under re-ID churn: lower `track_lost_exit_ms` moderately.
* If false exits appear during brief occlusion: raise `track_lost_exit_ms`.

2) Update ROI config examples in README to include both transition keys.

Acceptance:

* `cd packages/eva/vision && python3 -m compileall app`

Stop; update `progress.md`.
