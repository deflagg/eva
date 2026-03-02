from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from dynaconf import Dynaconf

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True, slots=True)
class ServerConfig:
    host: str
    port: int


@dataclass(frozen=True, slots=True)
class ExecutiveConfig:
    base_url: str
    timeout_ms: int


@dataclass(frozen=True, slots=True)
class AttentionConfig:
    window_ms: int


@dataclass(frozen=True, slots=True)
class CaptionConfig:
    enabled: bool
    model_id: str
    device: str
    max_dim: int
    max_new_tokens: int
    cooldown_ms: int
    dedupe_window_ms: int


@dataclass(frozen=True, slots=True)
class SemanticConfig:
    enabled: bool
    model_id: str
    device: str
    history_size: int


@dataclass(frozen=True, slots=True)
class SurpriseConfig:
    threshold: float


@dataclass(frozen=True, slots=True)
class InsightRetentionConfig:
    max_clips: int
    max_age_hours: int


@dataclass(frozen=True, slots=True)
class InsightConfig:
    enabled: bool
    pre_frames: int
    post_frames: int
    max_frames: int
    cooldown_ms: int
    post_wait_ms: int
    assets_dir: Path
    retention: InsightRetentionConfig


@dataclass(frozen=True, slots=True)
class AppConfig:
    server: ServerConfig
    executive: ExecutiveConfig
    attention: AttentionConfig
    caption: CaptionConfig
    semantic: SemanticConfig
    surprise: SurpriseConfig
    insight: InsightConfig


_app_config_cache: AppConfig | None = None


def _config_error(key: str, message: str) -> RuntimeError:
    return RuntimeError(f"Vision config error: {key} {message}")


def _read_non_empty_string(settings: Dynaconf, key: str, default: str) -> str:
    raw_value = settings.get(key, default=default)
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise _config_error(key, "must be a non-empty string")

    return raw_value.strip()


def _read_bool(settings: Dynaconf, key: str, default: bool) -> bool:
    raw_value = settings.get(key, default=default)

    if isinstance(raw_value, bool):
        return raw_value

    if isinstance(raw_value, str):
        normalized = raw_value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False

    raise _config_error(key, "must be a boolean")


