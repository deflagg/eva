````md
## docs/implementation-plan-66-67.md — Rename Agent → Executive + Clarify “Memory” Naming in Code (No Behavior Changes)

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

# GOAL

Align naming with the mental model:

* EVA is the overall “brain/agent,” composed of modules/services.
* The package currently named `packages/eva/agent` is EVA’s **executive function** (tool-loop, /respond, memory writes).
* `packages/eva/memory/` is EVA’s **persisted memory data organ**.
* Folders under `packages/eva/agent/src/*` such as `memory/` and `vectorstore/` are **code** (helpers/adapters), not data.

We will:
1) Rename the `agent` package folder to `executive`.
2) Rename/rehome confusing Agent *code* folders (`src/memory`, `src/vectorstore`) into a clearer `src/memcontext` namespace.

**NO runtime behavior changes**: the persisted memory stays in `packages/eva/memory/`, tone logic stays the same, DB logic stays the same.

---

# CURRENT STATE (FACTS)

* Persisted memory data is already under `packages/eva/memory/` (SQLite, JSONL, cache JSON, LanceDB directory).
* Tone is already implemented:
  * read tone at request start
  * injected into respond system prompt
  * updated after response and saved to `packages/eva/memory/cache/personality_tone.json`
* The confusing bit is naming only:
  * `packages/eva/agent/src/memory/*` is code
  * `packages/eva/memory/*` is data
  * `packages/eva/agent/src/vectorstore/*` is code

---

# DECISIONS (LOCKED)

* Do NOT move persisted memory data under any `src/` folder.
* Do NOT change tone logic, TTL, smoothing, vector search logic, DB schemas, or file formats.
* Keep config file names as-is for now to minimize churn:
  * Keep `agent.config.json` / `agent.config.local.json` / `agent.secrets.local.json` names even after folder rename.
  * Keep cosmiconfig namespace `agent` unchanged.
  * (We can rename config filenames in a separate later iteration if desired.)

---

# TARGET LAYOUT (AFTER THIS PLAN)

## EVA persisted data (unchanged)
```text
packages/eva/memory/
├── persona.md
├── experience_tags.json
├── working_memory.log              # gitignored
├── short_term_memory.db            # gitignored
├── cache/                          # gitignored
│   ├── personality_tone.json
│   ├── core_experiences.json
│   └── core_personality.json
└── vector_db/                      # gitignored
    └── lancedb/                    # LanceDB directory (tables live under here)
````

## Executive code (renamed from agent) with clearer namespaces

```text
packages/eva/executive/
├── agent.config.json               # KEEP NAME (for now)
├── agent.config.local.json         # gitignored (KEEP NAME)
├── agent.secrets.local.json        # gitignored (KEEP NAME)
├── README.md
├── scripts/
│   └── reset-*.mjs
└── src/
    ├── memcontext/
    │   ├── tone.ts
    │   └── long_term/
    │       └── lancedb.ts
    ├── server.ts
    ├── config.ts
    ├── prompts/
    └── tools/
```

---

# IMPLEMENTATION ITERATIONS

## Iteration 66 — Rename package folder `agent` → `executive` (mechanical rename)

Goal:

* Make naming match the mental model: EVA is the agent; this module is the executive function.

Deliverables:

1. Rename folder (git mv):

* `packages/eva/agent/` → `packages/eva/executive/`

2. Update any repo references that used the old path.
   This is a search-and-replace / path-fix step. Update as needed:

* Any spawn/subprocess commands in `packages/eva/src/*` that reference `packages/eva/agent/...`
* Any docs mentioning `packages/eva/agent`
* Any scripts in root or package.json scripts that `cd` into `packages/eva/agent`
* Any tooling configs referencing the old folder (eslint, tsconfig refs, etc.)

IMPORTANT:

* Do NOT rename config files yet (they remain `agent.config*.json`).
* Do NOT rename cosmiconfig namespace (`cosmiconfigSync('agent', ...)`) or searchPlaces.

Acceptance:

* Build executive module:

  * `cd packages/eva/executive && npm run build`

* Start executive service (whatever command you currently use, e.g. dev/start):

  * Confirm logs show it is listening.
  * `GET /health` returns `service: 'agent'` (service name can remain; not changing behavior).

* Build EVA gateway (to ensure any path references were updated):

  * `cd packages/eva && npm run build`

Stop; update progress.md with:

* folder rename
* list of updated references
* run instructions

---

## Iteration 67 — Clarify “memory code” naming: introduce `src/memcontext/` and move tone + lancedb adapters

Goal:

* Make it obvious that these are code modules used to assemble memory context and access the long-term store.

Deliverables:

1. Create directories:

* `packages/eva/executive/src/memcontext/`
* `packages/eva/executive/src/memcontext/long_term/`

2. Move files (code only):

* `packages/eva/executive/src/memory/tone.ts`
  → `packages/eva/executive/src/memcontext/tone.ts`

* `packages/eva/executive/src/vectorstore/lancedb.ts`
  → `packages/eva/executive/src/memcontext/long_term/lancedb.ts`

3. Update imports in:

* `packages/eva/executive/src/server.ts`

Change:

* from `./memory/tone.js`
* to   `./memcontext/tone.js`

Change:

* from `./vectorstore/lancedb.js`
* to   `./memcontext/long_term/lancedb.js`

NOTE:

* Keep the `.js` extension in import specifiers (ESM style used in this repo).
* Do NOT change any logic inside tone.ts or lancedb.ts beyond adjusting their own internal relative imports if any exist.

Acceptance:

* Build:

  * `cd packages/eva/executive && npm run build`

* Runtime sanity:

  * Start executive service and call `GET /health`
  * Confirm reported memory paths still point into `packages/eva/memory/...` (unchanged):

    * tone cache: `.../cache/personality_tone.json`
    * lancedb dir: `.../vector_db/lancedb`

Stop; update progress.md with:

* file moves
* import updates
* verification steps
