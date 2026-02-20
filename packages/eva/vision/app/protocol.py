from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

PROTOCOL_VERSION: Literal[1] = 1
RoleType = Literal["ui", "eva", "quickvision"]
InsightSeverity = Literal["low", "medium", "high"]

BINARY_META_LENGTH_BYTES = 4


class BinaryFrameParseError(ValueError):
    """Raised when a binary frame envelope cannot be decoded."""


class ProtocolMessage(BaseModel):
    type: str
    v: int = PROTOCOL_VERSION


class HelloMessage(ProtocolMessage):
    type: Literal["hello"] = "hello"
    v: Literal[1] = PROTOCOL_VERSION
    role: RoleType
    ts_ms: int = Field(ge=0)


class ErrorMessage(ProtocolMessage):
    type: Literal["error"] = "error"
    v: Literal[1] = PROTOCOL_VERSION
    frame_id: str | None = None
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)


class CommandMessage(ProtocolMessage):
    type: Literal["command"] = "command"
    v: Literal[1] = PROTOCOL_VERSION
    name: str = Field(min_length=1)


class FrameBinaryMetaMessage(ProtocolMessage):
    type: Literal["frame_binary"] = "frame_binary"
    v: Literal[1] = PROTOCOL_VERSION
    frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    mime: Literal["image/jpeg"] = "image/jpeg"
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    image_bytes: int = Field(ge=1)


@dataclass(slots=True)
class BinaryFrameEnvelope:
    meta: FrameBinaryMetaMessage
    image_payload: bytes


class DetectionEntry(BaseModel):
    cls: int = Field(ge=0)
    name: str = Field(min_length=1)
    conf: float = Field(ge=0, le=1)
    box: tuple[float, float, float, float]
    track_id: int | None = None


class EventEntry(BaseModel):
    name: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    severity: InsightSeverity
    track_id: int | None = None
    data: dict[str, Any]


class DetectionsMessage(ProtocolMessage):
    type: Literal["detections"] = "detections"
    v: Literal[1] = PROTOCOL_VERSION
    frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    model: str = Field(min_length=1)
    detections: list[DetectionEntry]
    events: list[EventEntry] | None = None


class InsightSummary(BaseModel):
    one_liner: str = Field(min_length=1)
    tts_response: str = Field(min_length=1)
    what_changed: list[str]
    severity: InsightSeverity
    tags: list[str]


class InsightUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0)


class InsightMessage(ProtocolMessage):
    type: Literal["insight"] = "insight"
    v: Literal[1] = PROTOCOL_VERSION
    clip_id: str = Field(min_length=1)
    trigger_frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    summary: InsightSummary
    usage: InsightUsage


def _extract_optional_frame_id(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None

    frame_id = payload.get("frame_id")
    return frame_id if isinstance(frame_id, str) else None


def decode_binary_frame_envelope(payload: bytes) -> BinaryFrameEnvelope:
    if len(payload) < BINARY_META_LENGTH_BYTES:
        raise BinaryFrameParseError("Binary frame payload is too short.")

    metadata_length = int.from_bytes(payload[:BINARY_META_LENGTH_BYTES], byteorder="big", signed=False)
    if metadata_length <= 0:
        raise BinaryFrameParseError("Binary frame metadata length must be greater than zero.")

    metadata_start = BINARY_META_LENGTH_BYTES
    metadata_end = metadata_start + metadata_length

    if len(payload) < metadata_end:
        raise BinaryFrameParseError("Binary frame metadata length exceeds payload size.")

    metadata_raw = payload[metadata_start:metadata_end]

    try:
        metadata_obj = json.loads(metadata_raw.decode("utf-8"))
    except Exception as exc:
        raise BinaryFrameParseError("Binary frame metadata is not valid JSON.") from exc

    frame_id = _extract_optional_frame_id(metadata_obj)

    try:
        metadata = FrameBinaryMetaMessage.model_validate(metadata_obj)
    except ValidationError as exc:
        raise BinaryFrameParseError(
            f"Binary frame metadata is invalid{f' for frame_id={frame_id}' if frame_id else ''}."
        ) from exc

    image_payload = payload[metadata_end:]
    if len(image_payload) != metadata.image_bytes:
        raise BinaryFrameParseError(
            f"Binary frame image length mismatch (expected {metadata.image_bytes}, got {len(image_payload)})."
        )

    return BinaryFrameEnvelope(meta=metadata, image_payload=image_payload)


def make_hello(role: RoleType) -> dict[str, object]:
    return HelloMessage(role=role, ts_ms=int(time.time() * 1000)).model_dump(exclude_none=True)


def make_error(code: str, message: str, frame_id: str | None = None) -> dict[str, object]:
    return ErrorMessage(code=code, message=message, frame_id=frame_id).model_dump(exclude_none=True)
