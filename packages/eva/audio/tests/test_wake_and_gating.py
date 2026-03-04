from __future__ import annotations

import json
import unittest
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from app import main
from app.config import (
    BASE_DIR,
    AppConfig,
    ConversationConfig,
    STTConfig,
    ServerConfig,
    SpeakerConfig,
    VADConfig,
    VoiceprintsConfig,
    WakeConfig,
    config_summary,
    load_app_config,
)
from app.protocol import BINARY_META_LENGTH_BYTES, PROTOCOL_VERSION
from app.speaker import SpeakerCheckResult, SpeakerReference, SpeakerReferenceResult
from app.stt import TranscriptResult
from app.vad import FRAME_BYTES, CompletedUtterance, VADProcessResult
from app.wake import build_wake_detector


def _make_config(*, speaker_enabled: bool) -> AppConfig:
    return AppConfig(
        server=ServerConfig(host="127.0.0.1", port=8793),
        vad=VADConfig(aggressiveness=2, preroll_ms=200, end_silence_ms=400, min_utterance_ms=300),
        wake=WakeConfig(
            phrases=("hey eva", "okay eva"),
            match_mode="word_boundary",
            case_sensitive=False,
            min_confidence=0.0,
        ),
        stt=STTConfig(
            model_id="small.en",
            device="cpu",
            compute_type="int8",
            cache_dir=Path("/tmp/eva-audio-tests-whisper"),
        ),
        conversation=ConversationConfig(active_timeout_ms=25000),
        speaker=SpeakerConfig(
            enabled=speaker_enabled,
            model_id="speechbrain/spkrec-ecapa-voxceleb",
            device="cpu",
            cache_dir=Path("/tmp/eva-audio-tests-speechbrain"),
            similarity_threshold=0.75,
            min_check_utterance_ms=500,
            max_voiced_ms=2000,
            short_utterance_policy="require_rewake",
        ),
        voiceprints=VoiceprintsConfig(
            dir=Path("/tmp/eva-audio-tests-voiceprints"),
            ema_alpha=0.35,
        ),
    )


