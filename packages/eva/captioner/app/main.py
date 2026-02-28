from __future__ import annotations

import io
import time
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError

from .settings import settings

app = FastAPI(title="captioner", version="0.1.0")


class RequestBodyTooLargeError(Exception):
    def __init__(self, max_body_bytes: int):
        super().__init__(f"Request body exceeded max_body_bytes ({max_body_bytes})")
        self.max_body_bytes = max_body_bytes


@dataclass(slots=True)
class CaptionSettings:
    enabled: bool
    model_id: str
    device: str
    max_dim: int
    max_new_tokens: int
    max_body_bytes: int


@dataclass(slots=True)
class CaptionRuntime:
    model_id: str
    requested_device: str
    resolved_device: str
    torch_module: Any
    processor: Any
    model: Any


_caption_settings: CaptionSettings | None = None
_caption_runtime: CaptionRuntime | None = None
_last_latency_ms: int | None = None


def _read_bool(key: str, default: bool) -> bool:
    raw_value = settings.get(key, default=default)
    if isinstance(raw_value, bool):
        return raw_value

    raise RuntimeError(f"Captioner config error: {key} must be a boolean")


def _read_non_empty_string(key: str, default: str) -> str:
    raw_value = settings.get(key, default=default)
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise RuntimeError(f"Captioner config error: {key} must be a non-empty string")

    return raw_value.strip()


def _read_positive_int(key: str, default: int) -> int:
    raw_value = settings.get(key, default=default)

    if isinstance(raw_value, bool):
        raise RuntimeError(f"Captioner config error: {key} must be a positive integer")

    if isinstance(raw_value, int):
        parsed_value = raw_value
    elif isinstance(raw_value, str) and raw_value.strip().isdigit():
        parsed_value = int(raw_value.strip())
    else:
        raise RuntimeError(f"Captioner config error: {key} must be a positive integer")

    if parsed_value <= 0:
        raise RuntimeError(f"Captioner config error: {key} must be a positive integer")

    return parsed_value


def _read_device(key: str, default: str) -> str:
    value = _read_non_empty_string(key, default).lower()
    if value not in {"auto", "cuda", "cpu"}:
        raise RuntimeError(f"Captioner config error: {key} must be one of: auto|cuda|cpu")

    return value


def load_caption_settings() -> CaptionSettings:
    return CaptionSettings(
        enabled=_read_bool("caption.enabled", True),
        model_id=_read_non_empty_string("caption.model_id", "Salesforce/blip-image-captioning-base"),
        device=_read_device("caption.device", "cuda"),
        max_dim=_read_positive_int("caption.max_dim", 384),
        max_new_tokens=_read_positive_int("caption.max_new_tokens", 24),
        max_body_bytes=_read_positive_int("caption.max_body_bytes", 1_048_576),
    )


def make_error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
            }
        },
    )


async def read_request_body_with_limit(request: Request, max_body_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total_bytes = 0

    async for chunk in request.stream():
        chunk_size = len(chunk)
        total_bytes += chunk_size
        if total_bytes > max_body_bytes:
            raise RequestBodyTooLargeError(max_body_bytes)

        if chunk_size > 0:
            chunks.append(chunk)

    return b"".join(chunks)


def _resolve_device(torch_module: Any, requested_device: str) -> str:
    cuda_available = bool(torch_module.cuda.is_available())

    if requested_device == "auto":
        return "cuda" if cuda_available else "cpu"

    if requested_device == "cuda" and not cuda_available:
        print("[captioner] requested device=cuda but CUDA is unavailable; falling back to cpu")
        return "cpu"

    return requested_device


def _load_caption_runtime(cfg: CaptionSettings) -> CaptionRuntime:
    try:
        import torch
        from transformers import BlipForConditionalGeneration, BlipProcessor
    except Exception as exc:  # pragma: no cover - import-time dependency failures are environment-specific
        raise RuntimeError(f"Missing caption model dependencies: {exc}") from exc

    resolved_device = _resolve_device(torch, cfg.device)

    print(
        "[captioner] loading model: "
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


def _generate_caption(cfg: CaptionSettings, runtime: CaptionRuntime, jpeg_bytes: bytes) -> tuple[str, int]:
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as decoded:
            image = decoded.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Request body must be a valid JPEG image.") from exc

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


def _get_caption_settings() -> CaptionSettings:
    global _caption_settings

    if _caption_settings is None:
        _caption_settings = load_caption_settings()

    return _caption_settings


def _get_caption_runtime() -> CaptionRuntime | None:
    return _caption_runtime


@app.on_event("startup")
async def on_startup() -> None:
    global _caption_settings, _caption_runtime

    try:
        _caption_settings = load_caption_settings()
    except Exception as exc:
        raise RuntimeError(f"Captioner startup failed: {exc}") from exc

    _caption_runtime = None

    if _caption_settings.enabled:
        try:
            _caption_runtime = _load_caption_runtime(_caption_settings)
        except Exception as exc:
            raise RuntimeError(f"Captioner startup failed: {exc}") from exc

    print(
        "[captioner] config: "
        f"enabled={_caption_settings.enabled} "
        f"model_id={_caption_settings.model_id} "
        f"device={_caption_settings.device} "
        f"max_dim={_caption_settings.max_dim} "
        f"max_new_tokens={_caption_settings.max_new_tokens} "
        f"max_body_bytes={_caption_settings.max_body_bytes}"
    )


@app.get("/health")
async def health() -> dict[str, object]:
    cfg = _get_caption_settings()
    runtime = _get_caption_runtime()
    return {
        "service": "captioner",
        "status": "ok",
        "caption_enabled": cfg.enabled,
        "model_id": cfg.model_id,
        "requested_device": cfg.device,
        "resolved_device": runtime.resolved_device if runtime is not None else None,
        "model_loaded": runtime is not None,
        "max_dim": cfg.max_dim,
        "max_new_tokens": cfg.max_new_tokens,
        "max_body_bytes": cfg.max_body_bytes,
        "last_latency_ms": _last_latency_ms,
    }


@app.post("/caption")
async def caption(request: Request) -> JSONResponse:
    global _last_latency_ms

    cfg = _get_caption_settings()

    if not cfg.enabled:
        return make_error_response(503, "CAPTION_DISABLED", "Captioning is disabled by configuration.")

    runtime = _get_caption_runtime()
    if runtime is None:
        return make_error_response(503, "MODEL_NOT_READY", "Caption model is not loaded.")

    content_type_header = request.headers.get("content-type", "")
    content_type = content_type_header.split(";", 1)[0].strip().lower()

    if content_type != "image/jpeg":
        return make_error_response(
            415,
            "UNSUPPORTED_CONTENT_TYPE",
            "Caption endpoint expects Content-Type: image/jpeg.",
        )

    try:
        body = await read_request_body_with_limit(request, cfg.max_body_bytes)
    except RequestBodyTooLargeError as exc:
        return make_error_response(413, "PAYLOAD_TOO_LARGE", str(exc))

    if len(body) == 0:
        return make_error_response(400, "EMPTY_BODY", "Request body must contain JPEG bytes.")

    try:
        text, latency_ms = _generate_caption(cfg, runtime, body)
    except ValueError as exc:
        return make_error_response(400, "INVALID_IMAGE", str(exc))
    except Exception as exc:
        return make_error_response(500, "CAPTION_FAILED", f"Caption generation failed: {exc}")

    _last_latency_ms = latency_ms

    return JSONResponse(
        status_code=200,
        content={
            "text": text,
            "latency_ms": latency_ms,
            "model": runtime.model_id,
        },
    )
