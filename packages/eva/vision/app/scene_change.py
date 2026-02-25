from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Literal

import numpy as np
from PIL import Image, UnidentifiedImageError

from .protocol import EventEntry
from .settings import settings

DEFAULT_DOWNSAMPLE_MAX_DIM = 160
DEFAULT_EMA_ALPHA = 0.08
DEFAULT_PIXEL_THRESHOLD = 18.0
DEFAULT_CELL_PX = 10
DEFAULT_CELL_ACTIVE_RATIO = 0.08
DEFAULT_MIN_BLOB_CELLS = 4
DEFAULT_SCORE_THRESHOLD = 1.2
DEFAULT_MIN_PERSIST_FRAMES = 3
DEFAULT_COOLDOWN_MS = 2500
DEFAULT_SEVERITY_MEDIUM_SCORE = 2.5
DEFAULT_SEVERITY_HIGH_SCORE = 5.0


class SceneChangeFrameDecodeError(ValueError):
    """Raised when a frame payload cannot be decoded into an image."""


@dataclass(slots=True)
class SceneChangeDownsampleSettings:
    max_dim: int


@dataclass(slots=True)
class SceneChangeSeveritySettings:
    medium_score: float
    high_score: float


@dataclass(slots=True)
class SceneChangeSettings:
    enabled: bool
    downsample: SceneChangeDownsampleSettings
    ema_alpha: float
    pixel_threshold: float
    cell_px: int
    cell_active_ratio: float
    min_blob_cells: int
    score_threshold: float
    min_persist_frames: int
    cooldown_ms: int
    severity: SceneChangeSeveritySettings


@dataclass(slots=True)
class SceneBlob:
    x1: float
    y1: float
    x2: float
    y2: float
    area_cells: int
    density: float


_scene_change_settings: SceneChangeSettings | None = None


def _as_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False

    return default


def _as_positive_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a positive integer")

    if isinstance(value, int):
        if value <= 0:
            raise RuntimeError(f"Vision config error: {key} must be a positive integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        if parsed <= 0:
            raise RuntimeError(f"Vision config error: {key} must be a positive integer")
        return parsed

    raise RuntimeError(f"Vision config error: {key} must be a positive integer")


def _as_non_negative_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")

    if isinstance(value, int):
        if value < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())

    raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")


def _as_non_negative_float(value: Any, *, key: str, default: float) -> float:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a non-negative number")

    if isinstance(value, (int, float)):
        parsed = float(value)
        if parsed < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")
        return parsed

    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError as exc:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number") from exc

        if parsed < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative number")

        return parsed

    raise RuntimeError(f"Vision config error: {key} must be a non-negative number")


def _as_ratio_float(value: Any, *, key: str, default: float) -> float:
    parsed = _as_non_negative_float(value, key=key, default=default)
    if parsed > 1.0:
        raise RuntimeError(f"Vision config error: {key} must be between 0 and 1")
    return parsed


