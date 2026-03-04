# docs/implementation-plan-238-240.md — Audio Gating Policy: Wake Phrase Required Even When Person Is Present/Facing

Implement in **SMALL ITERATIONS** so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration.

Each iteration must end with:
- build/typecheck passing (or explicit manual test steps included)
- short change summary + files changed
- clear run instructions
- update `docs/progress.md` (create it if missing)
- STOP after each iteration for review

---

## ASSUMPTION (CURRENT BASELINE)

Current behavior in `packages/eva/audio/app/main.py`:
- In the non-active gating path, audio checks presence via Executive (`get_presence`).
- If `found && preson_present && person_facing_me`, the utterance is accepted **without** wake phrase:
  - `accepted = True`
  - `accept_reason = "presence"`
  - `wake_match_reason = "presence_bypass"`
- Otherwise it runs STT and wake phrase matching.

Current tests in `packages/eva/audio/tests/test_wake_and_gating.py` include a matrix case that explicitly expects:
- presence=true/facing=true + no wake phrase => accepted by presence.

---

## GOAL (END STATE)

Policy change:
1) Wake phrase is required to enter ACTIVE from idle, even when a person is visible and facing the camera.
2) Presence checks remain available for diagnostics/telemetry only.
3) Existing ACTIVE-window continuation semantics remain unchanged.

---

## NON-GOALS (LOCKED)

- No change to wake phrase matching semantics (`wake.phrases`, `match_mode`, `case_sensitive`, `min_confidence`).
- No change to VAD segmentation logic.
- No change to executive presence schema (`preson_present` typo remains as-is for compatibility).
- No broad refactor of audio state machine beyond the gating branch.

---

## DEFINITIONS (LOCKED)

### Idle → Active entry policy
- `accept_reason="presence"` must never be set for new ACTIVE entry.
- New ACTIVE entry from idle must occur only through wake phrase match (`accept_reason="wake_phrase"`).

### Presence behavior after change
- Presence lookup still runs in non-active path.
- Presence fields and counters still update:
  - `presence_checks`, `presence_check_errors`
  - `last_presence_found`, `last_presence_preson_present`, `last_presence_person_facing_me`, etc.
- Presence result can influence `wake_match_reason` text only (diagnostic metadata), not acceptance.

### Voiceprint update policy
- Voiceprint persistence on ACTIVE entry must be tied to intentional wake engagement only.
- Remove any lingering dependence on `accept_reason="presence"`.

---

## FILE SURFACES (LOCKED)

Primary:
- `packages/eva/audio/app/main.py`
- `packages/eva/audio/tests/test_wake_and_gating.py`

Docs:
- `docs/progress.md`

---

## ITERATIONS (START AT 238)

## Iteration 238 — Remove presence bypass from idle gating

Goal:
- Presence no longer directly accepts utterances.

Deliverables:
1. `packages/eva/audio/app/main.py`
- In the non-active gating branch, remove assignment of:
  - `accepted = True`
  - `accept_reason = "presence"`
  - `wake_match_reason = "presence_bypass"`
- Replace with diagnostic-only marker (e.g. `wake_match_reason = "presence_seen_phrase_required"`) when presence indicates visible+facing.
- Keep exception marker `presence_error_phrase_required` unchanged.

2. Keep downstream acceptance/rejection flow unchanged.

Acceptance:
- `presence=true/facing=true` without wake phrase does not pass acceptance.
- STT+wake check still executes when not already accepted.
- `cd packages/eva/audio && pytest -q tests/test_wake_and_gating.py`

Stop; update `docs/progress.md`.

---

## Iteration 239 — Update gating matrix tests to new policy

Goal:
- Tests encode wake-required behavior and prevent regression.

Deliverables:
1. `packages/eva/audio/tests/test_wake_and_gating.py`
- Rename and update matrix case:
  - from `test_gating_matrix_presence_true_no_phrase_accepts`
  - to `test_gating_matrix_presence_true_no_phrase_rejects`
- Assert:
  - no speech transcript emitted for that case
  - `accepted_by_presence == 0`
  - `wake_phrase_checks == 1`
  - `utterances_rejected == 1`
- Keep existing cases for:
  - presence=false + phrase match => accepts
  - presence=false + no phrase => rejects
  - active-window continuation => accepts active utterances

Acceptance:
- `cd packages/eva/audio && pytest -q tests/test_wake_and_gating.py`
- Optional full package check:
  - `cd packages/eva && npm run build`

Stop; update `docs/progress.md`.

---

## Iteration 240 — Clean up wake-only intent comments/branches

Goal:
- Align comments and narrow conditionals to wake-only semantics.

Deliverables:
1. `packages/eva/audio/app/main.py`
- Update comments that currently mention `wake_phrase/presence ACTIVE entry` to wake-only entry language.
- Tighten any conditional sets that include `"presence"` where no longer reachable in idle-entry path (e.g. voiceprint-upsert eligibility check).

Acceptance:
- `cd packages/eva/audio && pytest -q tests/test_wake_and_gating.py`
- `cd packages/eva && npm run build`
- Quick manual run:
  - person visible/facing + no wake phrase => rejected
  - person visible/facing + wake phrase => accepted

Stop; update `docs/progress.md`.

---

## ROLLBACK PLAN

If behavior is too strict in real-world usage:
1. Revert commit for Iteration 238 (presence bypass removal) to restore previous behavior.
2. Revert Iteration 239 test expectation changes.
3. Keep telemetry additions/comments only if they are neutral.

---

## OPERATOR NOTES

- This plan intentionally keeps presence polling to preserve diagnostics and service-health visibility.
- If a configurable policy is desired later, add a dedicated gating config flag in a separate plan/iteration set (do not mix into 238–240).
