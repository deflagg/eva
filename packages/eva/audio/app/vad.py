from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import ceil

import webrtcvad

SAMPLE_RATE_HZ = 16_000
FRAME_MS = 20
BYTES_PER_SAMPLE = 2
FRAME_BYTES = SAMPLE_RATE_HZ * FRAME_MS // 1000 * BYTES_PER_SAMPLE
SPEECH_START_TRIGGER_FRAMES = 2


class VADFrameError(ValueError):
    """Raised when an input frame is invalid for VAD processing."""


@dataclass(frozen=True, slots=True)
class VADRuntimeConfig:
    aggressiveness: int
    preroll_ms: int
    end_silence_ms: int
    min_utterance_ms: int


@dataclass(frozen=True, slots=True)
class CompletedUtterance:
    audio_bytes: bytes
    started_server_ts_ms: int
    utterance_end_server_ts_ms: int
    duration_ms: int
    frame_count: int


@dataclass(frozen=True, slots=True)
class VADProcessResult:
    speech_started: bool
    utterances: tuple[CompletedUtterance, ...]
    dropped_short: bool


class VADSegmenter:
    def __init__(self, config: VADRuntimeConfig) -> None:
        self._vad = webrtcvad.Vad(config.aggressiveness)

        self._preroll_frame_count = max(0, ceil(config.preroll_ms / FRAME_MS))
        self._end_silence_frame_count = max(1, ceil(config.end_silence_ms / FRAME_MS))
        self._min_utterance_frame_count = max(1, ceil(config.min_utterance_ms / FRAME_MS))

        self._preroll_frames: deque[bytes] = deque(maxlen=max(1, self._preroll_frame_count))

        self._in_speech = False
        self._pre_speech_voiced_streak = 0
        self._active_unvoiced_streak = 0
        self._active_started_server_ts_ms: int | None = None
        self._active_frames: list[bytes] = []

    def process_frame(self, frame_bytes: bytes, now_ms: int) -> VADProcessResult:
        if len(frame_bytes) != FRAME_BYTES:
            raise VADFrameError(
                f"Invalid frame length for VAD (expected {FRAME_BYTES} bytes, got {len(frame_bytes)})."
            )

        is_voiced = self._vad.is_speech(frame_bytes, SAMPLE_RATE_HZ)

        if not self._in_speech:
            if self._preroll_frame_count > 0:
                self._preroll_frames.append(frame_bytes)

            if is_voiced:
                self._pre_speech_voiced_streak += 1
            else:
                self._pre_speech_voiced_streak = 0

            if self._pre_speech_voiced_streak < SPEECH_START_TRIGGER_FRAMES:
                return VADProcessResult(speech_started=False, utterances=(), dropped_short=False)

            self._in_speech = True
            self._active_unvoiced_streak = 0
            self._pre_speech_voiced_streak = 0

            if self._preroll_frame_count > 0:
                self._active_frames = list(self._preroll_frames)
            else:
                self._active_frames = [frame_bytes]

            initial_frame_span_ms = max(0, (len(self._active_frames) - 1) * FRAME_MS)
            self._active_started_server_ts_ms = max(0, now_ms - initial_frame_span_ms)

            return VADProcessResult(speech_started=True, utterances=(), dropped_short=False)

        self._active_frames.append(frame_bytes)

        if is_voiced:
            self._active_unvoiced_streak = 0
        else:
            self._active_unvoiced_streak += 1

        if self._active_unvoiced_streak < self._end_silence_frame_count:
            return VADProcessResult(speech_started=False, utterances=(), dropped_short=False)

        utterance_frame_count = len(self._active_frames)
        utterance_duration_ms = utterance_frame_count * FRAME_MS
        utterance_end_server_ts_ms = now_ms

        utterances: tuple[CompletedUtterance, ...] = ()
        dropped_short = False

        if utterance_frame_count >= self._min_utterance_frame_count:
            utterance_audio_bytes = b"".join(self._active_frames)
            started_server_ts_ms = (
                self._active_started_server_ts_ms
                if self._active_started_server_ts_ms is not None
                else max(0, utterance_end_server_ts_ms - utterance_duration_ms)
            )

            utterances = (
                CompletedUtterance(
                    audio_bytes=utterance_audio_bytes,
                    started_server_ts_ms=started_server_ts_ms,
                    utterance_end_server_ts_ms=utterance_end_server_ts_ms,
                    duration_ms=utterance_duration_ms,
                    frame_count=utterance_frame_count,
                ),
            )
        else:
            dropped_short = True

        self._reset_after_utterance()

        return VADProcessResult(
            speech_started=False,
            utterances=utterances,
            dropped_short=dropped_short,
        )

    def _reset_after_utterance(self) -> None:
        self._in_speech = False
        self._pre_speech_voiced_streak = 0
        self._active_unvoiced_streak = 0
        self._active_started_server_ts_ms = None
        self._active_frames = []
        self._preroll_frames.clear()
