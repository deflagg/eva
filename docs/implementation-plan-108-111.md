## docs/implementation-plan-108-111.md — Make chat responses human-sounding (fix prompt assembly + context shaping)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in `progress.md`

---

# GOAL

When the user asks something simple like “what just happened”, EVA should answer like a person watching a camera would answer (short, conversational, friendly), while still respecting safety and tool-call constraints.

Examples of desired vibe:
- “Not much — looks like a guy standing there looking tense and messing with his hood.”
- “Nothing urgent. Just someone fidgeting a bit.”

---

# CURRENT STATE (OBSERVED FROM LOGS)

The `/respond` request currently sends:
- System prompt includes an incident-report rubric: “Describe what changed, why it matters, and what to do next.”
- User message content is wrapped as an instruction:
  “Generate a direct response for the user message... user_text: what just happened”
- Recent insights are injected in a report-shaped format:
  “[09:41:13] (medium) The subject appears to adjust their hood...”

These three inputs strongly bias the model toward “Recently, there was…” report language.

---

# DECISIONS (LOCKED)

* No backwards compatibility.
* The model should see the user’s actual message as the user turn (no “Generate a direct response…” wrapper).
* Default response style:
  - 1–2 short sentences
  - casual spoken language (contractions OK)
  - no enumerations unless user asks for details
* Keep safety guidance, but avoid forcing “report structure” on every reply.
* Keep tool constraint: must call `commit_text_response` exactly once.

---

# IMPLEMENTATION ITERATIONS (START AT 108)

## Iteration 108 — Remove user-text wrapper (send raw user message as the user turn)

Goal:
- Stop treating the user message like an instruction prompt.

Deliverables:
1) Locate the code that constructs the OpenAI “messages” array for `/respond`.
   - Use ripgrep:
     - `rg -n "Generate a direct response for the user message" packages/eva`
     - `rg -n "user_text:" packages/eva`
     - `rg -n "commit_text_response" packages/eva`
2) Replace the user message payload:
   - BEFORE:
     - user content: “Generate a direct response… user_text: <text>”
   - AFTER:
     - user content: `<text>` exactly as entered in UI (`payload.request.user_text`)
3) Keep the tool schema + output constraints in the system prompt unchanged for now.

Acceptance:
- Manual: run UI, send “what just happened”.
- Verify logs show the user message content is exactly “what just happened” (no wrapper).
- Response should already become noticeably more conversational.

Stop; update `progress.md`.

---

## Iteration 109 — Remove “incident report rubric” and replace with a spoken-style rubric + 2 examples

Goal:
- Stop instructing the model to write reports by default.

Deliverables:
1) Locate the system prompt template builder for chat.
   - Use ripgrep:
     - `rg -n "Describe what changed" packages/eva`
     - `rg -n "EVA Persona" packages/eva`
     - `rg -n "Persona guidance" packages/eva`
2) Replace/remove this behavior rule:
   - Remove (or rewrite) the line:
     - “Describe what changed, why it matters, and what to do next.”
3) Replace with ONE compact rule and TWO examples (few-shot), e.g.:

   Style rule:
   - “Default to a casual spoken reply: 1–2 short sentences. Summarize like a human. Only expand into a detailed breakdown if the user asks for details or if there is genuine high risk.”

   Examples:
   - User: “what just happened”
     Assistant: “Not much — someone looks a bit tense and is fiddling with their hood. Nothing clearly urgent.”
   - User: “give me details”
     Assistant: “Here’s what I noticed: … (bullets are OK here)”

4) Keep your existing “Never include IDs/telemetry/system internals in spoken output” rule.

Acceptance:
- Manual: ask “what just happened”.
- Output should no longer start with “Recently, there was…”
- Manual: ask “give me details” and confirm it can be more structured.

Stop; update `progress.md`.

---

## Iteration 110 — Make retrieved “Recent insights” context human-shaped (remove timestamps/severity labels from the injected context)

Goal:
- Stop priming the model with report-like context formatting.

Deliverables:
1) Locate the code that formats the “Retrieved memory context” block for chat.
   - Use ripgrep:
     - `rg -n "Retrieved EVA memory context" packages/eva`
     - `rg -n "Recent insights" packages/eva`
     - `rg -n "Context budget" packages/eva`
2) Change injected “Recent insights” formatting:
   - BEFORE:
     - `[09:41:13] (medium) The subject appears to adjust their hood...`
   - AFTER:
     - `Recent observations:`
       - `- Someone looked tense and adjusted their hood.`
       - `- They stayed mostly still, then fidgeted briefly.`
3) Keep timestamps/severity available for debugging, but put them in:
   - debug logs
   - or a debug-only context section gated behind a flag (not included by default in the model prompt)

Acceptance:
- Manual: verify the model still answers correctly, but tone is more natural.
- Verify logs still contain raw structured insight lines (for you), but LLM prompt context is humanized.

Stop; update `progress.md`.

---

## Iteration 111 — Add regression checks + smoke checklist

Goal:
- Prevent accidental reintroduction of the wrapper/report voice.

Deliverables:
1) Add a minimal automated test (or snapshot test) around the prompt builder:
   - Asserts the user message equals raw `user_text` (no wrapper text present).
   - Asserts the system prompt does NOT contain the removed report rubric string.
   - Asserts injected “Recent insights” block does not include the `[HH:MM:SS] (severity)` pattern.

2) Add a short smoke checklist (docs or progress):
   - “what just happened” → 1–2 casual sentences
   - “give me details” → structured breakdown allowed
   - high-severity events → mention safety first (still concise)

Acceptance:
- Tests pass locally (or script runs and prints PASS).
- Manual smoke passes.

Stop; update `progress.md`.