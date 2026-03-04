from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError


class ExecutiveClientError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ExecutiveEventItem(BaseModel):
    name: str = Field(min_length=1)
    ts_ms: int = Field(ge=0)
    severity: str = Field(pattern="^(low|medium|high)$")
    track_id: int | None = None
    data: dict[str, Any]


class ExecutiveEventsRequest(BaseModel):
    v: int = Field(default=1)
    source: str = Field(min_length=1)
    events: list[ExecutiveEventItem] = Field(min_length=1)
    meta: dict[str, Any] | None = None


class ExecutiveEventsResponse(BaseModel):
    accepted: int = Field(ge=0)
    ts_ms: int = Field(ge=0)


class ExecutiveClipFrame(BaseModel):
    frame_id: str | None = None
    ts_ms: int | None = None
    mime: str = Field(default="image/jpeg")
    asset_rel_path: str = Field(min_length=1)


class ExecutiveInsightRequest(BaseModel):
    clip_id: str = Field(min_length=1)
    trigger_frame_id: str = Field(min_length=1)
    frames: list[ExecutiveClipFrame] = Field(min_length=1)


class ExecutiveInsightPresence(BaseModel):
    preson_present: bool
    person_facing_me: bool


class ExecutiveInsightSummary(BaseModel):
    one_liner: str = Field(min_length=1)
    tts_response: str = Field(min_length=1)
    what_changed: list[str] = Field(min_length=1)
    tags: list[str] = Field(min_length=1)
    presence: ExecutiveInsightPresence | None = None


class ExecutiveInsightUsage(BaseModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_usd: float = Field(ge=0)


class ExecutiveInsightResponse(BaseModel):
    summary: ExecutiveInsightSummary
    usage: ExecutiveInsightUsage


def _extract_error_message(payload: Any, *, fallback: str) -> str:
    if isinstance(payload, dict):
        error_obj = payload.get("error")
        if isinstance(error_obj, dict):
            message = error_obj.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()

    return fallback


class ExecutiveClient:
    def __init__(self, *, base_url: str, timeout_ms: int):
        normalized_base_url = base_url.strip()
        if not normalized_base_url:
            raise RuntimeError("Vision config error: executive.base_url must be a non-empty string")

        timeout_seconds = max(timeout_ms, 1) / 1000.0

        self._base_url = normalized_base_url
        self._timeout_ms = max(timeout_ms, 1)
        self._http_client = httpx.AsyncClient(base_url=self._base_url, timeout=timeout_seconds)

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def timeout_ms(self) -> int:
        return self._timeout_ms

    async def close(self) -> None:
        await self._http_client.aclose()

    async def post_events(
        self,
        *,
        source: str,
        events: list[dict[str, Any]],
        meta: dict[str, Any] | None = None,
    ) -> ExecutiveEventsResponse:
        try:
            request_payload = ExecutiveEventsRequest(
                v=1,
                source=source,
                events=events,
                meta=meta,
            )
        except ValidationError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_REQUEST_INVALID",
                f"Invalid /events payload: {exc}",
            ) from exc

        response_payload = await self._post_json("/events", request_payload.model_dump(exclude_none=True), action="events")

        try:
            return ExecutiveEventsResponse.model_validate(response_payload)
        except ValidationError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_INVALID_RESPONSE",
                f"Executive /events response schema validation failed: {exc}",
            ) from exc

    async def post_insight(
        self,
        *,
        clip_id: str,
        trigger_frame_id: str,
        frames: list[dict[str, Any]],
    ) -> ExecutiveInsightResponse:
        try:
            request_payload = ExecutiveInsightRequest(
                clip_id=clip_id,
                trigger_frame_id=trigger_frame_id,
                frames=frames,
            )
        except ValidationError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_REQUEST_INVALID",
                f"Invalid /insight payload: {exc}",
            ) from exc

        response_payload = await self._post_json("/insight", request_payload.model_dump(exclude_none=True), action="insight")

        try:
            return ExecutiveInsightResponse.model_validate(response_payload)
        except ValidationError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_INVALID_RESPONSE",
                f"Executive /insight response schema validation failed: {exc}",
            ) from exc

    async def _post_json(self, path: str, payload: dict[str, Any], *, action: str) -> Any:
        try:
            response = await self._http_client.post(
                path,
                json=payload,
                headers={"content-type": "application/json"},
            )
        except httpx.TimeoutException:
            raise ExecutiveClientError(
                "EXECUTIVE_TIMEOUT",
                f"Executive /{action} request timed out after {self._timeout_ms}ms.",
            ) from None
        except httpx.HTTPError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_UNREACHABLE",
                f"Executive /{action} request failed: {exc}",
            ) from exc

        if response.status_code >= 400:
            payload_obj: Any
            try:
                payload_obj = response.json()
            except Exception:
                payload_obj = None

            message = _extract_error_message(
                payload_obj,
                fallback=f"Executive /{action} returned HTTP {response.status_code}.",
            )
            raise ExecutiveClientError("EXECUTIVE_ERROR", message)

        try:
            return response.json()
        except Exception:
            raise ExecutiveClientError(
                "EXECUTIVE_INVALID_RESPONSE",
                f"Executive /{action} returned non-JSON response.",
            ) from None
