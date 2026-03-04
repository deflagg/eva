from __future__ import annotations

import asyncio
import contextlib
import io
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from PIL import Image, UnidentifiedImageError

from .attention import AttentionWindow
from .clip_assets import ClipAssetRef, ClipAssetsManager
from .config import AppConfig, CaptionConfig, SemanticConfig, config_summary, load_app_config
from .executive_client import ExecutiveClient, ExecutiveClientError, ExecutiveInsightResponse
from .frame_buffer import BufferedFrame, FrameBuffer
from .protocol import (
    BinaryFrameParseError,
    CommandParseError,
    decode_binary_frame_envelope,
    make_error,
    make_frame_events,
    make_hello,
    make_insight,
    parse_command_payload,
)
from .semantic_model import (
    SemanticEmbedding,
    SemanticRuntime,
    compute_semantic_embedding,
    load_semantic_runtime,
)
from .surprise import SurpriseTracker

app = FastAPI(title="vision", version="0.1.0")


@dataclass(slots=True)
class CaptionRuntime:
    model_id: str
    requested_device: str
    resolved_device: str
    torch_module: Any
    processor: Any
    model: Any


@dataclass(slots=True)
class WsRuntimeStats:
    connections_opened: int = 0
    active_connections: int = 0
    frames_buffered: int = 0
    frames_evicted: int = 0
    attention_start_count: int = 0
    last_attention_start_ts_ms: int | None = None
    scene_caption_emitted: int = 0
    scene_caption_dedupe_suppressed: int = 0
    scene_caption_cooldown_skipped: int = 0
    scene_caption_errors: int = 0
    last_scene_caption_ts_ms: int | None = None
    last_scene_caption_text: str | None = None
    semantic_embeddings: int = 0
    semantic_errors: int = 0
    last_semantic_surprise: float | None = None
    last_semantic_similarity_prev: float | None = None
    last_semantic_similarity_mean: float | None = None
    insight_decision_escalate_count: int = 0
    insight_decision_noop_count: int = 0
    last_should_escalate: bool | None = None
    insight_requested: int = 0
    insight_emitted: int = 0
    insight_cooldown_skipped: int = 0
    insight_busy_skipped: int = 0
    insight_clip_build_errors: int = 0
    insight_errors: int = 0
    last_insight_ts_ms: int | None = None
    last_insight_clip_id: str | None = None
    executive_events_forwarded: int = 0
    executive_events_failed: int = 0
    last_executive_events_forwarded_ts_ms: int | None = None


@dataclass(slots=True)
class WsCaptionState:
    last_caption_attempt_ts_ms: int | None = None
    last_emitted_caption_ts_ms: int | None = None
    last_emitted_caption_text: str | None = None


@dataclass(slots=True)
class WsInsightState:
    last_started_ts_ms: int | None = None
    in_flight_task: asyncio.Task[None] | None = None


@dataclass(frozen=True, slots=True)
class SceneCaptionEmission:
    event: dict[str, object]
    should_escalate: bool


EXECUTIVE_EVENTS_SOURCE = "vision"
EXECUTIVE_EVENTS_WARN_COOLDOWN_MS = 10_000

_app_config: AppConfig | None = None
_caption_runtime: CaptionRuntime | None = None
_semantic_runtime: SemanticRuntime | None = None
_executive_client: ExecutiveClient | None = None
_last_latency_ms: int | None = None
_last_executive_warning_ts_ms: int | None = None
_ws_runtime = WsRuntimeStats()


def _resolve_device(torch_module: Any, requested_device: str) -> str:
    cuda_available = bool(torch_module.cuda.is_available())

    if requested_device == "auto":
        return "cuda" if cuda_available else "cpu"

    if requested_device == "cuda" and not cuda_available:
        print("[vision] requested device=cuda but CUDA is unavailable; falling back to cpu")
        return "cpu"

    return requested_device


def _load_caption_runtime(cfg: CaptionConfig) -> CaptionRuntime:
    try:
        import torch
        from transformers import BlipForConditionalGeneration, BlipProcessor
    except Exception as exc:  # pragma: no cover - import-time dependency failures are environment-specific
        raise RuntimeError(f"Missing caption model dependencies: {exc}") from exc

    resolved_device = _resolve_device(torch, cfg.device)

    print(
        "[vision] loading model: "
        f"model_id={cfg.model_id} requested_device={cfg.device} resolved_device={resolved_device}"
    )

    processor = BlipProcessor.from_pretrained(cfg.model_id)
    model = BlipForConditionalGeneration.from_pretrained(cfg.model_id)
    model.to(resolved_device)
    model.eval()

    return CaptionRuntime(
        model_id=cfg.model_id,
        requested_device=cfg.device,
        resolved_device=resolved_device,
        torch_module=torch,
        processor=processor,
        model=model,
    )


