from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .config import STTConfig

_WHISPER_TRANSCRIBE_OPTIONS: dict[str, object] = {
    "task": "transcribe",
    "language": "en",
    "vad_filter": False,
    "condition_on_previous_text": False,
    "beam_size": 1,
    "temperature": 0.0,
}


@dataclass(frozen=True, slots=True)
class SttRuntimeStatus:
    ready: bool
    reason: str | None
    model_id: str
    device: str
    compute_type: str
    cache_dir: str


@dataclass(frozen=True, slots=True)
class TranscriptResult:
    text: str
    confidence: float


class WhisperTranscriber:
    def __init__(self, config: STTConfig) -> None:
        self._model_id = config.model_id
        self._device = config.device
        self._compute_type = config.compute_type
        self._cache_dir = config.cache_dir
        self._model: Any | None = None
        self._reason: str | None = None

        try:
            from faster_whisper import WhisperModel
        except Exception as exc:  # pragma: no cover - dependency import is environment-specific
            self._reason = f"Failed to import faster_whisper: {exc}"
            return

        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            self._model = WhisperModel(
                self._model_id,
                device=self._device,
                compute_type=self._compute_type,
                download_root=str(self._cache_dir),
            )
        except Exception as exc:
            self._reason = f"Failed to initialize Whisper model: {exc}"

    def status(self) -> SttRuntimeStatus:
        return SttRuntimeStatus(
            ready=self._model is not None,
            reason=self._reason,
            model_id=self._model_id,
            device=self._device,
            compute_type=self._compute_type,
            cache_dir=str(self._cache_dir),
        )

    async def transcribe(self, utterance_pcm16le_bytes: bytes) -> TranscriptResult | None:
        if self._model is None:
            return None

        return await asyncio.to_thread(self._transcribe_sync, utterance_pcm16le_bytes)

    def _transcribe_sync(self, utterance_pcm16le_bytes: bytes) -> TranscriptResult | None:
        audio = _pcm16le_to_float32(utterance_pcm16le_bytes)
        if audio is None:
            return None

        segments, info = self._model.transcribe(audio, **_WHISPER_TRANSCRIBE_OPTIONS)

        texts: list[str] = []
        confidence_samples: list[float] = []

        for segment in segments:
            segment_text = str(getattr(segment, "text", "")).strip()
            if segment_text:
                texts.append(segment_text)

            avg_logprob = getattr(segment, "avg_logprob", None)
            if isinstance(avg_logprob, (int, float)) and math.isfinite(avg_logprob):
                confidence_samples.append(_clamp(float(math.exp(float(avg_logprob))), 0.0, 1.0))

        transcript_text = " ".join(texts).strip()
        if not transcript_text:
            return None

        confidence = _confidence_from_samples(confidence_samples, info)

        return TranscriptResult(
            text=transcript_text,
            confidence=round(confidence, 4),
        )


def build_stt_transcriber(config: STTConfig) -> WhisperTranscriber:
    return WhisperTranscriber(config)


def _pcm16le_to_float32(payload: bytes) -> np.ndarray | None:
    if len(payload) < 2:
        return None

    samples = np.frombuffer(payload, dtype=np.int16)
    if samples.size == 0:
        return None

    return samples.astype(np.float32) / 32768.0


def _confidence_from_samples(samples: list[float], info: Any) -> float:
    if samples:
        return _clamp(sum(samples) / len(samples), 0.0, 1.0)

    language_probability = getattr(info, "language_probability", None)
    if isinstance(language_probability, (int, float)) and math.isfinite(language_probability):
        return _clamp(float(language_probability), 0.0, 1.0)

    return 0.0


def _clamp(value: float, minimum: float, maximum: float) -> float:
    if value < minimum:
        return minimum

    if value > maximum:
        return maximum

    return value
