from fastapi import FastAPI

from .yolo import create_runtime

app = FastAPI(title="QuickVision", version="0.1.0")
runtime = create_runtime()


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "quickvision", "status": "stub"}


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True, "model_loaded": runtime.model_loaded}
