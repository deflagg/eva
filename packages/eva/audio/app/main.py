from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .config import AppConfig, config_summary, load_app_config
from .executive_client import ExecutiveClient, ExecutiveClientError, PresenceSnapshot
from .protocol import (
    BinaryAudioParseError,
    decode_binary_audio_envelope,
    make_error,
    make_hello,
    make_speech_transcript,
)
from .speaker import SpeakerReference, SpeakerVerifier, build_speaker_verifier
from .stt import WhisperTranscriber, build_stt_transcriber
from .vad import FRAME_BYTES, VADFrameError, VADRuntimeConfig, VADSegmenter
from .voiceprints import VoiceprintStore, build_voiceprint_store
from .wake import WakeWordDetector, build_wake_detector

app = FastAPI(title="audio", version="0.1.0")


@dataclass(slots=True)
class WsRuntimeStats:
    connections_opened: int = 0
    active_connections: int = 0
    audio_chunks_received: int = 0
    audio_chunks_invalid: int = 0
    audio_bytes_received: int = 0
    last_chunk_ts_ms: int | None = None
    vad_frames_processed: int = 0
    vad_frames_invalid: int = 0
    utterances_emitted: int = 0
    utterances_dropped_short: int = 0
    last_utterance_duration_ms: int | None = None
    last_utterance_end_server_ts_ms: int | None = None
    wake_phrase_checks: int = 0
    wake_phrase_matches: int = 0
    last_wake_phrase: str | None = None
    presence_checks: int = 0
    presence_check_errors: int = 0
    last_presence_found: bool | None = None
    last_presence_preson_present: bool | None = None
    last_presence_person_facing_me: bool | None = None
    last_presence_age_ms: int | None = None
    last_presence_ts_ms: int | None = None
    utterances_accepted: int = 0
    accepted_by_wake_phrase: int = 0
    accepted_by_presence: int = 0
    accepted_by_active: int = 0
    utterances_rejected: int = 0
    last_accept_reason: str | None = None
    conversation_active_entries: int = 0
    conversation_active_exits: int = 0
    last_active_until_ts_ms: int | None = None
    speaker_checks: int = 0
    speaker_matches: int = 0
    speaker_rejections: int = 0
    speaker_short_utterances: int = 0
    speaker_reference_sets: int = 0
    speaker_reference_clears: int = 0
    last_speaker_similarity: float | None = None
    last_speaker_decision: str | None = None
    voiceprint_updates: int = 0
    voiceprint_update_errors: int = 0
    voiceprint_fallback_uses: int = 0
    last_voiceprint_sample_count: int | None = None
    stt_runs: int = 0
    stt_errors: int = 0
    transcripts_emitted: int = 0
    last_transcript_ts_ms: int | None = None
    last_transcript_confidence: float | None = None


_app_config: AppConfig | None = None
_wake_detector: WakeWordDetector | None = None
_executive_client: ExecutiveClient | None = None
_stt_transcriber: WhisperTranscriber | None = None
_speaker_verifier: SpeakerVerifier | None = None
_voiceprint_store: VoiceprintStore | None = None
_ws_stats = WsRuntimeStats()


def _get_app_config() -> AppConfig:
    global _app_config

    if _app_config is None:
        _app_config = load_app_config()

    return _app_config


def _get_wake_detector() -> WakeWordDetector:
    global _wake_detector

    if _wake_detector is None:
        config = _get_app_config()
        _wake_detector = build_wake_detector(config.wake)

    return _wake_detector


def _get_executive_client() -> ExecutiveClient:
    global _executive_client

    if _executive_client is None:
        config = _get_app_config()
        _executive_client = ExecutiveClient(
            base_url=config.executive.base_url,
            timeout_ms=config.executive.timeout_ms,
        )

    return _executive_client


def _get_stt_transcriber() -> WhisperTranscriber:
    global _stt_transcriber

    if _stt_transcriber is None:
        config = _get_app_config()
        _stt_transcriber = build_stt_transcriber(config.stt)

    return _stt_transcriber


