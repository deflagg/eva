from __future__ import annotations

import asyncio
import base64
import time
import uuid
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from io import BytesIO
from typing import Any
from urllib.parse import urlparse

from PIL import Image, UnidentifiedImageError

from .protocol import EventEntry, FrameBinaryMetaMessage, InsightMessage
from .settings import settings
from .vision_agent_client import VisionAgentClient, VisionAgentClientError, VisionAgentFrame

HARD_MAX_INSIGHT_FRAMES = 6
DEFAULT_SURPRISE_THRESHOLD = 5.0
DEFAULT_DOWNSAMPLE_MAX_DIM = 640
DEFAULT_DOWNSAMPLE_JPEG_QUALITY = 75
DEFAULT_SURPRISE_WEIGHTS = {
    "abandoned_object": 5.0,
    "near_collision": 5.0,
    "roi_dwell": 3.0,
    "line_cross": 3.0,
    "sudden_motion": 1.5,
    "track_stop": 1.5,
}


class InsightError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class SurpriseSettings:
    enabled: bool
    threshold: float
    cooldown_ms: int
    weights: dict[str, float]


@dataclass(slots=True)
class InsightDownsampleSettings:
    enabled: bool
    max_dim: int
    jpeg_quality: int


@dataclass(slots=True)
class InsightSettings:
    enabled: bool
    vision_agent_url: str
    timeout_ms: int
    max_frames: int
    pre_frames: int
    post_frames: int
    insight_cooldown_ms: int
    downsample: InsightDownsampleSettings
    surprise: SurpriseSettings


@dataclass(slots=True)
class BufferedFrame:
    seq: int
    frame_id: str
    ts_ms: int
    mime: str
    image_bytes: bytes


