from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AttentionState:
    window_ms: int
    active_until_ms: int | None
    is_active: bool


class AttentionWindow:
    def __init__(self, *, window_ms: int):
        if window_ms < 1:
            raise ValueError("Attention window_ms must be >= 1")

        self._window_ms = window_ms
        self._active_until_ms: int | None = None

    @property
    def window_ms(self) -> int:
        return self._window_ms

    @property
    def active_until_ms(self) -> int | None:
        return self._active_until_ms

    def activate(self, *, now_ms: int | None = None) -> int:
        now = _current_time_ms() if now_ms is None else now_ms
        self._active_until_ms = now + self._window_ms
        return self._active_until_ms

    def is_active(self, *, now_ms: int | None = None) -> bool:
        if self._active_until_ms is None:
            return False

        now = _current_time_ms() if now_ms is None else now_ms
        return now < self._active_until_ms

    def state(self, *, now_ms: int | None = None) -> AttentionState:
        return AttentionState(
            window_ms=self._window_ms,
            active_until_ms=self._active_until_ms,
            is_active=self.is_active(now_ms=now_ms),
        )


def _current_time_ms() -> int:
    return int(time.time() * 1000)
