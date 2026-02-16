# Eva Protocol (v1)

JSON messages are exchanged over WebSockets.

## Message Types

### 1) `frame` (UI -> Eva -> QuickVision)

```json
{
  "type": "frame",
  "v": 1,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000000,
  "mime": "image/jpeg",
  "width": 1280,
  "height": 720,
  "image_b64": "<base64 jpeg bytes, no data: prefix>"
}
```

### 2) `detections` (QuickVision -> Eva -> UI)

```json
{
  "type": "detections",
  "v": 1,
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
      "box": [120, 80, 420, 640]
    }
  ]
}
```

### 3) `error` (any direction)

```json
{
  "type": "error",
  "v": 1,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "code": "SOME_CODE",
  "message": "Human-readable error"
}
```

### 4) Optional `hello` (debug)

```json
{
  "type": "hello",
  "v": 1,
  "role": "ui",
  "ts_ms": 1700000000000
}
```

## Notes

- `v` is protocol version and is currently fixed at `1`.
- `image_b64` must be raw base64 bytes (no `data:` URL prefix).
- Detection `box` coordinates are in source-frame pixel space: `[x1, y1, x2, y2]`.