class InsightBuffer:
    def __init__(self, config: InsightSettings):
        self.config = config
        self._frames: deque[BufferedFrame] = deque(maxlen=128)
        self._next_seq = 1
        self._frame_event = asyncio.Event()
        self._last_insight_ts_ms: int | None = None
        self._last_surprise_trigger_ts_ms: int | None = None
        self._vision_agent = VisionAgentClient(config.vision_agent_url, config.timeout_ms)

    def add_frame(self, meta: FrameBinaryMetaMessage, image_payload: bytes) -> None:
        self._frames.append(
            BufferedFrame(
                seq=self._next_seq,
                frame_id=meta.frame_id,
                ts_ms=meta.ts_ms,
                mime=meta.mime,
                image_bytes=image_payload,
            )
        )
        self._next_seq += 1
        self._frame_event.set()

    async def run_insight_test(self) -> InsightMessage:
        self._ensure_enabled()

        trigger = self._latest_trigger_frame()
        now_ms = int(time.time() * 1000)
        self._enforce_insight_cooldown(now_ms)
        self._last_insight_ts_ms = now_ms

        return await self._request_insight(trigger)

    async def run_auto_insight(self, *, trigger_frame_id: str, events: list[EventEntry]) -> InsightMessage | None:
        self._ensure_enabled()

        if not self.config.surprise.enabled:
            return None

        surprise_score = self._compute_surprise_score(events)
        if surprise_score < self.config.surprise.threshold:
            return None

        now_ms = int(time.time() * 1000)

        if self._is_surprise_cooldown_active(now_ms):
            return None

        if self._is_insight_cooldown_active(now_ms):
            return None

        trigger = self._find_trigger_frame(trigger_frame_id)
        if trigger is None:
            return None

        self._last_surprise_trigger_ts_ms = now_ms
        self._last_insight_ts_ms = now_ms

        return await self._request_insight(trigger)

    async def _request_insight(self, trigger: BufferedFrame) -> InsightMessage:
        clip_frames = await self._build_clip(trigger)
        if not clip_frames:
            raise InsightError("NO_CLIP_FRAMES", "Failed to build insight clip frames.")

        clip_id = str(uuid.uuid4())

        request_frames = [self._build_request_frame(frame) for frame in clip_frames]

        try:
            insight = await self._vision_agent.request_insight(
                clip_id=clip_id,
                trigger_frame_id=trigger.frame_id,
                frames=request_frames,
            )
        except VisionAgentClientError as exc:
            raise InsightError(exc.code, str(exc)) from exc

        return InsightMessage(
            clip_id=clip_id,
            trigger_frame_id=trigger.frame_id,
            ts_ms=int(time.time() * 1000),
            summary=insight.summary.model_dump(exclude_none=True),
            usage=insight.usage.model_dump(exclude_none=True),
        )

    def _build_request_frame(self, frame: BufferedFrame) -> VisionAgentFrame:
        image_b64 = base64.b64encode(frame.image_bytes).decode("ascii")
        if self.config.downsample.enabled:
            image_b64 = self._downsample_payload_image(image_b64)

        return VisionAgentFrame(
            frame_id=frame.frame_id,
            ts_ms=frame.ts_ms,
            mime="image/jpeg",
            image_b64=image_b64,
        )

    def _downsample_payload_image(self, image_b64: str) -> str:
        try:
            source_bytes = base64.b64decode(image_b64, validate=True)
        except Exception as exc:
            raise InsightError(
                "INSIGHT_DOWNSAMPLE_DECODE_FAILED",
                "Failed to decode insight frame payload for downsampling.",
            ) from exc

        try:
            with Image.open(BytesIO(source_bytes)) as source_image:
                image = source_image.convert("RGB")
        except (UnidentifiedImageError, OSError) as exc:
            raise InsightError(
                "INSIGHT_DOWNSAMPLE_DECODE_FAILED",
                "Failed to parse insight frame image for downsampling.",
            ) from exc

        width, height = image.size
        longest_side = max(width, height)
        if longest_side > self.config.downsample.max_dim:
            scale = self.config.downsample.max_dim / float(longest_side)
            target_size = (
                max(1, int(round(width * scale))),
                max(1, int(round(height * scale))),
            )
            image = image.resize(target_size, Image.Resampling.LANCZOS)

        output = BytesIO()
        try:
            image.save(
                output,
                format="JPEG",
                quality=self.config.downsample.jpeg_quality,
                optimize=True,
            )
        except OSError as exc:
            raise InsightError(
                "INSIGHT_DOWNSAMPLE_ENCODE_FAILED",
                "Failed to encode downsampled insight frame payload.",
            ) from exc

        return base64.b64encode(output.getvalue()).decode("ascii")

    async def _build_clip(self, trigger: BufferedFrame) -> list[BufferedFrame]:
        selected_pre = self._collect_pre_frames(trigger.seq)
        selected = [*selected_pre, trigger]

        remaining_capacity = max(self.config.max_frames - len(selected), 0)
        post_target = min(self.config.post_frames, remaining_capacity)

        post_frames = self._collect_post_frames(trigger.seq, post_target)

        if len(post_frames) < post_target:
            deadline = asyncio.get_running_loop().time() + (self.config.timeout_ms / 1000.0)

            while len(post_frames) < post_target:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break

                try:
                    await asyncio.wait_for(self._frame_event.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                finally:
                    self._frame_event.clear()

                post_frames = self._collect_post_frames(trigger.seq, post_target)

        clip = [*selected, *post_frames]
        return clip[: self.config.max_frames]

    def _collect_pre_frames(self, trigger_seq: int) -> list[BufferedFrame]:
        if self.config.pre_frames <= 0:
            return []

        candidates = [frame for frame in self._frames if frame.seq < trigger_seq]
        return candidates[-self.config.pre_frames :]

    def _collect_post_frames(self, trigger_seq: int, limit: int) -> list[BufferedFrame]:
        if limit <= 0:
            return []

        candidates = [frame for frame in self._frames if frame.seq > trigger_seq]
        return candidates[:limit]

    def _ensure_enabled(self) -> None:
        if not self.config.enabled:
            raise InsightError("INSIGHTS_DISABLED", "Insights are disabled in QuickVision settings.")

    def _latest_trigger_frame(self) -> BufferedFrame:
        if not self._frames:
            raise InsightError("NO_TRIGGER_FRAME", "No frames available yet; cannot run insight_test.")

        return self._frames[-1]

    def _find_trigger_frame(self, trigger_frame_id: str) -> BufferedFrame | None:
        for frame in reversed(self._frames):
            if frame.frame_id == trigger_frame_id:
                return frame

        if not self._frames:
            return None

        return self._frames[-1]

    def _is_insight_cooldown_active(self, now_ms: int) -> bool:
        if self._last_insight_ts_ms is None or self.config.insight_cooldown_ms <= 0:
            return False

        elapsed_ms = now_ms - self._last_insight_ts_ms
        return elapsed_ms < self.config.insight_cooldown_ms

    def _is_surprise_cooldown_active(self, now_ms: int) -> bool:
        if self._last_surprise_trigger_ts_ms is None or self.config.surprise.cooldown_ms <= 0:
            return False

        elapsed_ms = now_ms - self._last_surprise_trigger_ts_ms
        return elapsed_ms < self.config.surprise.cooldown_ms

    def _enforce_insight_cooldown(self, now_ms: int) -> None:
        if not self._is_insight_cooldown_active(now_ms):
            return

        elapsed_ms = now_ms - (self._last_insight_ts_ms or 0)
        retry_after = self.config.insight_cooldown_ms - elapsed_ms
        raise InsightError(
            "INSIGHT_COOLDOWN",
            f"Insight cooldown active. Retry in ~{retry_after}ms.",
        )

    def _compute_surprise_score(self, events: list[EventEntry]) -> float:
        score = 0.0
        for event in events:
            weight = self.config.surprise.weights.get(event.name.lower(), 0.0)
            score += weight

        return score


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


def _as_non_negative_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"QuickVision config error: {key} must be a non-negative integer")

    if isinstance(value, int):
        if value < 0:
            raise RuntimeError(f"QuickVision config error: {key} must be a non-negative integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())

    raise RuntimeError(f"QuickVision config error: {key} must be a non-negative integer")


def _as_non_negative_float(value: Any, *, key: str, default: float) -> float:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"QuickVision config error: surprise.{key} must be a non-negative number")

    if isinstance(value, (int, float)):
        parsed = float(value)
        if parsed < 0:
            raise RuntimeError(f"QuickVision config error: surprise.{key} must be a non-negative number")
        return parsed

    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError as exc:
            raise RuntimeError(f"QuickVision config error: surprise.{key} must be a non-negative number") from exc

        if parsed < 0:
            raise RuntimeError(f"QuickVision config error: surprise.{key} must be a non-negative number")

        return parsed

    raise RuntimeError(f"QuickVision config error: surprise.{key} must be a non-negative number")


