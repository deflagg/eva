# docs/implementation-plan-229-237.md — Centralized Logging (`packages/eva/logs`) + Rotation + Colorized Supervisor Console (Startup/Shutdown)

Implement in **SMALL ITERATIONS** so diffs stay small and reviewable. Do NOT do big refactors. Do NOT “get ahead” of the current iteration.

Each iteration must end with:
- build/typecheck passing (or explicit manual test steps included)
- short change summary + files changed
- clear run instructions
- update `docs/progress.md` (create it if missing)
- STOP after each iteration for review

---

## ASSUMPTION (CURRENT BASELINE)

Current stack (verified in repo):
- `packages/eva` is the supervisor process (TS/Node) started via `npm run dev` → `tsx src/index.ts`.
- When `subprocesses.enabled=true` in `packages/eva/eva.config.json`, Eva starts:
  - Executive service (package name `agent`) via `ManagedProcess`
  - Vision runtime (Python / uvicorn) via `ManagedProcess`
  - Audio runtime (Python / uvicorn) via `ManagedProcess`
- `ManagedProcess` currently:
  - pipes child stdout/stderr
  - prefixes lines with `[agent]`, `[vision]`, `[audio]`
  - prints to console via `console.log/error`
- Eva itself prints runtime output via `console.*` (notably `packages/eva/src/server.ts`).

DOC MISMATCH (confirmed):
- `README.md` says “Audio runtime is started separately.”
- Current `eva.config.json` has `subprocesses.enabled=true` and includes an `audio` subprocess block; `packages/eva/src/index.ts` will start audio when enabled.
Iteration 237 corrects the README.

---

## GOAL (END STATE)

1) Centralized logs under **`packages/eva/logs/`** (default):
- One run directory per start:
  - `packages/eva/logs/runs/<run_id>/`
- Per-service logs:
  - `eva.log`, `agent.log`, `vision.log`, `audio.log`
- Combined log:
  - `combined.log` (interleaved, timestamped, tagged by service)

2) Automatic log rollover:
- size-based rotation for each log file
- keep bounded history

3) Console UX:
- Organized, colorized startup showing Eva + subprocess status (starting → healthy)
- Organized shutdown sequence (server close + subprocess stop + timings)
- Console is not unwieldy by default:
  - default mode = `compact` (lifecycle + stderr + warn/error heuristics + exits)
  - `follow` prints everything
  - `service:<name>` prints only one service + lifecycle

---

## NON-GOALS (LOCKED)

- No remote logging stack (ELK/Loki/Datadog/etc).
- No refactor of Python/agent logging frameworks.
- No UI log viewer.
- No JSON structured logging in this plan (can be added later).

---

## DEFINITIONS (REMOVE ALL AMBIGUITY)

### Time + Run ID
- All timestamps written to logs are **UTC ISO-8601**: `new Date(nowMs).toISOString()`
- `runId` format is **UTC-derived** and filesystem-safe:

Algorithm (locked):
1) `iso = new Date(nowMs).toISOString()` → `YYYY-MM-DDTHH:mm:ss.sssZ`
2) `base = iso.slice(0, 19)` → `YYYY-MM-DDTHH:mm:ss` (drop ms + Z)
3) `base = base.replace('T', '_').replaceAll(':', '-')` → `YYYY-MM-DD_HH-mm-ss`
4) `runId = `${base}_pid${pid}``

Example:
- `2026-03-04_21-12-34_pid12345`

### Log base directory resolution
- `packageRoot` = absolute path to `packages/eva` (already computed in `src/index.ts`)
- `baseDir` resolution (locked):
  - if `logging.dir` is absolute: `baseDir = logging.dir`
  - else: `baseDir = path.resolve(packageRoot, logging.dir)`
- Default `logging.dir` = `"logs"` → `packages/eva/logs`

### Run directory + pointer
- `runsDir = path.join(baseDir, 'runs')`
- `runDir = path.join(runsDir, runId)`
- `latestFilePath = path.join(baseDir, 'latest.txt')`
- `latest.txt` content is **absolute runDir path + trailing newline**:
  - `fs.writeFileSync(latestFilePath, `${runDir}\n`, 'utf8')`

### Files created per run (locked)
Inside `runDir`:
- `eva.log`
- `agent.log`
- `vision.log`
- `audio.log`
- `combined.log`

