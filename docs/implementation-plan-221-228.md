# docs/implementation-plan-221-228.md — Audio Runtime Hard Cutover to Transcript Wake + Presence Bypass

Implement in **SMALL ITERATIONS** so diffs stay reviewable.
Do not do broad refactors; keep each iteration scoped and reversible.

Each iteration must end with:
- build/typecheck/compile checks passing (or explicit manual test steps)
- short change summary + files changed
- clear run instructions
- update `progress.md`
- STOP for review

---

## INTENT (from product direction)

- Remove Picovoice Porcupine completely from audio runtime.
- Keep no-wake operation when presence is detected/fresh.
- When presence is absent, require configured wake word/phrase in STT transcript.
- Streamline runtime and remove unneeded config/code/dependencies.

---

## CURRENT BASELINE (after Iteration 220)

- Audio wake path is hard-coded to Porcupine (`wake.provider=porcupine`).
- Audio startup currently logs Porcupine readiness/errors and expects `PV_ACCESS_KEY`.
- Non-active utterance acceptance is:
  - Porcupine wake OR
  - presence from Executive `/presence`.
- STT currently runs only after an utterance is already accepted.
- `audio/wakewords/*.ppn` and `pvporcupine` are still part of the runtime surface.

---

## TARGET END STATE

1. **No Porcupine** code path, dependency, config, env vars, or logs.
2. Acceptance logic for non-active utterances:
   - Presence true (`preson_present && person_facing_me`) => accept without wake phrase.
   - Presence false => run STT and require transcript wake phrase match.
3. Conversation active window behavior preserved.
4. Startup/health/telemetry reflect transcript wake architecture only.
5. Audio runtime surface is leaner and easier to operate.

---

## DESIGN RULES (LOCKED)

1. Hard cut only: do not keep dormant provider switches for Porcupine fallback.
2. Preserve presence-bypass behavior as a first-class activation path.
3. Keep changes incremental and reversible per iteration.
4. Keep protocol compatibility for downstream transcript consumers.
5. Remove dead config keys and dependencies once replacement is live.

---

## TARGET WAKE CONFIG SHAPE (PROPOSED)

```yaml
wake:
  phrases:
    - "hey eva"
    - "okay eva"
  match_mode: word_boundary # one of: contains|exact|word_boundary
  case_sensitive: false
  min_confidence: 0.0
```

Notes:
- `phrases` must be non-empty.
- `min_confidence` is applied to STT confidence when available.
- No `provider`, `keyword_path`, `sensitivity`, `access_key_env`, `access_key`.

---

# ITERATIONS (START AT 221)

## Iteration 221 — Config schema hard cut from Porcupine to transcript wake

Goal:
- Remove Porcupine config model/validation and replace with transcript wake config.

Deliverables:
- `packages/eva/audio/app/config.py`
  - replace `WakeConfig` fields with transcript wake fields
  - remove validation forcing `wake.provider == porcupine`
  - validate phrase list + match mode
  - update `config_summary()` wake section
- `packages/eva/audio/settings.yaml`
  - replace wake section with transcript wake fields

Acceptance:
- `cd packages/eva/audio && python3 -m compileall -f app`
- startup fails fast with clear config error on empty phrase list.

Stop; update `progress.md`.

---

## Iteration 222 — Replace `wake.py` with transcript matcher runtime

Goal:
- Remove Porcupine runtime classes and implement transcript phrase matcher.

Deliverables:
- `packages/eva/audio/app/wake.py`
  - delete Porcupine detector classes
  - add transcript matcher implementation:
    - normalization
    - contains/exact/word_boundary modes
    - optional confidence threshold gate
  - expose typed match result/status for runtime stats/logging

Acceptance:
- `cd packages/eva/audio && python3 -m compileall -f app`
- unit/manual checks for phrase matching modes pass.

Stop; update `progress.md`.

---

## Iteration 223 — Gating flow refactor: presence-first + transcript wake fallback

Goal:
- Change non-active utterance acceptance to preserve presence bypass and use transcript wake when needed.

