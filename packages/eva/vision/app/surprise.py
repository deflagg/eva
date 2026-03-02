from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class SurpriseMetrics:
    surprise: float
    similarity_prev: float
    similarity_mean: float
    should_escalate: bool


class SurpriseTracker:
    def __init__(self, *, history_size: int, threshold: float):
        if history_size < 1:
            raise ValueError("history_size must be >= 1")

        if threshold < 0 or threshold > 1:
            raise ValueError("threshold must be in range [0,1]")

        self._history_size = history_size
        self._threshold = threshold
        self._history: deque[np.ndarray] = deque()

    @property
    def history_length(self) -> int:
        return len(self._history)

    def update(self, embedding_vector: np.ndarray) -> SurpriseMetrics:
        vector = np.asarray(embedding_vector, dtype=np.float32).reshape(-1)
        if vector.size == 0:
            raise ValueError("embedding_vector must be non-empty")

        norm = float(np.linalg.norm(vector))
        if norm > 0:
            vector = vector / norm

        if self._history and self._history[-1].shape != vector.shape:
            # Model/output shape changed; reset rolling state cleanly.
            self._history.clear()

        if not self._history:
            similarity_prev = 1.0
            similarity_mean = 1.0
            surprise = 0.0
        else:
            previous_vector = self._history[-1]
            similarity_prev = _clamp_cosine(float(np.dot(vector, previous_vector)))

            stacked = np.stack(tuple(self._history), axis=0)
            mean_vector = stacked.mean(axis=0)
            mean_norm = float(np.linalg.norm(mean_vector))
            if mean_norm > 0:
                mean_vector = mean_vector / mean_norm
            similarity_mean = _clamp_cosine(float(np.dot(vector, mean_vector)))

            surprise = _clamp_01(1.0 - max(similarity_prev, similarity_mean))

        should_escalate = surprise >= self._threshold

        self._history.append(vector.copy())
        while len(self._history) > self._history_size:
            self._history.popleft()

        return SurpriseMetrics(
            surprise=surprise,
            similarity_prev=similarity_prev,
            similarity_mean=similarity_mean,
            should_escalate=should_escalate,
        )


def _clamp_01(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return value


def _clamp_cosine(value: float) -> float:
    if value < -1:
        return -1.0
    if value > 1:
        return 1.0
    return value
