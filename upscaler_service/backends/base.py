from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]


class BackendError(Exception):
    pass


class BackendNotReadyError(BackendError):
    pass


class BackendCancelledError(BackendError):
    pass


class BackendMemoryBudgetError(BackendError):
    def __init__(self, message: str, *, payload: Optional[dict] = None):
        super().__init__(message)
        self.payload = payload or {}


@dataclass(frozen=True)
class BackendModelSpec:
    key: str
    backend_model_name: str
    file_name: str
    url: str
    sha256: str
    architecture: str
    model_scale: int
    output_scale: int
    native_scale: int
    downscaled_from_native: bool


@dataclass(frozen=True)
class BackendRunResult:
    output_path: Path
    backend_model_name: str
    native_scale: int
    downscaled_from_native: bool
    output_kind: str = 'file'
    output_width: Optional[int] = None
    output_height: Optional[int] = None
    output_channels: Optional[int] = None
    output_dtype: Optional[str] = None
    output_mode: Optional[str] = None


class UpscalerBackend(ABC):
    name = 'unknown'

    @abstractmethod
    def start(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def prepare_models(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def health(self) -> dict:
        raise NotImplementedError

    def plan_job(self, *, job, image_info: dict) -> dict:
        return {}

    @abstractmethod
    def submit(
        self,
        *,
        job,
        staged_path: Path,
        output_path: Path,
        image_info: dict,
        progress_callback: ProgressCallback,
        cancel_callback: CancelCallback,
    ) -> BackendRunResult:
        raise NotImplementedError

    @abstractmethod
    def cancel(self, job) -> None:
        raise NotImplementedError

    @abstractmethod
    def serialize_job(self, job, *, queue_position: Optional[int]) -> dict:
        raise NotImplementedError