No other files are required for this plan.

### Log record format (locked)
Each persisted line is a **single record** with:
- ISO timestamp (UTC)
- service tag
- either a level tag (`eva`) OR stream tag (subprocess)
- the original message text (unmodified except newline normalization)

Formatting:

Eva internal:
- `${iso}  [eva]   [${level}] ${message}\n`

Subprocess stream:
- `${iso}  [${service.padEnd(5)}] [${stream}] ${line}\n`

Notes:
- `message` and `line` MUST NOT be `.trim()`ed.
- Newlines from producers are normalized:
  - we store records as **one line per record**
  - the raw line text does not contain `\n` or `\r\n`; the writer appends `\n`

### Backpressure policy (locked)
- Log writing is **best-effort**.
- We do NOT block Eva or pause subprocess streams for log backpressure.
- Implementation uses `WriteStream.write()` and does not await drains.
- If a write throws, we catch, increment an internal drop counter, and continue.
  - (Drop counters are optional to expose; they must not crash the process.)

This is intentional: logging must never become the reason the stack stalls.

---

## ROTATION SEMANTICS (ZERO AMBIGUITY)

### What `maxBytes` means
- Rotate **before** writing a record if:
  - `currentSizeBytes + recordBytes > maxBytes`
- `recordBytes = Buffer.byteLength(recordString, 'utf8')`

Boundary example:
- If `currentSizeBytes + recordBytes === maxBytes`, do NOT rotate (write fits exactly).

### What `maxFiles` means (IMPORTANT)
- `maxFiles` is the number of **backup files** kept.
- Active file is separate.

So total files on disk per log can be `1 + maxFiles`:
- active: `vision.log`
- backups: `vision.log.1` … `vision.log.<maxFiles>`

### Rotation naming + algorithm (locked)
On rotate `foo.log`:
1) Close current stream and await close (Windows-safe).
2) Delete `foo.log.<maxFiles>` if it exists.
3) For `i = maxFiles-1` down to `1`:
   - rename `foo.log.<i>` → `foo.log.<i+1>` if source exists
4) Rename `foo.log` → `foo.log.1` if it exists.
5) Open a new `foo.log` stream and reset `currentSizeBytes = 0`.

All rename/delete operations are best-effort:
- if rename fails, log a warning to console and continue writing to a new file if possible.

---

## RETENTION SEMANTICS (ZERO AMBIGUITY)

- Retention applies to **run directories** under `<baseDir>/runs/`.
- `maxRuns` is the number of newest run directories to keep.

Sorting (locked):
- sort by directory name ascending (because runId begins with `YYYY-MM-DD_HH-mm-ss_...`)
- newest are at the end
- keep the last `maxRuns` names

Deletion (locked):
- delete older runs using `fs.rmSync(path, { recursive: true, force: true })`
- best-effort (never crash on failure)

---

## CONFIG CHANGES (LOCKED)

Add `logging` to Eva config schema and committed config with safe defaults.

### `packages/eva/src/config.ts` — Zod schema addition (CORRECT)

```ts
const ConsoleModeSchema = z.enum([
  'compact',
  'follow',
  'service:eva',
  'service:agent',
  'service:vision',
  'service:audio',
]);

const LoggingConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // resolved relative to packages/eva (packageRoot) unless absolute
  dir: z.string().trim().min(1).default('logs'),

  rotation: z
    .object({
      maxBytes: z.number().int().positive().default(10 * 1024 * 1024),
      maxFiles: z.number().int().positive().default(10),
    })
    .default({
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 10,
    }),

  retention: z
    .object({
      maxRuns: z.number().int().positive().default(20),
    })
    .default({
      maxRuns: 20,
    }),

  console: z
    .object({
      mode: ConsoleModeSchema.default('compact'),
      timestamps: z.boolean().default(true),
    })
    .default({
      mode: 'compact',
      timestamps: true,
    }),
});
`````

Then add `logging` to `EvaConfigSchema`:

```ts id="mfdtwa"
logging: LoggingConfigSchema.default({
  enabled: true,
  dir: 'logs',
  rotation: { maxBytes: 10 * 1024 * 1024, maxFiles: 10 },
  retention: { maxRuns: 20 },
  console: { mode: 'compact', timestamps: true },
}),
```