Deliverables:
- `packages/eva/audio/app/main.py`
  - non-active utterance flow:
    1. check `/presence`
    2. accept immediately if presence true
    3. otherwise run STT
    4. apply transcript matcher
  - accept reasons standardized:
    - `presence`
    - `wake_phrase`
    - `active`
  - keep active-window and speaker-lock behavior intact

Acceptance:
- `cd packages/eva/audio && python3 -m compileall -f app`
- manual matrix:
  - presence=true, no phrase => accepted
  - presence=false, phrase match => accepted
  - presence=false, no phrase => rejected

Stop; update `progress.md`.

---

## Iteration 224 — Startup/health/telemetry cleanup for new architecture

Goal:
- Ensure observability reflects transcript wake model only.

Deliverables:
- `packages/eva/audio/app/main.py`
  - startup logs: remove Porcupine/provider/access-key wording
  - health payload wake section updated for transcript matcher
  - stats renamed/added:
    - `wake_phrase_checks`
    - `wake_phrase_matches`
    - `last_wake_phrase`
  - remove obsolete Porcupine fields from ws stats

Acceptance:
- `GET /health` has no Porcupine-specific fields
- startup log has no `PV_ACCESS_KEY` or `porcupine` references.

Stop; update `progress.md`.

---

## Iteration 225 — Dependency and asset hard cleanup

Goal:
- Remove unneeded Porcupine dependencies/assets and prevent regression.

Deliverables:
- `packages/eva/audio/requirements.txt`
  - remove `pvporcupine`
  - add explicit `requests` if needed for speechbrain runtime in this env
- remove/retire `packages/eva/audio/wakewords/` usage
- remove Porcupine references from docs/examples/env setup in repo

Acceptance:
- fresh venv install works without Porcupine key
- audio startup has no Porcupine runtime errors.

Stop; update `progress.md`.

---

## Iteration 226 — Runtime streamlining pass (no behavior change)

Goal:
- Reduce startup/load complexity and warning noise while preserving behavior.

Deliverables:
- `packages/eva/audio/app/main.py`
- `packages/eva/audio/app/speaker.py`
- `packages/eva/audio/app/stt.py`
- optional config additions in `packages/eva/audio/app/config.py`:
  - `speaker.enabled` (default true)

Streamlining requirements:
- if `speaker.enabled=false`, skip speaker runtime init cleanly
- keep concise startup summary + actionable warnings only
- avoid duplicate or non-actionable logs

Acceptance:
- compile checks pass
- startup logs clearly indicate enabled/disabled subsystems.

Stop; update `progress.md`.

---

## Iteration 227 — Test coverage for transcript wake + presence bypass

Goal:
- Lock behavior with unit/integration tests.

Deliverables:
- Add/extend tests for:
  1. transcript matcher modes and normalization
  2. confidence threshold behavior
  3. gating matrix (presence bypass vs phrase-required path)
  4. active-window continuation unaffected
- add regression assertions that Porcupine config keys are rejected/absent

Acceptance:
- test suite passes
- gating matrix documented in test output or runbook.

Stop; update `progress.md`.

---

## Iteration 228 — Docs + final regression guardrails

Goal:
- Finalize operator docs and guard against accidental Porcupine reintroduction.

Deliverables:
- docs/runbook updates for new wake behavior and config
- remove outdated credential guidance (`PV_ACCESS_KEY`)
- add explicit checklist for presence-bypass + transcript-wake verification
- optional lint/check script to fail on `pvporcupine` / `wake.provider` references

Acceptance:
- docs and startup instructions are internally consistent
- repo scan confirms no runtime Porcupine references remain.

Stop; update `progress.md`.

---

## FINAL E2E CHECKLIST

1. Start full Eva stack; audio health is 200.
2. Confirm no Porcupine/access-key warnings in startup logs.
3. Presence TRUE + no wake phrase utterance => transcript emitted.
4. Presence FALSE + wake phrase in utterance => transcript emitted.
5. Presence FALSE + no wake phrase => utterance rejected.
6. Active conversation continuation still works until timeout.
7. Fresh install from `requirements.txt` runs without Picovoice setup.
