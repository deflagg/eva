# Eva Protocol (v2)

Control/events are JSON over WebSocket. Binary transport (for camera frames and mic chunks) uses a shared envelope format.

## Binary Envelope Format

A binary payload is sent as one WebSocket message with layout:

1. 4-byte unsigned big-endian metadata length `N`
2. `N` bytes UTF-8 JSON metadata
3. Remaining bytes raw payload bytes

---

## Message Types

### 1) `frame_binary` envelope (UI -> Eva -> Vision)

Metadata shape:

```json
{
  "type": "frame_binary",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000000,
  "mime": "image/jpeg",
  "width": 1280,
  "height": 720,
  "image_bytes": 54321
}
```

Rules:
- `image_bytes` must match payload byte length.
- `mime` is currently fixed to `image/jpeg`.

### 2) `audio_binary` envelope (UI -> Eva -> Audio Runtime)

Metadata shape:

```json
{
  "type": "audio_binary",
  "v": 2,
  "chunk_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000000,
  "mime": "audio/pcm_s16le",
  "sample_rate_hz": 16000,
  "channels": 1,
  "audio_bytes": 640
}
```

Rules:
- `audio_bytes` must match payload byte length.
- Transport is PCM16 little-endian mono at 16kHz (`mime=audio/pcm_s16le`, `sample_rate_hz=16000`, `channels=1`).

### 3) `frame_received` (Eva -> UI)

Ingress ACK emitted by Eva immediately after frame enqueue/reject decision.

```json
{
  "type": "frame_received",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000001,
  "accepted": true,
  "queue_depth": 12,
  "dropped": 0,
  "motion": {
    "mad": 13.42,
    "triggered": true
  }
}
```

Notes:
- This is a receipt signal, not Vision inference completion.
- `motion` is optional MotionGate telemetry.

### 4) `audio_received` (Eva -> UI)

Ingress ACK emitted by Eva after audio chunk decode/accept decision.

```json
{
  "type": "audio_received",
  "v": 2,
  "chunk_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000001,
  "accepted": true,
  "queue_depth": 0,
  "dropped": 0
}
```

### 5) `frame_events` (Vision -> Eva -> UI)

```json
{
  "type": "frame_events",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000456,
  "width": 1280,
  "height": 720,
  "events": [
    {
      "name": "scene_caption",
      "ts_ms": 1700000000456,
      "severity": "low",
      "data": {
        "text": "a person entering the room",
        "model": "Salesforce/blip-image-captioning-base",
        "latency_ms": 181,
        "semantic": {
          "surprise": 0.61,
          "similarity_prev": 0.32,
          "similarity_mean": 0.41,
          "model": "openai/clip-vit-base-patch32",
          "latency_ms": 22,
          "should_escalate": true
        }
      }
    }
  ]
}
```

### 6) `insight` (Vision -> Eva -> UI)

```json
{
  "type": "insight",
  "v": 2,
  "clip_id": "2b84b71b-2db6-4781-bdc5-f2b35e643b1f",
  "trigger_frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000789,
  "summary": {
    "one_liner": "Two people crossed paths near the entry.",
    "tts_response": "Heads up, two people just crossed near the entry.",
    "what_changed": ["person entered", "person turned toward doorway"],
    "tags": ["entry", "motion"],
    "presence": {
      "preson_present": true,
      "person_facing_me": true
    }
  },
  "usage": {
    "input_tokens": 812,
    "output_tokens": 92,
    "cost_usd": 0.0021
  }
}
```

Notes:
- `summary.presence` is part of the canonical insight summary shape.
- `summary.presence` must include both `preson_present` and `person_facing_me`.
- `person_facing_me` should be `false` when `preson_present` is `false`.
- Field name is intentionally `preson_present` (compatibility spelling).

### 7) `speech_transcript` (Audio Runtime -> Eva)

```json
{
  "type": "speech_transcript",
  "v": 2,
  "ts_ms": 1700000000000,
  "text": "what time is it",
  "confidence": 0.8
}
```

### 8) `text_output` (Eva -> UI)

```json
{
  "type": "text_output",
  "v": 2,
  "request_id": "f53ef67c-70af-4b78-a2cb-5f49551de061",
  "session_id": "system-insights",
  "ts_ms": 1700000001200,
  "text": "Something changed near the entry.",
  "meta": {
    "tone": "conversational",
    "concepts": ["insight"],
    "surprise": 0,
    "note": "Auto utterance from insight."
  }
}
```

### 9) `speech_output` (Eva -> UI)

```json
{
  "type": "speech_output",
  "v": 2,
  "request_id": "f53ef67c-70af-4b78-a2cb-5f49551de061",
  "session_id": "system-alerts",
  "ts_ms": 1700000001234,
  "mime": "audio/mpeg",
  "voice": "alloy",
  "rate": 1,
  "text": "Alert: near collision.",
  "audio_b64": "<base64 mp3 bytes>",
  "meta": {
    "trigger_kind": "insight",
    "trigger_id": "2b84b71b-2db6-4781-bdc5-f2b35e643b1f",
    "severity": "high"
  }
}
```

### 10) `command` (UI -> Eva -> Vision)

```json
{
  "type": "command",
  "v": 2,
  "name": "attention_start"
}
```

### 11) `error` (any direction)

```json
{
  "type": "error",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "code": "SOME_CODE",
  "message": "Human-readable error"
}
```

### 12) `hello` (optional/debug)

```json
{
  "type": "hello",
  "v": 2,
  "role": "audio",
  "ts_ms": 1700000000000
}
```

Valid roles: `ui | eva | vision | audio`

## Notes

- Protocol version is fixed at `v: 2`.
- Canonical schema source: `packages/protocol/schema.json`.
