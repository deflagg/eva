# docs/implementation-plan-213-220.md — Presence in Insight Response (no dedicated face detector)

Implement in **SMALL ITERATIONS** so diffs stay reviewable.
Do not do broad refactors; keep each iteration scoped and reversible.

Each iteration must end with:
- build/typecheck passing (or explicit manual test steps)
- short change summary + files changed
- clear run instructions
- update `progress.md`
- STOP for review

---

## INTENT (from product direction)

- Presence should be part of the **insight response shape**.
- No separate Vision-side face detector pipeline.
- Keep existing flow behavior as much as possible.
- Add two indicators to insight output:
  - person present?
  - person facing me?

---

## CURRENT BASELINE (after Iteration 212)

- Vision has a dedicated OpenCV-based presence path emitting `presence_update` events.
- Executive `/presence` freshness is currently fed from those `presence_update` events.
- Audio gating uses Executive `/presence` for no-wake utterances.
- Insight summary currently includes:
  - `one_liner`
  - `tts_response`
  - `what_changed[]`
  - `tags[]`

---

## TARGET END STATE

1. Insight summary shape includes presence fields.
2. Presence signal source for `/presence` is derived from **insight summaries**, not separate `presence_update` telemetry.
3. OpenCV face detector path is removed from Vision.
4. Audio gating uses `/presence` with `preson_present` and `person_facing_me` as the presence fields.

---

## DESIGN RULES (LOCKED)

1. No new dedicated detector service/path for face-only presence.
2. Presence-in-insight should be explicit and typed in all protocol surfaces.
3. Preserve backward compatibility during transition:
   - add fields as optional first
   - switch source of truth only after plumbing is complete
4. Standardize `/presence` on `preson_present` and `person_facing_me` (no `in_view` / `facing` fields).
5. Remove OpenCV/presence telemetry only after `/presence` is fed by insight data.

---

## PRESENCE SHAPE (PROPOSED)

Use a nested object under `summary`:

```json
"summary": {
  "one_liner": "...",
  "tts_response": "...",
  "what_changed": ["..."],
  "tags": ["..."],
  "presence": {
    "preson_present": true,
    "person_facing_me": true
  }
}
```

Notes:
- `preson_present`: boolean
- `person_facing_me`: boolean (false when no person or not facing forward)

---

# ITERATIONS (START AT 213)

## Iteration 213 — Protocol shape extension for insight presence (optional-first)

Goal:
- Add presence fields to insight summary across schema/types without breaking current runtime.

Deliverables:
1. Canonical protocol updates:
- `packages/protocol/schema.json`
- `packages/protocol/README.md`

2. Runtime model updates (optional fields initially):
- `packages/eva/executive/src/tools/insight.ts`
- `packages/eva/vision/app/protocol.py`
- `packages/eva/vision/app/executive_client.py`
- `packages/eva/src/protocol.ts`
- `packages/ui/src/types.ts`

Acceptance:
- `cd packages/eva && npm run build`
- `cd packages/ui && npm run build`
- `cd packages/eva/vision && python3 -m compileall -f app`

Stop; update `progress.md`.

---

## Iteration 214 — Executive insight generation returns presence fields

Goal:
- Executive `/insight` actually produces presence fields via tool output.

Deliverables:
1. Tool schema + prompt updates:
- `packages/eva/executive/src/tools/insight.ts`
- `packages/eva/executive/src/prompts/insight.ts`
  - require model to emit `summary.presence.preson_present` and `summary.presence.person_facing_me`

2. Executive insight handling:
- `packages/eva/executive/src/server.ts`
  - validate persisted/returned insight summary with new fields
  - include fields in `wm_insight` entries

Acceptance:
- `cd packages/eva/executive && npm run build`
- Manual: `POST /insight` returns summary containing `presence` object.

Stop; update `progress.md`.

---

## Iteration 215 — Vision→Eva→UI plumbing for enriched insight summary

Goal:
- Ensure new insight presence fields propagate end-to-end and are not stripped.

Deliverables:
- `packages/eva/vision/app/main.py` (forward unchanged summary)
- `packages/eva/src/protocol.ts` (zod shape includes `summary.presence` so Eva relay preserves it)
- `packages/ui/src/types.ts`
- optional: lightweight display/log in `packages/ui/src/main.tsx`

