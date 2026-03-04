from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .config import SpeakerConfig

SAMPLE_RATE_HZ = 16_000
FRAME_MS = 20
BYTES_PER_SAMPLE = 2
FRAME_BYTES = SAMPLE_RATE_HZ * FRAME_MS // 1000 * BYTES_PER_SAMPLE

SpeakerDecision = Literal[
    "match",
    "mismatch",
    "short_utterance",
    "no_reference",
    "no_voiced_audio",
    "unavailable",
    "error",
]


@dataclass(frozen=True, slots=True)
class SpeakerRuntimeStatus:
    enabled: bool
    ready: bool
    reason: str | None
    model_id: str
    device: str
    similarity_threshold: float
    min_check_utterance_ms: int
    max_voiced_ms: int
    short_utterance_policy: str


@dataclass(frozen=True, slots=True)
class SpeakerReference:
    embedding: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class SpeakerReferenceResult:
    reference: SpeakerReference | None
    decision: SpeakerDecision
    detail: str


@dataclass(frozen=True, slots=True)
class SpeakerCheckResult:
    decision: SpeakerDecision
    similarity: float | None
    detail: str


class SpeakerVerifier:
    def __init__(self, config: SpeakerConfig) -> None:
        self._enabled = config.enabled
        self._model_id = config.model_id
        self._device = config.device
        self._similarity_threshold = config.similarity_threshold
        self._min_check_utterance_ms = config.min_check_utterance_ms
        self._max_voiced_ms = config.max_voiced_ms
        self._short_utterance_policy = config.short_utterance_policy

        self._classifier = None
        self._torch = None
        self._reason: str | None = None
        self._vad: Any | None = None

        if not self._enabled:
            self._reason = "disabled by config (speaker.enabled=false)"
            return

        try:
            import webrtcvad
        except Exception as exc:  # pragma: no cover - dependency import is environment-specific
            self._reason = f"Failed to import webrtcvad runtime: {exc}"
            return

        self._vad = webrtcvad.Vad(2)

        try:
            import torch
            from speechbrain.inference.speaker import EncoderClassifier
        except Exception as exc:  # pragma: no cover - dependency import is environment-specific
            self._reason = f"Failed to import speechbrain/torch runtime: {exc}"
            return

        resolved_device = self._resolve_device(torch)

        try:
            config.cache_dir.mkdir(parents=True, exist_ok=True)
            self._classifier = EncoderClassifier.from_hparams(
                source=self._model_id,
                savedir=str(config.cache_dir),
                run_opts={"device": resolved_device},
            )
            self._torch = torch
            self._device = resolved_device
        except Exception as exc:
            self._reason = f"Failed to initialize SpeechBrain ECAPA model: {exc}"

    def status(self) -> SpeakerRuntimeStatus:
        return SpeakerRuntimeStatus(
            enabled=self._enabled,
            ready=self._enabled and self._classifier is not None and self._torch is not None and self._vad is not None,
            reason=self._reason,
            model_id=self._model_id,
            device=self._device,
            similarity_threshold=self._similarity_threshold,
            min_check_utterance_ms=self._min_check_utterance_ms,
            max_voiced_ms=self._max_voiced_ms,
            short_utterance_policy=self._short_utterance_policy,
        )

    def build_reference(self, *, utterance_pcm16le_bytes: bytes, utterance_duration_ms: int) -> SpeakerReferenceResult:
        if not self._enabled:
            return SpeakerReferenceResult(
                reference=None,
                decision="unavailable",
                detail="Speaker subsystem disabled by config.",
            )

        if utterance_duration_ms < self._min_check_utterance_ms:
            return SpeakerReferenceResult(
                reference=None,
                decision="short_utterance",
                detail=(
                    f"Utterance too short for speaker lock reference "
                    f"({utterance_duration_ms}ms < {self._min_check_utterance_ms}ms)."
                ),
            )

        embedding_result = self._extract_embedding(utterance_pcm16le_bytes)
        if embedding_result is None:
            return SpeakerReferenceResult(
                reference=None,
                decision="unavailable",
                detail="Speaker runtime unavailable.",
            )

        embedding, detail = embedding_result
        if embedding is None:
            return SpeakerReferenceResult(reference=None, decision="no_voiced_audio", detail=detail)

        return SpeakerReferenceResult(
            reference=SpeakerReference(embedding=tuple(float(x) for x in embedding.tolist())),
            decision="match",
            detail="Speaker reference captured.",
        )

    def verify_active_speaker(
        self,
        *,
        utterance_pcm16le_bytes: bytes,
        utterance_duration_ms: int,
        reference: SpeakerReference | None,
    ) -> SpeakerCheckResult:
        if not self._enabled:
            return SpeakerCheckResult(
                decision="unavailable",
                similarity=None,
                detail="Speaker subsystem disabled by config.",
            )

        if reference is None:
            return SpeakerCheckResult(
                decision="no_reference",
                similarity=None,
                detail="No active speaker reference available.",
            )

        if utterance_duration_ms < self._min_check_utterance_ms:
            return SpeakerCheckResult(
                decision="short_utterance",
                similarity=None,
                detail=(
                    f"Utterance too short for speaker verification "
                    f"({utterance_duration_ms}ms < {self._min_check_utterance_ms}ms)."
                ),
            )

        embedding_result = self._extract_embedding(utterance_pcm16le_bytes)
        if embedding_result is None:
            return SpeakerCheckResult(
                decision="unavailable",
                similarity=None,
                detail="Speaker runtime unavailable.",
            )

        embedding, detail = embedding_result
        if embedding is None:
            return SpeakerCheckResult(decision="no_voiced_audio", similarity=None, detail=detail)

        reference_vec = np.asarray(reference.embedding, dtype=np.float32)
        if reference_vec.size == 0:
            return SpeakerCheckResult(
                decision="no_reference",
                similarity=None,
                detail="Active speaker reference embedding was empty.",
            )

        similarity = float(np.dot(embedding, reference_vec))
        if similarity >= self._similarity_threshold:
            return SpeakerCheckResult(
                decision="match",
                similarity=similarity,
                detail=(
                    f"Speaker similarity {similarity:.3f} >= threshold {self._similarity_threshold:.3f}."
                ),
            )

        return SpeakerCheckResult(
            decision="mismatch",
            similarity=similarity,
            detail=(
                f"Speaker similarity {similarity:.3f} < threshold {self._similarity_threshold:.3f}."
            ),
        )

    def _extract_embedding(self, utterance_pcm16le_bytes: bytes) -> tuple[np.ndarray | None, str] | None:
        if self._classifier is None or self._torch is None:
            return None

        voiced_audio = self._extract_voiced_audio_window(utterance_pcm16le_bytes)
        if voiced_audio is None:
            return None, "No voiced audio detected for speaker embedding."

        try:
            signal = self._torch.from_numpy(voiced_audio).unsqueeze(0)
            with self._torch.no_grad():
                embedding_batch = self._classifier.encode_batch(signal)

            embedding = (
                embedding_batch.squeeze().detach().cpu().numpy().astype(np.float32).reshape(-1)
            )

            norm = float(np.linalg.norm(embedding))
            if norm <= 0:
                return None, "Speaker embedding norm was zero."

            embedding = embedding / norm
            return embedding, "ok"
        except Exception as exc:
            return None, f"Failed to compute speaker embedding: {exc}"

    def _extract_voiced_audio_window(self, utterance_pcm16le_bytes: bytes) -> np.ndarray | None:
        if self._vad is None:
            return None

        if len(utterance_pcm16le_bytes) < FRAME_BYTES:
            return None

        max_voiced_frames = max(1, self._max_voiced_ms // FRAME_MS)
        voiced_frames: list[bytes] = []

        for offset in range(0, len(utterance_pcm16le_bytes) - FRAME_BYTES + 1, FRAME_BYTES):
            frame = utterance_pcm16le_bytes[offset : offset + FRAME_BYTES]
            try:
                is_voiced = self._vad.is_speech(frame, SAMPLE_RATE_HZ)
            except Exception:
                continue

            if not is_voiced:
                continue

            voiced_frames.append(frame)
            if len(voiced_frames) >= max_voiced_frames:
                break

        if len(voiced_frames) == 0:
            return None

        voiced_bytes = b"".join(voiced_frames)
        samples = np.frombuffer(voiced_bytes, dtype=np.int16)
        if samples.size == 0:
            return None

        return samples.astype(np.float32) / 32768.0

    def _resolve_device(self, torch_module: object) -> str:
        if self._device == "auto":
            cuda_available = bool(getattr(getattr(torch_module, "cuda", None), "is_available", lambda: False)())
            return "cuda" if cuda_available else "cpu"

        return self._device


def build_speaker_verifier(config: SpeakerConfig) -> SpeakerVerifier:
    return SpeakerVerifier(config)