def _read_int(
    settings: Dynaconf,
    key: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw_value = settings.get(key, default=default)

    if isinstance(raw_value, bool):
        raise _config_error(key, "must be an integer")

    parsed_value: int
    if isinstance(raw_value, int):
        parsed_value = raw_value
    elif isinstance(raw_value, str):
        stripped = raw_value.strip()
        if stripped and stripped.lstrip("+-").isdigit():
            parsed_value = int(stripped)
        else:
            raise _config_error(key, "must be an integer")
    else:
        raise _config_error(key, "must be an integer")

    if minimum is not None and parsed_value < minimum:
        raise _config_error(key, f"must be >= {minimum}")

    if maximum is not None and parsed_value > maximum:
        raise _config_error(key, f"must be <= {maximum}")

    return parsed_value


def _read_float(
    settings: Dynaconf,
    key: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    raw_value = settings.get(key, default=default)

    if isinstance(raw_value, bool):
        raise _config_error(key, "must be a number")

    parsed_value: float
    if isinstance(raw_value, (int, float)):
        parsed_value = float(raw_value)
    elif isinstance(raw_value, str):
        stripped = raw_value.strip()
        try:
            parsed_value = float(stripped)
        except ValueError as exc:
            raise _config_error(key, "must be a number") from exc
    else:
        raise _config_error(key, "must be a number")

    if minimum is not None and parsed_value < minimum:
        raise _config_error(key, f"must be >= {minimum}")

    if maximum is not None and parsed_value > maximum:
        raise _config_error(key, f"must be <= {maximum}")

    return parsed_value


def _read_device(settings: Dynaconf, key: str, default: str) -> str:
    value = _read_non_empty_string(settings, key, default).lower()
    if value not in {"auto", "cuda", "cpu"}:
        raise _config_error(key, "must be one of: auto|cuda|cpu")

    return value


def _read_assets_dir(settings: Dynaconf, key: str, default: str) -> Path:
    raw_path = _read_non_empty_string(settings, key, default)
    parsed_path = Path(raw_path).expanduser()
    if not parsed_path.is_absolute():
        parsed_path = (BASE_DIR / parsed_path).resolve()

    return parsed_path


def _load_dynaconf() -> Dynaconf:
    return Dynaconf(
        settings_files=[
            str(BASE_DIR / "settings.yaml"),
            str(BASE_DIR / "settings.local.yaml"),
        ],
        merge_enabled=True,
        environments=False,
        load_dotenv=False,
    )


def _build_app_config(settings: Dynaconf) -> AppConfig:
    server = ServerConfig(
        host=_read_non_empty_string(settings, "server.host", "127.0.0.1"),
        port=_read_int(settings, "server.port", 8792, minimum=1, maximum=65_535),
    )

    executive = ExecutiveConfig(
        base_url=_read_non_empty_string(settings, "executive.base_url", "http://127.0.0.1:8791"),
        timeout_ms=_read_int(settings, "executive.timeout_ms", 2_000, minimum=1),
    )

    attention = AttentionConfig(
        window_ms=_read_int(settings, "attention.window_ms", 15_000, minimum=1),
    )

    caption = CaptionConfig(
        enabled=_read_bool(settings, "caption.enabled", True),
        model_id=_read_non_empty_string(settings, "caption.model_id", "Salesforce/blip-image-captioning-base"),
        device=_read_device(settings, "caption.device", "cuda"),
        max_dim=_read_int(settings, "caption.max_dim", 384, minimum=1),
        max_new_tokens=_read_int(settings, "caption.max_new_tokens", 24, minimum=1),
        cooldown_ms=_read_int(settings, "caption.cooldown_ms", 2_000, minimum=1),
        dedupe_window_ms=_read_int(settings, "caption.dedupe_window_ms", 15_000, minimum=1),
    )

    semantic = SemanticConfig(
        enabled=_read_bool(settings, "semantic.enabled", True),
        model_id=_read_non_empty_string(settings, "semantic.model_id", "openai/clip-vit-base-patch32"),
        device=_read_device(settings, "semantic.device", "auto"),
        history_size=_read_int(settings, "semantic.history_size", 64, minimum=1),
    )

    surprise = SurpriseConfig(
        threshold=_read_float(settings, "surprise.threshold", 0.35, minimum=0, maximum=1),
    )

    insight_retention = InsightRetentionConfig(
        max_clips=_read_int(settings, "insight.retention.max_clips", 200, minimum=1),
        max_age_hours=_read_int(settings, "insight.retention.max_age_hours", 24, minimum=1),
    )

    insight = InsightConfig(
        enabled=_read_bool(settings, "insight.enabled", True),
        pre_frames=_read_int(settings, "insight.pre_frames", 2, minimum=0),
        post_frames=_read_int(settings, "insight.post_frames", 2, minimum=0),
        max_frames=_read_int(settings, "insight.max_frames", 6, minimum=1),
        cooldown_ms=_read_int(settings, "insight.cooldown_ms", 30_000, minimum=1),
        post_wait_ms=_read_int(settings, "insight.post_wait_ms", 400, minimum=0),
        assets_dir=_read_assets_dir(settings, "insight.assets_dir", "assets/insights"),
        retention=insight_retention,
    )

    return AppConfig(
        server=server,
        executive=executive,
        attention=attention,
        caption=caption,
        semantic=semantic,
        surprise=surprise,
        insight=insight,
    )


def load_app_config(*, force_reload: bool = False) -> AppConfig:
    global _app_config_cache

    if force_reload or _app_config_cache is None:
        settings = _load_dynaconf()
        _app_config_cache = _build_app_config(settings)

    return _app_config_cache


def config_summary(config: AppConfig) -> dict[str, object]:
    return {
        "server": {
            "host": config.server.host,
            "port": config.server.port,
        },
        "executive": {
            "base_url": config.executive.base_url,
            "timeout_ms": config.executive.timeout_ms,
        },
        "attention": {
            "window_ms": config.attention.window_ms,
        },
        "caption": {
            "enabled": config.caption.enabled,
            "model_id": config.caption.model_id,
            "device": config.caption.device,
            "max_dim": config.caption.max_dim,
            "max_new_tokens": config.caption.max_new_tokens,
            "cooldown_ms": config.caption.cooldown_ms,
            "dedupe_window_ms": config.caption.dedupe_window_ms,
        },
        "semantic": {
            "enabled": config.semantic.enabled,
            "model_id": config.semantic.model_id,
            "device": config.semantic.device,
            "history_size": config.semantic.history_size,
        },
        "surprise": {
            "threshold": config.surprise.threshold,
        },
        "insight": {
            "enabled": config.insight.enabled,
            "pre_frames": config.insight.pre_frames,
            "post_frames": config.insight.post_frames,
            "max_frames": config.insight.max_frames,
            "cooldown_ms": config.insight.cooldown_ms,
            "post_wait_ms": config.insight.post_wait_ms,
            "assets_dir": str(config.insight.assets_dir),
            "retention": {
                "max_clips": config.insight.retention.max_clips,
                "max_age_hours": config.insight.retention.max_age_hours,
            },
        },
    }
