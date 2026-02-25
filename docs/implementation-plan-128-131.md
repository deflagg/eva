## docs/implementation-plan-128-131.md

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md

ASSUMPTION:
* Iterations 0–127 from the prior plan(s) are complete.
* Vision emits stable scene-change events and triggers insights when thresholds/cooldowns permit.
* Executive insight tool `submit_insight` exists and returns `tts_response`.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 128–131)
────────────────────────────────────────────────────────────
Only “say something” when an *insight* is actually triggered.

1) No speech/text alerts for raw events (including `scene_change`).
2) When an `insight` arrives, Eva emits ONE conversational assistant utterance to the UI.
3) That utterance must sound like a human reacting to the scene (even when no person is present):
   - “whoa”, “wait—what was that?”, “did something just fall?”, “did that chair just spin?”
   - ask a follow-up question
   - hedge uncertainty (don’t accuse; don’t over-claim)
4) Insight LLM call must be guided by a system prompt that produces:
   - factual `one_liner` + `what_changed`
   - “human reaction” `tts_response` that is helpful, not creepy, and not person-assumptive

────────────────────────────────────────────────────────────
DESIGN OVERVIEW
────────────────────────────────────────────────────────────
A) Executive model produces `tts_response` (via `submit_insight`) that we want to speak.
B) Vision must include `tts_response` in `insight.summary` so Eva/UI can use it.
C) Eva must stop generating any event-based “Alert: …” outputs.
D) Eva should only emit `text_output` derived from an Insight, deduped per clip_id.
E) UI will auto-speak the `text_output` if speech/autospeak is enabled.

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 128
────────────────────────────────────────────────────────────

Iteration 128 — Executive: rewrite Insight system prompt for scene-agnostic “human reaction” `tts_response`
Goal:
* Make `tts_response` work for ANY scene: person, pet, object motion, door/gate movement, lighting, etc.
* Make it sound like a person reacting (“whoa / what was that”) without being creepy or accusatory.

Deliverables:
* Update `packages/eva/executive/src/prompts/insight.ts` (currently has generic `tts_response` rules).

1) Keep hard constraints:
- Call `submit_insight` exactly once.
- No plain text outside the tool call.

2) Replace/extend the `tts_response` section with the following policy:

TTS STYLE:
- `tts_response` must be 1–2 short spoken-friendly sentences.
- It should sound like a natural human reaction to an unexpected change.
- Prefer interjections: “whoa”, “huh”, “wait—what was that?”, “yo…”
- Include ONE gentle follow-up question most of the time.

SAFETY / NON-CREEPY RULES:
- Never mention cameras, frames, “I analyzed”, models, telemetry, IDs, tokens/cost.
- Never accuse a person (“who threw that?”) as a statement of fact.
  Use uncertainty: “did something just fall?” / “did someone bump it?” / “could that have been the wind?”
- Don’t over-claim emotion or intent. Hedge with “looks like / seems like / might’ve”.

SCENE-AWARE RESPONSE POLICY:
- If a person is clearly present: a friendly check-in is OK (hedged).
- If no person is present: react to the change and ask if the user expected it.
- If a pet/animal is visible: keep it light and observational.
- If an object fell/moved/spun: react and lightly check for safety (“everything okay over there?”) without alarmism unless severity is high.
- If door/gate/window moves: react and ask if it’s expected.

3) Add example templates (style only; model can vary wording):
- Object spins: “Whoa—did that chair just spin? Did you bump it, or is something moving it?”
- Object falls: “Wait—did something just fall? Everything okay?”
- Door/gate: “Uh—did a door or gate just open? Is that supposed to happen?”
- Animal: “Haha—pretty sure an animal just walked by. Want me to describe what I saw?”
- Person present: “You looked startled for a moment—everything okay now?”

4) Profanity guidance (no new config yet; keep it simple):
- Prefer “what the heck” over explicit profanity.
- Do NOT output slurs or harassment.
(If you want “spicy mode” later, add it as a separate follow-on plan; do not expand scope here.)

Acceptance:
* `cd packages/eva/executive && npm run build`
* Manual:
  - Trigger a few insights (include non-person scenes if possible).
  - Confirm `tts_response` matches the policy and examples.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 129 — Vision + Protocol: carry `tts_response` in Insight payload end-to-end
Goal:
* Insight messages include `summary.tts_response` all the way to UI.

Deliverables:
1) Vision protocol:
* `packages/eva/vision/app/protocol.py`
  - Add `tts_response` to the Insight summary model (required, min length 1).

2) Vision insight packaging:
* `packages/eva/vision/app/insights.py`
  - When building `summary_payload`, include `tts_response` from the Agent response.

3) Eva protocol schema:
* `packages/eva/src/protocol.ts`
  - Extend `InsightSummarySchema` to include `tts_response: z.string().min(1)`.

4) UI types:
* `packages/ui/src/types.ts`
  - Extend InsightSummary to include `tts_response`.

5) Protocol docs:
* `packages/protocol/README.md` (and schema.json if maintained)
  - Document insight.summary.tts_response.

Acceptance:
* `cd packages/eva/vision && python -m app.run`
* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual:
  - Trigger insight_test; confirm incoming insight payload contains `tts_response`.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 130 — Eva: remove event-based “Alert:” output; emit a single utterance only on Insight
Goal:
* Eliminate “Alert: scene change” and any other event-triggered utterances.
* Emit exactly one assistant utterance when an insight arrives.

Deliverables:
1) Remove event alert path:
* `packages/eva/src/server.ts`
  - Remove any logic that sends `text_output` (or `speech_output`) based on events severity.
  - Keep forwarding events to agent `/events` intact (wm_event ingest still happens; just no “say something” output).

2) Add insight-driven utterance:
* In `message.type === 'insight'` handler:
  - Send a `text_output` message to the UI:
    - `text = insight.summary.tts_response` (fallback to one_liner if missing)
    - `session_id = "system-insights"` (avoid “alerts” naming)
    - `meta.note = "Auto utterance from insight."`
    - `meta.concepts = ["insight"]`
    - Add passthrough fields in meta (allowed by UI types): trigger_kind="insight", trigger_id=clip_id

3) Dedupe:
- Use `clip_id` dedupe so the utterance is sent once per insight.

Acceptance:
* `cd packages/eva && npm run build`
* Manual:
  - Create scene changes without insights: confirm no “Alert:” utterances happen.
  - Trigger an insight: confirm exactly one conversational assistant utterance appears.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 131 — UI polish (optional guardrail) + docs
Goal:
* Ensure only insight-derived utterances are auto-spoken (future-proof).

Deliverables (recommended):
* `packages/ui/src/main.tsx`
  - In auto-speak logic for `text_output`, only auto-speak when:
    - it is a user chat reply OR
    - meta.trigger_kind === "insight"
  - Keep behavior minimal; no refactor.

Docs:
* Update `packages/ui/README.md`:
  - Clarify: “System speech happens only on insight outputs.”
* Update root README or Eva README (optional):
  - Document the new behavior.

Acceptance:
* `cd packages/ui && npm run build`
* Manual:
  - Confirm no speaking for raw scene_change events.
  - Confirm speaking happens for insight utterances.

Stop; update progress.md.