Acceptance:
- `cd packages/eva && npm run build`
- `cd packages/ui && npm run build`
- Manual: UI receives `insight.summary.presence`.

Stop; update `progress.md`.

---

## Iteration 216 — Executive `/presence` source migration to insight summaries

Goal:
- Feed `/presence` from latest persisted insight presence instead of `presence_update` events.

Deliverables:
- `packages/eva/executive/src/server.ts`
  - maintain latest presence cache from successful `/insight` writes (`wm_insight.summary.presence`)
  - `/presence` endpoint response shape:
    - `{found,preson_present,person_facing_me,ts_ms?,age_ms}`

Transitional safety:
- Keep old event-based cache update path for one iteration as fallback (if needed), but do not expose `in_view`/`facing` in the API response.

Acceptance:
- `cd packages/eva/executive && npm run build`
- Manual: trigger insight with presence, then `GET /presence` reflects it.

Stop; update `progress.md`.

---

## Iteration 217 — Audio gating verification against migrated `/presence`

Goal:
- Keep Audio Runtime behavior stable while using migrated `/presence` source.

Deliverables:
- Update/validate audio gating reads against `/presence` fields:
  - `preson_present`
  - `person_facing_me`
- Validate/log that gating still works for:
  - wake bypass
  - no-wake + fresh presence
  - stale/no presence rejection

Files (if log/telemetry adjustments needed):
- `packages/eva/audio/app/main.py`
- `packages/eva/audio/app/executive_client.py` (only if response typing needs tweak)

Acceptance:
- `cd packages/eva/audio && python3 -m compileall app`
- Manual gating matrix passes.

Stop; update `progress.md`.

---

## Iteration 218 — Remove Vision dedicated presence detector + OpenCV dependency

Goal:
- Remove separate face-detection path now that presence is insight-derived.

Deliverables:
- Remove presence detector runtime path:
  - `packages/eva/vision/app/presence.py`
  - remove presence sampling/emission code from `packages/eva/vision/app/main.py`
- Remove presence config surface from Vision if no longer needed:
  - `packages/eva/vision/app/config.py`
  - `packages/eva/vision/settings.yaml`
- Remove OpenCV dependency:
  - `packages/eva/vision/requirements.txt` (drop `opencv-python-headless`)

Acceptance:
- `cd packages/eva/vision && python3 -m compileall -f app`
- `cd packages/eva && npm run build`
- Manual: no `presence_update` emission from Vision.

Stop; update `progress.md`.

---

## Iteration 219 — Remove remaining `presence_update` plumbing + cleanup

Goal:
- Eliminate obsolete presence telemetry paths after migration.

Deliverables:
- `packages/eva/executive/src/server.ts`
  - remove `presence_update`-event cache update logic once insight-backed path is confirmed stable
- `packages/eva/executive/src/memcontext/working_memory_replay.ts`
  - remove now-obsolete replay filter branch if no longer relevant
- docs cleanup references to `presence_update` as source-of-truth

Acceptance:
- `cd packages/eva/executive && npm run build`
- Manual: `/presence` works with no dependence on `presence_update` ingestion.

Stop; update `progress.md`.

---

## Iteration 220 — Regression guardrails + docs/runbook update

Goal:
- Prevent accidental reintroduction of separate detector telemetry and lock final behavior.

Deliverables:
1. Add/update regression checks to assert:
- Insight schema includes presence fields.
- `/presence` source is insight-derived.
- Vision does not depend on OpenCV presence detector path.

2. Docs updates:
- `packages/protocol/README.md`
- root/feature docs and operational runbook notes.

Acceptance:
- build + regression checks pass
- end-to-end manual checklist passes

Stop; update `progress.md`.

---

## E2E CHECKLIST (final)

1. Trigger insight with a visible person facing camera.
   - insight payload includes `presence: {preson_present:true, person_facing_me:true}`
2. Trigger insight with no person.
   - `presence: {preson_present:false, person_facing_me:false}`
3. `GET /presence?window_ms=...` reflects latest insight presence freshness.
4. Audio no-wake gating respects `/presence` outcome.
5. No Vision `presence_update` telemetry stream exists.
6. OpenCV is no longer required for Vision presence path.
