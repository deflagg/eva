from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

PROTOCOL_VERSION: Literal[2] = 2
RoleType = Literal["ui", "eva", "vision", "audio"]

BINARY_META_LENGTH_BYTES = 4


class BinaryAudioParseError(ValueError):
    """Raised when a binary audio envelope cannot be decoded."""


class ProtocolMessage(BaseModel):
    type: str
    v: int = PROTOCOL_VERSION


class HelloMessage(ProtocolMessage):
    type: Literal["hello"] = "hello"
    v: Literal[2] = PROTOCOL_VERSION
    role: RoleType
    ts_ms: int = Field(ge=0)


class ErrorMessage(ProtocolMessage):
    type: Literal["error"] = "error"
    v: Literal[2] = PROTOCOL_VERSION
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)


class AudioBinaryMetaMessage(ProtocolMessage):
    type: Literal["audio_binary"] = "audio_binary"
    v: Literal[2] = PROTOCOL_VERSION
    chunk_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    mime: Literal["audio/pcm_s16le"] = "audio/pcm_s16le"
    sample_rate_hz: Literal[16000] = 16000
    channels: Literal[1] = 1
    audio_bytes: int = Field(ge=1)


class SpeechTranscriptMessage(ProtocolMessage):
    type: Literal["speech_transcript"] = "speech_transcript"
    v: Literal[2] = PROTOCOL_VERSION
    ts_ms: int = Field(ge=0)
    text: str = Field(min_length=1)
    confidence: float = Field(ge=0, le=1)


@dataclass(slots=True)
class BinaryAudioEnvelope:
    meta: AudioBinaryMetaMessage
    audio_bytes: bytes


def _extract_optional_chunk_id(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None

    chunk_id = payload.get("chunk_id")
    return chunk_id if isinstance(chunk_id, str) else None


def decode_binary_audio_envelope(payload: bytes) -> BinaryAudioEnvelope:
    if len(payload) < BINARY_META_LENGTH_BYTES:
        raise BinaryAudioParseError("Binary audio payload is too short.")

    metadata_length = int.from_bytes(payload[:BINARY_META_LENGTH_BYTES], byteorder="big", signed=False)
    if metadata_length <= 0:
        raise BinaryAudioParseError("Binary audio metadata length must be greater than zero.")

    metadata_start = BINARY_META_LENGTH_BYTES
    metadata_end = metadata_start + metadata_length

    if len(payload) < metadata_end:
        raise BinaryAudioParseError("Binary audio metadata length exceeds payload size.")

    metadata_raw = payload[metadata_start:metadata_end]

    try:
        metadata_obj = json.loads(metadata_raw.decode("utf-8"))
    except Exception as exc:
        raise BinaryAudioParseError("Binary audio metadata is not valid JSON.") from exc

    chunk_id = _extract_optional_chunk_id(metadata_obj)

    try:
        metadata = AudioBinaryMetaMessage.model_validate(metadata_obj)
    except ValidationError as exc:
        raise BinaryAudioParseError(
            f"Binary audio metadata is invalid{f' for chunk_id={chunk_id}' if chunk_id else ''}."
        ) from exc

    audio_payload = payload[metadata_end:]
    if len(audio_payload) != metadata.audio_bytes:
        raise BinaryAudioParseError(
            f"Binary audio payload length mismatch (expected {metadata.audio_bytes}, got {len(audio_payload)})."
        )

    return BinaryAudioEnvelope(meta=metadata, audio_bytes=audio_payload)


def make_hello(role: RoleType) -> dict[str, object]:
    return HelloMessage(role=role, ts_ms=int(time.time() * 1000)).model_dump(exclude_none=True)


def make_error(code: str, message: str) -> dict[str, object]:
    return ErrorMessage(code=code, message=message).model_dump(exclude_none=True)


def make_speech_transcript(*, ts_ms: int, text: str, confidence: float) -> dict[str, object]:
    normalized_text = text.strip()
    clamped_confidence = max(0.0, min(1.0, float(confidence)))

    return SpeechTranscriptMessage(
        ts_ms=max(0, int(ts_ms)),
        text=normalized_text,
        confidence=clamped_confidence,
    ).model_dump(exclude_none=True)
