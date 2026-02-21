

## docs/implementation-plan-29-35.md — Eva Speech Endpoint (Edge TTS) + Auto Speak

> Historical plan note (superseded): this document describes an older insight auto-speak model.
> Current behavior is defined by `docs/implementation-plan-75-82.md`:
> - insight UI/protocol is silent/factual
> - narration is internal-only working memory
> - auto-speak target is chat `text_output`, not insights.

Implement the system below in SMALL ITERATIONS so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration. Each iteration must end with:

* build/lint/typecheck passing (or explicit “no tests yet; manual test steps included”)
* a short change summary + files changed
* clear run instructions
* stop after each iteration to allow review before proceeding
* keep progress in progress.md

---

# GOAL

Add speech synthesis so:

1. Eva exposes a speech endpoint (like `/eye` exists for WS):

* `POST /speech` returns **audio bytes** (MP3)

2. UI automatically speaks important new events:

* When a **new Insight** arrives (after a surprise), UI **automatically calls `/speech`** and plays the returned audio.

---

# DECISIONS (LOCKED)

### Transport (v1)

* **HTTP** for speech:

  * `POST /speech` → `audio/mpeg` bytes
* No WS streaming in v1 (keep diffs small).
  Reason: “text → binary blob” is a perfect HTTP request/response shape.

### Auto-speak location

* Auto-speak is implemented in **UI**, triggered by receiving a **new Insight**.
  Reason: browsers play audio locally; pushing raw audio over WS is more complex and not needed to get the value.

### Autoplay limitation (browser reality)

* Browsers can block `audio.play()` until the user interacts with the page.
* Plan includes a **one-time “Enable Audio” / “Auto Speak” toggle** in UI to satisfy autoplay rules.
* After enabled, speech happens automatically.

### Audio format (v1)

* MP3 (`Content-Type: audio/mpeg`)

---

# API CONTRACT (v1)

## `POST /speech`

Request JSON:

```json
{
  "text": "Hello from Eva",
  "voice": "en-US-JennyNeural",
  "rate": 1.0
}
```

Response:

* `200`
* `Content-Type: audio/mpeg`
* body: MP3 bytes

Errors (JSON):

* `400` invalid JSON / missing text / invalid fields
* `413` body too large
* `429` cooldown active
* `500` synthesis failed

CORS:

* Handle `OPTIONS /speech`
* Return:

  * `Access-Control-Allow-Origin: *`
  * `Access-Control-Allow-Methods: POST, OPTIONS`
  * `Access-Control-Allow-Headers: content-type`

---

# CONFIGURATION (Eva)

Extend Eva config with:

```json
"speech": {
  "enabled": false,
  "path": "/speech",
  "defaultVoice": "en-US-JennyNeural",
  "maxTextChars": 1000,
  "maxBodyBytes": 65536,
  "cooldownMs": 0,

  "cache": {
    "enabled": true,
    "ttlMs": 600000,
    "maxEntries": 64
  }
}
```

Notes:

* `enabled=false` by default to avoid surprising existing users.
* `eva.config.local.example.json` is **copy-only** (user copies → `eva.config.local.json`).

---

# CONFIGURATION (UI)

Auto-speak behavior is a UI concern. Add a small UI-side config/state:

* `autoSpeak.enabled: boolean` (default **true** when speech is enabled, but requires user gesture once)
* `autoSpeak.minSeverity: "MED" | "HIGH"` (default `"MED"`)
* `autoSpeak.cooldownMs: number` (default `2000`)
* `autoSpeak.textTemplate: string` (default: one-liner summary)

This keeps auto-speak flexible without rebuilding Eva.

---

# AUTO-SPEAK POLICY (v1)

When a new Insight arrives, UI will auto-speak if:

* autoSpeak is enabled, AND
* insight severity >= minSeverity (default MED), AND
* not within UI cooldown window, AND
* insight text is non-empty

**Important:** This prevents “LOW stillness” spam from turning your app into a cursed audiobook.

---

# IMPLEMENTATION ITERATIONS (START AT 29)

## Iteration 29 — Eva config plumbing only (no runtime behavior)

**Goal:** Add config schema + committed defaults without changing runtime unless enabled.

Deliverables:

* Update `packages/eva/src/config.ts` to add `speech` schema (Zod)
* Update `packages/eva/eva.config.json` to include `speech` block with `enabled:false`
* Add `packages/eva/eva.config.local.example.json` enabling speech

Acceptance:

* `cd packages/eva && npm run build` passes
* Eva behavior unchanged with existing config

Stop; update progress.md.

---

## Iteration 30 — Add Edge TTS dependency + wrapper module (no server route yet)

**Goal:** Introduce the TTS engine behind a tiny internal API.

Deliverables:

* Add dependency in `packages/eva/package.json`:

  * `node-edge-tts` (pin version)
