## docs/implementation-plan-75-82.md — Silent Insights + Environment-State Prompting + Chat TTS

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

## GOAL

1. **Protocol Insight becomes silent + factual**

* UI shows only:

  * `one_liner`
  * `what_changed`
  * `tags`
  * severity + ids + usage
* **No “Spoken line” in the Insight UI panel**
* **No auto-speak triggered by insight messages**

2. **Spoken/narrated text exists only as internal working memory**

* If we still generate a “spoken line” (narration), it should be written only to working memory (Executive is the only writer).

3. **Chat replies are natural + spoken**

* `/text` responses should sound like a normal human using the environment state as hidden context.
* UI auto-speaks **chat replies** via `/speech`.

---

## CURRENT STATE (FACTS)

* Protocol schema for `insight_summary` does **not** include `tts_response` .
* But runtime currently requires it across QuickVision , EVA , and UI .
* UI parses insights as requiring `tts_response`  and auto-speaks it .
* QuickVision constructs the outbound InsightMessage by dumping the insight summary dict as-is .
* Bonus cosmetic mismatch: UI title still says “Iteration 54”  even though progress.md has advanced beyond that.

---

## DECISIONS (LOCKED)

* **Protocol v1 InsightSummary = schema.json** (no narration field).
* If narration exists, it’s **internal-only** (working memory), not part of protocol insight messages.
* **Auto-speak target = chat response text_output**, not insights.

---

## NEW WORKING MEMORY ENTRY (internal-only)

Add a new JSONL record type written by Executive (single-writer):

```json
{
  "type": "wm_insight",
  "ts_ms": 1730000000000,
  "source": "vision",
  "clip_id": "uuid",
  "trigger_frame_id": "frame",
  "severity": "low|medium|high",
  "one_liner": "…",
  "what_changed": ["…"],
  "tags": ["…"],
  "narration": "1–2 sentences, spoken-friendly (optional)",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0 }
}
```

---

# IMPLEMENTATION ITERATIONS (START AT 75)

## Iteration 75 — Align code to protocol schema: remove `tts_response` from protocol InsightSummary

Goal:

* Make runtime match `packages/protocol/schema.json` for InsightSummary.

Deliverables:

* Update EVA protocol validator:

  * `packages/eva/src/protocol.ts`: remove `tts_response` from `InsightSummarySchema` .
* Update QuickVision protocol model:

  * `packages/eva/vision/app/protocol.py`: remove `tts_response` from `InsightSummary` .
* Update UI protocol types:

  * `packages/ui/src/types.ts`: remove `tts_response` from `InsightSummary` .
* Update UI runtime type guard:

  * `packages/ui/src/main.tsx`: `isInsightMessage()` must NOT require `tts_response` .

Acceptance:

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* `cd packages/eva/vision && python3 -m compileall app`
* Running stack: insights still render, even if backend still sends `tts_response` (extra fields should be ignored/stripped).

Stop; update progress.md.

---

## Iteration 76 — Ensure outbound InsightMessage never contains narration

Goal:

* Regardless of what the insight service returns, QuickVision → EVA → UI never transmits narration.

Deliverables:

* In `packages/eva/vision/app/insights.py`, when building `InsightMessage`, explicitly drop narration keys before sending:

  * currently `summary=insight.summary.model_dump(exclude_none=True)` 
  * change to either exclude `tts_response` explicitly or rebuild a dict containing only schema fields.

Acceptance:

* Trigger an insight and confirm UI shows no “Spoken line” field (even if insight service still returns it).

Stop; update progress.md.

---

## Iteration 77 — Executive writes `wm_insight` (single-writer) when serving `/insight`

Goal:

* Spoken/narration text goes only into working memory.

Deliverables:

* Extend Executive working memory types in `packages/eva/executive/src/server.ts` to include a `WorkingMemoryWmInsightEntry` (patterned like `WorkingMemoryWmEventEntry`) .
* In the `/insight` handler (where Executive already runs the insight tool-loop), append a `wm_insight` record under the SAME SerialTaskQueue used for other memory writes (Executive already uses a single-writer design).
* Store narration under a dedicated field (e.g., `narration`) and keep it optional.

Acceptance:

* Trigger an insight and verify `packages/eva/memory/working_memory.log` contains a valid JSONL line with `"type":"wm_insight"`.

Stop; update progress.md.

---

## Iteration 78 — UI: remove “Spoken line” rendering + remove insight auto-speak behavior

Goal:

* Insights are silent UI facts, not spoken narration.

Deliverables:

* In `packages/ui/src/main.tsx`:

  * remove the “Spoken line” section and any reliance on `insight.summary.tts_response`
  * delete or disable `maybeAutoSpeakInsight()` logic which currently speaks `tts_response` 
* Optional quick win:

  * update the hardcoded UI title “Iteration 54”  to current or remove it.

Acceptance:

* New insight arrives → no spoken line displayed → no audio plays.

Stop; update progress.md.

---

## Iteration 79 — UI: auto-speak chat replies (TextOutputMessage)

Goal:

* When EVA replies via `/text`, UI plays TTS of the reply.

Deliverables:

* Hook into receipt of `TextOutputMessage` and call the existing speech client.
* Add dedupe guard (track last spoken `request_id`) + cooldown to avoid repeated playback when UI re-renders.
* Reuse existing “Enable Audio” / speech config UX; rename labels if needed so the toggle clearly controls **chat speaking**, not insights.

Acceptance:

* Send `/text` → receive reply → UI auto-speaks the reply text.

Stop; update progress.md.

---

## Iteration 80 — Executive: treat recent events as system metadata (not user-facing telemetry)

Goal:

* “What are the recent events?” should produce a natural answer, not a raw list of track IDs.

Deliverables:

* Update respond system prompt generation (`buildRespondSystemPrompt`) to add explicit instruction:

  * live events are **environment state**
  * do not repeat raw telemetry unless the user asks for details
* The current respond prompt doesn’t contain that constraint; it just lists memory context .

Acceptance:

* Ask “what are the recent events” → response sounds human (“Two people moved quickly past each other…”) rather than listing track IDs/speeds.

Stop; update progress.md.

---

## Iteration 81 — Executive: add an “Environment Snapshot” formatter (optional but recommended)

Goal:

* Give the model a cleaner hidden-state summary than raw event lines.

Deliverables:

* Build a small formatter in Executive:

  * input: recent `wm_event` list (already read by `readRecentWmEvents`) 
  * output: a short paragraph + 3–7 bullets describing “what’s going on” in plain English
* Inject that snapshot into memory context (system prompt), and keep raw lines only as fallback/debug.

Acceptance:

* Chat responses are consistently natural even when lots of events arrive.

Stop; update progress.md.

---

## Iteration 82 — Cleanup + docs

Deliverables:

* Update any docs that still imply “Insight has a spoken line and auto-speaks” (those were correct historically, but no longer match your mental model).
* Ensure the protocol docs remain the authoritative contract (schema already matches your desired silent InsightSummary).

Acceptance:

* Repo docs + runtime behavior agree: silent insights, spoken chat.

Stop; update progress.md.
