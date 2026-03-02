from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from .protocol import FrameBinaryMetaMessage


@dataclass(frozen=True, slots=True)
class BufferedFrame:
    frame_id: str
    ts_ms: int
    width: int
    height: int
    jpeg_bytes: bytes


@dataclass(frozen=True, slots=True)
class FrameBufferStats:
    max_frames: int
    depth: int
    added: int
    evicted: int


@dataclass(frozen=True, slots=True)
class FrameBufferAddResult:
    frame: BufferedFrame
    evicted_on_insert: int
    stats: FrameBufferStats


class FrameBuffer:
    def __init__(self, *, max_frames: int):
        if max_frames < 1:
            raise ValueError("FrameBuffer max_frames must be >= 1")

        self._max_frames = max_frames
        self._frames: deque[BufferedFrame] = deque()
        self._added = 0
        self._evicted = 0

    def add_frame(self, meta: FrameBinaryMetaMessage, jpeg: bytes) -> FrameBufferAddResult:
        frame = BufferedFrame(
            frame_id=meta.frame_id,
            ts_ms=meta.ts_ms,
            width=meta.width,
            height=meta.height,
            jpeg_bytes=jpeg,
        )
        self._frames.append(frame)
        self._added += 1

        evicted_on_insert = 0
        while len(self._frames) > self._max_frames:
            self._frames.popleft()
            self._evicted += 1
            evicted_on_insert += 1

        return FrameBufferAddResult(
            frame=frame,
            evicted_on_insert=evicted_on_insert,
            stats=self.stats(),
        )

    def get_clip(self, trigger_frame_id: str, pre_frames: int, post_frames: int) -> list[BufferedFrame]:
        if pre_frames < 0:
            raise ValueError("pre_frames must be >= 0")

        if post_frames < 0:
            raise ValueError("post_frames must be >= 0")

        frames = list(self._frames)
        trigger_index = next((index for index, frame in enumerate(frames) if frame.frame_id == trigger_frame_id), -1)
        if trigger_index < 0:
            return []

        start_index = max(0, trigger_index - pre_frames)
        end_index_exclusive = min(len(frames), trigger_index + post_frames + 1)

        return frames[start_index:end_index_exclusive]

    def get_latest(self) -> BufferedFrame | None:
        if not self._frames:
            return None

        return self._frames[-1]

    def stats(self) -> FrameBufferStats:
        return FrameBufferStats(
            max_frames=self._max_frames,
            depth=len(self._frames),
            added=self._added,
            evicted=self._evicted,
        )