def _resize_to_max_dim(image: Image.Image, max_dim: int) -> Image.Image:
    width, height = image.size
    longest_side = max(width, height)
    if longest_side <= max_dim:
        return image

    scale = max_dim / float(longest_side)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))

    if hasattr(Image, "Resampling"):
        resample = Image.Resampling.BICUBIC
    else:
        resample = Image.BICUBIC

    return image.resize((resized_width, resized_height), resample=resample)


def _generate_caption(cfg: CaptionConfig, runtime: CaptionRuntime, jpeg_bytes: bytes) -> tuple[str, int]:
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as decoded:
            image = decoded.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Frame payload must be a valid JPEG image.") from exc

    image = _resize_to_max_dim(image, cfg.max_dim)

    inputs = runtime.processor(images=image, return_tensors="pt")
    for key, value in inputs.items():
        inputs[key] = value.to(runtime.resolved_device)

    torch_module = runtime.torch_module

    if runtime.resolved_device == "cuda":
        torch_module.cuda.synchronize()

    start_time = time.perf_counter()
    with torch_module.inference_mode():
        generated = runtime.model.generate(
            **inputs,
            max_new_tokens=cfg.max_new_tokens,
        )

    if runtime.resolved_device == "cuda":
        torch_module.cuda.synchronize()

    latency_ms = max(1, int(round((time.perf_counter() - start_time) * 1000)))
    text = runtime.processor.decode(generated[0], skip_special_tokens=True).strip()

    if not text:
        text = "(empty caption)"

    return text, latency_ms


def _get_app_config() -> AppConfig:
    global _app_config

    if _app_config is None:
        _app_config = load_app_config()

    return _app_config


def _get_caption_runtime() -> CaptionRuntime | None:
    return _caption_runtime


def _get_semantic_runtime() -> SemanticRuntime | None:
    return _semantic_runtime


def _get_executive_client() -> ExecutiveClient | None:
    return _executive_client


def _warn_executive_forward_failure(reason: str) -> None:
    global _last_executive_warning_ts_ms

    now_ms = _current_time_ms()
    if (
        _last_executive_warning_ts_ms is not None
        and now_ms - _last_executive_warning_ts_ms < EXECUTIVE_EVENTS_WARN_COOLDOWN_MS
    ):
        return

    _last_executive_warning_ts_ms = now_ms
    print(f"[vision] warning: failed to forward event to executive /events: {reason}")


def _normalize_event_for_events_ingest(event: dict[str, object]) -> dict[str, object]:
    name = event.get("name")
    ts_ms = event.get("ts_ms")
    severity = event.get("severity")
    data = event.get("data")

    if not isinstance(name, str) or not name.strip():
        raise ValueError("event name is invalid")

    if not isinstance(ts_ms, int) or ts_ms < 0:
        raise ValueError("event ts_ms is invalid")

    if severity not in {"low", "medium", "high"}:
        raise ValueError("event severity is invalid")

    if not isinstance(data, dict):
        raise ValueError("event data is invalid")

    return {
        "name": name,
        "ts_ms": ts_ms,
        "severity": severity,
        "data": data,
    }


async def _forward_event_to_executive(
    *,
    executive_client: ExecutiveClient | None,
    frame_id: str,
    event: dict[str, object],
) -> None:
    if executive_client is None:
        return

    try:
        normalized_event = _normalize_event_for_events_ingest(event)
    except Exception as exc:
        _ws_runtime.executive_events_failed += 1
        _warn_executive_forward_failure(f"invalid event shape: {exc}")
        return

    try:
        await executive_client.post_events(
            source=EXECUTIVE_EVENTS_SOURCE,
            events=[normalized_event],
            meta={"frame_id": frame_id},
        )
        _ws_runtime.executive_events_forwarded += 1
        _ws_runtime.last_executive_events_forwarded_ts_ms = _current_time_ms()
    except ExecutiveClientError as exc:
        _ws_runtime.executive_events_failed += 1
        _warn_executive_forward_failure(str(exc))
    except Exception as exc:  # pragma: no cover
        _ws_runtime.executive_events_failed += 1
        _warn_executive_forward_failure(str(exc))


def _derive_clip_window(config: AppConfig) -> tuple[int, int]:
    max_frames = max(config.insight.max_frames, 1)
    pre_frames = min(config.insight.pre_frames, max_frames - 1)
    remaining_for_post = max(max_frames - 1 - pre_frames, 0)
    post_frames = min(config.insight.post_frames, remaining_for_post)
    return pre_frames, post_frames


def _count_post_frames(clip_frames: list[BufferedFrame], trigger_frame_id: str) -> int:
    trigger_index = next((idx for idx, frame in enumerate(clip_frames) if frame.frame_id == trigger_frame_id), -1)
    if trigger_index < 0:
        return 0

    return max(len(clip_frames) - trigger_index - 1, 0)


