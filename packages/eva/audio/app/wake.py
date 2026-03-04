from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .config import WakeConfig


@dataclass(frozen=True, slots=True)
class WakeDetectorStatus:
    provider: str
    ready: bool
    reason: str | None
    frame_length: int | None
    sample_rate_hz: int | None
    phrase_count: int
    match_mode: str
    case_sensitive: bool
    min_confidence: float


@dataclass(frozen=True, slots=True)
class WakePhraseMatchResult:
    matched: bool
    reason: str
    phrase: str | None
    transcript: str
    normalized_transcript: str
    confidence: float | None
    confidence_threshold: float
    confidence_ok: bool
    match_mode: str


class WakeWordDetector:
    """Transcript-based wake phrase matcher.

    Note: `detect_wake_word(...)` is kept as a temporary compatibility shim for
    pre-transcript gating code paths and intentionally always returns False.
    Use `match_transcript(...)` / `detect_wake_phrase(...)` for transcript wake.
    """

    def __init__(self, config: WakeConfig) -> None:
        self._phrases = tuple(config.phrases)
        self._match_mode = config.match_mode
        self._case_sensitive = config.case_sensitive
        self._min_confidence = float(config.min_confidence)
        self._normalized_phrases = tuple(self._normalize_text(phrase) for phrase in self._phrases)

        self._word_boundary_patterns: tuple[re.Pattern[str], ...] = ()
        if self._match_mode == "word_boundary":
            self._word_boundary_patterns = tuple(
                re.compile(self._build_word_boundary_pattern(phrase))
                for phrase in self._normalized_phrases
            )

    def _normalize_text(self, value: str) -> str:
        normalized = " ".join(value.strip().split())
        if not self._case_sensitive:
            return normalized.casefold()

        return normalized

    @staticmethod
    def _build_word_boundary_pattern(phrase: str) -> str:
        # `phrase` is already normalized to single spaces.
        escaped = re.escape(phrase).replace(r"\ ", r"\s+")
        return rf"\b{escaped}\b"

    @staticmethod
    def _parse_confidence(confidence: float | None) -> float | None:
        if confidence is None:
            return None

        if isinstance(confidence, bool):
            return None

        if not isinstance(confidence, (int, float)):
            return None

        parsed = float(confidence)
        if not math.isfinite(parsed):
            return None

        return parsed

    def _match_phrase(self, normalized_transcript: str) -> str | None:
        if self._match_mode == "contains":
            for original_phrase, normalized_phrase in zip(self._phrases, self._normalized_phrases, strict=True):
                if normalized_phrase in normalized_transcript:
                    return original_phrase
            return None

        if self._match_mode == "exact":
            for original_phrase, normalized_phrase in zip(self._phrases, self._normalized_phrases, strict=True):
                if normalized_transcript == normalized_phrase:
                    return original_phrase
            return None

        # mode == "word_boundary"
        for original_phrase, pattern in zip(self._phrases, self._word_boundary_patterns, strict=True):
            if pattern.search(normalized_transcript):
                return original_phrase

        return None

    def match_transcript(self, transcript: str, *, confidence: float | None = None) -> WakePhraseMatchResult:
        safe_transcript = transcript if isinstance(transcript, str) else ""
        normalized_transcript = self._normalize_text(safe_transcript)

        parsed_confidence = self._parse_confidence(confidence)
        confidence_ok = parsed_confidence is None or parsed_confidence >= self._min_confidence

        if not normalized_transcript:
            return WakePhraseMatchResult(
                matched=False,
                reason="empty_transcript",
                phrase=None,
                transcript=safe_transcript,
                normalized_transcript=normalized_transcript,
                confidence=parsed_confidence,
                confidence_threshold=self._min_confidence,
                confidence_ok=confidence_ok,
                match_mode=self._match_mode,
            )

        if not confidence_ok:
            return WakePhraseMatchResult(
                matched=False,
                reason="below_confidence",
                phrase=None,
                transcript=safe_transcript,
                normalized_transcript=normalized_transcript,
                confidence=parsed_confidence,
                confidence_threshold=self._min_confidence,
                confidence_ok=False,
                match_mode=self._match_mode,
            )

        matched_phrase = self._match_phrase(normalized_transcript)
        if matched_phrase is None:
            return WakePhraseMatchResult(
                matched=False,
                reason="no_phrase_match",
                phrase=None,
                transcript=safe_transcript,
                normalized_transcript=normalized_transcript,
                confidence=parsed_confidence,
                confidence_threshold=self._min_confidence,
                confidence_ok=True,
                match_mode=self._match_mode,
            )

        return WakePhraseMatchResult(
            matched=True,
            reason="wake_phrase_match",
            phrase=matched_phrase,
            transcript=safe_transcript,
            normalized_transcript=normalized_transcript,
            confidence=parsed_confidence,
            confidence_threshold=self._min_confidence,
            confidence_ok=True,
            match_mode=self._match_mode,
        )

    def detect_wake_phrase(self, transcript: str, *, confidence: float | None = None) -> bool:
        return self.match_transcript(transcript, confidence=confidence).matched

    def detect_wake_word(self, utterance_pcm16le_bytes: bytes) -> bool:
        # Temporary compatibility shim during gating migration.
        _ = utterance_pcm16le_bytes
        return False

    def status(self) -> WakeDetectorStatus:
        return WakeDetectorStatus(
            provider="transcript",
            ready=True,
            reason=None,
            frame_length=None,
            sample_rate_hz=None,
            phrase_count=len(self._phrases),
            match_mode=self._match_mode,
            case_sensitive=self._case_sensitive,
            min_confidence=self._min_confidence,
        )

    def close(self) -> None:
        # No external runtime resources.
        return


def build_wake_detector(config: WakeConfig) -> WakeWordDetector:
    return WakeWordDetector(config)
