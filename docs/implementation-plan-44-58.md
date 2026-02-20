## docs/implementation-plan-44-??.md — Replace VisionAgent with `agent`, Rename QuickVision→Vision, Add EVA Text + Memory

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

# GOAL

1. **Remove VisionAgent** entirely (no `packages/vision-agent` service).
2. Add a new **`packages/agent`** service (Node/TS) that is the **only** place that:

   * calls OpenAI (pi tool-loop)
   * writes EVA memory artifacts (working/short/long + caches)
3. **QuickVision calls `agent` for insights** (instead of VisionAgent).
4. Rename **`packages/quickvision` → `packages/vision`** (Python service).
5. Eva adds **text I/O**:

   * `POST /text` accepts user text (HTTP)
   * Eva publishes responses to UI over the existing `/eye` WS as `text_output`
6. Implement EVA memory tiers under `packages/eva/memory/*` (working JSONL, short-term SQLite, long-term vector store, cache files).

---

# DECISIONS (LOCKED)

* **OpenAI calls live only in `packages/agent`.** No other package contains an OpenAI key.
* Vision insight transport v1: **Vision → Agent via HTTP POST** (no WS tool-loop).
* Eva text transport v1:

  * input: **HTTP POST `/text`**
  * output: **WS message `text_output` over `/eye`** (no second WS endpoint)
* Config approach: **cosmiconfig + zod** (Node) and **Dynaconf** (Python), with:

  * committed defaults
  * gitignored local overrides
  * gitignored local secrets (no env vars required)
* Backward compatibility (LOCKED):

  * QuickVision/ Vision will support `insights.vision_agent_url` **as a deprecated alias key** that still points to **agent**, not to the deleted VisionAgent service.
  * Eva will support `quickvision.wsUrl` **as a deprecated alias key** for one iteration after the rename.
* Iteration discipline:

  * no large refactors
  * rename and deletions are isolated iterations with lots of verification

---

# ARCHITECTURE (TARGET)

**Frames path**
UI → Eva WS `/eye` (binary frames) → Vision WS `/infer` → Eva → UI (`detections`, `events`, `insight`)

**Insight path**
Vision → Agent `POST /insight` → Vision emits `insight` WS message → Eva relays → UI auto-speaks `insight.summary.tts_response`

**Text path**
UI → Eva `POST /text` → Agent `POST /respond` → Eva sends `text_output` over `/eye` → UI renders chat

---

# API CONTRACT (Text v1)

### `POST /text` (Eva)

Request JSON:

```json
{ "text": "…", "session_id": "optional", "source": "ui" }
```

Response JSON (debug-friendly; same shape as WS message):

```json
{
  "type": "text_output",
  "v": 1,
  "request_id": "uuid",
  "session_id": "optional",
  "ts_ms": 1700000000000,
  "text": "reply",
  "meta": { "tone": "calm", "concepts": ["..."], "surprise": 0.2, "note": "..." }
}
```

Errors:

* `400` invalid JSON / invalid fields
* `413` body too large
* `502` agent error / bad response
* `504` agent timeout

CORS (dev-friendly):

* Support `OPTIONS /text`
* For `/text` responses:

  * `Access-Control-Allow-Origin: *`
  * `Access-Control-Allow-Methods: POST, OPTIONS`
  * `Access-Control-Allow-Headers: content-type`

---

# INSIGHT CONTRACT (Agent v1)

### `POST /insight` (Agent)

Request JSON (keep shape compatible with current QuickVision clip payload):

```json
{
  "clip_id": "uuid",
  "trigger_frame_id": "frame-123",
  "frames": [
    { "frame_id": "frame-121", "ts_ms": 1700, "mime": "image/jpeg", "image_b64": "..." }
  ]
}
```

Response JSON:

```json
{
  "summary": {
    "severity": "low|medium|high",
    "one_liner": "…",
    "tts_response": "…",
    "tags": ["..."],
    "what_changed": ["..."]
  },
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0 }
}
```

Notes:

* This matches the current QuickVision client schema (frames include `frame_id` + `ts_ms` and response includes `tts_response`).
* `tts_response` rules remain the same as before:

  * 1–2 sentences
  * spoken-friendly, natural
  * no tags, no IDs, no token/cost, no telemetry
  * severity-aware tone

---

# EVA MEMORY (new)

Create `packages/eva/memory/`:

