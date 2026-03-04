# Logging Runbook

This runbook covers Eva centralized logs, console modes, and rotation behavior.

## Log location and active run

Base log directory (default):

- `packages/eva/logs`

Each start creates a run directory:

- `packages/eva/logs/runs/<runId>/`

Find the active run directory quickly:

- `packages/eva/logs/latest.txt`
  - file content is the absolute path to the active run dir.

Example:

```bash
cd packages/eva
cat logs/latest.txt
```

## Per-service files

Inside each run directory:

- `eva.log` — Eva lifecycle/internal logs
- `agent.log` — Executive subprocess stdout/stderr records
- `vision.log` — Vision subprocess stdout/stderr records
- `audio.log` — Audio subprocess stdout/stderr records
- `combined.log` — interleaved timestamped records across Eva + subprocesses

## Console modes

Configure under `logging.console.mode` in `packages/eva/eva.config.local.json`.

Supported values:

- `compact` (default)
- `follow`
- `service:eva`
- `service:agent`
- `service:vision`
- `service:audio`

Behavior:

- `compact`
  - always prints lifecycle lines
  - always prints subprocess `stderr`
  - prints subprocess `stdout` only when matching:
    - `/\b(warn|warning|error|failed|fatal)\b/i`
  - suppresses empty subprocess lines in console
- `follow`
  - prints all subprocess stdout/stderr lines
- `service:<name>`
  - prints only that subprocess stream lines
  - lifecycle lines always print

Example override:

```json
{
  "logging": {
    "console": {
      "mode": "service:vision",
      "timestamps": true
    }
  }
}
```

## Rotation semantics

Configured under `logging.rotation`:

- `maxBytes`: rotate threshold per active file
- `maxFiles`: number of backup files kept

Rotation behavior:

- rotate **before write** when:
  - `currentSizeBytes + recordBytes > maxBytes`
- if `currentSizeBytes + recordBytes === maxBytes`, the write stays in the active file (no rotate)
- backup naming:
  - active file: `vision.log`
  - backups: `vision.log.1`, `vision.log.2`, ..., `vision.log.<maxFiles>`
- `maxFiles` counts backups only (active file is separate)
  - total possible files per log = `1 + maxFiles`

## Run retention

Configured under `logging.retention.maxRuns`.

- Eva keeps the newest run directories and prunes older ones under `logs/runs/`.

## Quick checks

```bash
cd packages/eva
npm run dev
cat logs/latest.txt
RUN_DIR=$(cat logs/latest.txt)
ls -la "$RUN_DIR"
```