def _as_surprise_weights(value: Any) -> dict[str, float]:
    if value is None:
        return dict(DEFAULT_SURPRISE_WEIGHTS)

    if not isinstance(value, Mapping):
        raise RuntimeError("QuickVision config error: surprise.weights must be a mapping/object")

    weights = dict(DEFAULT_SURPRISE_WEIGHTS)

    for raw_name, raw_weight in value.items():
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise RuntimeError("QuickVision config error: surprise.weights keys must be non-empty strings")

        event_name = raw_name.strip().lower()
        weight = _as_non_negative_float(raw_weight, key=f"weights.{event_name}", default=0.0)
        weights[event_name] = weight

    return weights


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("QuickVision config error: insights.vision_agent_url must be a valid http(s) URL")

    return url


def load_insight_settings() -> InsightSettings:
    enabled = _as_bool(settings.get("insights.enabled", default=False), default=False)

    raw_url = settings.get("insights.vision_agent_url", default="http://localhost:8790/insight")
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise RuntimeError("QuickVision config error: insights.vision_agent_url must be a non-empty string")

    timeout_ms = _as_non_negative_int(
        settings.get("insights.timeout_ms", default=2000),
        key="insights.timeout_ms",
        default=2000,
    )
    max_frames = _as_non_negative_int(
        settings.get("insights.max_frames", default=6),
        key="insights.max_frames",
        default=6,
    )
    pre_frames = _as_non_negative_int(
        settings.get("insights.pre_frames", default=3),
        key="insights.pre_frames",
        default=3,
    )
    post_frames = _as_non_negative_int(
        settings.get("insights.post_frames", default=2),
        key="insights.post_frames",
        default=2,
    )
    insight_cooldown_ms = _as_non_negative_int(
        settings.get("insights.insight_cooldown_ms", default=10000),
        key="insights.insight_cooldown_ms",
        default=10000,
    )
    downsample_enabled = _as_bool(settings.get("insights.downsample.enabled", default=True), default=True)
    downsample_max_dim = _as_non_negative_int(
        settings.get("insights.downsample.max_dim", default=DEFAULT_DOWNSAMPLE_MAX_DIM),
        key="insights.downsample.max_dim",
        default=DEFAULT_DOWNSAMPLE_MAX_DIM,
    )
    downsample_jpeg_quality = _as_non_negative_int(
        settings.get("insights.downsample.jpeg_quality", default=DEFAULT_DOWNSAMPLE_JPEG_QUALITY),
        key="insights.downsample.jpeg_quality",
        default=DEFAULT_DOWNSAMPLE_JPEG_QUALITY,
    )

    if downsample_max_dim <= 0:
        raise RuntimeError("QuickVision config error: insights.downsample.max_dim must be >= 1")

    if downsample_jpeg_quality < 1 or downsample_jpeg_quality > 100:
        raise RuntimeError("QuickVision config error: insights.downsample.jpeg_quality must be between 1 and 100")

    surprise_enabled = _as_bool(settings.get("surprise.enabled", default=True), default=True)
    surprise_threshold = _as_non_negative_float(
        settings.get("surprise.threshold", default=DEFAULT_SURPRISE_THRESHOLD),
        key="threshold",
        default=DEFAULT_SURPRISE_THRESHOLD,
    )
    surprise_cooldown_ms = _as_non_negative_int(
        settings.get("surprise.cooldown_ms", default=10000),
        key="surprise.cooldown_ms",
        default=10000,
    )
    surprise_weights = _as_surprise_weights(settings.get("surprise.weights", default=DEFAULT_SURPRISE_WEIGHTS))

    max_frames = max(1, min(max_frames, HARD_MAX_INSIGHT_FRAMES))
    pre_frames = min(pre_frames, max_frames - 1)
    post_frames = min(post_frames, max_frames - 1)

    return InsightSettings(
        enabled=enabled,
        vision_agent_url=_validate_url(raw_url.strip()),
        timeout_ms=max(timeout_ms, 1),
        max_frames=max_frames,
        pre_frames=pre_frames,
        post_frames=post_frames,
        insight_cooldown_ms=insight_cooldown_ms,
        downsample=InsightDownsampleSettings(
            enabled=downsample_enabled,
            max_dim=downsample_max_dim,
            jpeg_quality=downsample_jpeg_quality,
        ),
        surprise=SurpriseSettings(
            enabled=surprise_enabled,
            threshold=surprise_threshold,
            cooldown_ms=surprise_cooldown_ms,
            weights=surprise_weights,
        ),
    )
