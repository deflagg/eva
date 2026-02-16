# Protocol v1

JSON messages exchanged over WebSocket between:

- UI ↔ Eva (`ws://<eva-host>:8787/eye`)
- Eva ↔ QuickVision (`ws://<quickvision-host>:8000/infer`)

## Message types

### `frame`

```json
{
  "type": "frame",
  "v": 1,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "ts_ms": 1700000000000,
  "mime": "image/jpeg",
  "width": 1280,
  "height": 720,
  "image_b64": "<base64 jpeg bytes>"
}
```

### `detections`

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
    { "cls": 0, "name": "person", "conf": 0.91, "box": [100, 80, 430, 700] }
  ]
}
```

### `error`

```json
{
  "type": "error",
  "v": 1,
  "frame_id": "550e8400-e29b-41d4-a716-446655440000",
  "code": "QV_UNAVAILABLE",
  "message": "QuickVision is not connected"
}
```

### Optional `hello`

```json
{
  "type": "hello",
  "v": 1,
  "role": "eva",
  "ts_ms": 1700000000000
}
```

## Notes

- `v` is protocol version and is currently fixed at `1`.
- `image_b64` must be raw base64 bytes without a `data:` prefix.
- Detection boxes are pixel coordinates in source frame space: `[x1, y1, x2, y2]`.