```text
packages/eva/memory/
├── working_memory.log              # JSONL, last 1 hour (gitignored)
├── short_term_memory.db            # SQLite summaries (gitignored)
├── persona.md                      # committed base persona
├── experience_tags.json            # committed strict tag whitelist
├── cache/                          # gitignored
│   ├── core_personality.json
│   ├── personality_tone.json
│   ├── core_experiences.json
│   └── recent_experiences.json
└── vector_db/                      # gitignored (Chroma persistence)
    ├── long_term_experiences/
    └── long_term_personality/
```

Retention rules (LOCKED):

* Working: JSONL, last **1 hour**
* Short-term: SQLite summaries, last **7–30 days**
* Long-term: vector DB, **forever**
* Tags in memory entries must be subset of `experience_tags.json`

---

# EVA CONFIG (new)

Extend `packages/eva/src/config.ts` + `packages/eva/eva.config.json` with:

```json
"agent": { "baseUrl": "http://127.0.0.1:8791", "timeoutMs": 30000 },
"text":  { "enabled": true, "path": "/text", "maxBodyBytes": 16384, "maxTextChars": 4000 }
```

Also (later) extend subprocess config:

* `subprocesses.agent`
* `subprocesses.vision` (after rename)

---

# QUICKVISION/VISION CONFIG (new)

Extend Dynaconf settings to add:

* `insights.agent_url: "http://127.0.0.1:8791/insight"`

Back-compat:

* If `insights.agent_url` missing but `insights.vision_agent_url` exists:

  * treat `vision_agent_url` as deprecated alias key and still call it (expected to be agent)
  * log deprecation warning

---

# IMPLEMENTATION ITERATIONS (START AT 44)

## Iteration 44 — Add EVA memory folder + tags/persona (no runtime behavior)

Goal:

* Create memory scaffold + committed static files + gitignore rules.

Deliverables:

* Add `packages/eva/memory/`
* Add committed:

  * `packages/eva/memory/persona.md`
  * `packages/eva/memory/experience_tags.json`
* Update root `.gitignore` to ignore:

  * `packages/eva/memory/working_memory.log`
  * `packages/eva/memory/short_term_memory.db`
  * `packages/eva/memory/cache/**`
  * `packages/eva/memory/vector_db/**`

Acceptance:

* `cd packages/eva && npm run build` passes
* `cd packages/ui && npm run build` passes
* `cd packages/quickvision && python3 -m compileall app` passes
* no runtime behavior changes

Stop; update progress.md.

---

## Iteration 45 — Add `packages/agent` skeleton + `/health` (no OpenAI yet)

Goal:

* Create the new agent service with repo-standard config + secrets patterns.

Deliverables:

* Create `packages/agent` package with:

  * `.nvmrc`, `package.json`, `tsconfig.json`, `README.md`
  * `agent.config.json` committed defaults
  * `agent.config.local.json` (gitignored)
  * `agent.secrets.local.json` (gitignored)
  * `src/config.ts` (cosmiconfig + zod)
  * `src/server.ts` (tiny router)
  * `src/index.ts` boot
* Endpoints:

  * `GET /health` → 200 JSON including `service`, `status`, `uptime_ms`
* Path handling (required):

  * resolve `memory.dir` relative to the config file path (or enforce absolute)

Acceptance:

* `cd packages/agent && npm i && npm run build` passes
* `curl http://127.0.0.1:8791/health` returns 200

Stop; update progress.md.

---

## Iteration 46 — Agent: add `POST /insight` stub (deterministic)

Goal:

* Provide an always-on stub endpoint so Vision can be rewired before OpenAI integration.

Deliverables:

* Add `POST /insight` that:

  * validates Content-Type `application/json`
  * enforces max body bytes (config)
  * validates minimal request shape:

    * `frames` array non-empty (match current QuickVision expectation)
  * returns deterministic response:

    * `summary.one_liner`, `summary.tts_response`, `summary.tags`, `summary.what_changed`, `summary.severity`
    * `usage` present (0s are OK)

Acceptance:

* `cd packages/agent && npm run build`
* `curl -sS -X POST http://127.0.0.1:8791/insight -H 'content-type: application/json' -d '<payload>'` returns 200 and expected shape

Stop; update progress.md.

---

## Iteration 47 — QuickVision: add `insights.agent_url` + deprecate `vision_agent_url` (no rename yet)

Goal:

* Switch QuickVision’s insight caller from VisionAgent to Agent.

Deliverables (small diffs only):

