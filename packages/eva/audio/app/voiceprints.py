from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import VoiceprintsConfig
from .speaker import SpeakerReference

VOICEPRINT_FILE_VERSION = 1
VOICEPRINT_FILENAME = "default.json"


@dataclass(frozen=True, slots=True)
class VoiceprintRecord:
    embedding: tuple[float, ...]
    created_at_ms: int
    last_seen_ms: int
    sample_count: int


@dataclass(frozen=True, slots=True)
class VoiceprintStoreStatus:
    path: str
    loaded: bool
    reason: str | None
    sample_count: int | None
    created_at_ms: int | None
    last_seen_ms: int | None
    embedding_dims: int | None
    ema_alpha: float


class VoiceprintStore:
    def __init__(self, config: VoiceprintsConfig) -> None:
        self._dir = config.dir
        self._path = self._dir / VOICEPRINT_FILENAME
        self._ema_alpha = config.ema_alpha
        self._record: VoiceprintRecord | None = None
        self._reason: str | None = None

        self._load_from_disk()

    def status(self) -> VoiceprintStoreStatus:
        record = self._record
        return VoiceprintStoreStatus(
            path=str(self._path),
            loaded=record is not None,
            reason=self._reason,
            sample_count=record.sample_count if record else None,
            created_at_ms=record.created_at_ms if record else None,
            last_seen_ms=record.last_seen_ms if record else None,
            embedding_dims=len(record.embedding) if record else None,
            ema_alpha=self._ema_alpha,
        )

    def get_reference(self) -> SpeakerReference | None:
        if self._record is None:
            return None

        return SpeakerReference(embedding=self._record.embedding)

    def upsert_from_reference(self, *, reference: SpeakerReference, observed_at_ms: int) -> VoiceprintRecord | None:
        normalized_current = _normalize_embedding(np.asarray(reference.embedding, dtype=np.float32))
        if normalized_current is None:
            self._reason = "Current speaker reference embedding was empty or invalid."
            return None

        if self._record is None:
            next_record = VoiceprintRecord(
                embedding=tuple(float(v) for v in normalized_current.tolist()),
                created_at_ms=observed_at_ms,
                last_seen_ms=observed_at_ms,
                sample_count=1,
            )
        else:
            existing = np.asarray(self._record.embedding, dtype=np.float32)
            normalized_existing = _normalize_embedding(existing)

            if normalized_existing is None or normalized_existing.shape != normalized_current.shape:
                blended = normalized_current
            else:
                blended = self._ema_alpha * normalized_current + (1.0 - self._ema_alpha) * normalized_existing
                normalized_blended = _normalize_embedding(blended)
                blended = normalized_blended if normalized_blended is not None else normalized_current

            next_record = VoiceprintRecord(
                embedding=tuple(float(v) for v in blended.tolist()),
                created_at_ms=self._record.created_at_ms,
                last_seen_ms=observed_at_ms,
                sample_count=max(1, self._record.sample_count + 1),
            )

        try:
            self._write_record(next_record)
        except Exception as exc:
            self._reason = f"Failed to persist voiceprint: {exc}"
            return None

        self._record = next_record
        self._reason = None
        return next_record

    def _load_from_disk(self) -> None:
        if not self._path.is_file():
            self._record = None
            self._reason = "Voiceprint file not found."
            return

        try:
            raw = self._path.read_text(encoding="utf-8")
            payload = json.loads(raw)
            record = _parse_record_payload(payload)
        except Exception as exc:
            self._record = None
            self._reason = f"Failed to load voiceprint: {exc}"
            return

        self._record = record
        self._reason = None

    def _write_record(self, record: VoiceprintRecord) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)

        payload = {
            "version": VOICEPRINT_FILE_VERSION,
            "embedding": [float(v) for v in record.embedding],
            "createdAt": int(record.created_at_ms),
            "lastSeen": int(record.last_seen_ms),
            "sampleCount": int(record.sample_count),
        }

        tmp_path = self._path.with_suffix(
            f"{self._path.suffix}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
        )

        tmp_path.write_text(f"{json.dumps(payload, ensure_ascii=False)}\n", encoding="utf-8")
        tmp_path.replace(self._path)


def _parse_record_payload(payload: Any) -> VoiceprintRecord:
    if not isinstance(payload, dict):
        raise ValueError("voiceprint payload must be an object")

    version = payload.get("version")
    if version != VOICEPRINT_FILE_VERSION:
        raise ValueError(f"unsupported voiceprint version: {version}")

    embedding_raw = payload.get("embedding")
    if not isinstance(embedding_raw, list) or len(embedding_raw) == 0:
        raise ValueError("voiceprint embedding must be a non-empty list")

    embedding_values: list[float] = []
    for item in embedding_raw:
        if not isinstance(item, (int, float)):
            raise ValueError("voiceprint embedding must contain numbers")

        value = float(item)
        if not np.isfinite(value):
            raise ValueError("voiceprint embedding must contain finite numbers")

        embedding_values.append(value)

    normalized_embedding = _normalize_embedding(np.asarray(embedding_values, dtype=np.float32))
    if normalized_embedding is None:
        raise ValueError("voiceprint embedding could not be normalized")

    created_at = payload.get("createdAt")
    last_seen = payload.get("lastSeen")
    sample_count = payload.get("sampleCount")

    if not isinstance(created_at, int) or created_at < 0:
        raise ValueError("voiceprint createdAt must be a non-negative integer")
    if not isinstance(last_seen, int) or last_seen < 0:
        raise ValueError("voiceprint lastSeen must be a non-negative integer")
    if not isinstance(sample_count, int) or sample_count <= 0:
        raise ValueError("voiceprint sampleCount must be a positive integer")

    return VoiceprintRecord(
        embedding=tuple(float(v) for v in normalized_embedding.tolist()),
        created_at_ms=created_at,
        last_seen_ms=last_seen,
        sample_count=sample_count,
    )


def _normalize_embedding(vector: np.ndarray) -> np.ndarray | None:
    if vector.ndim != 1 or vector.size == 0:
        return None

    if not np.all(np.isfinite(vector)):
        return None

    norm = float(np.linalg.norm(vector))
    if norm <= 0:
        return None

    return (vector / norm).astype(np.float32)


def build_voiceprint_store(config: VoiceprintsConfig) -> VoiceprintStore:
    return VoiceprintStore(config)
