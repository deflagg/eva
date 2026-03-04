# docs/implementation-plan-241-242.md — Remove Presence Checks from Audio Runtime (Wake-only)

Implement in **SMALL ITERATIONS** so diffs stay reviewable.
Do not do broad refactors; keep each iteration scoped and reversible.

Each iteration must end with:
- build/typecheck/compile + tests passing (or explicit manual steps)
- short change summary + files changed
- clear run instructions
- update `docs/progress.md`
- STOP for review

---

## INTENT (LOCKED)

- Vision continues to produce presence in `insight.summary.presence` (NO CHANGES).
- Executive `/presence` may continue to exist (NO CHANGES).
- **Audio runtime must have ZERO presence integration**:
  - no HTTP calls to Executive `/presence`
  - no `executive:` config section in audio settings
  - no `gating.presence_window_ms` config section in audio settings
  - no presence stats fields in Audio `/health`
  - remove the `ExecutiveClient` module used only for `/presence`

Audio gating remains:
- **Idle (not active):** run STT, require transcript wake phrase match
- **Active:** accept with speaker rules unchanged (speaker subsystem remains as-is)

Non-goals (explicit):
- Do NOT change speaker verification behavior.
- Do NOT change wake phrase algorithm (still `WakeWordDetector.match_transcript`).
- Do NOT change Vision/Executive presence architecture.

---

## CURRENT BASELINE (repo today)

- Audio runtime still imports `ExecutiveClient` and calls `/presence` in the non-active path (telemetry-only).
- Audio config includes:
  - `executive.base_url`, `executive.timeout_ms`
  - `gating.presence_window_ms`
- Docs (`README.md`, `docs/audio-transcript-wake-runbook.md`) still claim presence bypass acceptance (stale).
- Guardrail script (`packages/eva/scripts/check-audio-wake-cutover-guardrails.mjs`) asserts presence-bypass runbook text (stale).

---

## TARGET END STATE (NO AMBIGUITY)

After this plan:
- `packages/eva/audio/app/main.py` contains **no**:
  - `get_presence`
  - `/presence`
  - `PresenceSnapshot`
  - presence-related stats fields
- `packages/eva/audio/app/executive_client.py` is deleted.
- `packages/eva/audio/settings.yaml` contains **no** `executive:` and **no** `gating:`.
- `packages/eva/audio/app/config.py` contains **no** `ExecutiveConfig` and **no** `GatingConfig`.
- `packages/eva/audio/requirements.txt` contains **no** `httpx`.
- Tests no longer stub an executive presence client.
- Docs + guardrails match wake-only behavior.

---

# ITERATIONS

## Iteration 241 — Remove presence integration from Audio runtime (code + config + deps + tests)

Goal:
- Audio runtime has **zero presence code** and **zero Executive /presence usage**.

Deliverables (execute exactly):

### A) Delete presence HTTP client module
- DELETE file: `packages/eva/audio/app/executive_client.py`

### B) Remove executive + gating config from audio config loader
Edit: `packages/eva/audio/app/config.py`

1) Delete dataclasses:
- `ExecutiveConfig`
- `GatingConfig`

2) Update `AppConfig` dataclass:
- remove fields:
  - `executive: ExecutiveConfig`
  - `gating: GatingConfig`

3) Update `_build_app_config(settings)`:
- remove reading of:
  - `executive.base_url`
  - `executive.timeout_ms`
  - `gating.presence_window_ms`

4) Update `config_summary(config)`:
- remove `"executive": {...}`
- remove `"gating": {...}`

No other config behavior changes.

### C) Remove executive + gating sections from committed audio settings
Edit: `packages/eva/audio/settings.yaml`

- DELETE the entire `executive:` block
- DELETE the entire `gating:` block

Keep everything else unchanged.

### D) Remove presence logic and stats from audio runtime main loop + health
Edit: `packages/eva/audio/app/main.py`

1) Remove imports:
- remove: `from .executive_client import ExecutiveClient, ExecutiveClientError, PresenceSnapshot`

2) Remove globals + getters:
- delete `_executive_client: ExecutiveClient | None`
- delete `_get_executive_client()` function
- remove any remaining references to `_executive_client`

3) Startup summary:
- remove `executive=...` from the startup print line
- remove any code that creates/uses `ExecutiveClient` during startup

4) WS stats:
In `WsRuntimeStats`, DELETE these fields:
- `presence_checks`
- `presence_check_errors`
- `last_presence_found`
- `last_presence_preson_present`
- `last_presence_person_facing_me`
- `last_presence_age_ms`
- `last_presence_ts_ms`
- `accepted_by_presence`

5) `/health` response:
Remove the presence fields from the `"ws": {...}` payload.
(Do not leave keys with `null`; remove them entirely.)

