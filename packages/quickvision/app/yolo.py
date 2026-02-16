from dataclasses import dataclass


@dataclass
class YoloRuntime:
    model_loaded: bool = False


def create_runtime() -> YoloRuntime:
    return YoloRuntime(model_loaded=False)
