from __future__ import annotations

from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError

InsightSeverity = Literal["low", "medium", "high"]


class VisionAgentClientError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class VisionAgentFrame(BaseModel):
    frame_id: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    mime: Literal["image/jpeg"] = "image/jpeg"
    image_b64: str = Field(min_length=1)


class VisionAgentInsightRequest(BaseModel):
    clip_id: str = Field(min_length=1)
    trigger_frame_id: str = Field(min_length=1)
    frames: list[VisionAgentFrame] = Field(min_length=1)


class VisionAgentInsightSummary(BaseModel):
    one_liner: str = Field(min_length=1)
    what_changed: list[str] = Field(min_length=1)
    severity: InsightSeverity
    tags: list[str] = Field(min_length=1)


class VisionAgentInsightUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0)


class VisionAgentInsightResponse(BaseModel):
    summary: VisionAgentInsightSummary
    usage: VisionAgentInsightUsage


def _extract_error_message(payload: Any, fallback: str) -> str:
    if isinstance(payload, dict):
        error_obj = payload.get("error")
        if isinstance(error_obj, dict):
            message = error_obj.get("message")
            if isinstance(message, str) and message.strip():
                return message

    return fallback


class VisionAgentClient:
    def __init__(self, base_url: str, timeout_ms: int):
        self.base_url = base_url
        self.timeout_ms = timeout_ms

    async def request_insight(
        self,
        *,
        clip_id: str,
        trigger_frame_id: str,
        frames: list[VisionAgentFrame],
    ) -> VisionAgentInsightResponse:
        request_payload = VisionAgentInsightRequest(
            clip_id=clip_id,
            trigger_frame_id=trigger_frame_id,
            frames=frames,
        )

        timeout_seconds = max(self.timeout_ms, 1) / 1000.0

        try:
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.post(
                    self.base_url,
                    json=request_payload.model_dump(exclude_none=True),
                    headers={"content-type": "application/json"},
                )
        except httpx.TimeoutException:
            raise VisionAgentClientError(
                "VISION_AGENT_TIMEOUT",
                f"VisionAgent request timed out after {self.timeout_ms}ms.",
            ) from None
        except httpx.HTTPError as exc:
            raise VisionAgentClientError(
                "VISION_AGENT_UNREACHABLE",
                f"VisionAgent request failed: {exc}",
            ) from exc

        if response.status_code >= 400:
            payload: Any
            try:
                payload = response.json()
            except Exception:
                payload = None

            message = _extract_error_message(
                payload,
                f"VisionAgent returned HTTP {response.status_code}.",
            )
            raise VisionAgentClientError("VISION_AGENT_ERROR", message)

        try:
            payload = response.json()
        except Exception:
            raise VisionAgentClientError("VISION_AGENT_INVALID_RESPONSE", "VisionAgent returned non-JSON response.")

        try:
            return VisionAgentInsightResponse.model_validate(payload)
        except ValidationError as exc:
            raise VisionAgentClientError(
                "VISION_AGENT_INVALID_RESPONSE",
                f"VisionAgent response schema validation failed: {exc}",
            ) from exc