def _get_speaker_verifier() -> SpeakerVerifier:
    global _speaker_verifier

    if _speaker_verifier is None:
        config = _get_app_config()
        _speaker_verifier = build_speaker_verifier(config.speaker)

    return _speaker_verifier


def _get_voiceprint_store() -> VoiceprintStore:
    global _voiceprint_store

    if _voiceprint_store is None:
        config = _get_app_config()
        _voiceprint_store = build_voiceprint_store(config.voiceprints)

    return _voiceprint_store


@app.on_event("startup")
async def startup_event() -> None:
    config = _get_app_config()
    wake_detector = _get_wake_detector()
    stt_transcriber = _get_stt_transcriber()
    speaker_verifier = _get_speaker_verifier()
    voiceprint_store = _get_voiceprint_store()
    executive_client = _get_executive_client()

    wake_status = wake_detector.status()
    stt_status = stt_transcriber.status()
    speaker_status = speaker_verifier.status()
    voiceprint_status = voiceprint_store.status()

    speaker_state = (
        "disabled"
        if not speaker_status.enabled
        else ("ready" if speaker_status.ready else "unavailable")
    )

    print(
        "[audio] startup summary "
        f"listen={config.server.host}:{config.server.port} "
        f"executive={executive_client.base_url} "
        f"wake={'ready' if wake_status.ready else 'unavailable'} "
        f"stt={'ready' if stt_status.ready else 'unavailable'} "
        f"speaker={speaker_state} "
        f"voiceprint={'loaded' if voiceprint_status.loaded else 'missing'}"
    )

    if not wake_status.ready:
        print(
            "[audio][warn] wake matcher unavailable "
            f"reason={wake_status.reason}"
        )

    if not stt_status.ready:
        print(
            "[audio][warn] stt runtime unavailable "
            f"model_id={stt_status.model_id} "
            f"reason={stt_status.reason}"
        )

    if not speaker_status.enabled:
        print("[audio] speaker subsystem disabled by config (speaker.enabled=false)")
    elif not speaker_status.ready:
        print(
            "[audio][warn] speaker runtime unavailable "
            f"model_id={speaker_status.model_id} "
            f"reason={speaker_status.reason}"
        )

    if not voiceprint_status.loaded:
        print(
            "[audio] voiceprint unavailable "
            f"path={voiceprint_status.path} "
            f"reason={voiceprint_status.reason}"
        )


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global _wake_detector
    global _executive_client
    global _stt_transcriber
    global _speaker_verifier
    global _voiceprint_store

    if _wake_detector is not None:
        _wake_detector.close()
        _wake_detector = None

    if _executive_client is not None:
        await _executive_client.close()
        _executive_client = None

    _stt_transcriber = None
    _speaker_verifier = None
    _voiceprint_store = None