def _collect_existing_asset_clip_for_test(
    *,
    assets_dir: Path,
    max_frames: int,
) -> tuple[str, list[dict[str, Any]]] | None:
    try:
        clip_dirs = [candidate for candidate in assets_dir.iterdir() if candidate.is_dir()]
    except OSError:
        return None

    clip_dirs_with_mtime: list[tuple[Path, float]] = []
    for clip_dir in clip_dirs:
        try:
            clip_dirs_with_mtime.append((clip_dir, clip_dir.stat().st_mtime))
        except OSError:
            continue

    clip_dirs_with_mtime.sort(key=lambda item: item[1], reverse=True)

    for clip_dir, _mtime in clip_dirs_with_mtime:
        try:
            frame_files = sorted(
                [
                    candidate
                    for candidate in clip_dir.iterdir()
                    if candidate.is_file() and candidate.suffix.lower() == ".jpg"
                ],
                key=lambda item: item.name,
            )
        except OSError:
            continue

        if not frame_files:
            continue

        selected_frames = frame_files[: max(1, max_frames)]
        base_ts_ms = _current_time_ms()
        refs: list[dict[str, Any]] = []
        for index, frame_file in enumerate(selected_frames):
            frame_id = frame_file.stem.strip() or f"frame-{index + 1}"
            refs.append(
                {
                    "frame_id": frame_id,
                    "ts_ms": base_ts_ms + index,
                    "mime": "image/jpeg",
                    "asset_rel_path": f"{clip_dir.name}/{frame_file.name}",
                }
            )

        trigger_frame_id = refs[0]["frame_id"]
        return trigger_frame_id, refs

    return None


