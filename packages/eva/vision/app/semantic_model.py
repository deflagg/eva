from __future__ import annotations

import io
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, UnidentifiedImageError

from .config import SemanticConfig


@dataclass(slots=True)
class SemanticRuntime:
    model_id: str
    requested_device: str
    resolved_device: str
    torch_module: Any
    processor: Any
    model: Any


@dataclass(frozen=True, slots=True)
class SemanticEmbedding:
    vector: np.ndarray
    latency_ms: int
    model: str


def _resolve_device(torch_module: Any, requested_device: str) -> str:
    cuda_available = bool(torch_module.cuda.is_available())

    if requested_device == "auto":
        return "cuda" if cuda_available else "cpu"

    if requested_device == "cuda" and not cuda_available:
        print("[vision] semantic requested device=cuda but CUDA is unavailable; falling back to cpu")
        return "cpu"

    return requested_device


def load_semantic_runtime(cfg: SemanticConfig) -> SemanticRuntime:
    try:
        import torch
        from transformers import AutoProcessor, CLIPModel
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"Missing semantic model dependencies: {exc}") from exc

    resolved_device = _resolve_device(torch, cfg.device)

    print(
        "[vision] loading semantic model: "
        f"model_id={cfg.model_id} requested_device={cfg.device} resolved_device={resolved_device}"
    )

    processor = AutoProcessor.from_pretrained(cfg.model_id)
    model = CLIPModel.from_pretrained(cfg.model_id)
    model.to(resolved_device)
    model.eval()

    return SemanticRuntime(
        model_id=cfg.model_id,
        requested_device=cfg.device,
        resolved_device=resolved_device,
        torch_module=torch,
        processor=processor,
        model=model,
    )


def compute_semantic_embedding(runtime: SemanticRuntime, jpeg_bytes: bytes) -> SemanticEmbedding:
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as decoded:
            image = decoded.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Semantic model input must be a valid JPEG image.") from exc

    inputs = runtime.processor(images=image, return_tensors="pt")
    for key, value in inputs.items():
        inputs[key] = value.to(runtime.resolved_device)

    torch_module = runtime.torch_module

    if runtime.resolved_device == "cuda":
        torch_module.cuda.synchronize()

    started = time.perf_counter()
    with torch_module.inference_mode():
        image_features = runtime.model.get_image_features(**inputs)

    if runtime.resolved_device == "cuda":
        torch_module.cuda.synchronize()

    latency_ms = max(1, int(round((time.perf_counter() - started) * 1000)))

    vector = image_features[0].detach().cpu().float().numpy()
    norm = float(np.linalg.norm(vector))
    if norm > 0:
        vector = vector / norm

    return SemanticEmbedding(vector=vector, latency_ms=latency_ms, model=runtime.model_id)