@app.get("/health")
async def health() -> dict[str, Any]:
    config = _get_app_config()
    wake_status = _get_wake_detector().status()
    stt_status = _get_stt_transcriber().status()
    speaker_status = _get_speaker_verifier().status()
    voiceprint_status = _get_voiceprint_store().status()

    return {
        "service": "audio",
        "status": "ok",
        "config": config_summary(config),
        "wake_runtime": {
            "ready": wake_status.ready,
            "reason": wake_status.reason,
            "phrase_count": wake_status.phrase_count,
            "match_mode": wake_status.match_mode,
            "case_sensitive": wake_status.case_sensitive,
            "min_confidence": wake_status.min_confidence,
        },
        "stt_runtime": {
            "ready": stt_status.ready,
            "reason": stt_status.reason,
            "model_id": stt_status.model_id,
            "device": stt_status.device,
            "compute_type": stt_status.compute_type,
            "cache_dir": stt_status.cache_dir,
        },
        "speaker_runtime": {
            "enabled": speaker_status.enabled,
            "ready": speaker_status.ready,
            "reason": speaker_status.reason,
            "model_id": speaker_status.model_id,
            "device": speaker_status.device,
            "similarity_threshold": speaker_status.similarity_threshold,
            "min_check_utterance_ms": speaker_status.min_check_utterance_ms,
            "max_voiced_ms": speaker_status.max_voiced_ms,
            "short_utterance_policy": speaker_status.short_utterance_policy,
        },
        "voiceprint_runtime": {
            "path": voiceprint_status.path,
            "loaded": voiceprint_status.loaded,
            "reason": voiceprint_status.reason,
            "sample_count": voiceprint_status.sample_count,
            "created_at_ms": voiceprint_status.created_at_ms,
            "last_seen_ms": voiceprint_status.last_seen_ms,
            "embedding_dims": voiceprint_status.embedding_dims,
            "ema_alpha": voiceprint_status.ema_alpha,
        },
        "ws": {
            "connections_opened": _ws_stats.connections_opened,
            "active_connections": _ws_stats.active_connections,
            "audio_chunks_received": _ws_stats.audio_chunks_received,
            "audio_chunks_invalid": _ws_stats.audio_chunks_invalid,
            "audio_bytes_received": _ws_stats.audio_bytes_received,
            "last_chunk_ts_ms": _ws_stats.last_chunk_ts_ms,
            "vad_frames_processed": _ws_stats.vad_frames_processed,
            "vad_frames_invalid": _ws_stats.vad_frames_invalid,
            "utterances_emitted": _ws_stats.utterances_emitted,
            "utterances_dropped_short": _ws_stats.utterances_dropped_short,
            "last_utterance_duration_ms": _ws_stats.last_utterance_duration_ms,
            "last_utterance_end_server_ts_ms": _ws_stats.last_utterance_end_server_ts_ms,
            "wake_phrase_checks": _ws_stats.wake_phrase_checks,
            "wake_phrase_matches": _ws_stats.wake_phrase_matches,
            "last_wake_phrase": _ws_stats.last_wake_phrase,
            "presence_checks": _ws_stats.presence_checks,
            "presence_check_errors": _ws_stats.presence_check_errors,
            "last_presence_found": _ws_stats.last_presence_found,
            "last_presence_preson_present": _ws_stats.last_presence_preson_present,
            "last_presence_person_facing_me": _ws_stats.last_presence_person_facing_me,
            "last_presence_age_ms": _ws_stats.last_presence_age_ms,
            "last_presence_ts_ms": _ws_stats.last_presence_ts_ms,
            "utterances_accepted": _ws_stats.utterances_accepted,
            "accepted_by_wake_phrase": _ws_stats.accepted_by_wake_phrase,
            "accepted_by_presence": _ws_stats.accepted_by_presence,
            "accepted_by_active": _ws_stats.accepted_by_active,
            "utterances_rejected": _ws_stats.utterances_rejected,
            "last_accept_reason": _ws_stats.last_accept_reason,
            "conversation_active_entries": _ws_stats.conversation_active_entries,
            "conversation_active_exits": _ws_stats.conversation_active_exits,
            "last_active_until_ts_ms": _ws_stats.last_active_until_ts_ms,
            "speaker_checks": _ws_stats.speaker_checks,
            "speaker_matches": _ws_stats.speaker_matches,
            "speaker_rejections": _ws_stats.speaker_rejections,
            "speaker_short_utterances": _ws_stats.speaker_short_utterances,
            "speaker_reference_sets": _ws_stats.speaker_reference_sets,
            "speaker_reference_clears": _ws_stats.speaker_reference_clears,
            "last_speaker_similarity": _ws_stats.last_speaker_similarity,
            "last_speaker_decision": _ws_stats.last_speaker_decision,
            "voiceprint_updates": _ws_stats.voiceprint_updates,
            "voiceprint_update_errors": _ws_stats.voiceprint_update_errors,
            "voiceprint_fallback_uses": _ws_stats.voiceprint_fallback_uses,
            "last_voiceprint_sample_count": _ws_stats.last_voiceprint_sample_count,
            "stt_runs": _ws_stats.stt_runs,
            "stt_errors": _ws_stats.stt_errors,
            "transcripts_emitted": _ws_stats.transcripts_emitted,
            "last_transcript_ts_ms": _ws_stats.last_transcript_ts_ms,
            "last_transcript_confidence": _ws_stats.last_transcript_confidence,
        },
    }