async def _collect_insight_clip(
    *,
    config: AppConfig,
    frame_buffer: FrameBuffer,
    frame_arrival_event: asyncio.Event,
    trigger_frame_id: str,
) -> list[BufferedFrame]:
    pre_frames, post_frames = _derive_clip_window(config)

    clip_frames = frame_buffer.get_clip(trigger_frame_id, pre_frames=pre_frames, post_frames=post_frames)
    if not clip_frames:
        return []

    if post_frames <= 0:
        return clip_frames[: config.insight.max_frames]

    if _count_post_frames(clip_frames, trigger_frame_id) >= post_frames:
        return clip_frames[: config.insight.max_frames]

    if config.insight.post_wait_ms <= 0:
        return clip_frames[: config.insight.max_frames]

    deadline = asyncio.get_running_loop().time() + (config.insight.post_wait_ms / 1000.0)

    while _count_post_frames(clip_frames, trigger_frame_id) < post_frames:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break

        try:
            await asyncio.wait_for(frame_arrival_event.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            break

        frame_arrival_event.clear()

        clip_frames = frame_buffer.get_clip(trigger_frame_id, pre_frames=pre_frames, post_frames=post_frames)
        if not clip_frames:
            return []

    return clip_frames[: config.insight.max_frames]


async def _request_and_emit_insight(
    *,
    executive_client: ExecutiveClient,
    clip_id: str,
    trigger_frame_id: str,
    insight_frames: list[dict[str, Any]],
    send_payload: Any,
) -> None:
    insight_response: ExecutiveInsightResponse
    try:
        insight_response = await executive_client.post_insight(
            clip_id=clip_id,
            trigger_frame_id=trigger_frame_id,
            frames=insight_frames,
        )
    except ExecutiveClientError as exc:
        _ws_runtime.insight_errors += 1
        await send_payload(make_error(exc.code, str(exc), frame_id=trigger_frame_id))
        return
    except Exception as exc:  # pragma: no cover
        _ws_runtime.insight_errors += 1
        await send_payload(
            make_error(
                "EXECUTIVE_ERROR",
                f"Executive /insight request failed: {exc}",
                frame_id=trigger_frame_id,
            )
        )
        return

    summary_payload = insight_response.summary.model_dump(exclude_none=True)
    usage_payload = insight_response.usage.model_dump(exclude_none=True)

    insight_payload = make_insight(
        clip_id=clip_id,
        trigger_frame_id=trigger_frame_id,
        summary=summary_payload,
        usage=usage_payload,
    )

    delivered = await send_payload(insight_payload)
    if delivered:
        _ws_runtime.insight_emitted += 1
        _ws_runtime.last_insight_ts_ms = _current_time_ms()
        _ws_runtime.last_insight_clip_id = clip_id


async def _run_insight_for_trigger(
    *,
    config: AppConfig,
    executive_client: ExecutiveClient | None,
    clip_assets: ClipAssetsManager,
    frame_buffer: FrameBuffer,
    frame_arrival_event: asyncio.Event,
    trigger_frame_id: str,
    send_payload: Any,
) -> None:
    if executive_client is None:
        return

    clip_frames = await _collect_insight_clip(
        config=config,
        frame_buffer=frame_buffer,
        frame_arrival_event=frame_arrival_event,
        trigger_frame_id=trigger_frame_id,
    )

    if not clip_frames:
        _ws_runtime.insight_clip_build_errors += 1
        await send_payload(
            make_error(
                "CAPTION_FAILED",
                "Insight clip unavailable for trigger frame.",
                frame_id=trigger_frame_id,
            )
        )
        return

    clip_id = str(uuid4())

    try:
        clip_refs: list[ClipAssetRef] = await asyncio.to_thread(
            clip_assets.persist_clip,
            clip_id=clip_id,
            frames=clip_frames,
        )
    except Exception as exc:
        _ws_runtime.insight_clip_build_errors += 1
        await send_payload(
            make_error(
                "CAPTION_FAILED",
                f"Failed to persist insight clip assets: {exc}",
                frame_id=trigger_frame_id,
            )
        )
        return

    insight_frames = [
        {
            "frame_id": ref.frame_id,
            "ts_ms": ref.ts_ms,
            "mime": ref.mime,
            "asset_rel_path": ref.asset_rel_path,
        }
        for ref in clip_refs
    ]

    await _request_and_emit_insight(
        executive_client=executive_client,
        clip_id=clip_id,
        trigger_frame_id=trigger_frame_id,
        insight_frames=insight_frames,
        send_payload=send_payload,
    )


def _derive_frame_buffer_max_frames(config: AppConfig) -> int:
    minimum_clip_window = config.insight.pre_frames + config.insight.post_frames + 1
    return max(16, config.insight.max_frames, minimum_clip_window * 3)


def _current_time_ms() -> int:
    return int(time.time() * 1000)


def _is_dedupe_suppressed(text: str, state: WsCaptionState, dedupe_window_ms: int, now_ms: int) -> bool:
    if state.last_emitted_caption_text is None or state.last_emitted_caption_ts_ms is None:
        return False

    if text != state.last_emitted_caption_text:
        return False

    return now_ms - state.last_emitted_caption_ts_ms < dedupe_window_ms


async def _build_semantic_payload(
    *,
    semantic_cfg: SemanticConfig,
    semantic_runtime: SemanticRuntime | None,
    surprise_tracker: SurpriseTracker,
    frame_jpeg_bytes: bytes,
) -> tuple[dict[str, object] | None, bool]:
    if not semantic_cfg.enabled or semantic_runtime is None:
        return None, False

    embedding: SemanticEmbedding = await asyncio.to_thread(compute_semantic_embedding, semantic_runtime, frame_jpeg_bytes)
    metrics = surprise_tracker.update(embedding.vector)

    _ws_runtime.semantic_embeddings += 1
    _ws_runtime.last_semantic_surprise = metrics.surprise
    _ws_runtime.last_semantic_similarity_prev = metrics.similarity_prev
    _ws_runtime.last_semantic_similarity_mean = metrics.similarity_mean
    _ws_runtime.last_should_escalate = metrics.should_escalate

    semantic_payload = {
        "surprise": metrics.surprise,
        "similarity_prev": metrics.similarity_prev,
        "similarity_mean": metrics.similarity_mean,
        "model": embedding.model,
        "latency_ms": embedding.latency_ms,
        "should_escalate": metrics.should_escalate,
    }

    return semantic_payload, metrics.should_escalate


async def _build_scene_caption_event(
    *,
    caption_cfg: CaptionConfig,
    caption_runtime: CaptionRuntime | None,
    semantic_cfg: SemanticConfig,
    semantic_runtime: SemanticRuntime | None,
    surprise_tracker: SurpriseTracker,
    attention: AttentionWindow,
    caption_state: WsCaptionState,
    frame_jpeg_bytes: bytes,
    now_ms: int,
) -> SceneCaptionEmission | None:
    global _last_latency_ms

    if not caption_cfg.enabled or caption_runtime is None:
        return None

    if not attention.is_active(now_ms=now_ms):
        return None

    if caption_state.last_caption_attempt_ts_ms is not None:
        elapsed_since_last_attempt_ms = now_ms - caption_state.last_caption_attempt_ts_ms
        if elapsed_since_last_attempt_ms < caption_cfg.cooldown_ms:
            _ws_runtime.scene_caption_cooldown_skipped += 1
            return None

    caption_state.last_caption_attempt_ts_ms = now_ms

    text, latency_ms = await asyncio.to_thread(_generate_caption, caption_cfg, caption_runtime, frame_jpeg_bytes)
    _last_latency_ms = latency_ms

    emitted_ts_ms = _current_time_ms()
    if _is_dedupe_suppressed(text, caption_state, caption_cfg.dedupe_window_ms, emitted_ts_ms):
        _ws_runtime.scene_caption_dedupe_suppressed += 1
        return None

    semantic_payload, should_escalate = await _build_semantic_payload(
        semantic_cfg=semantic_cfg,
        semantic_runtime=semantic_runtime,
        surprise_tracker=surprise_tracker,
        frame_jpeg_bytes=frame_jpeg_bytes,
    )

    caption_state.last_emitted_caption_text = text
    caption_state.last_emitted_caption_ts_ms = emitted_ts_ms

    _ws_runtime.scene_caption_emitted += 1
    _ws_runtime.last_scene_caption_ts_ms = emitted_ts_ms
    _ws_runtime.last_scene_caption_text = text
    if semantic_payload is not None:
        if should_escalate:
            _ws_runtime.insight_decision_escalate_count += 1
        else:
            _ws_runtime.insight_decision_noop_count += 1

    event_data: dict[str, object] = {
        "text": text,
        "model": caption_runtime.model_id,
        "latency_ms": latency_ms,
    }
    if semantic_payload is not None:
        event_data["semantic"] = semantic_payload

    return SceneCaptionEmission(
        event={
            "name": "scene_caption",
            "ts_ms": emitted_ts_ms,
            "severity": "low",
            "data": event_data,
        },
        should_escalate=should_escalate,
    )


@app.on_event("startup")
async def on_startup() -> None:
    global _app_config, _caption_runtime, _semantic_runtime, _executive_client

    try:
        _app_config = load_app_config()
    except Exception as exc:
        raise RuntimeError(f"Vision startup failed: {exc}") from exc

    _caption_runtime = None
    _semantic_runtime = None
    _executive_client = ExecutiveClient(
        base_url=_app_config.executive.base_url,
        timeout_ms=_app_config.executive.timeout_ms,
    )

    if _app_config.caption.enabled:
        try:
            _caption_runtime = _load_caption_runtime(_app_config.caption)
        except Exception as exc:
            raise RuntimeError(f"Vision startup failed: {exc}") from exc

    if _app_config.semantic.enabled:
        try:
            _semantic_runtime = load_semantic_runtime(_app_config.semantic)
        except Exception as exc:
            raise RuntimeError(f"Vision startup failed: {exc}") from exc

    frame_buffer_max_frames = _derive_frame_buffer_max_frames(_app_config)

    print(
        "[vision] config: "
        f"server={_app_config.server.host}:{_app_config.server.port} "
        f"executive_base_url={_app_config.executive.base_url} "
        f"executive_timeout_ms={_app_config.executive.timeout_ms} "
        f"attention_window_ms={_app_config.attention.window_ms} "
        f"frame_buffer_max_frames={frame_buffer_max_frames} "
        f"caption_enabled={_app_config.caption.enabled} "
        f"caption_runtime_ready={_caption_runtime is not None} "
        f"semantic_enabled={_app_config.semantic.enabled} "
        f"semantic_runtime_ready={_semantic_runtime is not None} "
        f"insight_enabled={_app_config.insight.enabled}"
    )


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _executive_client

    client = _executive_client
    _executive_client = None

    if client is not None:
        await client.close()


@app.get("/health")
async def health() -> dict[str, object]:
    cfg = _get_app_config()
    caption_runtime = _get_caption_runtime()
    semantic_runtime = _get_semantic_runtime()
    executive_client = _get_executive_client()

    return {
        "service": "vision",
        "status": "ok",
        "config": config_summary(cfg),
        "caption_enabled": cfg.caption.enabled,
        "model_id": cfg.caption.model_id,
        "requested_device": cfg.caption.device,
        "resolved_device": caption_runtime.resolved_device if caption_runtime is not None else None,
        "model_loaded": caption_runtime is not None,
        "max_dim": cfg.caption.max_dim,
        "max_new_tokens": cfg.caption.max_new_tokens,
        "semantic_model_id": cfg.semantic.model_id,
        "semantic_requested_device": cfg.semantic.device,
        "semantic_resolved_device": semantic_runtime.resolved_device if semantic_runtime is not None else None,
        "semantic_model_loaded": semantic_runtime is not None,
        "surprise_threshold": cfg.surprise.threshold,
        "executive_base_url": cfg.executive.base_url,
        "executive_timeout_ms": cfg.executive.timeout_ms,
        "executive_client_ready": executive_client is not None,
        "last_latency_ms": _last_latency_ms,
        "ws_runtime": {
            "connections_opened": _ws_runtime.connections_opened,
            "active_connections": _ws_runtime.active_connections,
            "frames_buffered": _ws_runtime.frames_buffered,
            "frames_evicted": _ws_runtime.frames_evicted,
            "attention_start_count": _ws_runtime.attention_start_count,
            "last_attention_start_ts_ms": _ws_runtime.last_attention_start_ts_ms,
            "scene_caption_emitted": _ws_runtime.scene_caption_emitted,
            "scene_caption_dedupe_suppressed": _ws_runtime.scene_caption_dedupe_suppressed,
            "scene_caption_cooldown_skipped": _ws_runtime.scene_caption_cooldown_skipped,
            "scene_caption_errors": _ws_runtime.scene_caption_errors,
            "last_scene_caption_ts_ms": _ws_runtime.last_scene_caption_ts_ms,
            "last_scene_caption_text": _ws_runtime.last_scene_caption_text,
            "semantic_embeddings": _ws_runtime.semantic_embeddings,
            "semantic_errors": _ws_runtime.semantic_errors,
            "last_semantic_surprise": _ws_runtime.last_semantic_surprise,
            "last_semantic_similarity_prev": _ws_runtime.last_semantic_similarity_prev,
            "last_semantic_similarity_mean": _ws_runtime.last_semantic_similarity_mean,
            "insight_decision_escalate_count": _ws_runtime.insight_decision_escalate_count,
            "insight_decision_noop_count": _ws_runtime.insight_decision_noop_count,
            "last_should_escalate": _ws_runtime.last_should_escalate,
            "insight_requested": _ws_runtime.insight_requested,
            "insight_emitted": _ws_runtime.insight_emitted,
            "insight_cooldown_skipped": _ws_runtime.insight_cooldown_skipped,
            "insight_busy_skipped": _ws_runtime.insight_busy_skipped,
            "insight_clip_build_errors": _ws_runtime.insight_clip_build_errors,
            "insight_errors": _ws_runtime.insight_errors,
            "last_insight_ts_ms": _ws_runtime.last_insight_ts_ms,
            "last_insight_clip_id": _ws_runtime.last_insight_clip_id,
            "executive_events_forwarded": _ws_runtime.executive_events_forwarded,
            "executive_events_failed": _ws_runtime.executive_events_failed,
            "last_executive_events_forwarded_ts_ms": _ws_runtime.last_executive_events_forwarded_ts_ms,
            "frame_buffer_max_frames_hint": _derive_frame_buffer_max_frames(cfg),
        },
    }


@app.websocket("/infer")
async def infer_socket(websocket: WebSocket) -> None:
    cfg = _get_app_config()
    caption_runtime = _get_caption_runtime()
    semantic_runtime = _get_semantic_runtime()
    executive_client = _get_executive_client()
    frame_buffer = FrameBuffer(max_frames=_derive_frame_buffer_max_frames(cfg))
    clip_assets = ClipAssetsManager(
        assets_dir=cfg.insight.assets_dir,
        max_clips=cfg.insight.retention.max_clips,
        max_age_hours=cfg.insight.retention.max_age_hours,
    )
    frame_arrival_event = asyncio.Event()

    attention = AttentionWindow(window_ms=cfg.attention.window_ms)
    caption_state = WsCaptionState()
    insight_state = WsInsightState()
    surprise_tracker = SurpriseTracker(
        history_size=cfg.semantic.history_size,
        threshold=cfg.surprise.threshold,
    )

    send_lock = asyncio.Lock()

    async def send_payload(payload: dict[str, object]) -> bool:
        async with send_lock:
            try:
                await websocket.send_json(payload)
                return True
            except Exception:
                return False

    def maybe_start_insight(trigger_frame_id: str, *, force: bool = False) -> bool:
        if not cfg.insight.enabled:
            return False

        if executive_client is None:
            return False

        if insight_state.in_flight_task is not None and not insight_state.in_flight_task.done():
            _ws_runtime.insight_busy_skipped += 1
            return False

        now_ms = _current_time_ms()
        if not force and insight_state.last_started_ts_ms is not None:
            elapsed_ms = now_ms - insight_state.last_started_ts_ms
            if elapsed_ms < cfg.insight.cooldown_ms:
                _ws_runtime.insight_cooldown_skipped += 1
                return False

        insight_state.last_started_ts_ms = now_ms
        _ws_runtime.insight_requested += 1

        async def run_task() -> None:
            await _run_insight_for_trigger(
                config=cfg,
                executive_client=executive_client,
                clip_assets=clip_assets,
                frame_buffer=frame_buffer,
                frame_arrival_event=frame_arrival_event,
                trigger_frame_id=trigger_frame_id,
                send_payload=send_payload,
            )

        task = asyncio.create_task(run_task())
        insight_state.in_flight_task = task

        def on_done(done_task: asyncio.Task[None]) -> None:
            if insight_state.in_flight_task is done_task:
                insight_state.in_flight_task = None

            try:
                done_task.result()
            except asyncio.CancelledError:
                return
            except Exception as exc:  # pragma: no cover
                _ws_runtime.insight_errors += 1
                print(f"[vision] warning: unhandled insight task error: {exc}")

        task.add_done_callback(on_done)
        return True

    _ws_runtime.connections_opened += 1
    _ws_runtime.active_connections += 1

    await websocket.accept()
    await send_payload(make_hello("vision"))

    print(
        "[vision] /infer connected: "
        f"active_connections={_ws_runtime.active_connections} "
        f"attention_window_ms={attention.window_ms} "
        f"frame_buffer_max_frames={frame_buffer.stats().max_frames} "
        f"caption_enabled={cfg.caption.enabled} "
        f"caption_runtime_ready={caption_runtime is not None} "
        f"semantic_enabled={cfg.semantic.enabled} "
        f"semantic_runtime_ready={semantic_runtime is not None} "
        f"semantic_history_size={cfg.semantic.history_size} "
        f"surprise_threshold={cfg.surprise.threshold} "
        f"executive_client_ready={executive_client is not None} "
        f"insight_enabled={cfg.insight.enabled} "
        f"insight_cooldown_ms={cfg.insight.cooldown_ms}"
    )

    try:
        while True:
            ws_event = await websocket.receive()
            event_type = ws_event.get("type")

            if event_type == "websocket.disconnect":
                break

            if event_type != "websocket.receive":
                continue

            binary_payload = ws_event.get("bytes")
            text_payload = ws_event.get("text")

            if binary_payload is not None:
                try:
                    envelope = decode_binary_frame_envelope(binary_payload)
                except BinaryFrameParseError as exc:
                    await send_payload(make_error("INVALID_FRAME_BINARY", str(exc)))
                    continue

                add_result = frame_buffer.add_frame(envelope.meta, envelope.jpeg_bytes)
                frame_arrival_event.set()

                _ws_runtime.frames_buffered += 1
                _ws_runtime.frames_evicted += add_result.evicted_on_insert

                frame_now_ms = _current_time_ms()
                attention_active = attention.is_active(now_ms=frame_now_ms)

                if (
                    add_result.stats.added <= 5
                    or add_result.stats.added % 25 == 0
                    or add_result.evicted_on_insert > 0
                ):
                    print(
                        "[vision] frame_buffer: "
                        f"depth={add_result.stats.depth}/{add_result.stats.max_frames} "
                        f"added={add_result.stats.added} "
                        f"evicted={add_result.stats.evicted} "
                        f"attention_active={attention_active}"
                    )

                events: list[dict[str, object]] = []

                try:
                    scene_caption_emission = await _build_scene_caption_event(
                        caption_cfg=cfg.caption,
                        caption_runtime=caption_runtime,
                        semantic_cfg=cfg.semantic,
                        semantic_runtime=semantic_runtime,
                        surprise_tracker=surprise_tracker,
                        attention=attention,
                        caption_state=caption_state,
                        frame_jpeg_bytes=envelope.jpeg_bytes,
                        now_ms=frame_now_ms,
                    )
                except Exception as exc:
                    _ws_runtime.scene_caption_errors += 1
                    if cfg.semantic.enabled:
                        _ws_runtime.semantic_errors += 1
                    await send_payload(
                        make_error(
                            "CAPTION_FAILED",
                            f"Caption generation failed: {exc}",
                            frame_id=envelope.meta.frame_id,
                        )
                    )
                    scene_caption_emission = None

                if scene_caption_emission is not None:
                    events.append(scene_caption_emission.event)
                    semantic_payload = scene_caption_emission.event["data"].get("semantic")
                    print(
                        "[vision] scene_caption emitted: "
                        f"frame_id={envelope.meta.frame_id} "
                        f"latency_ms={scene_caption_emission.event['data']['latency_ms']} "
                        f"text={scene_caption_emission.event['data']['text']!r} "
                        f"semantic_surprise={semantic_payload['surprise'] if isinstance(semantic_payload, dict) else 'n/a'} "
                        f"should_escalate={scene_caption_emission.should_escalate}"
                    )

                    asyncio.create_task(
                        _forward_event_to_executive(
                            executive_client=executive_client,
                            frame_id=envelope.meta.frame_id,
                            event=scene_caption_emission.event,
                        )
                    )

                    if scene_caption_emission.should_escalate and attention_active:
                        maybe_start_insight(envelope.meta.frame_id)

                await send_payload(
                    make_frame_events(
                        frame_id=envelope.meta.frame_id,
                        ts_ms=envelope.meta.ts_ms,
                        width=envelope.meta.width,
                        height=envelope.meta.height,
                        events=events,
                    )
                )
                continue

            if isinstance(text_payload, str):
                try:
                    parsed_payload = json.loads(text_payload)
                except json.JSONDecodeError:
                    await send_payload(make_error("INVALID_JSON", "Expected valid JSON payload."))
                    continue

                frame_id: str | None = None
                if isinstance(parsed_payload, dict):
                    frame_id_value = parsed_payload.get("frame_id")
                    frame_id = frame_id_value if isinstance(frame_id_value, str) else None

                    if parsed_payload.get("type") == "command":
                        try:
                            command = parse_command_payload(parsed_payload)
                        except CommandParseError as exc:
                            await send_payload(make_error("INVALID_COMMAND", str(exc), frame_id=frame_id))
                            continue

                        if command.name == "attention_start":
                            now_ms = int(time.time() * 1000)
                            active_until_ms = attention.activate(now_ms=now_ms)
                            _ws_runtime.attention_start_count += 1
                            _ws_runtime.last_attention_start_ts_ms = now_ms

                            print(
                                "[vision] attention_start: "
                                f"active_until_ms={active_until_ms} "
                                f"window_ms={attention.window_ms} "
                                f"buffer_depth={frame_buffer.stats().depth}"
                            )
                            continue

                        if command.name == "insight_test":
                            latest_frame = frame_buffer.get_latest()
                            if latest_frame is not None:
                                started = maybe_start_insight(latest_frame.frame_id, force=True)
                                if not started:
                                    await send_payload(
                                        make_error(
                                            "INSIGHT_BUSY",
                                            "Insight test ignored: an insight request is already in flight.",
                                            frame_id=latest_frame.frame_id,
                                        )
                                    )
                                    continue

                                print(
                                    "[vision] insight_test: "
                                    f"trigger_frame_id={latest_frame.frame_id} "
                                    f"buffer_depth={frame_buffer.stats().depth}"
                                )
                                continue

                            if executive_client is None:
                                await send_payload(
                                    make_error(
                                        "EXECUTIVE_UNAVAILABLE",
                                        "Insight test failed: executive client is unavailable.",
                                        frame_id=frame_id,
                                    )
                                )
                                continue

                            existing_clip = await asyncio.to_thread(
                                _collect_existing_asset_clip_for_test,
                                assets_dir=clip_assets.assets_dir,
                                max_frames=cfg.insight.max_frames,
                            )
                            if existing_clip is None:
                                await send_payload(
                                    make_error(
                                        "INSIGHT_TEST_UNAVAILABLE",
                                        "Insight test needs buffered frames or existing clip assets.",
                                        frame_id=frame_id,
                                    )
                                )
                                continue

                            trigger_frame_id, insight_frames = existing_clip
                            clip_id = f"insight-test-{uuid4()}"
                            _ws_runtime.insight_requested += 1

                            print(
                                "[vision] insight_test using existing clip assets: "
                                f"clip_id={clip_id} "
                                f"frame_count={len(insight_frames)}"
                            )

                            await _request_and_emit_insight(
                                executive_client=executive_client,
                                clip_id=clip_id,
                                trigger_frame_id=trigger_frame_id,
                                insight_frames=insight_frames,
                                send_payload=send_payload,
                            )
                            continue

                        await send_payload(
                            make_error(
                                "UNSUPPORTED_COMMAND",
                                f"Unsupported command: {command.name}",
                                frame_id=frame_id,
                            )
                        )
                        continue

                await send_payload(
                    make_error(
                        "FRAME_BINARY_REQUIRED",
                        "Vision expects binary frame payloads on /infer.",
                        frame_id=frame_id,
                    )
                )
                continue

            await send_payload(make_error("INVALID_PAYLOAD", "Unsupported WebSocket payload."))
    except WebSocketDisconnect:
        pass
    finally:
        if insight_state.in_flight_task is not None and not insight_state.in_flight_task.done():
            insight_state.in_flight_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await insight_state.in_flight_task

        _ws_runtime.active_connections = max(0, _ws_runtime.active_connections - 1)
        final_stats = frame_buffer.stats()
        print(
            "[vision] /infer disconnected: "
            f"active_connections={_ws_runtime.active_connections} "
            f"buffer_added={final_stats.added} "
            f"buffer_evicted={final_stats.evicted} "
            f"attention_active={attention.is_active()} "
            f"scene_caption_emitted={_ws_runtime.scene_caption_emitted} "
            f"scene_caption_dedupe_suppressed={_ws_runtime.scene_caption_dedupe_suppressed} "
            f"scene_caption_cooldown_skipped={_ws_runtime.scene_caption_cooldown_skipped} "
            f"semantic_embeddings={_ws_runtime.semantic_embeddings} "
            f"escalate_decisions={_ws_runtime.insight_decision_escalate_count} "
            f"insight_requested={_ws_runtime.insight_requested} "
            f"insight_emitted={_ws_runtime.insight_emitted} "
            f"insight_cooldown_skipped={_ws_runtime.insight_cooldown_skipped} "
            f"insight_busy_skipped={_ws_runtime.insight_busy_skipped} "
            f"insight_errors={_ws_runtime.insight_errors} "
            f"executive_events_forwarded={_ws_runtime.executive_events_forwarded} "
            f"executive_events_failed={_ws_runtime.executive_events_failed}"
        )