### `packages/eva/eva.config.json` — committed defaults (CORRECT)

```json
"logging": {
  "enabled": true,
  "dir": "logs",
  "rotation": { "maxBytes": 10485760, "maxFiles": 10 },
  "retention": { "maxRuns": 20 },
  "console": { "mode": "compact", "timestamps": true }
}
```

If `logging.enabled=false`:

* Eva MUST NOT create `packages/eva/logs/**`
* file writers are disabled (no-op)
* console modes still apply (ConsoleRenderer still used)

---

## NEW FILES (LOCKED API SURFACES)

Add a small logging module under `packages/eva/src/logging/`.

### `packages/eva/src/logging/types.ts` (CORRECT)

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ServiceName = 'eva' | 'agent' | 'vision' | 'audio';
export type LogStream = 'stdout' | 'stderr';

export type ConsoleMode =
  | 'compact'
  | 'follow'
  | 'service:eva'
  | 'service:agent'
  | 'service:vision'
  | 'service:audio';

export interface LoggingConfig {
  enabled: boolean;
  dir: string;
  rotation: { maxBytes: number; maxFiles: number };
  retention: { maxRuns: number };
  console: { mode: ConsoleMode; timestamps: boolean };
}
```

### `packages/eva/src/logging/time.ts` (CORRECT)

```ts
export function formatIsoTimestamp(nowMs: number): string;
export function makeRunId(nowMs: number, pid: number): string;
```

Implementation locked:

* `formatIsoTimestamp(nowMs) => new Date(nowMs).toISOString()`
* `makeRunId` uses the algorithm from DEFINITIONS.

### `packages/eva/src/logging/RotatingFileWriter.ts` (CORRECT SIGNATURE)

```ts
export class RotatingFileWriter {
  constructor(opts: { filePath: string; maxBytes: number; maxFiles: number });

  writeLine(line: string): void;

  close(): Promise<void>;
}
```

Implementation locked:

* uses `node:fs`, `node:path`
* uses a single `fs.createWriteStream(filePath, { flags: 'a' })`
* initializes `currentSizeBytes` from `fs.statSync` if file exists, else `0`
* rotation semantics exactly as defined above
* `close()` must end the stream and await `'finish'` then `'close'` (or just `'close'` if finish always precedes close in implementation)

### `packages/eva/src/logging/ConsoleRenderer.ts` (CORRECT SIGNATURE)

```ts
import type { ConsoleMode, LogLevel, LogStream, ServiceName } from './types.js';

export class ConsoleRenderer {
  constructor(opts: { mode: ConsoleMode; timestamps: boolean });

  echoEva(level: LogLevel, message: string): void;

  echoSubprocessLine(service: Exclude<ServiceName, 'eva'>, stream: LogStream, line: string): void;

  echoLifecycle(message: string): void;
}
```

Filtering rules (locked):

* `follow`: echo all subprocess stdout/stderr
* `service:<X>`: echo only that service’s stdout/stderr; always echo lifecycle
* `compact`:

  * always echo lifecycle
  * always echo subprocess `stderr`
  * echo subprocess `stdout` only if line matches:

    * `/\b(warn|warning|error|failed|fatal)\b/i`
  * suppress empty lines in console only (files still record them)

Color rules (locked):

* implement local ANSI helper (no deps)
* suggested mapping:

  * eva: green
  * agent: cyan
  * vision: magenta
  * audio: yellow
  * stderr: red-tinted
* console lines format:

  * if timestamps enabled:

    * `HH:MM:SS.mmm  [svc] message`
  * else:

    * `[svc] message`

### `packages/eva/src/logging/LogManager.ts` (CORRECT SIGNATURE)

```ts
import type { LogLevel, LogStream, LoggingConfig, ServiceName } from './types.js';

export class LogManager {
  public readonly runId: string;
  public readonly runDir: string;
  public readonly latestFilePath: string;

  constructor(opts: { config: LoggingConfig; packageRoot: string });

  init(): void;

  log(service: ServiceName, level: LogLevel, message: string): void;

  logSubprocessLine(service: Exclude<ServiceName, 'eva'>, stream: LogStream, line: string): void;

