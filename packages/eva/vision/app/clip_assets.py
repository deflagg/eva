from __future__ import annotations

import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .frame_buffer import BufferedFrame

FRAME_ID_FILENAME_SANITIZE_PATTERN = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True, slots=True)
class ClipAssetRef:
    frame_id: str
    ts_ms: int
    mime: str
    asset_rel_path: str


class ClipAssetsManager:
    def __init__(self, *, assets_dir: Path, max_clips: int, max_age_hours: int):
        if max_clips < 1:
            raise ValueError("max_clips must be >= 1")

        if max_age_hours < 1:
            raise ValueError("max_age_hours must be >= 1")

        self._assets_dir = assets_dir
        self._max_clips = max_clips
        self._max_age_hours = max_age_hours

        self._assets_dir.mkdir(parents=True, exist_ok=True)

    @property
    def assets_dir(self) -> Path:
        return self._assets_dir

    def persist_clip(self, *, clip_id: str, frames: list[BufferedFrame]) -> list[ClipAssetRef]:
        if not clip_id.strip():
            raise ValueError("clip_id must be non-empty")

        if not frames:
            raise ValueError("frames must be non-empty")

        clip_dir = self._assets_dir / clip_id
        clip_dir.mkdir(parents=True, exist_ok=True)

        refs: list[ClipAssetRef] = []
        for index, frame in enumerate(frames, start=1):
            frame_id_suffix = self._sanitize_frame_id_for_filename(frame.frame_id)
            filename = f"{index:02d}-{frame_id_suffix}.jpg"
            frame_path = clip_dir / filename
            frame_path.write_bytes(frame.jpeg_bytes)

            refs.append(
                ClipAssetRef(
                    frame_id=frame.frame_id,
                    ts_ms=frame.ts_ms,
                    mime="image/jpeg",
                    asset_rel_path=f"{clip_id}/{filename}",
                )
            )

        self._prune_retention(current_clip_dir=clip_dir)
        return refs

    def _sanitize_frame_id_for_filename(self, frame_id: str) -> str:
        candidate = FRAME_ID_FILENAME_SANITIZE_PATTERN.sub("-", frame_id.strip()).strip("-_.")
        if not candidate:
            return "frame"

        return candidate[:80]

    def _prune_retention(self, *, current_clip_dir: Path) -> None:
        try:
            clip_dirs_with_mtime: list[tuple[Path, float]] = []
            for candidate in self._assets_dir.iterdir():
                if not candidate.is_dir():
                    continue

                try:
                    mtime = candidate.stat().st_mtime
                except OSError:
                    continue

                clip_dirs_with_mtime.append((candidate, mtime))
        except OSError as exc:
            print(f"[vision] warning: failed to scan clip assets for pruning: {exc}")
            return

        clip_dirs_with_mtime.sort(key=lambda item: item[1], reverse=True)

        now_seconds = time.time()
        max_age_seconds = float(self._max_age_hours) * 3600.0
        cutoff_seconds = now_seconds - max_age_seconds

        prune_targets: set[Path] = set()

        for candidate, mtime in clip_dirs_with_mtime:
            if candidate == current_clip_dir:
                continue

            if mtime < cutoff_seconds:
                prune_targets.add(candidate)

        for index, (candidate, _mtime) in enumerate(clip_dirs_with_mtime):
            if index < self._max_clips:
                continue

            if candidate == current_clip_dir:
                continue

            prune_targets.add(candidate)

        if not prune_targets:
            return

        for prune_target in sorted(prune_targets, key=lambda path_obj: path_obj.name):
            try:
                shutil.rmtree(prune_target)
            except OSError as exc:
                print(f"[vision] warning: failed to prune clip asset dir {prune_target}: {exc}")
