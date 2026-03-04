# docs/implementation-plan-<start>-<end>.md — <Project/Feature Title>

Implement in **SMALL ITERATIONS** so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration.

Each iteration must end with:
- build/typecheck/compile checks passing (or explicit manual test steps included)
- short change summary + files changed
- clear run instructions
- update `docs/progress.md` (create it if missing)
- STOP after each iteration for review

---

## REQUEST SUMMARY

- Problem statement:
  - <what needs to change>
- Requested constraints:
  - <hard constraints from requester>
- Scope boundary:
  - <what is in scope for this plan>

---

## ASSUMPTION (CURRENT BASELINE)

Current behavior (verified in repo):
- <file/path>: <what it does today>
- <file/path>: <current test/doc behavior>

Known gaps / risks:
- <risk 1>
- <risk 2>

---

## GOAL (END STATE)

1) <target outcome 1>
2) <target outcome 2>
3) <target outcome 3>

---

## NON-GOALS (LOCKED)

- No <out-of-scope refactor A>.
- No <out-of-scope behavior change B>.
- No <out-of-scope dependency/config migration C>.

---

## DEFINITIONS (LOCKED)

### <Term or Policy 1>
- <precise behavior rule>
- <accept/reject criteria>

### <Term or Policy 2>
- <exact semantics>
- <compatibility note>

### Telemetry / metrics impact (if applicable)
- Keep/update fields:
  - `<field_1>`
  - `<field_2>`
- Remove/deprecate fields:
  - `<field_legacy_1>`

---

## FILE SURFACES (LOCKED)

Primary:
- `<path/to/main/runtime/file>`
- `<path/to/secondary/file>`

Tests:
- `<path/to/tests>`

Docs:
- `docs/progress.md`
- `<optional other docs path>`

---

## ITERATIONS (START AT <N>)

## Iteration <N> — <Short Iteration Name>

Goal:
- <single focused goal>

Deliverables:
1. `<path/to/file>`
   - <exact edit requirement>
   - <exact edit requirement>
2. <optional second deliverable>

Acceptance:
- `<exact command>`
- `<exact command>`
- <behavior assertion(s)>

Stop; update `docs/progress.md`.

---

## Iteration <N+1> — <Short Iteration Name>

Goal:
- <single focused goal>

Deliverables:
1. `<path/to/file>`
   - <exact edit requirement>
2. `<path/to/test/file>`
   - <test updates / assertions>

Acceptance:
- `<exact command>`
- <behavior assertion(s)>

Stop; update `docs/progress.md`.

---

## Iteration <N+2> — <Short Iteration Name>

Goal:
- <single focused goal>

Deliverables:
1. `<path/to/file>`
   - <cleanup/tightening/docs alignment>

Acceptance:
- `<exact command>`
- `<exact command>`
- quick manual run:
  - <manual case 1>
  - <manual case 2>

Stop; update `docs/progress.md`.

---

## ROLLBACK PLAN

If behavior/regression risk is unacceptable:
1. Revert commit(s) for Iteration <N>.
2. Revert commit(s) for Iteration <N+1>.
3. Keep only neutral docs/telemetry changes if safe.

---

## OPERATOR NOTES

- Keep this plan execution strictly incremental.
- Prefer the smallest possible diff that satisfies each iteration.
- If a new requirement appears mid-plan, create a follow-up plan/iteration set instead of expanding scope in-place.