  close(): Promise<void>;
}
```

Implementation locked:

* if disabled, all methods are safe no-ops
* resolves baseDir/runDir/latest as DEFINITIONS
* creates directories with `fs.mkdirSync(runDir, { recursive: true })`
* writes latest pointer immediately in init()
* in Iteration 230 uses plain streams; in Iteration 232 switches to RotatingFileWriter
* prunes old runs in `init()` using retention semantics defined above

---

## EXISTING FILE MODIFICATIONS (LOCKED)

### `packages/eva/src/subprocess/ManagedProcess.ts` (CORRECT CHANGE)

Add an optional callback so Eva can capture child output.

```ts
export interface ManagedProcessLine {
  service: string; // options.name
  stream: 'stdout' | 'stderr';
  line: string;    // line text WITHOUT trailing newline; may be empty string
}

export interface ManagedProcessOptions {
  name: string;
  cwd: string;
  command: string[];
  healthUrl: string;
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;

  onLine?: (payload: ManagedProcessLine) => void;
}
```

Stream decoding & line splitting (locked, exact approach):

* MUST use `StringDecoder` to avoid breaking multibyte UTF-8 across chunks:

```ts
import { StringDecoder } from 'node:string_decoder';
```

Per stream (stdout, stderr):

* keep:

  * `decoder = new StringDecoder('utf8')`
  * `remainder = ''`

On `data(chunk)`:

1. `text = remainder + decoder.write(chunkBuffer)`
2. split with `text.split(/\r?\n/)`
3. set `remainder = parts.pop() ?? ''`
4. emit every `part` (including empty string) to `onLine`

On stream `end`:

1. `tail = decoder.end()`
2. `final = remainder + tail`
3. emit `final` once IF:

   * `final.length > 0` OR we need to preserve a deliberate trailing blank line
4. clear remainder

Console printing:

* Iteration 231 can keep existing console output temporarily, but it MUST stop trimming immediately.
* Iteration 235 moves console echo to ConsoleRenderer; ManagedProcess no longer prints directly.

### `packages/eva/src/index.ts` (WIRING POINTS)

Locked:

* after config load, create LogManager + ConsoleRenderer
* pass `onLine` into each subprocess ManagedProcess:

  * onLine always calls `logManager.logSubprocessLine(...)`
  * console echo behavior depends on iteration (231 keep, 235 filtered)

Shutdown locked:

* always call `await logManager.close()` before `process.exit(...)` so logs flush.

---

# ITERATIONS (START AT 229)

## Iteration 229 — Add logging config + ignore `packages/eva/logs/**`

Goal:

* repo is ready to generate logs without committing them
* config schema supports `logging`

Deliverables:

1. `packages/eva/src/config.ts`

* add `LoggingConfigSchema` and `EvaConfigSchema.logging`

2. `packages/eva/eva.config.json`

* add `"logging": { ... }` defaults

3. `.gitignore`

* add:

  * `packages/eva/logs/**`

Acceptance:

* `cd packages/eva && npm run build`
* `git status` remains clean after creating `packages/eva/logs/` manually
* If `docs/progress.md` does not exist, create it with:

  * a top-level header `# Progress`
  * a first bullet for Iteration 229 (even if “not started”)

Stop; update `docs/progress.md`.

---

## Iteration 230 — Create run directory + write `eva.log` + `combined.log` (no rotation yet)

Goal:

* Eva creates `packages/eva/logs/runs/<runId>/` and writes basic lifecycle logs.

Deliverables:

* new files:

  * `packages/eva/src/logging/types.ts`
  * `packages/eva/src/logging/time.ts`
  * `packages/eva/src/logging/LogManager.ts` (plain streams OK in this iteration)

* modify:

  * `packages/eva/src/index.ts`

    * init LogManager
    * log: startup begin, config loaded, startup end
    * log: shutdown begin/end

Acceptance:

* `cd packages/eva && npm run dev`
* confirms created:

  * `packages/eva/logs/latest.txt` containing absolute runDir + newline
  * `packages/eva/logs/runs/<runId>/eva.log`
  * `packages/eva/logs/runs/<runId>/combined.log`

Stop; update `docs/progress.md`.

---

## Iteration 231 — Capture subprocess stdout/stderr into `agent.log/vision.log/audio.log`

Goal:

* all child output captured on disk (even if console remains noisy for now)

Deliverables:

1. Update `ManagedProcess`:

* add `onLine` callback support
* implement buffered splitting with `StringDecoder` + remainders + flush-on-end (locked rules)

2. Update `index.ts`:

* pass `onLine` callback for agent/vision/audio:

  * `logManager.logSubprocessLine(service, stream, line)`

Acceptance:

* run stack; verify:

  * `agent.log`, `vision.log`, `audio.log` populated
  * `combined.log` includes interleaved subprocess lines with timestamps + tags
* `cd packages/eva && npm run build`

Stop; update `docs/progress.md`.

---

## Iteration 232 — Add size-based rotation (`RotatingFileWriter`) for all log files

Goal:

* logs never grow unbounded

Deliverables:

* new file:

  * `packages/eva/src/logging/RotatingFileWriter.ts`
* update `LogManager` to use rotating writers for:

  * eva.log, combined.log, agent.log, vision.log, audio.log
* rotation semantics exactly per ROTATION SEMANTICS section

Acceptance:

* temporarily set `logging.rotation.maxBytes` very small (e.g. 50_000)
* run stack and produce logs
* verify:

  * `vision.log.1`, `vision.log.2`, etc appear
  * total backups never exceed `maxFiles`
* `cd packages/eva && npm run build`

Stop; update `docs/progress.md`.

---

## Iteration 233 — Prune old run directories (`retention.maxRuns`)

Goal:

* `logs/runs/` remains bounded over time

Deliverables:

* implement pruning in `LogManager.init()`:

  * list run dirs under `<baseDir>/runs`
  * sort by name ascending
  * delete older dirs beyond `maxRuns` using `fs.rmSync(... recursive/force ...)`

Acceptance:

* create > `maxRuns` fake run dirs
* start Eva and verify older runs removed
* build passes

Stop; update `docs/progress.md`.

---

## Iteration 234 — Colorized, organized startup banner (console only)

Goal:

* console shows a clear “Eva Stack” summary and subprocess health progression

Deliverables:

* new file:

  * `packages/eva/src/logging/ConsoleRenderer.ts`
* modify `index.ts`:

  * print a banner:

    * runId + log dir
    * service endpoints (eva port + health URLs)
    * subprocess enabled flags
  * on each subprocess:

    * print `starting...`
    * print `healthy...`
  * print `eva listening...`

Acceptance:

* start stack, see banner + healthy markers
* build passes

Stop; update `docs/progress.md`.

---

## Iteration 235 — Console modes + filtering (default `compact`)

Goal:

* console is no longer unwieldy by default

Deliverables:

* implement filtering behavior in `ConsoleRenderer` exactly as defined
* modify `index.ts` + `ManagedProcess` wiring so:

  * subprocess console echo is done via `ConsoleRenderer.echoSubprocessLine(...)`
  * `ManagedProcess` no longer prints directly

Acceptance:

* `logging.console.mode=compact`:

  * mostly lifecycle + stderr + warn/error stdout heuristics + exit lines
* `logging.console.mode=follow`:

  * prints all streams
* `logging.console.mode=service:vision`:

  * only vision + lifecycle
* build passes

Stop; update `docs/progress.md`.

---

## Iteration 236 — Narrated shutdown sequence with timings + safe log flush

Goal:

* console shows clear shutdown; logs flush reliably

Deliverables:

* modify `index.ts` shutdown path:

  * print per-step durations:

    * close server
    * stop audio
    * stop vision
    * stop agent
  * always print log runDir at the end
  * call `await logManager.close()` before exit
* ensure “double-signal during shutdown” prints a clear message before force exit

Acceptance:

* Ctrl+C:

  * see narrated shutdown lines
  * confirm logs include shutdown markers
* build passes

Stop; update `docs/progress.md`.

---

## Iteration 237 — Documentation corrections (README + logging runbook)

Goal:

* docs match actual behavior and make logs discoverable

Deliverables:

1. `README.md`

* correct audio startup note (subprocess mode starts audio when enabled)
* document log location and how to find active run:

  * `packages/eva/logs/latest.txt`

2. add `docs/logging-runbook.md`:

* how to switch console modes
* how rotation works (including maxFiles semantics)
* where to look for per-service logs

Acceptance:

* docs render cleanly
* build passes

Stop; update `docs/progress.md`.