* Update `packages/quickvision/settings.yaml`:

  * add `insights.agent_url: "http://127.0.0.1:8791/insight"`
  * keep existing `insights.vision_agent_url` but mark deprecated in comments
* Update `packages/quickvision/app/insights.py`:

  * settings loader reads `insights.agent_url` first
  * if missing, reads `insights.vision_agent_url` but logs warning:

    * “insights.vision_agent_url is deprecated; use insights.agent_url”
  * validate URL message should mention agent_url when present
* Update `packages/quickvision/app/vision_agent_client.py` minimally:

  * keep filename for now (avoid refactor)
  * allow base_url to be agent insight URL
  * update error codes/messages to say “Insight service” (optional; keep as-is if too noisy)

Acceptance:

* `cd packages/quickvision && python3 -m compileall app` passes
* Manual: start agent stub + quickvision + eva + ui
* Trigger `insight_test` → UI receives insight with `tts_response`

Stop; update progress.md.

---

## Iteration 48 — Eva subprocess: spawn `agent` first (keep VisionAgent for now)

Goal:

* Let “one command boots stack” include agent early without removing anything.

Deliverables:

* Extend Eva config schema (`packages/eva/src/config.ts`) with:

  * `subprocesses.agent` block (same shape as existing subprocess entries)
* Update Eva bootstrap (`packages/eva/src/index.ts`) subprocess order:

  1. agent
  2. vision-agent (still)
  3. quickvision
  4. eva
* Update `packages/eva/eva.config.local.example.json` to include subprocess agent block.

Acceptance:

* `cd packages/eva && npm run build` passes
* Manual: subprocess mode boots with agent and logs show health wait succeeded

Stop; update progress.md.

---

## Iteration 49 — Agent: implement real `POST /insight` via OpenAI tool-call (port VisionAgent logic)

Goal:

* Replace stub with real insight generation, but keep the same external contract.

Deliverables:

* Port the core logic from `packages/vision-agent/src/server.ts` into `packages/agent`:

  * request parsing with maxBodyBytes
  * maxFrames enforcement (keep HARD_MAX_FRAMES=6 to match current clip builder)
  * cooldown enforcement
  * pi-ai `complete(...)` call with apiKey from agent secrets
  * required single tool call `submit_insight`
  * validate tool args
  * usage extraction
* Add tag whitelist enforcement:

  * load `packages/eva/memory/experience_tags.json`
  * if model returns unknown tags:

    * **drop unknown tags** and log warning (v1)
* Add minimal prompt files:

  * `packages/agent/src/prompts/insight.ts`
  * `packages/agent/src/tools/insight.ts`

Acceptance:

* `cd packages/agent && npm run build`
* Manual: start stack, trigger insight, confirm `tts_response` looks correct and UI auto-speaks it

Stop; update progress.md.

---

## Iteration 50 — Remove `packages/vision-agent` completely (now safe)

Goal:

* Delete VisionAgent and scrub all references.

Deliverables:

* Remove `packages/vision-agent/` directory
* Remove all references from:

  * docs
  * eva subprocess config schema and examples
  * `.gitignore` entries for vision-agent local config/secrets
  * any README sections describing vision-agent run steps
* Ensure QuickVision defaults point to agent (so nothing tries port 8790)

Acceptance:

* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* `cd packages/quickvision && python3 -m compileall app`
* Manual: boot stack (agent + quickvision + eva + ui) and insights still work

Stop; update progress.md.

---

## Iteration 51 — Rename `packages/quickvision` → `packages/vision` (mechanical rename only)

Goal:

* Rename the Python service without changing behavior.

Deliverables:

* `git mv packages/quickvision packages/vision`
* Update all references in repo:

  * docs, READMEs, subprocess config paths, scripts
* Update `.gitignore` paths:

  * `packages/vision/.venv/`
  * `packages/vision/**/__pycache__/`
  * `packages/vision/*.pt`
* Eva config: add deprecation alias for one iteration:

  * if `vision.wsUrl` missing but `quickvision.wsUrl` present → use it and log warning

Acceptance:

* `cd packages/vision && python3 -m compileall app`
* `cd packages/eva && npm run build`
* `cd packages/ui && npm run build`
* Manual: detections still flow and insights still work

Stop; update progress.md.

---

## Iteration 52 — Agent: add `POST /respond` stub (no OpenAI yet)

Goal:

* Add the chat endpoint shape before wiring Eva/UI.

Deliverables:

