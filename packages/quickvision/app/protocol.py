from pydantic import BaseModel, ConfigDict


class HelloMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    v: int
    role: str
    ts_ms: int