@app.websocket("/listen")
async def listen_socket(ws: WebSocket) -> None:
    await ws.accept()

    _ws_stats.connections_opened += 1
    _ws_stats.active_connections += 1

    await ws.send_json(make_hello("audio"))
    print("[audio] websocket connected: /listen")

    config = _get_app_config()
    wake_detector = _get_wake_detector()
    executive_client = _get_executive_client()
    stt_transcriber = _get_stt_transcriber()
    speaker_verifier = _get_speaker_verifier()
    voiceprint_store = _get_voiceprint_store()

    vad_segmenter = VADSegmenter(
        VADRuntimeConfig(
            aggressiveness=config.vad.aggressiveness,
            preroll_ms=config.vad.preroll_ms,
            end_silence_ms=config.vad.end_silence_ms,
            min_utterance_ms=config.vad.min_utterance_ms,
        )
    )

    active_until_ms: int | None = None
    speaker_reference: SpeakerReference | None = None

    if config.speaker.enabled:
        speaker_reference = voiceprint_store.get_reference()
        if speaker_reference is not None:
            _ws_stats.voiceprint_fallback_uses += 1
            print("[audio] speaker_reference_seeded_from_voiceprint")

    def clear_speaker_reference(reason: str) -> None:
        nonlocal speaker_reference

        if speaker_reference is None:
            return

        _ws_stats.speaker_reference_clears += 1
        speaker_reference = None
        print(f"[audio] speaker_reference_clear reason={reason}")

    def clear_active_state(reason: str, *, now_ts_ms: int | None = None) -> None:
        nonlocal active_until_ms

        if active_until_ms is not None:
            _ws_stats.conversation_active_exits += 1
            print(
                "[audio] conversation_active_exit "
                f"reason={reason} "
                f"active_until_ts_ms={active_until_ms}"
                + ("" if now_ts_ms is None else f" now_ts_ms={now_ts_ms}")
            )

        active_until_ms = None
        _ws_stats.last_active_until_ts_ms = None
        clear_speaker_reference(reason)

    try:
        while True:
            message = await ws.receive()
            message_type = message.get("type")

            if message_type == "websocket.disconnect":
                break

            payload_bytes = message.get("bytes")
            if payload_bytes is None:
                # Iteration 208: ignore JSON/text payloads while VAD+wake+gating+STT processing runs on binary audio frames.
                continue

            try:
                envelope = decode_binary_audio_envelope(payload_bytes)
            except BinaryAudioParseError as exc:
                _ws_stats.audio_chunks_invalid += 1
                await ws.send_json(make_error("INVALID_AUDIO_BINARY", str(exc)))
                continue

            _ws_stats.audio_chunks_received += 1
            _ws_stats.audio_bytes_received += len(envelope.audio_bytes)
            _ws_stats.last_chunk_ts_ms = envelope.meta.ts_ms

            chunk_bytes = envelope.audio_bytes
            if len(chunk_bytes) % FRAME_BYTES != 0:
                _ws_stats.vad_frames_invalid += 1
                await ws.send_json(
                    make_error(
                        "INVALID_AUDIO_FRAME_SIZE",
                        f"Audio chunk payload length must be divisible by {FRAME_BYTES} bytes for 20ms frames.",
                    )
                )
                continue

            for offset in range(0, len(chunk_bytes), FRAME_BYTES):
                frame_bytes = chunk_bytes[offset : offset + FRAME_BYTES]
                now_ms = int(time.time() * 1000)

                try:
                    vad_result = vad_segmenter.process_frame(frame_bytes, now_ms)
                except VADFrameError as exc:
                    _ws_stats.vad_frames_invalid += 1
                    await ws.send_json(make_error("INVALID_AUDIO_FRAME", str(exc)))
                    continue

                _ws_stats.vad_frames_processed += 1

                if vad_result.speech_started:
                    print(f"[audio] vad speech_start ts_ms={now_ms}")

                if vad_result.dropped_short:
                    _ws_stats.utterances_dropped_short += 1
                    print(
                        "[audio] vad utterance_dropped_short "
                        f"end_ts_ms={now_ms}"
                    )

                for utterance in vad_result.utterances:
                    _ws_stats.utterances_emitted += 1
                    _ws_stats.last_utterance_duration_ms = utterance.duration_ms
                    _ws_stats.last_utterance_end_server_ts_ms = utterance.utterance_end_server_ts_ms

                    utterance_decision_ts_ms = utterance.utterance_end_server_ts_ms

                    if active_until_ms is not None and utterance_decision_ts_ms > active_until_ms:
                        clear_active_state("timeout", now_ts_ms=utterance_decision_ts_ms)

                    wake_detected = False
                    wake_match_reason = "not_checked"
                    accepted = False
                    accept_reason = "rejected"
                    presence_snapshot: PresenceSnapshot | None = None
                    speaker_reject_detail = "speaker=not_checked"
                    transcript = None
                    was_active = active_until_ms is not None and utterance_decision_ts_ms <= active_until_ms

                    if was_active:
                        if not config.speaker.enabled:
                            accepted = True
                            accept_reason = "active"
                            _ws_stats.last_speaker_decision = "disabled"
                            _ws_stats.last_speaker_similarity = None
                            speaker_reject_detail = "speaker=disabled"
                        else:
                            _ws_stats.speaker_checks += 1

                            speaker_check = speaker_verifier.verify_active_speaker(
                                utterance_pcm16le_bytes=utterance.audio_bytes,
                                utterance_duration_ms=utterance.duration_ms,
                                reference=speaker_reference,
                            )
                            _ws_stats.last_speaker_decision = speaker_check.decision
                            _ws_stats.last_speaker_similarity = speaker_check.similarity
                            speaker_reject_detail = (
                                f"speaker={speaker_check.decision}"
                                + (
                                    ""
                                    if speaker_check.similarity is None
                                    else f",similarity={speaker_check.similarity:.3f}"
                                )
                            )

                            if speaker_check.decision == "match":
                                accepted = True
                                accept_reason = "active"
                                _ws_stats.speaker_matches += 1
                            else:
                                _ws_stats.speaker_rejections += 1
                                if speaker_check.decision == "short_utterance":
                                    _ws_stats.speaker_short_utterances += 1
                                    if config.speaker.short_utterance_policy == "require_rewake":
                                        clear_active_state(
                                            "speaker_short_utterance_require_rewake",
                                            now_ts_ms=utterance_decision_ts_ms,
                                        )

                                if speaker_check.decision in {"no_reference", "unavailable", "error"}:
                                    clear_active_state(
                                        f"speaker_{speaker_check.decision}",
                                        now_ts_ms=utterance_decision_ts_ms,
                                    )

                                print(
                                    "[audio] speaker_check_rejected "
                                    f"decision={speaker_check.decision} "
                                    + (
                                        ""
                                        if speaker_check.similarity is None
                                        else f"similarity={speaker_check.similarity:.3f} "
                                    )
                                    + f"detail={speaker_check.detail}"
                                )
                    else:
                        speaker_reject_detail = "speaker=not_active"
                        _ws_stats.last_wake_phrase = None

                        _ws_stats.presence_checks += 1
                        try:
                            presence_snapshot = await executive_client.get_presence(
                                window_ms=config.gating.presence_window_ms,
                            )
                            _ws_stats.last_presence_found = presence_snapshot.found
                            _ws_stats.last_presence_preson_present = presence_snapshot.preson_present
                            _ws_stats.last_presence_person_facing_me = presence_snapshot.person_facing_me
                            _ws_stats.last_presence_age_ms = presence_snapshot.age_ms
                            _ws_stats.last_presence_ts_ms = presence_snapshot.ts_ms

                            if (
                                presence_snapshot.found
                                and presence_snapshot.preson_present
                                and presence_snapshot.person_facing_me
                            ):
                                accepted = True
                                accept_reason = "presence"
                                wake_match_reason = "presence_bypass"
                        except ExecutiveClientError as exc:
                            _ws_stats.presence_check_errors += 1
                            wake_match_reason = "presence_error_phrase_required"
                            print(
                                "[audio] gating presence check failed "
                                f"code={exc.code} "
                                f"reason={exc}"
                            )

                        if not accepted:
                            _ws_stats.stt_runs += 1
                            try:
                                transcript = await stt_transcriber.transcribe(utterance.audio_bytes)
                            except Exception as exc:
                                _ws_stats.stt_errors += 1
                                wake_match_reason = "stt_error_for_wake_phrase"
                                print(
                                    "[audio] stt transcription failed during wake phrase check "
                                    f"reason={exc}"
                                )
                            else:
                                if transcript is None:
                                    wake_match_reason = "empty_transcript_for_wake_phrase"
                                else:
                                    _ws_stats.wake_phrase_checks += 1
                                    wake_match = wake_detector.match_transcript(
                                        transcript.text,
                                        confidence=transcript.confidence,
                                    )
                                    wake_detected = wake_match.matched
                                    _ws_stats.last_wake_phrase = wake_match.phrase
                                    wake_match_reason = wake_match.reason
                                    if wake_detected:
                                        _ws_stats.wake_phrase_matches += 1
                                        accepted = True
                                        accept_reason = "wake_phrase"

                    if not accepted:
                        _ws_stats.utterances_rejected += 1
                        _ws_stats.last_accept_reason = "rejected"

                        presence_detail = (
                            "presence=none"
                            if presence_snapshot is None
                            else (
                                "presence="
                                f"found:{presence_snapshot.found},"
                                f"preson_present:{presence_snapshot.preson_present},"
                                f"person_facing_me:{presence_snapshot.person_facing_me},"
                                f"age_ms:{presence_snapshot.age_ms}"
                            )
                        )

                        transcript_detail = (
                            "stt_transcript=none"
                            if transcript is None
                            else (
                                f"stt_transcript={transcript.text!r} "
                                f"stt_confidence={transcript.confidence:.3f}"
                            )
                        )

                        print(
                            "[audio] utterance_rejected "
                            f"start_ts_ms={utterance.started_server_ts_ms} "
                            f"utterance_end_server_ts_ms={utterance.utterance_end_server_ts_ms} "
                            f"duration_ms={utterance.duration_ms} "
                            f"wake_phrase_matched={wake_detected} "
                            f"wake_match_reason={wake_match_reason} "
                            f"{transcript_detail} "
                            f"{presence_detail} "
                            f"{speaker_reject_detail}"
                        )
                        continue

                    active_until_ms = utterance_decision_ts_ms + config.conversation.active_timeout_ms
                    _ws_stats.last_active_until_ts_ms = active_until_ms

                    if not was_active:
                        _ws_stats.conversation_active_entries += 1
                        print(
                            "[audio] conversation_active_enter "
                            f"reason={accept_reason} "
                            f"active_until_ts_ms={active_until_ms}"
                        )

                        if config.speaker.enabled:
                            reference_result = speaker_verifier.build_reference(
                                utterance_pcm16le_bytes=utterance.audio_bytes,
                                utterance_duration_ms=utterance.duration_ms,
                            )
                            _ws_stats.last_speaker_decision = f"reference_{reference_result.decision}"
                            _ws_stats.last_speaker_similarity = None

                            if reference_result.reference is not None:
                                speaker_reference = reference_result.reference
                                _ws_stats.speaker_reference_sets += 1
                                print(
                                    "[audio] speaker_reference_set "
                                    f"decision={reference_result.decision} "
                                    f"detail={reference_result.detail}"
                                )

                                # Iteration 212: persist voiceprints only on intentional engagement
                                # (wake_phrase/presence ACTIVE entry), never from ambient ACTIVE continuations.
                                if accept_reason in {"wake_phrase", "presence"}:
                                    updated_voiceprint = voiceprint_store.upsert_from_reference(
                                        reference=reference_result.reference,
                                        observed_at_ms=utterance_decision_ts_ms,
                                    )
                                    if updated_voiceprint is None:
                                        _ws_stats.voiceprint_update_errors += 1
                                        print("[audio] voiceprint_update_failed")
                                    else:
                                        _ws_stats.voiceprint_updates += 1
                                        _ws_stats.last_voiceprint_sample_count = updated_voiceprint.sample_count
                                        print(
                                            "[audio] voiceprint_updated "
                                            f"sample_count={updated_voiceprint.sample_count} "
                                            f"last_seen_ms={updated_voiceprint.last_seen_ms}"
                                        )
                            else:
                                print(
                                    "[audio] speaker_reference_unavailable "
                                    f"decision={reference_result.decision} "
                                    f"detail={reference_result.detail}"
                                )

                                fallback_reference = voiceprint_store.get_reference()
                                if fallback_reference is not None:
                                    speaker_reference = fallback_reference
                                    _ws_stats.voiceprint_fallback_uses += 1
                                    print("[audio] speaker_reference_fallback_from_voiceprint")
                                elif config.speaker.short_utterance_policy == "require_rewake":
                                    clear_active_state(
                                        "speaker_reference_unavailable_require_rewake",
                                        now_ts_ms=utterance_decision_ts_ms,
                                    )
                        else:
                            _ws_stats.last_speaker_decision = "reference_disabled"
                            _ws_stats.last_speaker_similarity = None

                    _ws_stats.utterances_accepted += 1
                    _ws_stats.last_accept_reason = accept_reason

                    if accept_reason == "wake_phrase":
                        _ws_stats.accepted_by_wake_phrase += 1
                    elif accept_reason == "presence":
                        _ws_stats.accepted_by_presence += 1
                    elif accept_reason == "active":
                        _ws_stats.accepted_by_active += 1

                    if transcript is None:
                        _ws_stats.stt_runs += 1

                        try:
                            transcript = await stt_transcriber.transcribe(utterance.audio_bytes)
                        except Exception as exc:
                            _ws_stats.stt_errors += 1
                            print(
                                "[audio] stt transcription failed "
                                f"reason={exc} "
                                f"accept_reason={accept_reason}"
                            )
                            continue

                    if transcript is None:
                        print(
                            "[audio] stt transcript empty_or_unavailable "
                            f"accept_reason={accept_reason} "
                            f"utterance_end_server_ts_ms={utterance.utterance_end_server_ts_ms}"
                        )
                        continue

                    speech_transcript = make_speech_transcript(
                        ts_ms=utterance.utterance_end_server_ts_ms,
                        text=transcript.text,
                        confidence=transcript.confidence,
                    )

                    await ws.send_json(speech_transcript)

                    _ws_stats.transcripts_emitted += 1
                    _ws_stats.last_transcript_ts_ms = utterance.utterance_end_server_ts_ms
                    _ws_stats.last_transcript_confidence = transcript.confidence

                    print(
                        "[audio] speech_transcript emitted "
                        f"accept_reason={accept_reason} "
                        f"utterance_end_server_ts_ms={utterance.utterance_end_server_ts_ms} "
                        f"confidence={transcript.confidence:.3f} "
                        f"text={transcript.text!r}"
                    )
    except WebSocketDisconnect:
        pass
    finally:
        if active_until_ms is not None or speaker_reference is not None:
            clear_active_state("disconnect")

        _ws_stats.active_connections = max(0, _ws_stats.active_connections - 1)
        print("[audio] websocket disconnected: /listen")
