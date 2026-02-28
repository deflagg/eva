# Captioner

Tier-1 caption service for Eva.

## Current behavior (Iteration 166)

- `GET /health` returns service/config/model health info.
- `POST /caption`:
  - expects `Content-Type: image/jpeg`
  - enforces `caption.max_body_bytes`
  - decodes JPEG, resizes to configured `max_dim`, runs BLIP captioning, returns:
    - `{"text":"...","latency_ms":<number>,"model":"<model_id>"}`

## Config

Configured via `settings.yaml` (with optional `settings.local.yaml` override):

- `server.host`
- `server.port`
- `caption.enabled`
- `caption.model_id`
- `caption.device` (`auto|cuda|cpu`)
- `caption.max_dim`
- `caption.max_new_tokens`
- `caption.max_body_bytes`

Default Tier-1 model/settings:

```yaml
caption:
  enabled: true
  model_id: Salesforce/blip-image-captioning-base
  device: cuda
  max_dim: 384
  max_new_tokens: 24
  max_body_bytes: 1048576
```

## Run (dev)

```bash
cd packages/eva/captioner
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.run
```

## Manual curl smoke check

```bash
# tiny JPEG file for testing
printf '\xFF\xD8\xFF\xD9' > /tmp/captioner-test.jpg

curl -sS -X POST \
  -H 'Content-Type: image/jpeg' \
  --data-binary @/tmp/captioner-test.jpg \
  http://127.0.0.1:8792/caption
```
