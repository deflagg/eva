from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION: Literal[1] = 1
RoleType = Literal["ui", "eva", "quickvision"]


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


class FrameMessage(ProtocolMessage):
    type: Literal["frame"] = "frame"
    v: Literal[1] = PROTOCOL_VERSION
    frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    mime: Literal["image/jpeg"] = "image/jpeg"
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    image_b64: str = Field(min_length=1)


class DetectionEntry(BaseModel):
    cls: int = Field(ge=0)
    name: str = Field(min_length=1)
    conf: float = Field(ge=0, le=1)
    box: tuple[float, float, float, float]


class DetectionsMessage(ProtocolMessage):
    type: Literal["detections"] = "detections"
    v: Literal[1] = PROTOCOL_VERSION
    frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    model: str = Field(min_length=1)
    detections: list[DetectionEntry]


def make_hello(role: RoleType) -> dict[str, object]:
    return HelloMessage(role=role, ts_ms=int(time.time() * 1000)).model_dump(exclude_none=True)


def make_error(code: str, message: str, frame_id: str | None = None) -> dict[str, object]:
    return ErrorMessage(code=code, message=message, frame_id=frame_id).model_dump(exclude_none=True)
