from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from .settings import settings

RepresentativePoint = Literal["centroid"]


@dataclass(slots=True)
class RoiRegion:
    name: str
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(slots=True)
class RoiLine:
    name: str
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass(slots=True)
class RoiSettings:
    enabled: bool
    representative_point: RepresentativePoint
    regions: dict[str, RoiRegion]
    lines: dict[str, RoiLine]
    dwell_default_threshold_ms: int
    dwell_region_threshold_ms: dict[str, int]
    transition_min_ms: int

    def dwell_threshold_ms_for_region(self, region_name: str) -> int:
        return self.dwell_region_threshold_ms.get(region_name, self.dwell_default_threshold_ms)


_roi_settings: RoiSettings | None = None


def _as_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False

    return default


def _as_mapping(value: Any, *, key: str) -> Mapping[str, Any]:
    if value is None:
        return {}

    if isinstance(value, Mapping):
        return value

    raise RuntimeError(f"Vision config error: {key} must be a mapping/object")


def _as_float(value: Any, *, key: str) -> float:
    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be numeric")

    if isinstance(value, (int, float)):
        return float(value)

    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            pass

    raise RuntimeError(f"Vision config error: {key} must be numeric")


def _as_non_negative_int(value: Any, *, key: str, default: int) -> int:
    if value is None:
        return default

    if isinstance(value, bool):
        raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")

    if isinstance(value, int):
        if value < 0:
            raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")
        return value

    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())

    raise RuntimeError(f"Vision config error: {key} must be a non-negative integer")


def _load_regions(raw: Any) -> tuple[dict[str, RoiRegion], dict[str, int]]:
    raw_regions = _as_mapping(raw, key="roi.regions")
    regions: dict[str, RoiRegion] = {}
    dwell_region_threshold_ms: dict[str, int] = {}

    for region_name, region_value in raw_regions.items():
        if not isinstance(region_name, str) or not region_name.strip():
            raise RuntimeError("Vision config error: roi.regions keys must be non-empty strings")

        name = region_name.strip()
        region = _as_mapping(region_value, key=f"roi.regions.{name}")
        x1 = _as_float(region.get("x1"), key=f"roi.regions.{name}.x1")
        y1 = _as_float(region.get("y1"), key=f"roi.regions.{name}.y1")
        x2 = _as_float(region.get("x2"), key=f"roi.regions.{name}.x2")
        y2 = _as_float(region.get("y2"), key=f"roi.regions.{name}.y2")

        left = min(x1, x2)
        top = min(y1, y2)
        right = max(x1, x2)
        bottom = max(y1, y2)

        if left == right or top == bottom:
            raise RuntimeError(f"Vision config error: roi.regions.{name} rectangle must have area")

        raw_region_dwell_threshold_ms = region.get("dwell_threshold_ms")
        if raw_region_dwell_threshold_ms is not None:
            dwell_region_threshold_ms[name] = _as_non_negative_int(
                raw_region_dwell_threshold_ms,
                key=f"roi.regions.{name}.dwell_threshold_ms",
                default=0,
            )

        regions[name] = RoiRegion(
            name=name,
            x1=left,
            y1=top,
            x2=right,
            y2=bottom,
        )

    return regions, dwell_region_threshold_ms


def _load_lines(raw: Any) -> dict[str, RoiLine]:
    raw_lines = _as_mapping(raw, key="roi.lines")
    lines: dict[str, RoiLine] = {}

    for line_name, line_value in raw_lines.items():
        if not isinstance(line_name, str) or not line_name.strip():
            raise RuntimeError("Vision config error: roi.lines keys must be non-empty strings")

        name = line_name.strip()
        line = _as_mapping(line_value, key=f"roi.lines.{name}")
        x1 = _as_float(line.get("x1"), key=f"roi.lines.{name}.x1")
        y1 = _as_float(line.get("y1"), key=f"roi.lines.{name}.y1")
        x2 = _as_float(line.get("x2"), key=f"roi.lines.{name}.x2")
        y2 = _as_float(line.get("y2"), key=f"roi.lines.{name}.y2")

        if x1 == x2 and y1 == y2:
            raise RuntimeError(f"Vision config error: roi.lines.{name} must not be a single point")

        lines[name] = RoiLine(
            name=name,
            x1=x1,
            y1=y1,
            x2=x2,
            y2=y2,
        )

    return lines


def _load_dwell_region_threshold_overrides(raw: Any, *, known_region_names: set[str]) -> dict[str, int]:
    raw_overrides = _as_mapping(raw, key="roi.dwell.region_threshold_ms")
    overrides: dict[str, int] = {}

    for region_name, region_value in raw_overrides.items():
        if not isinstance(region_name, str) or not region_name.strip():
            raise RuntimeError("Vision config error: roi.dwell.region_threshold_ms keys must be non-empty strings")

        name = region_name.strip()
        if name not in known_region_names:
            raise RuntimeError(
                f"Vision config error: roi.dwell.region_threshold_ms.{name} references unknown region"
            )

        overrides[name] = _as_non_negative_int(
            region_value,
            key=f"roi.dwell.region_threshold_ms.{name}",
            default=0,
        )

    return overrides


def load_roi_settings() -> RoiSettings:
    global _roi_settings

    if _roi_settings is not None:
        return _roi_settings

    enabled = _as_bool(settings.get("roi.enabled", default=True), default=True)

    representative_point_value = settings.get("roi.representative_point", default="centroid")
    representative_point = str(representative_point_value).strip().lower()
    if representative_point != "centroid":
        raise RuntimeError("Vision config error: roi.representative_point must be 'centroid'")

    regions, region_dwell_thresholds = _load_regions(settings.get("roi.regions", default={}))
    lines = _load_lines(settings.get("roi.lines", default={}))

    dwell_default_threshold_ms = _as_non_negative_int(
        settings.get("roi.dwell.default_threshold_ms", default=5000),
        key="roi.dwell.default_threshold_ms",
        default=5000,
    )

    dwell_region_threshold_overrides = _load_dwell_region_threshold_overrides(
        settings.get("roi.dwell.region_threshold_ms", default={}),
        known_region_names=set(regions.keys()),
    )

    dwell_region_threshold_ms = {
        **region_dwell_thresholds,
        **dwell_region_threshold_overrides,
    }

    transition_min_ms = _as_non_negative_int(
        settings.get("roi.transitions.min_transition_ms", default=250),
        key="roi.transitions.min_transition_ms",
        default=250,
    )

    _roi_settings = RoiSettings(
        enabled=enabled,
        representative_point="centroid",
        regions=regions,
        lines=lines,
        dwell_default_threshold_ms=dwell_default_threshold_ms,
        dwell_region_threshold_ms=dwell_region_threshold_ms,
        transition_min_ms=transition_min_ms,
    )
    return _roi_settings


def box_centroid(box: tuple[float, float, float, float]) -> tuple[float, float]:
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def point_in_region(point: tuple[float, float], region: RoiRegion) -> bool:
    x, y = point
    return region.x1 <= x <= region.x2 and region.y1 <= y <= region.y2


def line_side(point: tuple[float, float], line: RoiLine) -> Literal["A", "B"] | None:
    x, y = point
    cross = (line.x2 - line.x1) * (y - line.y1) - (line.y2 - line.y1) * (x - line.x1)

    epsilon = 1e-6
    if cross > epsilon:
        return "A"
    if cross < -epsilon:
        return "B"

    return None