def load_scene_change_settings() -> SceneChangeSettings:
    global _scene_change_settings

    if _scene_change_settings is not None:
        return _scene_change_settings

    enabled = _as_bool(settings.get("scene_change.enabled", default=True), default=True)
    downsample_max_dim = _as_positive_int(
        settings.get("scene_change.downsample.max_dim", default=DEFAULT_DOWNSAMPLE_MAX_DIM),
        key="scene_change.downsample.max_dim",
        default=DEFAULT_DOWNSAMPLE_MAX_DIM,
    )
    ema_alpha = _as_non_negative_float(
        settings.get("scene_change.ema_alpha", default=DEFAULT_EMA_ALPHA),
        key="scene_change.ema_alpha",
        default=DEFAULT_EMA_ALPHA,
    )
    if ema_alpha <= 0 or ema_alpha > 1:
        raise RuntimeError("Vision config error: scene_change.ema_alpha must be > 0 and <= 1")

    pixel_threshold = _as_non_negative_float(
        settings.get("scene_change.pixel_threshold", default=DEFAULT_PIXEL_THRESHOLD),
        key="scene_change.pixel_threshold",
        default=DEFAULT_PIXEL_THRESHOLD,
    )
    cell_px = _as_positive_int(
        settings.get("scene_change.cell_px", default=DEFAULT_CELL_PX),
        key="scene_change.cell_px",
        default=DEFAULT_CELL_PX,
    )
    cell_active_ratio = _as_ratio_float(
        settings.get("scene_change.cell_active_ratio", default=DEFAULT_CELL_ACTIVE_RATIO),
        key="scene_change.cell_active_ratio",
        default=DEFAULT_CELL_ACTIVE_RATIO,
    )
    min_blob_cells = _as_positive_int(
        settings.get("scene_change.min_blob_cells", default=DEFAULT_MIN_BLOB_CELLS),
        key="scene_change.min_blob_cells",
        default=DEFAULT_MIN_BLOB_CELLS,
    )
    score_threshold = _as_non_negative_float(
        settings.get("scene_change.score_threshold", default=DEFAULT_SCORE_THRESHOLD),
        key="scene_change.score_threshold",
        default=DEFAULT_SCORE_THRESHOLD,
    )
    min_persist_frames = _as_positive_int(
        settings.get("scene_change.min_persist_frames", default=DEFAULT_MIN_PERSIST_FRAMES),
        key="scene_change.min_persist_frames",
        default=DEFAULT_MIN_PERSIST_FRAMES,
    )
    cooldown_ms = _as_non_negative_int(
        settings.get("scene_change.cooldown_ms", default=DEFAULT_COOLDOWN_MS),
        key="scene_change.cooldown_ms",
        default=DEFAULT_COOLDOWN_MS,
    )

    medium_score = _as_non_negative_float(
        settings.get("scene_change.severity.medium_score", default=DEFAULT_SEVERITY_MEDIUM_SCORE),
        key="scene_change.severity.medium_score",
        default=DEFAULT_SEVERITY_MEDIUM_SCORE,
    )
    high_score = _as_non_negative_float(
        settings.get("scene_change.severity.high_score", default=DEFAULT_SEVERITY_HIGH_SCORE),
        key="scene_change.severity.high_score",
        default=DEFAULT_SEVERITY_HIGH_SCORE,
    )
    if high_score < medium_score:
        raise RuntimeError(
            "Vision config error: scene_change.severity.high_score must be >= scene_change.severity.medium_score"
        )

    _scene_change_settings = SceneChangeSettings(
        enabled=enabled,
        downsample=SceneChangeDownsampleSettings(max_dim=downsample_max_dim),
        ema_alpha=ema_alpha,
        pixel_threshold=pixel_threshold,
        cell_px=cell_px,
        cell_active_ratio=cell_active_ratio,
        min_blob_cells=min_blob_cells,
        score_threshold=score_threshold,
        min_persist_frames=min_persist_frames,
        cooldown_ms=cooldown_ms,
        severity=SceneChangeSeveritySettings(
            medium_score=medium_score,
            high_score=high_score,
        ),
    )

    return _scene_change_settings


def _decode_to_grayscale(*, jpeg_bytes: bytes, max_dim: int) -> np.ndarray:
    try:
        with Image.open(BytesIO(jpeg_bytes)) as source_image:
            image = source_image.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise SceneChangeFrameDecodeError("Frame image payload is not a valid JPEG image.") from exc

    source_width, source_height = image.size
    longest_side = max(source_width, source_height)

    if longest_side > max_dim:
        scale = max_dim / float(longest_side)
        target_size = (
            max(1, int(round(source_width * scale))),
            max(1, int(round(source_height * scale))),
        )
        image = image.resize(target_size, Image.Resampling.BILINEAR)

    grayscale = image.convert("L")
    return np.asarray(grayscale, dtype=np.uint8)


def _pool_cell_ratios(mask: np.ndarray, *, cell_px: int) -> np.ndarray:
    frame_height, frame_width = mask.shape
    grid_rows = math.ceil(frame_height / cell_px)
    grid_cols = math.ceil(frame_width / cell_px)

    ratios = np.zeros((grid_rows, grid_cols), dtype=np.float32)

    for row in range(grid_rows):
        y1 = row * cell_px
        y2 = min(frame_height, y1 + cell_px)

        for col in range(grid_cols):
            x1 = col * cell_px
            x2 = min(frame_width, x1 + cell_px)
            cell_mask = mask[y1:y2, x1:x2]
            ratios[row, col] = float(cell_mask.mean()) if cell_mask.size > 0 else 0.0

    return ratios


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


