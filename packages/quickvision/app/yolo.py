from __future__ import annotations

import asyncio
import io
import os
import time
from dataclasses import dataclass

import numpy as np
from PIL import Image
from ultralytics import YOLO

from .protocol import DetectionEntry, DetectionsMessage

MODEL_LABEL = "yoloe-26"
HARD_CODED_MODEL_SOURCE = "yolo26n.pt"
VALID_DEVICES = {"auto", "cpu", "cuda"}


class YoloConfigError(RuntimeError):
    """Raised when YOLO runtime configuration is invalid."""


class FrameDecodeError(ValueError):
    """Raised when a frame payload cannot be decoded into an image."""


@dataclass(slots=True)
class LoadedYoloModel:
    model: YOLO
    model_source: str
    device: str


@dataclass(slots=True)
class InferenceFrame:
    frame_id: str
    width: int
    height: int
    image_bytes: bytes


_loaded_model: LoadedYoloModel | None = None


def _read_device_from_env() -> str:
    device = os.getenv("YOLO_DEVICE", "auto").strip().lower() or "auto"
    if device not in VALID_DEVICES:
        allowed_values = ", ".join(sorted(VALID_DEVICES))
        raise YoloConfigError(f"YOLO_DEVICE must be one of {{{allowed_values}}}, got: {device}")

    return device


def load_model() -> LoadedYoloModel:
    """Load YOLO model once from hard-coded source and device config."""
    global _loaded_model

    if _loaded_model is not None:
        return _loaded_model

    device = _read_device_from_env()

    try:
        model = YOLO(HARD_CODED_MODEL_SOURCE)
    except Exception as exc:
        raise YoloConfigError(
            f"Failed to load hardcoded YOLO model source '{HARD_CODED_MODEL_SOURCE}': {exc}"
        ) from exc

    _loaded_model = LoadedYoloModel(
        model=model,
        model_source=HARD_CODED_MODEL_SOURCE,
        device=device,
    )
    return _loaded_model


def get_loaded_model() -> LoadedYoloModel:
    if _loaded_model is None:
        raise YoloConfigError("YOLO model is not loaded. Call load_model() first.")

    return _loaded_model


def get_model_summary() -> str:
    model_state = get_loaded_model()
    resolved_ckpt = getattr(model_state.model, "ckpt_path", None)
    if isinstance(resolved_ckpt, str) and resolved_ckpt:
        return f"label={MODEL_LABEL} source={model_state.model_source} resolved={resolved_ckpt} device={model_state.device}"

    return f"label={MODEL_LABEL} source={model_state.model_source} device={model_state.device}"


def is_model_loaded() -> bool:
    return _loaded_model is not None


def _decode_frame_to_numpy(frame: InferenceFrame) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(frame.image_bytes)) as image:
            rgb = image.convert("RGB")
            return np.asarray(rgb)
    except Exception as exc:  # pragma: no cover - Pillow exception hierarchy varies
        raise FrameDecodeError("Frame image payload is not a valid JPEG image.") from exc


def _resolve_class_name(names: object, cls_id: int) -> str:
    if isinstance(names, dict):
        value = names.get(cls_id)
        return str(value) if value is not None else str(cls_id)

    if isinstance(names, (list, tuple)) and 0 <= cls_id < len(names):
        return str(names[cls_id])

    return str(cls_id)


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _run_inference_sync(frame: InferenceFrame) -> DetectionsMessage:
    model_state = get_loaded_model()
    image_np = _decode_frame_to_numpy(frame)

    predict_device = None if model_state.device == "auto" else model_state.device
    results = model_state.model.predict(source=image_np, verbose=False, device=predict_device)

    detections: list[DetectionEntry] = []

    if results:
        result = results[0]
        boxes = result.boxes

        if boxes is not None and len(boxes) > 0:
            names = getattr(result, "names", None)
            xyxy_list = boxes.xyxy.tolist()
            conf_list = boxes.conf.tolist()
            cls_list = boxes.cls.tolist()

            for raw_cls, raw_conf, raw_xyxy in zip(cls_list, conf_list, xyxy_list, strict=False):
                cls_id = int(raw_cls)
                conf = _clamp(float(raw_conf), 0.0, 1.0)

                x1_raw, y1_raw, x2_raw, y2_raw = (
                    float(raw_xyxy[0]),
                    float(raw_xyxy[1]),
                    float(raw_xyxy[2]),
                    float(raw_xyxy[3]),
                )
                x1 = _clamp(min(x1_raw, x2_raw), 0.0, float(frame.width))
                y1 = _clamp(min(y1_raw, y2_raw), 0.0, float(frame.height))
                x2 = _clamp(max(x1_raw, x2_raw), 0.0, float(frame.width))
                y2 = _clamp(max(y1_raw, y2_raw), 0.0, float(frame.height))

                detections.append(
                    DetectionEntry(
                        cls=cls_id,
                        name=_resolve_class_name(names, cls_id),
                        conf=conf,
                        box=(x1, y1, x2, y2),
                    )
                )

    return DetectionsMessage(
        frame_id=frame.frame_id,
        ts_ms=int(time.time() * 1000),
        width=frame.width,
        height=frame.height,
        model=MODEL_LABEL,
        detections=detections,
    )


async def run_inference(frame: InferenceFrame) -> DetectionsMessage:
    """Run YOLO inference in a worker thread."""
    return await asyncio.to_thread(_run_inference_sync, frame)