* Add:

  * `packages/eva/src/speech/edgeTts.ts` → `synthesize({text, voice, rate}) => Promise<Buffer>`
  * `packages/eva/src/speech/types.ts`
* Handle ESM/CJS interop if needed (dynamic import OK)

Acceptance:

* `cd packages/eva && npm i && npm run build` passes

Stop; update progress.md.

---

## Iteration 31 — Eva HTTP router + `POST /speech` returns MP3 bytes (MVP)

**Goal:** Add endpoint with guardrails + CORS.

Deliverables:

* Update `packages/eva/src/server.ts`:

  * Add tiny router:

    * `OPTIONS <speech.path>` → CORS preflight 204
    * `POST <speech.path>` → parse JSON → validate → synthesize → respond audio
    * fallback: keep existing “service ok” JSON response for all other routes
* Extend `StartServerOptions` to include `speech` config
* Update `packages/eva/src/index.ts` to pass `speech` config into `startServer(...)`

Guardrails (must implement now):

* enforce `maxBodyBytes` while reading request stream:

  * exceed → `413`
* enforce `text` validity:

  * empty → `400`
  * too long → `400`
* optional server-side cooldown (`cooldownMs`):

  * if enabled and too soon → `429`

Manual acceptance:

```bash
# enable speech in eva.config.local.json
cd packages/eva && npm run dev

curl -sS -X POST http://127.0.0.1:8787/speech \
  -H 'content-type: application/json' \
  -d '{"text":"hello from eva","voice":"en-US-JennyNeural"}' \
  --output out.mp3
```

Confirm `out.mp3` plays.

Stop; update progress.md.

---

## Iteration 32 — UI: Speech client + one-click “Enable Audio” (required for autoplay)

**Goal:** UI can request speech audio and play it reliably.

Deliverables:

* Derive Eva HTTP base from `eva.wsUrl`:

  * `ws://host:port/eye` → `http://host:port`
  * `wss://...` → `https://...`
* Add UI module `packages/ui/src/speech.ts`:

  * `speakText({text, voice})`:

    * POST `/speech`
    * create blob URL
    * set `<audio>` source
    * call `audio.play()`
    * if `play()` throws due to autoplay policy:

      * mark `audioLocked=true` and show UI prompt to click “Enable Audio”
* Add small UI controls:

  * Toggle: “Auto Speak” (default ON when speech enabled)
  * Button: “Enable Audio” (one-time unlock)
  * Optional: Voice field

Acceptance:

* Manual:

  * Start Eva with speech enabled
  * Start UI
  * Click “Enable Audio”
  * Click “Test Speak” and verify audio plays

Stop; update progress.md.

---

## Iteration 33 — Auto-speak: speak new insights automatically (core requirement)

**Goal:** Make the app speak automatically when new insights arrive.

Deliverables:

* Hook into the existing UI insight handling (where insights are displayed/logged).
* On “new insight received”:

  * compute `shouldAutoSpeak(insight)` using:

    * UI autoSpeak.enabled
    * severity >= minSeverity (default MED)
    * UI cooldown window (default 2000ms)
  * choose speak text:

    * `insight.summary.one_liner` if present
    * else fallback to `insight.title` or shortened summary
  * call `speakText(...)`

Behavior details:

* When a new speak begins:

  * cancel previous fetch via `AbortController`
  * stop previous audio playback (`audio.pause()`)
  * revoke old blob URL
* Add a “lastSpokenInsightId” guard to avoid double-speaking when UI re-renders.

Acceptance:

* Trigger a surprise → insight arrives → UI speaks it automatically
* LOW insights do **not** speak by default (unless user sets minSeverity=LOW)

Stop; update progress.md.

---

## Iteration 34 — Caching + in-flight dedupe (cost + latency win)

**Goal:** Don’t pay twice for the same phrase.

Deliverables (Eva):

* Add in-memory cache:

  * key: `sha256(voice|rate|text)`
  * value: `{ audio: Buffer, createdAtMs }`
* TTL eviction + maxEntries cap
* In-flight dedupe:

  * if same key already synthesizing, await same promise
* Add header: `X-Eva-TTS-Cache: HIT|MISS`

Acceptance:

* Speak same insight twice → second is HIT

Stop; update progress.md.

---

## Iteration 35 — Optional: Job mode (for long text) OR WS streaming (defer)

Only implement if you find synthesis latency or payload size becomes painful.

Preferred (more robust):

* `POST /speech/jobs` → `{ jobId }`
* `GET /speech/jobs/:jobId` → status + url
* `GET /speech/audio/:jobId.mp3` → bytes

True streaming only makes sense if the TTS engine streams audio as it generates; chunking a complete MP3 is mostly “fake streaming.”

Stop; update progress.md.

---

# CODING RULES

* Don’t implement future iterations early.
* Keep changes minimal.
* Prefer adding small new files over rewriting core logic.
* Each iteration: list changed files + exact run commands + manual test steps.

