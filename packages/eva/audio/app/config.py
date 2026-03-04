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
class VADConfig:
    aggressiveness: int
    preroll_ms: int
    end_silence_ms: int
    min_utterance_ms: int


@dataclass(frozen=True, slots=True)
class WakeConfig:
    phrases: tuple[str, ...]
    match_mode: str
    case_sensitive: bool
    min_confidence: float


@dataclass(frozen=True, slots=True)
class GatingConfig:
    presence_window_ms: int


@dataclass(frozen=True, slots=True)
class STTConfig:
    model_id: str
    device: str
    compute_type: str
    cache_dir: Path


@dataclass(frozen=True, slots=True)
class ConversationConfig:
    active_timeout_ms: int


@dataclass(frozen=True, slots=True)
class SpeakerConfig:
    enabled: bool
    model_id: str
    device: str
    cache_dir: Path
    similarity_threshold: float
    min_check_utterance_ms: int
    max_voiced_ms: int
    short_utterance_policy: str


@dataclass(frozen=True, slots=True)
class VoiceprintsConfig:
    dir: Path
    ema_alpha: float


@dataclass(frozen=True, slots=True)
class AppConfig:
    server: ServerConfig
    executive: ExecutiveConfig
    vad: VADConfig
    wake: WakeConfig
    gating: GatingConfig
    stt: STTConfig
    conversation: ConversationConfig
    speaker: SpeakerConfig
    voiceprints: VoiceprintsConfig


_app_config_cache: AppConfig | None = None


def _config_error(key: str, message: str) -> RuntimeError:
    return RuntimeError(f"Audio config error: {key} {message}")


def _read_non_empty_string(settings: Dynaconf, key: str, default: str) -> str:
    raw_value = settings.get(key, default=default)
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise _config_error(key, "must be a non-empty string")

    return raw_value.strip()


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


def _read_bool(settings: Dynaconf, key: str, default: bool) -> bool:
    raw_value = settings.get(key, default=default)
    if isinstance(raw_value, bool):
        return raw_value

    if isinstance(raw_value, str):
        normalized = raw_value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False

    raise _config_error(key, "must be a boolean")


def _read_non_empty_string_list(settings: Dynaconf, key: str, default: list[str]) -> tuple[str, ...]:
    raw_value = settings.get(key, default=default)
    if not isinstance(raw_value, (list, tuple)):
        raise _config_error(key, "must be a non-empty list of strings")

    values: list[str] = []
    for index, item in enumerate(raw_value):
        if not isinstance(item, str) or not item.strip():
            raise _config_error(f"{key}[{index}]", "must be a non-empty string")
        values.append(item.strip())

    if not values:
        raise _config_error(key, "must contain at least one phrase")

    return tuple(values)


def _read_path(settings: Dynaconf, key: str, default: str) -> Path:
    raw_path = _read_non_empty_string(settings, key, default)
    parsed_path = Path(raw_path).expanduser()
    if not parsed_path.is_absolute():
        parsed_path = (BASE_DIR / parsed_path).resolve()

    return parsed_path


def _read_device(settings: Dynaconf, key: str, default: str) -> str:
    value = _read_non_empty_string(settings, key, default).lower()
    if value not in {"auto", "cpu", "cuda"}:
        raise _config_error(key, "must be one of: auto|cpu|cuda")

    return value


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


def _reject_legacy_wake_keys(settings: Dynaconf) -> None:
    legacy_keys = (
        "wake.provider",
        "wake.keyword_path",
        "wake.sensitivity",
        "wake.access_key_env",
        "wake.access_key",
    )

    for key in legacy_keys:
        if settings.get(key, default=None) is not None:
            raise _config_error(
                key,
                "is no longer supported (Porcupine was removed). Use wake.phrases/match_mode/case_sensitive/min_confidence.",
            )