* `POST /respond` accepts:

  * `{ "text": "...", "session_id": "optional" }`
* Returns deterministic:

  * `{ text, meta, request_id }`

Acceptance:

* `cd packages/agent && npm run build`
* `curl -sS -X POST http://127.0.0.1:8791/respond -H 'content-type: application/json' -d '{"text":"hello"}'` works

Stop; update progress.md.

---

## Iteration 53 — Eva: implement `POST /text` + CORS + emit `text_output` over `/eye`

Goal:

* Create EVA text input path and publish responses to UI.

Deliverables:

* Extend Eva config schema + defaults:

  * `agent.baseUrl`, `agent.timeoutMs`
  * `text.enabled`, `text.path`, `text.maxBodyBytes`, `text.maxTextChars`
* Update Eva server router:

  * `OPTIONS <text.path>` → 204 + CORS
  * `POST <text.path>`:

    * enforce maxBodyBytes while reading stream → `413`
    * validate `text` non-empty and `<= maxTextChars` → `400`
    * call agent `/respond` with timeout
    * build `text_output` message (request_id, ts_ms, etc)
    * send it on `/eye` to the connected UI client (if any)
    * return the same JSON payload in HTTP response

Acceptance:

* `cd packages/eva && npm run build`
* Manual:

  * start Eva + agent
  * `curl POST /text` returns `text_output`
  * UI connected on `/eye` receives `text_output` message in logs

Stop; update progress.md.

---

## Iteration 54 — UI: minimal chat panel + render `text_output`

Goal:

* UI can send text and display replies.

Deliverables:

* Add small chat UI in `packages/ui/src/main.tsx`:

  * input + submit button
  * list of messages
* Call Eva HTTP base derived from `eva.wsUrl` (same pattern used for speech):

  * `ws://host:port/eye` → `http://host:port`
* Listen for `text_output` messages on existing `/eye` WS.

Acceptance:

* `cd packages/ui && npm run build`
* Manual: type message → see deterministic response, camera stream unaffected

Stop; update progress.md.

---

## Iteration 55 — Agent: real chat (`/respond`) via OpenAI tool-call + working memory writes

Goal:

* Agent becomes the real chat brain and writes working memory.

Deliverables:

* Replace `/respond` stub with OpenAI call:

  * required single tool call `commit_text_response`
* Write working memory JSONL:

  * append `text_input` entry
  * append `text_output` entry
* Update mutable tone cache:

  * `packages/eva/memory/cache/personality_tone.json` (gitignored)
* Enforce tag whitelist for `concepts`
* Add file write mutex/queue for:

  * `working_memory.log` appends

Acceptance:

* chat replies are real
* `working_memory.log` grows with valid JSONL
* no corruption under rapid requests

Stop; update progress.md.

---

## Iteration 56 — Agent: Worker A (hourly) — working→SQLite + trim working log

Goal:

* Bound working memory to 1 hour and persist summaries.

Deliverables:

* Initialize SQLite schema in `short_term_memory.db`
* Add endpoint `POST /jobs/hourly` (+ optional schedule)
* Under the same working-log mutex:

  * read working log
  * select entries older than 60 minutes
  * summarize salient ones (vision_insight + high surprise + chat highlights)
  * insert 3–5 bullet summaries into SQLite
  * atomic rewrite working log to last hour only

Acceptance:

* SQLite contains rows
* working log stays bounded

Stop; update progress.md.

---

## Iteration 57 — Agent: Worker B (daily) — SQLite→vector DB + cache refresh

Goal:

* Long-term memory persistence + stable cache outputs.

Deliverables:

* Add vector DB persistence under `packages/eva/memory/vector_db`
* Add endpoint `POST /jobs/daily` (+ optional schedule at 3AM)
* Read yesterday’s SQLite rows and upsert:

  * long_term_experiences
  * long_term_personality deltas (conservative)
* Update caches:

  * `cache/core_experiences.json`
  * `cache/core_personality.json`

Acceptance:

* cache files update
* vector DB populated

Stop; update progress.md.

---

## Iteration 58 — Agent: retrieval in chat (short + long memory injection)

Goal:

* Chat uses memory in a controlled way.

Deliverables:

* In chat prompt assembly:

  * include recent SQLite summaries (tag-filtered)
  * include topK vector retrieval results
  * include core cache files
* Hard cap memory injection size (token-aware)

Acceptance:

* Ask a question about something previously summarized → agent references it correctly

Stop; update progress.md.