6) `/listen` gating logic (non-active branch):
In the non-active path (the `else:` corresponding to `if was_active:`):
- DELETE the entire presence check block (everything that calls or handles `/presence`)
- Ensure wake-only behavior is:
  - always run STT for wake check
  - call `wake_detector.match_transcript(...)`
  - accept only when `wake_detected == True` (set `accept_reason = "wake_phrase"`)

7) Rejection logging:
- Remove `presence_detail` formatting entirely.
- The rejection log line must not mention `presence=`.

8) Accepted-by-reason counters:
- remove any branch that increments `accepted_by_presence`
- keep only:
  - `accepted_by_wake_phrase`
  - `accepted_by_active`

### E) Remove httpx dependency (no longer used)
Edit: `packages/eva/audio/requirements.txt`

- REMOVE line: `httpx>=...`

Do not remove `requests>=...` (guardrail expects it today).

### F) Update tests to match wake-only + no presence client
Edit: `packages/eva/audio/tests/test_wake_and_gating.py`

1) Remove imports:
- remove `ExecutiveConfig` and `GatingConfig` from `app.config`
- remove `PresenceSnapshot` import
- remove `main._get_executive_client` patching from `_run_session`

2) Delete presence stub code:
- delete `_StubExecutiveClient`
- delete any `executive_client` parameters and wiring in `_run_session`

3) Replace gating tests with wake-only equivalents:

Required tests after rewrite:

- `test_idle_no_wake_phrase_rejects`
  - STT returns transcript without wake phrase (e.g., `"what time is it"`)
  - Assert:
    - only `"hello"` is sent (no `speech_transcript`)
    - `utterances_rejected == 1`
    - `wake_phrase_checks == 1`
    - `wake_phrase_matches == 0`
    - `transcripts_emitted == 0`

- `test_idle_wake_phrase_accepts`
  - STT returns transcript containing wake phrase (e.g., `"hey eva what time is it"`)
  - Assert:
    - `speech_transcript` emitted
    - `accepted_by_wake_phrase == 1`
    - `wake_phrase_checks == 1`
    - `wake_phrase_matches == 1`

- `test_active_window_continuation_still_accepts_active_utterances`
  - Keep the same structure as existing test but remove executive expectations.
  - Assert:
    - `accepted_by_wake_phrase == 1` (first utterance)
    - `accepted_by_active == 1` (second utterance)
    - `transcripts_emitted == 2`
    - `utterances_rejected == 0`

4) Keep existing legacy wake regression tests unchanged (Porcupine keys).

Acceptance (must run all):
- `cd packages/eva/audio && python3 -m compileall -f app`
- `cd packages/eva/audio && python3 -m unittest discover -s tests -v`
- `cd packages/eva && npm run build` (sanity; should remain green)

Stop; update `docs/progress.md`.

---

## Iteration 242 — Update docs + update guardrails to enforce “no presence in audio”

Goal:
- Docs match wake-only behavior.
- Guardrails fail if presence is reintroduced to audio runtime.

Deliverables:

### A) Update runbook to remove presence bypass and remove `/presence` mention
Edit: `docs/audio-transcript-wake-runbook.md`

Replace the “Non-active utterance gating rules” section with EXACT text:

- When conversation is **not active**:
  1) Run STT on the utterance.
  2) Match transcript against `wake.phrases`.
  3) If match succeeds → accept (`accept_reason=wake_phrase`).
  4) Otherwise → reject (no transcript emitted).

Remove all checklist steps referencing presence true/false.

Add explicit line:
- “Audio runtime does not query Executive `/presence`.”

### B) Update root README to remove presence bypass claim for audio
Edit: `README.md`

Update the “Audio wake behavior …” section so it states:
- Wake activation is transcript-based.
- Idle acceptance requires wake phrase match.
- Audio does not use presence gating.

Do NOT change the “Presence source of truth” section (Vision/Executive still own that).

### C) Update guardrail script to match new docs AND enforce presence removal
Edit: `packages/eva/scripts/check-audio-wake-cutover-guardrails.mjs`

1) Remove assertions that require runbook presence-bypass checklist text.
2) Add assertions:

- Audio settings has no presence plumbing:
  - `assertNotContains(settings, 'executive:', 'audio settings should not include executive config')`
  - `assertNotContains(settings, 'gating:', 'audio settings should not include gating config')`

- Audio runtime main has no presence usage:
  - `assertNotContains(main, '/presence', 'audio runtime must not call Executive /presence')`
  - `assertNotContains(main, 'get_presence', 'audio runtime must not reference get_presence')`

- Runbook does not mention presence bypass:
  - `assertNotContains(runbook, 'Presence TRUE', 'runbook must not claim presence bypass behavior')`
  - `assertContains(runbook, 'Audio runtime does not query Executive `/presence`', 'runbook must explicitly state no presence queries')`

- Root README does not claim presence bypass for audio:
  - `assertNotContains(rootReadme, 'presence true/fresh', 'root README must not claim presence bypass for audio')`

Acceptance:
- `cd packages/eva && npm run check:audio-wake-guardrails`

Stop; update `docs/progress.md`.

