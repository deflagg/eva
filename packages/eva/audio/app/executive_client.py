from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError


class ExecutiveClientError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class PresenceResponse(BaseModel):
    found: bool
    preson_present: bool
    person_facing_me: bool
    age_ms: int = Field(ge=0)
    ts_ms: int | None = Field(default=None, ge=0)


@dataclass(frozen=True, slots=True)
class PresenceSnapshot:
    found: bool
    preson_present: bool
    person_facing_me: bool
    age_ms: int
    ts_ms: int | None


class ExecutiveClient:
    def __init__(self, *, base_url: str, timeout_ms: int):
        normalized_base_url = base_url.strip()
        if not normalized_base_url:
            raise RuntimeError("Audio config error: executive.base_url must be a non-empty string")

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

    async def get_presence(self, *, window_ms: int) -> PresenceSnapshot:
        if window_ms <= 0:
            raise ExecutiveClientError("EXECUTIVE_REQUEST_INVALID", "Presence window must be a positive integer.")

        try:
            response = await self._http_client.get(
                "/presence",
                params={"window_ms": str(window_ms)},
                headers={"accept": "application/json"},
            )
        except httpx.TimeoutException:
            raise ExecutiveClientError(
                "EXECUTIVE_TIMEOUT",
                f"Executive /presence request timed out after {self._timeout_ms}ms.",
            ) from None
        except httpx.HTTPError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_UNREACHABLE",
                f"Executive /presence request failed: {exc}",
            ) from exc

        if response.status_code >= 400:
            payload_obj: Any
            try:
                payload_obj = response.json()
            except Exception:
                payload_obj = None

            message = _extract_error_message(
                payload_obj,
                fallback=f"Executive /presence returned HTTP {response.status_code}.",
            )
            raise ExecutiveClientError("EXECUTIVE_ERROR", message)

        try:
            payload_obj = response.json()
        except Exception:
            raise ExecutiveClientError(
                "EXECUTIVE_INVALID_RESPONSE",
                "Executive /presence returned non-JSON response.",
            ) from None

        try:
            parsed = PresenceResponse.model_validate(payload_obj)
        except ValidationError as exc:
            raise ExecutiveClientError(
                "EXECUTIVE_INVALID_RESPONSE",
                f"Executive /presence response schema validation failed: {exc}",
            ) from exc

        return PresenceSnapshot(
            found=parsed.found,
            preson_present=parsed.preson_present,
            person_facing_me=parsed.person_facing_me,
            age_ms=parsed.age_ms,
            ts_ms=parsed.ts_ms,
        )


def _extract_error_message(payload: Any, *, fallback: str) -> str:
    if isinstance(payload, dict):
        error_obj = payload.get("error")
        if isinstance(error_obj, dict):
            message = error_obj.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()

    return fallback