class SceneChangeEngine:
    def __init__(self, scene_change_settings: SceneChangeSettings):
        self._settings = scene_change_settings
        self._background: np.ndarray | None = None
        self._persist_count = 0
        self._last_emit_ts_ms: int | None = None

    def process_frame(self, *, ts_ms: int, width: int, height: int, jpeg_bytes: bytes) -> list[EventEntry]:
        if not self._settings.enabled:
            return []

        grayscale = _decode_to_grayscale(jpeg_bytes=jpeg_bytes, max_dim=self._settings.downsample.max_dim)
        current = grayscale.astype(np.float32)

        if self._background is None or self._background.shape != current.shape:
            self._background = current
            self._persist_count = 0
            return []

        diff = np.abs(current - self._background)
        change_mask = diff > self._settings.pixel_threshold
        self._background = ((1.0 - self._settings.ema_alpha) * self._background) + (self._settings.ema_alpha * current)

        blobs, score = self._extract_blobs(change_mask=change_mask)

        if score >= self._settings.score_threshold and blobs:
            self._persist_count += 1
        else:
            self._persist_count = 0
            return []

        if self._persist_count < self._settings.min_persist_frames:
            return []

        if self._settings.cooldown_ms > 0 and self._last_emit_ts_ms is not None:
            elapsed_ms = ts_ms - self._last_emit_ts_ms
            if elapsed_ms < self._settings.cooldown_ms:
                return []

        self._last_emit_ts_ms = ts_ms

        severity: Literal["low", "medium", "high"]
        if score >= self._settings.severity.high_score:
            severity = "high"
        elif score >= self._settings.severity.medium_score:
            severity = "medium"
        else:
            severity = "low"

        event = EventEntry(
            name="scene_change",
            ts_ms=ts_ms,
            severity=severity,
            data={
                "score": round(score, 4),
                "reason": "pixel",
                "blobs": [
                    {
                        "x1": round(blob.x1, 4),
                        "y1": round(blob.y1, 4),
                        "x2": round(blob.x2, 4),
                        "y2": round(blob.y2, 4),
                        "area_cells": blob.area_cells,
                        "density": round(blob.density, 4),
                    }
                    for blob in blobs
                ],
            },
        )

        return [event]

    def _extract_blobs(self, *, change_mask: np.ndarray) -> tuple[list[SceneBlob], float]:
        cell_ratios = _pool_cell_ratios(change_mask, cell_px=self._settings.cell_px)
        active_cells = cell_ratios >= self._settings.cell_active_ratio

        if not active_cells.any():
            return [], 0.0

        rows, cols = active_cells.shape
        visited = np.zeros_like(active_cells, dtype=np.bool_)

        frame_height, frame_width = change_mask.shape
        blobs: list[SceneBlob] = []
        score = 0.0

        for row in range(rows):
            for col in range(cols):
                if not active_cells[row, col] or visited[row, col]:
                    continue

                cells = self._collect_cluster(active_cells=active_cells, visited=visited, row=row, col=col)
                area_cells = len(cells)
                if area_cells < self._settings.min_blob_cells:
                    continue

                density = float(sum(float(cell_ratios[r, c]) for r, c in cells) / area_cells)

                min_row = min(r for r, _ in cells)
                max_row = max(r for r, _ in cells)
                min_col = min(c for _, c in cells)
                max_col = max(c for _, c in cells)

                x1_px = min_col * self._settings.cell_px
                y1_px = min_row * self._settings.cell_px
                x2_px = min(frame_width, (max_col + 1) * self._settings.cell_px)
                y2_px = min(frame_height, (max_row + 1) * self._settings.cell_px)

                blob = SceneBlob(
                    x1=_clamp01(x1_px / frame_width),
                    y1=_clamp01(y1_px / frame_height),
                    x2=_clamp01(x2_px / frame_width),
                    y2=_clamp01(y2_px / frame_height),
                    area_cells=area_cells,
                    density=density,
                )

                blobs.append(blob)
                score += area_cells * density

        return blobs, score

    @staticmethod
    def _collect_cluster(
        *,
        active_cells: np.ndarray,
        visited: np.ndarray,
        row: int,
        col: int,
    ) -> list[tuple[int, int]]:
        rows, cols = active_cells.shape
        queue: deque[tuple[int, int]] = deque([(row, col)])
        visited[row, col] = True
        cluster: list[tuple[int, int]] = []

        while queue:
            current_row, current_col = queue.popleft()
            cluster.append((current_row, current_col))

            for row_delta in (-1, 0, 1):
                for col_delta in (-1, 0, 1):
                    if row_delta == 0 and col_delta == 0:
                        continue

                    next_row = current_row + row_delta
                    next_col = current_col + col_delta

                    if next_row < 0 or next_col < 0 or next_row >= rows or next_col >= cols:
                        continue

                    if visited[next_row, next_col] or not active_cells[next_row, next_col]:
                        continue

                    visited[next_row, next_col] = True
                    queue.append((next_row, next_col))

        return cluster