def _build_app_config(settings: Dynaconf) -> AppConfig:
    _reject_legacy_wake_keys(settings)

    wake_match_mode = _read_non_empty_string(settings, "wake.match_mode", "word_boundary").lower()
    if wake_match_mode not in {"contains", "exact", "word_boundary"}:
        raise _config_error("wake.match_mode", "must be one of: contains|exact|word_boundary")

    short_utterance_policy = _read_non_empty_string(
        settings,
        "speaker.short_utterance_policy",
        "require_rewake",
    ).lower()
    if short_utterance_policy not in {"require_rewake", "ignore"}:
        raise _config_error("speaker.short_utterance_policy", "must be one of: require_rewake|ignore")

    return AppConfig(
        server=ServerConfig(
            host=_read_non_empty_string(settings, "server.host", "127.0.0.1"),
            port=_read_int(settings, "server.port", 8793, minimum=1, maximum=65_535),
        ),
        executive=ExecutiveConfig(
            base_url=_read_non_empty_string(settings, "executive.base_url", "http://127.0.0.1:8791"),
            timeout_ms=_read_int(settings, "executive.timeout_ms", 3_000, minimum=1),
        ),
        vad=VADConfig(
            aggressiveness=_read_int(settings, "vad.aggressiveness", 2, minimum=0, maximum=3),
            preroll_ms=_read_int(settings, "vad.preroll_ms", 200, minimum=0),
            end_silence_ms=_read_int(settings, "vad.end_silence_ms", 400, minimum=20),
            min_utterance_ms=_read_int(settings, "vad.min_utterance_ms", 300, minimum=20),
        ),
        wake=WakeConfig(
            phrases=_read_non_empty_string_list(
                settings,
                "wake.phrases",
                ["hey eva", "okay eva"],
            ),
            match_mode=wake_match_mode,
            case_sensitive=_read_bool(settings, "wake.case_sensitive", False),
            min_confidence=_read_float(settings, "wake.min_confidence", 0.0, minimum=0, maximum=1),
        ),
        gating=GatingConfig(
            presence_window_ms=_read_int(settings, "gating.presence_window_ms", 1_500, minimum=1),
        ),
        stt=STTConfig(
            model_id=_read_non_empty_string(settings, "stt.model_id", "small.en"),
            device=_read_device(settings, "stt.device", "cpu"),
            compute_type=_read_non_empty_string(settings, "stt.compute_type", "int8"),
            cache_dir=_read_path(settings, "stt.cache_dir", "../memory/models/whisper"),
        ),
        conversation=ConversationConfig(
            active_timeout_ms=_read_int(settings, "conversation.active_timeout_ms", 25_000, minimum=1),
        ),
        speaker=SpeakerConfig(
            enabled=_read_bool(settings, "speaker.enabled", True),
            model_id=_read_non_empty_string(settings, "speaker.model_id", "speechbrain/spkrec-ecapa-voxceleb"),
            device=_read_device(settings, "speaker.device", "cpu"),
            cache_dir=_read_path(settings, "speaker.cache_dir", "../memory/models/speechbrain"),
            similarity_threshold=_read_float(settings, "speaker.similarity_threshold", 0.75, minimum=0, maximum=1),
            min_check_utterance_ms=_read_int(settings, "speaker.min_check_utterance_ms", 500, minimum=1),
            max_voiced_ms=_read_int(settings, "speaker.max_voiced_ms", 2_000, minimum=20),
            short_utterance_policy=short_utterance_policy,
        ),
        voiceprints=VoiceprintsConfig(
            dir=_read_path(settings, "voiceprints.dir", "../memory/voiceprints"),
            ema_alpha=_read_float(settings, "voiceprints.ema_alpha", 0.35, minimum=0.0001, maximum=1),
        ),
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
        "vad": {
            "aggressiveness": config.vad.aggressiveness,
            "preroll_ms": config.vad.preroll_ms,
            "end_silence_ms": config.vad.end_silence_ms,
            "min_utterance_ms": config.vad.min_utterance_ms,
        },
        "wake": {
            "phrases": list(config.wake.phrases),
            "match_mode": config.wake.match_mode,
            "case_sensitive": config.wake.case_sensitive,
            "min_confidence": config.wake.min_confidence,
        },
        "gating": {
            "presence_window_ms": config.gating.presence_window_ms,
        },
        "stt": {
            "model_id": config.stt.model_id,
            "device": config.stt.device,
            "compute_type": config.stt.compute_type,
            "cache_dir": str(config.stt.cache_dir),
        },
        "conversation": {
            "active_timeout_ms": config.conversation.active_timeout_ms,
        },
        "speaker": {
            "enabled": config.speaker.enabled,
            "model_id": config.speaker.model_id,
            "device": config.speaker.device,
            "cache_dir": str(config.speaker.cache_dir),
            "similarity_threshold": config.speaker.similarity_threshold,
            "min_check_utterance_ms": config.speaker.min_check_utterance_ms,
            "max_voiced_ms": config.speaker.max_voiced_ms,
            "short_utterance_policy": config.speaker.short_utterance_policy,
        },
        "voiceprints": {
            "dir": str(config.voiceprints.dir),
            "ema_alpha": config.voiceprints.ema_alpha,
        },
    }
