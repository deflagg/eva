## docs/implementation-plan-132-136.md

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/test passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow for review and feedback before proceeding to the next one.
* Keep progress in progress.md

ASSUMPTION:
* Iterations 0–131 from the prior plan(s) are complete.
* Scene-change is stable and insights are being generated.
* You want EVA to “act like a person” — natural, reactive, conversational — but ONLY when an insight is triggered.

────────────────────────────────────────────────────────────
GOAL (ITERATIONS 132–136)
────────────────────────────────────────────────────────────
1) EVA ONLY speaks when an INSIGHT is triggered (never on raw events).
2) The spoken line sounds like a real person reacting:
   - quick interjection (“whoa”, “wait”, “hold up”, “what the heck”, “no way”)
   - one grounded observation (hedged)
   - one follow-up question
3) Remove all gendered language from the assistant output (no “his/her”, no gender guesses).
4) Increase variety of openers and phrasing so it doesn’t sound templated.
5) Add explicit PERSON-focused examples (in addition to object/pet/door examples).
6) Keep “false alarm” behavior: if there’s no meaningful change, say so naturally.

────────────────────────────────────────────────────────────
DESIGN OVERVIEW
────────────────────────────────────────────────────────────
A) Executive (Agent) generates structured insight via tool `submit_insight` including `tts_response`.
B) Vision passes `tts_response` through `insight.summary.tts_response`.
C) Eva emits ONE `text_output` utterance only when an Insight arrives (text = tts_response).
D) UI auto-speaks only insight-derived utterances (and user chat replies), as a guardrail.

────────────────────────────────────────────────────────────
IMPLEMENTATION ITERATIONS — START AT 132
────────────────────────────────────────────────────────────

Iteration 132 — Executive: rewrite Insight prompt to enforce (a) no gender, (b) high variety, (c) more person examples
Goal:
* Make `tts_response` sound like a person in real life, remove gendered language, and increase variety.

Deliverables:
* Update `packages/eva/executive/src/prompts/insight.ts` (`buildInsightSystemPrompt`).

1) Keep hard constraints:
- Call `submit_insight` exactly once.
- No plain text outside the tool call.

2) Replace/extend `tts_response` guidance with:

HUMAN REACTION STYLE:
- 1–2 short spoken-friendly sentences.
- React like a person: a quick opener + a grounded guess + a question.
- Hedging is good: “looks like / seems like / might’ve”.

NO GENDER LANGUAGE (HARD RULE):
- Never use gendered pronouns or gendered words: no “his”, “her”, “him”, “she”, “he”, “boyfriend”, etc.
- Use “they”, “someone”, “a person”, “the subject”, or just omit pronouns entirely.

VARIETY (HARD RULE):
- Do not reuse the same opener repeatedly.
- Rotate openers among: “Whoa”, “Wait”, “Hold up”, “Huh”, “No way”, “Yo”, “Uh…”, “Oh—”, “Okay…”
- Vary question forms: “What was that?”, “Did you see that too?”, “Is that expected?”, “Everything alright?”, “Want me to keep watching?”

FALSE ALARM BEHAVIOR:
- If there’s no meaningful visual change across frames, treat it as a false alarm.
  - one_liner: “No significant change detected.”
  - what_changed: ["No meaningful visual change across frames."]
  - severity: low
  - tags: include "no_change" (or "uncertain")
  - tts_response: choose one of these (vary):
    - “Huh—might’ve been nothing. Want me to keep watching?”
    - “Okay, false alarm. Want me to stay on it?”
    - “Never mind—doesn’t look like anything changed. Keep an eye out anyway?”

3) Add expanded examples (STYLE ONLY) — include PEOPLE examples:

PEOPLE (examples):
- “Whoa—did someone just crack a smile? What’s going on?”
- “Wait—did their expression change a bit? Did something happen?”
- “Huh—someone looks more upbeat all of a sudden. Something good happen?”
- “Hold up—did they look startled for a second? Everything okay?”

OBJECTS / ENVIRONMENT (examples):
- “Wait—did something just fall? Everything alright?”
- “Whoa—did that chair just spin? Did something bump it?”
- “Hold up—did something like a door or gate move? Is that expected?”
- “No way—did something slide across the floor? What was that?”

ANIMALS (examples):
- “Yo—pretty sure an animal just walked by. Want me to describe it?”
- “Huh—did a cat just cruise through? Did you see that?”

BLUR / OCCLUSION (examples):
- “Uh—did it go blurry for a second? Everything okay over there?”
- “Wait—did something block the view for a moment? What happened?”

Acceptance:
* `cd packages/eva/executive && npm run build`
* Manual:
  - Trigger multiple insights and confirm:
    - zero gendered pronouns/terms
    - opener variety (not always “Whoa—”)
    - person examples appear appropriately when a person is actually visible
    - no-change clips produce “false alarm” style speech

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 133 — Executive: configurable “tts_style” dial (clean vs spicy) for human reaction intensity
Goal:
* Allow stronger reactions (“what the f—”) optionally, without hardcoding it.

Deliverables:
1) Add config:
- In `packages/eva/executive/src/config.ts` (AgentConfig validation):
  - Add `insight.ttsStyle: "clean" | "spicy"` default "clean"

2) Thread into prompt:
- Update `buildInsightSystemPrompt(maxFrames, ttsStyle)` call sites.
- Prompt rule:
  - clean: “what the heck / what was that”
  - spicy: allow occasional mild profanity (not constant), but still no slurs/harassment.

Acceptance:
* `cd packages/eva/executive && npm run build`
* Manual:
  - clean mode → softened language
  - spicy mode → occasional stronger reaction

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 134 — Vision/Eva/UI: ensure `tts_response` is carried end-to-end and visible
Goal:
* Ensure no one drops `tts_response`.

Deliverables:
- Vision:
  - `packages/eva/vision/app/protocol.py`: Insight summary includes `tts_response`
  - `packages/eva/vision/app/insights.py`: include `tts_response` in summary payload
- Eva:
  - `packages/eva/src/protocol.ts`: InsightSummarySchema includes `tts_response`
- UI:
  - `packages/ui/src/types.ts`: InsightSummary includes `tts_response`
  - (Optional) show `tts_response` as a secondary line in “Latest insight” panel

Acceptance:
* All builds pass.
* Manual: trigger insight_test; confirm `tts_response` arrives in UI.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 135 — Eva: speak ONLY on Insight; remove all event-based speaking paths
Goal:
* No “Alert: scene change” or event-driven assistant messages.
* Exactly one assistant utterance per insight.

Deliverables:
- `packages/eva/src/server.ts`:
  1) Remove event-based alert speaking logic (if any remains).
  2) On inbound `insight`:
     - emit one `text_output` using `insight.summary.tts_response` (fallback: one_liner)
     - set `session_id = "system-insights"`
     - add meta.trigger_kind="insight", meta.trigger_id=clip_id
     - dedupe by clip_id

Acceptance:
* No assistant messages during raw events.
* One assistant message on insight.

Stop; update progress.md.

────────────────────────────────────────────────────────────

Iteration 136 — UI guardrail: auto-speak only insight utterances (and chat replies), plus docs
Goal:
* Future-proof: UI should only auto-speak insight-driven system speech.

Deliverables:
- `packages/ui/src/main.tsx`:
  - only auto-speak `text_output` when:
    - it is a user chat reply, OR
    - meta.trigger_kind === "insight"
- Docs:
  - `packages/ui/README.md` updated with the rule.

Acceptance:
* Build passes.
* Manual: only insight utterances are spoken.

Stop; update progress.md.