# QuickVision (Python daemon)

## Prerequisites

- Python 3.11

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

## Environment

- `QV_PORT` (default `8000`)
- `YOLO_MODEL_PATH` (required in later iterations for real inference)
- `YOLO_DEVICE` (`auto|cpu|cuda`, default `auto`)