def _make_utterance(*, end_ts_ms: int, duration_ms: int = 800) -> CompletedUtterance:
    frame_count = max(1, duration_ms // 20)
    return CompletedUtterance(
        audio_bytes=b"\x00" * FRAME_BYTES,
        started_server_ts_ms=max(0, end_ts_ms - duration_ms),
        utterance_end_server_ts_ms=end_ts_ms,
        duration_ms=duration_ms,
        frame_count=frame_count,
    )


def _make_audio_binary_envelope(*, frame_count: int) -> bytes:
    audio_payload = b"\x00" * (FRAME_BYTES * frame_count)
    metadata = {
        "type": "audio_binary",
        "v": PROTOCOL_VERSION,
        "chunk_id": "chunk-test",
        "ts_ms": 1,
        "mime": "audio/pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
        "audio_bytes": len(audio_payload),
    }
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    return len(metadata_bytes).to_bytes(BINARY_META_LENGTH_BYTES, byteorder="big") + metadata_bytes + audio_payload


def _build_fake_vad_segmenter(utterances: list[CompletedUtterance]):
    class FakeVADSegmenter:
        _queue = list(utterances)

        def __init__(self, _runtime_config: object) -> None:
            pass

        def process_frame(self, _frame_bytes: bytes, _now_ms: int) -> VADProcessResult:
            if FakeVADSegmenter._queue:
                utterance = FakeVADSegmenter._queue.pop(0)
                return VADProcessResult(speech_started=False, utterances=(utterance,), dropped_short=False)

            return VADProcessResult(speech_started=False, utterances=(), dropped_short=False)

    return FakeVADSegmenter


class _FakeWebSocket:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        self._messages = list(messages)
        self.sent_json: list[dict[str, object]] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent_json.append(payload)

    async def receive(self) -> dict[str, object]:
        if self._messages:
            return self._messages.pop(0)

        return {"type": "websocket.disconnect"}


class _StubSttTranscriber:
    def __init__(self, outputs: list[TranscriptResult | None]) -> None:
        self._outputs = list(outputs)
        self.calls = 0

    async def transcribe(self, _utterance_pcm16le_bytes: bytes) -> TranscriptResult | None:
        self.calls += 1
        if not self._outputs:
            return None

        return self._outputs.pop(0)


class _NoopSpeakerVerifier:
    def verify_active_speaker(self, **_kwargs: object) -> SpeakerCheckResult:
        raise AssertionError("verify_active_speaker should not be called in this test")

    def build_reference(self, **_kwargs: object) -> SpeakerReferenceResult:
        raise AssertionError("build_reference should not be called in this test")


class _MatchingSpeakerVerifier:
    def __init__(self) -> None:
        self.verify_calls = 0
        self.build_calls = 0

    def verify_active_speaker(self, **_kwargs: object) -> SpeakerCheckResult:
        self.verify_calls += 1
        return SpeakerCheckResult(decision="match", similarity=0.99, detail="stub active speaker match")

    def build_reference(self, **_kwargs: object) -> SpeakerReferenceResult:
        self.build_calls += 1
        return SpeakerReferenceResult(
            reference=SpeakerReference(embedding=(1.0, 0.0)),
            decision="match",
            detail="stub reference built",
        )


@dataclass(slots=True)
class _VoiceprintRecord:
    sample_count: int
    last_seen_ms: int


class _StubVoiceprintStore:
    def __init__(self) -> None:
        self.get_reference_calls = 0
        self.upsert_calls = 0

    def get_reference(self) -> SpeakerReference | None:
        self.get_reference_calls += 1
        return None

    def upsert_from_reference(self, *, reference: SpeakerReference, observed_at_ms: int) -> _VoiceprintRecord | None:
        _ = reference
        self.upsert_calls += 1
        return _VoiceprintRecord(sample_count=1, last_seen_ms=observed_at_ms)


@contextmanager
def _temporary_settings_local(contents: str | None):
    path = BASE_DIR / "settings.local.yaml"
    had_original = path.exists()
    original = path.read_text(encoding="utf-8") if had_original else None

    try:
        if contents is None:
            if path.exists():
                path.unlink()
        else:
            path.write_text(contents, encoding="utf-8")
        yield
    finally:
        if had_original:
            path.write_text(original or "", encoding="utf-8")
        elif path.exists():
            path.unlink()


class WakeMatcherTests(unittest.TestCase):
    def test_transcript_matcher_modes_and_normalization(self) -> None:
        contains = build_wake_detector(
            WakeConfig(
                phrases=("hey eva",),
                match_mode="contains",
                case_sensitive=False,
                min_confidence=0.0,
            )
        )
        exact = build_wake_detector(
            WakeConfig(
                phrases=("hey eva",),
                match_mode="exact",
                case_sensitive=False,
                min_confidence=0.0,
            )
        )
        word_boundary = build_wake_detector(
            WakeConfig(
                phrases=("hey eva",),
                match_mode="word_boundary",
                case_sensitive=False,
                min_confidence=0.0,
            )
        )

        self.assertTrue(contains.match_transcript("Can you HEY EVA please?").matched)
        self.assertFalse(contains.match_transcript("heyeva").matched)

        self.assertTrue(exact.match_transcript("   Hey    Eva   ").matched)
        self.assertFalse(exact.match_transcript("hey eva now").matched)

        self.assertTrue(word_boundary.match_transcript("well, hey eva there").matched)
        self.assertFalse(word_boundary.match_transcript("heyeva").matched)

    def test_confidence_threshold_behavior(self) -> None:
        matcher = build_wake_detector(
            WakeConfig(
                phrases=("hey eva",),
                match_mode="contains",
                case_sensitive=False,
                min_confidence=0.7,
            )
        )

        self.assertFalse(matcher.match_transcript("hey eva", confidence=0.4).matched)
        self.assertEqual(matcher.match_transcript("hey eva", confidence=0.4).reason, "below_confidence")
        self.assertTrue(matcher.match_transcript("hey eva", confidence=0.9).matched)
        self.assertTrue(matcher.match_transcript("hey eva", confidence=None).matched)


class GatingFlowTests(unittest.IsolatedAsyncioTestCase):
    async def _run_session(
        self,
        *,
        config: AppConfig,
        utterances: list[CompletedUtterance],
        stt_transcriber: _StubSttTranscriber,
        speaker_verifier: object,
        voiceprint_store: _StubVoiceprintStore,
    ) -> tuple[_FakeWebSocket, main.WsRuntimeStats]:
        wake_detector = build_wake_detector(config.wake)
        fake_vad_segmenter = _build_fake_vad_segmenter(utterances)

        message_bytes = _make_audio_binary_envelope(frame_count=max(1, len(utterances)))
        ws = _FakeWebSocket(
            [
                {"type": "websocket.receive", "bytes": message_bytes},
                {"type": "websocket.disconnect"},
            ]
        )

        main._ws_stats = main.WsRuntimeStats()

        with (
            patch.object(main, "_get_app_config", return_value=config),
            patch.object(main, "_get_wake_detector", return_value=wake_detector),
            patch.object(main, "_get_stt_transcriber", return_value=stt_transcriber),
            patch.object(main, "_get_speaker_verifier", return_value=speaker_verifier),
            patch.object(main, "_get_voiceprint_store", return_value=voiceprint_store),
            patch.object(main, "VADSegmenter", fake_vad_segmenter),
        ):
            await main.listen_socket(ws)

        return ws, main._ws_stats

    async def test_idle_no_wake_phrase_rejects(self) -> None:
        config = _make_config(speaker_enabled=False)
        stt = _StubSttTranscriber([TranscriptResult(text="what time is it", confidence=0.95)])
        speaker = _NoopSpeakerVerifier()
        voiceprints = _StubVoiceprintStore()

        ws, stats = await self._run_session(
            config=config,
            utterances=[_make_utterance(end_ts_ms=1_000)],
            stt_transcriber=stt,
            speaker_verifier=speaker,
            voiceprint_store=voiceprints,
        )

        self.assertTrue(ws.accepted)
        self.assertEqual([msg.get("type") for msg in ws.sent_json], ["hello"])
        self.assertEqual(stats.utterances_rejected, 1)
        self.assertEqual(stats.wake_phrase_checks, 1)
        self.assertEqual(stats.wake_phrase_matches, 0)
        self.assertEqual(stats.transcripts_emitted, 0)

    async def test_idle_wake_phrase_accepts(self) -> None:
        config = _make_config(speaker_enabled=False)
        stt = _StubSttTranscriber([TranscriptResult(text="hey eva what time is it", confidence=0.92)])
        speaker = _NoopSpeakerVerifier()
        voiceprints = _StubVoiceprintStore()

        ws, stats = await self._run_session(
            config=config,
            utterances=[_make_utterance(end_ts_ms=1_000)],
            stt_transcriber=stt,
            speaker_verifier=speaker,
            voiceprint_store=voiceprints,
        )

        self.assertEqual(ws.sent_json[0]["type"], "hello")
        self.assertTrue(any(msg.get("type") == "speech_transcript" for msg in ws.sent_json))
        self.assertEqual(stats.accepted_by_wake_phrase, 1)
        self.assertEqual(stats.wake_phrase_checks, 1)
        self.assertEqual(stats.wake_phrase_matches, 1)

    async def test_active_window_continuation_still_accepts_active_utterances(self) -> None:
        config = _make_config(speaker_enabled=True)
        stt = _StubSttTranscriber(
            [
                TranscriptResult(text="hey eva start", confidence=0.91),
                TranscriptResult(text="continue speaking", confidence=0.88),
            ]
        )
        speaker = _MatchingSpeakerVerifier()
        voiceprints = _StubVoiceprintStore()

        ws, stats = await self._run_session(
            config=config,
            utterances=[
                _make_utterance(end_ts_ms=1_000),
                _make_utterance(end_ts_ms=2_000),
            ],
            stt_transcriber=stt,
            speaker_verifier=speaker,
            voiceprint_store=voiceprints,
        )

        self.assertTrue(any(msg.get("type") == "speech_transcript" for msg in ws.sent_json))
        self.assertEqual(stats.accepted_by_wake_phrase, 1)
        self.assertEqual(stats.accepted_by_active, 1)
        self.assertEqual(stats.transcripts_emitted, 2)
        self.assertEqual(stats.utterances_rejected, 0)
        self.assertEqual(stats.wake_phrase_checks, 1)
        self.assertEqual(speaker.build_calls, 1)
        self.assertEqual(speaker.verify_calls, 1)
        self.assertEqual(voiceprints.upsert_calls, 1)


class LegacyWakeConfigRegressionTests(unittest.TestCase):
    def test_porcupine_keys_are_absent_from_runtime_wake_config(self) -> None:
        with _temporary_settings_local(None):
            config = load_app_config(force_reload=True)
            summary = config_summary(config)

        wake_summary = summary["wake"]
        self.assertNotIn("provider", wake_summary)
        self.assertNotIn("keyword_path", wake_summary)
        self.assertNotIn("sensitivity", wake_summary)
        self.assertNotIn("access_key_env", wake_summary)
        self.assertNotIn("access_key", wake_summary)
        self.assertFalse(hasattr(config.wake, "provider"))
        self.assertFalse(hasattr(config.wake, "keyword_path"))

    def test_legacy_porcupine_provider_key_is_rejected(self) -> None:
        with _temporary_settings_local("wake:\n  provider: porcupine\n"):
            with self.assertRaises(RuntimeError) as ctx:
                load_app_config(force_reload=True)

        self.assertIn("wake.provider", str(ctx.exception))
        self.assertIn("no longer supported", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
