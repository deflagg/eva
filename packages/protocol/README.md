# Eva Protocol (v2)

Detections/control messages are JSON over WebSocket. Frame transport (UI -> Eva -> Vision) uses a binary envelope.

## Message Types

### 1) `frame_binary` envelope (UI -> Eva -> Vision)

Each frame is sent as one **binary WebSocket message** with this layout:

1. **4 bytes**: unsigned big-endian metadata length `N`
2. **N bytes**: UTF-8 JSON metadata object
3. **remaining bytes**: raw JPEG payload

Metadata JSON shape:

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
- `image_bytes` must exactly match the binary JPEG payload size.
- `mime` is currently fixed to `image/jpeg`.

### 2) `frame_received` (Eva -> UI) JSON

Receipt ACK emitted by Eva as soon as a binary frame is accepted by Eva runtime ingress.

```json
{
  "type": "frame_received",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000001,
  "accepted": true,
  "queue_depth": 12,
  "dropped": 0
}
```

Notes:
- This is a **receipt** signal, not a Vision processing completion signal.
- `accepted=false` means Eva dropped/rejected the frame at ingress.
- `queue_depth` and `dropped` are broker-facing observability counters.

### 3) `detections` (Vision -> Eva -> UI) JSON

```json
{
  "type": "detections",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000000,
  "width": 1280,
  "height": 720,
  "model": "yoloe-26",
  "detections": [
    {
      "cls": 0,
      "name": "person",
      "conf": 0.91,
      "box": [120, 80, 420, 640],
      "track_id": 17
    }
  ],
  "events": [
    {
      "name": "line_cross",
      "ts_ms": 1700000000123,
      "severity": "medium",
      "track_id": 17,
      "data": {
        "line": "doorway",
        "direction": "A->B"
      }
    }
  ]
}
```

Notes:
- `detection.track_id` is optional.
- `detections.events` is optional.
- `events[].severity` is one of `low | medium | high`.

### 4) `insight` (Vision -> Eva -> UI) JSON

> Important: insight messages do **not** include `frame_id`.

```json
{
  "type": "insight",
  "v": 2,
  "clip_id": "2b84b71b-2db6-4781-bdc5-f2b35e643b1f",
  "trigger_frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000456,
  "summary": {
    "one_liner": "Two people crossed paths quickly near the entry.",
    "tts_response": "Whoa—did those two just cross paths near the entry? Was that expected?",
    "what_changed": [
      "Person A entered from left",
      "Person B moved toward doorway"
    ],
    "severity": "medium",
    "tags": ["entry", "motion"]
  },
  "usage": {
    "input_tokens": 812,
    "output_tokens": 92,
    "cost_usd": 0.0021
  }
}
```

Notes:
- `summary.tts_response` is required and carries the conversational utterance string produced by the insight model.

### 5) `text_output` (Eva -> UI) JSON

Used for immediate server-originated text replies/alerts.

```json
{
  "type": "text_output",
  "v": 2,
  "request_id": "f53ef67c-70af-4b78-a2cb-5f49551de061",
  "session_id": "system-alerts",
  "ts_ms": 1700000001200,
  "text": "Alert: near collision.",
  "meta": {
    "tone": "urgent",
    "concepts": ["high_severity", "alert"],
    "surprise": 1,
    "note": "Auto alert (push mode)."
  }
}
```

### 6) `speech_output` (Eva -> UI) JSON

> Additive protocol extension for server-originated spoken output.
>
> Browser autoplay policy still applies: clients may need a one-time user gesture (for example, an **Enable Audio** button) before automatic playback is allowed.

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

### 7) `command` (UI -> Eva -> Vision, debug) JSON

> Temporary debug command introduced in Iteration 13.

```json
{
  "type": "command",
  "v": 2,
  "name": "insight_test"
}
```

### 8) `error` (any direction) JSON

```json
{
  "type": "error",
  "v": 2,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "code": "SOME_CODE",
  "message": "Human-readable error"
}
```

### 9) Optional `hello` (debug) JSON

```json
{
  "type": "hello",
  "v": 2,
  "role": "ui",
  "ts_ms": 1700000000000
}
```

## Notes

- `v` is protocol version and is currently fixed at `2`.
- Detection `box` coordinates are in source-frame pixel space: `[x1, y1, x2, y2]`.
