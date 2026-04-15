from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import numpy as np
from PIL import Image, ImageOps
from werkzeug.utils import secure_filename

from .backends import BackendCancelledError, BackendError, BackendMemoryBudgetError, BackendNotReadyError, create_backend


LOG = logging.getLogger(__name__)
MAX_PREVIEW_LONG_SIDE = 1600
_HEIF_OPENER_REGISTERED = False
_HEIF_OPENER_LOCK = threading.Lock()


def _read_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


def _register_heif_opener_once() -> None:
    global _HEIF_OPENER_REGISTERED
    if _HEIF_OPENER_REGISTERED:
        return

    with _HEIF_OPENER_LOCK:
        if _HEIF_OPENER_REGISTERED:
            return
        from pillow_heif import register_heif_opener
        register_heif_opener()
        _HEIF_OPENER_REGISTERED = True


class UpscalerServiceError(Exception):
    def __init__(self, message: str, status_code: int = 400, payload: Optional[dict] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


@dataclass(frozen=True)
class UpscalerServiceConfig:
    api_key: str = ''
    backend: str = 'torch-cpu'
    model_cache_dir: str = '/models'
    auto_download_models: bool = True
    preload_models: bool = False
    model_cache_size: int = 1
    cpu_threads: int = 0
    interop_threads: int = 1
    memory_limit_bytes: int = 0
    memory_target_percent: float = 0.75
    memory_reserved_bytes: int = 805306368
    work_root: str = ''
    artifact_ttl_seconds: int = 21600
    max_workers: int = 1
    cleanup_interval_seconds: int = 300

    @classmethod
    def from_env(cls):
        for deprecated in ('AI_UPSCALER_BINARY_PATH', 'AI_UPSCALER_MODELS_DIR', 'AI_UPSCALER_ENABLE_STREAMING_OUTPUT'):
            if os.getenv(deprecated):
                LOG.warning('%s is deprecated and ignored by the CPU AI upscaler backend.', deprecated)

        return cls(
            api_key=os.getenv('AI_UPSCALER_API_KEY', ''),
            backend=os.getenv('AI_UPSCALER_BACKEND', 'torch-cpu'),
            model_cache_dir=os.getenv('AI_UPSCALER_MODEL_CACHE_DIR', '/models'),
            auto_download_models=_read_bool_env('AI_UPSCALER_AUTO_DOWNLOAD_MODELS', True),
            preload_models=_read_bool_env('AI_UPSCALER_PRELOAD_MODELS', False),
            model_cache_size=int(os.getenv('AI_UPSCALER_MODEL_CACHE_SIZE', '1')),
            cpu_threads=int(os.getenv('AI_UPSCALER_CPU_THREADS', '0')),
            interop_threads=int(os.getenv('AI_UPSCALER_INTEROP_THREADS', '1')),
            memory_limit_bytes=int(os.getenv('AI_UPSCALER_MEMORY_LIMIT_BYTES', '0')),
            memory_target_percent=float(os.getenv('AI_UPSCALER_MEMORY_TARGET_PERCENT', '0.75')),
            memory_reserved_bytes=int(os.getenv('AI_UPSCALER_MEMORY_RESERVED_BYTES', '805306368')),
            work_root=os.getenv('AI_UPSCALER_WORK_ROOT', ''),
            artifact_ttl_seconds=int(os.getenv('AI_UPSCALE_ARTIFACT_TTL_SECONDS', '21600')),
            max_workers=int(os.getenv('AI_UPSCALER_MAX_WORKERS', '1')),
            cleanup_interval_seconds=int(os.getenv('AI_UPSCALER_CLEANUP_INTERVAL_SECONDS', '300')),
        )


@dataclass
class ArtifactRecord:
    id: str
    job_id: str
    kind: str
    filename: str
    path: Path
    mime_type: str
    size: int


@dataclass
class DownloadBundle:
    path: Path
    filename: str
    mime_type: str
    cleanup: Callable[[], None]


@dataclass
class JobRecord:
    id: str
    created_at: float
    updated_at: float
    work_dir: Path
    source_filename: str
    source_content_type: str
    settings: dict
    original_size: int
    status: str = 'queued'
    phase: str = 'queued'
    progress: int = 0
    backend: str = 'torch-cpu'
    backend_model_name: Optional[str] = None
    error: Optional[str] = None
    warnings: list[str] = field(default_factory=list)
    metadata: Optional[dict] = None
    artifacts: dict[str, ArtifactRecord] = field(default_factory=dict)
    future: object = None
    delete_requested: bool = False
    cancel_requested: bool = False
    cancelled_at: Optional[float] = None
    completed_at: Optional[float] = None
    staged_path: Optional[Path] = None
    image_info: Optional[dict] = None
    execution_plan: Optional[dict] = None
    worker_instance_id: Optional[str] = None


class UpscalerService:
    def __init__(
        self,
        config: Optional[UpscalerServiceConfig] = None,
        *,
        start_cleanup_thread: bool = True,
        start_backend_thread: bool = True,
    ):
        self.config = config or UpscalerServiceConfig.from_env()
        work_root = self.config.work_root or os.path.join(tempfile.gettempdir(), 'compressify-upscaler')
        self.work_root = Path(work_root)
        self.work_root.mkdir(parents=True, exist_ok=True)
        _register_heif_opener_once()
        self._cleanup_orphan_workdirs()
        self.worker_instance_id = uuid.uuid4().hex
        self.started_at = datetime.now(timezone.utc).isoformat()

        self.jobs: dict[str, JobRecord] = {}
        self.artifacts: dict[str, ArtifactRecord] = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=max(1, self.config.max_workers))
        self._cleanup_stop = threading.Event()
        self._cleanup_thread = None

        self.backend = create_backend(self.config)
        if start_backend_thread:
            self.backend.start()

        if start_cleanup_thread:
            self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
            self._cleanup_thread.start()

    def submit_job(self, *, file_bytes: bytes, filename: str, content_type: str, settings: dict) -> dict:
        self.cleanup_expired_jobs()
        health = self.get_health()
        if health.get('state') != 'ready':
            raise UpscalerServiceError(
                health.get('reason') or 'AI upscaling service is unavailable.',
                status_code=503,
                payload={
                    'backend': health.get('backend'),
                    'state': health.get('state'),
                    'details': health.get('details') or {},
                },
            )

        safe_filename = self._sanitize_source_filename(filename, content_type)
        job_id = uuid.uuid4().hex
        work_dir = self.work_root / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        input_path = work_dir / safe_filename
        input_path.write_bytes(file_bytes)

        job = JobRecord(
            id=job_id,
            created_at=time.time(),
            updated_at=time.time(),
            work_dir=work_dir,
            source_filename=safe_filename,
            source_content_type=content_type or mimetypes.guess_type(safe_filename)[0] or 'application/octet-stream',
            settings=dict(settings),
            original_size=len(file_bytes),
            backend=self.backend.name,
            worker_instance_id=self.worker_instance_id,
        )

        try:
            staged_path, image_info = self._stage_input_image(job, input_path)
            job.staged_path = staged_path
            job.image_info = image_info
            execution_plan = self.backend.plan_job(job=job, image_info=image_info)
            if execution_plan:
                execution_plan = dict(execution_plan)
                execution_plan.pop('model_spec', None)
                job.execution_plan = execution_plan
        except BackendMemoryBudgetError as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise UpscalerServiceError(str(exc), status_code=409, payload=exc.payload) from exc
        except UpscalerServiceError:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise
        except (BackendError, BackendNotReadyError) as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise UpscalerServiceError(str(exc), status_code=503) from exc

        with self.lock:
            self.jobs[job_id] = job
            job.future = self.executor.submit(self._run_job, job_id, input_path)

        return self.serialize_job(job_id)

    def serialize_job(self, job_id: str) -> dict:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise UpscalerServiceError('Job not found.', status_code=404)
            queue_position = self._queue_position_locked(job_id)
            response = {
                'job_id': job.id,
                'status': job.status,
                'created_at': job.created_at,
                'updated_at': job.updated_at,
                'error': job.error,
                'worker_instance_id': job.worker_instance_id or self.worker_instance_id,
                **self.backend.serialize_job(job, queue_position=queue_position),
            }

            if job.status == 'done' and job.metadata:
                response['result'] = {
                    'filename': job.metadata['filename'],
                    'metadata': job.metadata,
                    'warnings': list(job.warnings),
                    'artifacts': {
                        artifact.kind: {
                            'artifact_id': artifact.id,
                            'filename': artifact.filename,
                            'mime_type': artifact.mime_type,
                            'size': artifact.size,
                        }
                        for artifact in job.artifacts.values()
                    },
                }
            elif job.warnings:
                response['warnings'] = list(job.warnings)
            return response

    def cancel_job(self, job_id: str) -> dict:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise UpscalerServiceError('Job not found.', status_code=404)
            if job.status in {'done', 'error', 'cancelled', 'deleted'}:
                if job.status == 'done':
                    self._delete_job_locked(job)
                    return {'job_id': job_id, 'status': 'deleted', 'phase': 'deleted'}
                return {'job_id': job_id, 'status': job.status, 'phase': job.phase}

            job.cancel_requested = True
            job.updated_at = time.time()
            if job.status == 'queued':
                if job.future and hasattr(job.future, 'cancel') and job.future.cancel():
                    self._mark_cancelled(job)
                    return {'job_id': job_id, 'status': 'cancelled', 'phase': 'cancelled'}
                job.phase = 'cancelling'
                return {'job_id': job_id, 'status': job.status, 'phase': job.phase}

            job.phase = 'cancelling'
            self.backend.cancel(job)
        return {'job_id': job_id, 'status': 'processing', 'phase': 'cancelling'}

    def delete_job(self, job_id: str) -> dict:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise UpscalerServiceError('Job not found.', status_code=404)
            if job.status in {'queued', 'processing'}:
                job.delete_requested = True
                job.cancel_requested = True
                job.updated_at = time.time()
                if job.future and hasattr(job.future, 'cancel') and job.future.cancel():
                    self._delete_job_locked(job)
                    return {'job_id': job_id, 'status': 'deleted'}
                self.backend.cancel(job)
                return {'job_id': job_id, 'status': 'deleting'}

            self._delete_job_locked(job)
            return {'job_id': job_id, 'status': 'deleted'}

    def get_artifact(self, artifact_id: str, kind: str) -> ArtifactRecord:
        self.cleanup_expired_jobs()
        with self.lock:
            artifact = self.artifacts.get(artifact_id)
            if not artifact or artifact.kind != kind:
                raise UpscalerServiceError('Artifact not found.', status_code=404)
            return artifact

    def get_health(self, force_refresh: bool = False) -> dict:
        del force_refresh
        payload = self.backend.health()
        payload['worker_instance_id'] = self.worker_instance_id
        payload['started_at'] = self.started_at
        return payload

    def cleanup_expired_jobs(self) -> None:
        now = time.time()
        expired_ids = []
        with self.lock:
            for job_id, job in self.jobs.items():
                if job.status not in {'done', 'error', 'cancelled', 'deleted'}:
                    continue
                reference_time = job.completed_at or job.cancelled_at or job.updated_at
                if now - reference_time > self.config.artifact_ttl_seconds:
                    expired_ids.append(job_id)

            for job_id in expired_ids:
                job = self.jobs.get(job_id)
                if job:
                    self._delete_job_locked(job)

    def create_download_bundle(self, artifacts: list[dict]) -> DownloadBundle:
        if not isinstance(artifacts, list) or not artifacts:
            raise UpscalerServiceError('No AI upscaled artifacts provided.', status_code=400)

        normalized = []
        for item in artifacts:
            if not isinstance(item, dict):
                raise UpscalerServiceError('Invalid AI artifact list.', status_code=400)
            artifact_id = (item.get('artifact_id') or '').strip()
            filename = self._sanitize_download_name(item.get('filename'))
            if not artifact_id or not filename:
                raise UpscalerServiceError('Each AI artifact requires artifact_id and filename.', status_code=400)
            artifact = self.get_artifact(artifact_id, 'download')
            normalized.append((artifact, filename))

        if len(normalized) == 1:
            artifact, filename = normalized[0]
            return DownloadBundle(
                path=artifact.path,
                filename=filename,
                mime_type=artifact.mime_type,
                cleanup=lambda: None,
            )

        bundle_path = self.work_root / f'bundle-{uuid.uuid4().hex}.zip'
        with zipfile.ZipFile(bundle_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for artifact, filename in normalized:
                archive.write(artifact.path, arcname=filename)

        return DownloadBundle(
            path=bundle_path,
            filename='ai_upscaled_images.zip',
            mime_type='application/zip',
            cleanup=lambda: bundle_path.unlink(missing_ok=True),
        )

    def _run_job(self, job_id: str, input_path: Path) -> None:
        with self.lock:
            job = self.jobs[job_id]
            if job.delete_requested:
                self._delete_job_locked(job)
                return
            if job.cancel_requested:
                self._mark_cancelled(job)
                return
            job.status = 'processing'
            job.phase = 'running'
            job.progress = 3
            job.updated_at = time.time()
            staged_path = job.staged_path
            image_info = job.image_info

        try:
            if staged_path is None or image_info is None:
                staged_path, image_info = self._stage_input_image(job, input_path)
                with self.lock:
                    current_job = self.jobs.get(job_id)
                    if not current_job:
                        return
                    current_job.staged_path = staged_path
                    current_job.image_info = image_info
            backend_output_path = job.work_dir / 'backend-output'
            run_result = self.backend.submit(
                job=job,
                staged_path=staged_path,
                output_path=backend_output_path,
                image_info=image_info,
                progress_callback=lambda current, total, phase: self._update_job_progress(job_id, current, total, phase),
                cancel_callback=lambda: self._job_cancelled(job_id),
            )

            with self.lock:
                job.backend_model_name = run_result.backend_model_name
                job.progress = max(job.progress, 92)
                job.phase = 'encoding'
                job.updated_at = time.time()

            output_artifact, preview_artifact, metadata, warnings = self._finalize_artifacts(
                job,
                backend_output_path,
                image_info=image_info,
                run_result=run_result,
            )

            with self.lock:
                if job.delete_requested:
                    self._delete_job_locked(job)
                    return
                if job.cancel_requested:
                    self._mark_cancelled(job)
                    return

                job.status = 'done'
                job.phase = 'done'
                job.progress = 100
                job.updated_at = time.time()
                job.completed_at = time.time()
                job.warnings = warnings
                job.metadata = metadata
                job.artifacts = {
                    output_artifact.id: output_artifact,
                    preview_artifact.id: preview_artifact,
                }
                self.artifacts[output_artifact.id] = output_artifact
                self.artifacts[preview_artifact.id] = preview_artifact
        except BackendCancelledError:
            with self.lock:
                job = self.jobs.get(job_id)
                if not job:
                    return
                if job.delete_requested:
                    self._delete_job_locked(job)
                    return
                self._mark_cancelled(job)
        except (BackendError, BackendNotReadyError) as exc:
            with self.lock:
                job = self.jobs.get(job_id)
                if not job:
                    return
                if job.delete_requested:
                    self._delete_job_locked(job)
                    return
                if job.cancel_requested:
                    self._mark_cancelled(job)
                    return
                job.status = 'error'
                job.phase = 'error'
                job.updated_at = time.time()
                job.completed_at = time.time()
                job.error = str(exc)
        except Exception as exc:  # pragma: no cover - defensive path
            with self.lock:
                job = self.jobs.get(job_id)
                if not job:
                    return
                if job.delete_requested:
                    self._delete_job_locked(job)
                    return
                if job.cancel_requested:
                    self._mark_cancelled(job)
                    return
                job.status = 'error'
                job.phase = 'error'
                job.updated_at = time.time()
                job.completed_at = time.time()
                job.error = f'AI upscaling failed: {exc}'

    def _update_job_progress(self, job_id: str, current: int, total: int, phase: str) -> None:
        if total <= 0:
            return
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job.status != 'processing':
                return
            ratio = min(max(current / total, 0), 1)
            job.progress = max(job.progress, min(90, int(8 + ratio * 82)))
            job.phase = phase
            job.updated_at = time.time()

    def _job_cancelled(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            return bool(job and job.cancel_requested)

    def _mark_cancelled(self, job: JobRecord) -> None:
        self._cleanup_job_files_locked(job)
        job.status = 'cancelled'
        job.phase = 'cancelled'
        job.progress = 0
        job.updated_at = time.time()
        job.cancelled_at = time.time()
        job.error = None

    def _cleanup_job_files_locked(self, job: JobRecord) -> None:
        for artifact_id in list(job.artifacts.keys()):
            self.artifacts.pop(artifact_id, None)
        job.artifacts.clear()
        job.metadata = None
        job.warnings = []
        job.staged_path = None
        job.image_info = None
        shutil.rmtree(job.work_dir, ignore_errors=True)

    def _stage_input_image(self, job: JobRecord, input_path: Path):
        try:
            with Image.open(input_path) as image:
                image = ImageOps.exif_transpose(image)
                original_format = (image.format or '').upper() or Path(job.source_filename).suffix.lstrip('.').upper()
                bit_depth = self._detect_image_bit_depth(image)
                if bit_depth > 8:
                    raise UpscalerServiceError(
                        '16-bit AI upscaling inputs are not supported yet. Convert the image to 8-bit and try again.',
                        status_code=400,
                        payload={
                            'code': 'unsupported_bit_depth',
                            'user_message': '16-bit AI upscaling inputs are not supported yet. Convert the image to 8-bit and try again.',
                            'bit_depth': bit_depth,
                        },
                    )
                rgba_image = image.convert('RGBA')
                has_transparency = rgba_image.getchannel('A').getextrema()[0] < 255
                rgb_image = None if has_transparency else rgba_image.convert('RGB')

                jpeg_safe = (
                    not has_transparency
                    and original_format in {'JPEG', 'JPG'}
                    and job.settings['output_format'] == 'jpeg'
                )
                if jpeg_safe:
                    staged_path = job.work_dir / 'staged-input.jpg'
                    rgb_image.save(staged_path, format='JPEG', quality=95)
                else:
                    staged_path = job.work_dir / 'staged-input.png'
                    rgba_image.save(staged_path, format='PNG')

                return staged_path, {
                    'width': image.width,
                    'height': image.height,
                    'original_format': original_format,
                    'has_transparency': has_transparency,
                    'bit_depth': bit_depth,
                }
        except UpscalerServiceError:
            raise
        except Exception as exc:
            raise UpscalerServiceError(f'Could not decode input image: {exc}', status_code=400) from exc

    def _finalize_artifacts(self, job: JobRecord, backend_output_path: Path, *, image_info: dict, run_result) -> tuple[ArtifactRecord, ArtifactRecord, dict, list[str]]:
        output_format = job.settings['output_format']
        quality = job.settings.get('quality')
        warnings = []

        image = self._open_backend_output_image(run_result)
        preview_image = None
        try:

            if output_format == 'jpeg' and image.mode in {'RGBA', 'LA'}:
                background = Image.new('RGB', image.size, (255, 255, 255))
                alpha = image.getchannel('A')
                background.paste(image.convert('RGB'), mask=alpha)
                image = background
                warnings.append('JPEG does not support transparency — transparent areas will become white')
            elif output_format == 'jpeg':
                image = image.convert('RGB')

            output_filename = f'{Path(job.source_filename).stem}_upscaled.{self._extension_for_format(output_format)}'
            output_path = job.work_dir / output_filename
            self._save_image(image, output_path, output_format, quality)

            if max(image.size) > MAX_PREVIEW_LONG_SIDE:
                scale_ratio = MAX_PREVIEW_LONG_SIDE / max(image.size)
                preview_size = (
                    max(1, round(image.width * scale_ratio)),
                    max(1, round(image.height * scale_ratio)),
                )
                preview_image = image.resize(preview_size, Image.Resampling.LANCZOS)
            else:
                preview_image = image
            preview_format = 'png' if preview_image.mode in {'RGBA', 'LA'} else 'jpeg'
            preview_filename = f'{Path(job.source_filename).stem}_preview.{self._extension_for_format(preview_format)}'
            preview_path = job.work_dir / preview_filename
            preview_quality = 85 if preview_format == 'jpeg' else None
            self._save_image(preview_image, preview_path, preview_format, preview_quality)
        finally:
            if preview_image is not None and preview_image is not image:
                preview_image.close()
            image.close()

        output_artifact = ArtifactRecord(
            id=f'{job.id}-output',
            job_id=job.id,
            kind='download',
            filename=output_filename,
            path=output_path,
            mime_type=self._mime_type_for_format(output_format),
            size=output_path.stat().st_size,
        )
        preview_artifact = ArtifactRecord(
            id=f'{job.id}-preview',
            job_id=job.id,
            kind='preview',
            filename=preview_filename,
            path=preview_path,
            mime_type=self._mime_type_for_format(preview_format),
            size=preview_path.stat().st_size,
        )

        metadata = {
            'filename': output_filename,
            'original_size': job.original_size,
            'compressed_size': output_artifact.size,
            'original_dimensions': [image_info['width'], image_info['height']],
            'final_dimensions': [image_info['width'] * job.settings['scale'], image_info['height'] * job.settings['scale']],
            'format': output_format.upper(),
            'original_format': image_info['original_format'],
            'compression_ratio': round(output_artifact.size / job.original_size * 100, 2),
            'workflow': 'ai-upscale',
            'upscale': {
                'model_preset': job.settings['model_preset'],
                'model_name': run_result.backend_model_name,
                'backend_model_name': run_result.backend_model_name,
                'requested_scale': job.settings['scale'],
                'native_scale': run_result.native_scale,
                'downscaled_from_native': run_result.downscaled_from_native,
            },
        }
        return output_artifact, preview_artifact, metadata, warnings

    def _open_backend_output_image(self, run_result) -> Image.Image:
        if getattr(run_result, 'output_kind', 'file') == 'memmap':
            shape = (
                (run_result.output_height, run_result.output_width)
                if int(run_result.output_channels or 1) == 1
                else (run_result.output_height, run_result.output_width, run_result.output_channels)
            )
            memmap = np.memmap(
                run_result.output_path,
                mode='r',
                dtype=np.dtype(run_result.output_dtype or 'uint8'),
                shape=shape,
            )
            image = Image.fromarray(np.asarray(memmap), mode=run_result.output_mode or 'RGB')
            image.load()
            return image

        image = Image.open(run_result.output_path)
        image.load()
        return image

    def _save_image(self, image: Image.Image, path: Path, output_format: str, quality: Optional[int]) -> None:
        if output_format == 'png':
            # PNG is lossless at every compression level; use the default level
            # for a better CPU/size tradeoff on large AI-upscaled outputs.
            image.save(path, format='PNG', compress_level=6)
        elif output_format == 'webp':
            target = image
            if image.mode not in {'RGB', 'RGBA'}:
                target = image.convert('RGBA' if 'A' in image.getbands() else 'RGB')
            target.save(path, format='WEBP', quality=quality or 90, method=6)
        else:
            target = image.convert('RGB')
            target.save(path, format='JPEG', quality=quality or 92, optimize=True, progressive=True)

    def _queue_position_locked(self, job_id: str) -> Optional[int]:
        job = self.jobs.get(job_id)
        if not job or job.status != 'queued':
            return None
        queued_ids = [queued_job.id for queued_job in sorted(self.jobs.values(), key=lambda item: item.created_at) if queued_job.status == 'queued']
        try:
            return queued_ids.index(job_id) + 1
        except ValueError:
            return None

    def _delete_job_locked(self, job: JobRecord) -> None:
        self._cleanup_job_files_locked(job)
        job.status = 'deleted'
        job.phase = 'deleted'
        job.updated_at = time.time()
        self.jobs.pop(job.id, None)

    def _cleanup_loop(self) -> None:
        while not self._cleanup_stop.wait(self.config.cleanup_interval_seconds):
            self.cleanup_expired_jobs()

    def _cleanup_orphan_workdirs(self) -> None:
        stale_before = time.time() - max(1, int(self.config.artifact_ttl_seconds))
        for child in self.work_root.iterdir():
            try:
                if child.stat().st_mtime > stale_before:
                    continue
            except OSError:
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    @staticmethod
    def _extension_for_format(output_format: str) -> str:
        return 'jpg' if output_format == 'jpeg' else output_format

    @staticmethod
    def _mime_type_for_format(output_format: str) -> str:
        return 'image/jpeg' if output_format == 'jpeg' else f'image/{output_format}'

    @staticmethod
    def _sanitize_download_name(filename: str | None) -> str:
        if not filename:
            return ''
        original = Path(str(filename)).name.strip()
        sanitized = secure_filename(original)
        return sanitized or 'download'

    @staticmethod
    def _sanitize_source_filename(filename: str | None, content_type: str | None = None) -> str:
        original = Path(str(filename or '')).name.strip()
        sanitized = secure_filename(original)
        if sanitized:
            return sanitized

        extension = Path(original).suffix.strip()
        if not extension and content_type:
            extension = mimetypes.guess_extension(content_type) or ''
        extension = secure_filename(extension).lstrip('.')
        return f'upload.{extension}' if extension else 'upload'

    @staticmethod
    def _detect_image_bit_depth(image: Image.Image) -> int:
        mode = (image.mode or '').upper()
        if mode.startswith('I;16'):
            return 16

        bands = image.getbands() or ()
        for band in bands:
            try:
                sample = image.getchannel(band)
                extrema = sample.getextrema()
            except Exception:
                continue

            if isinstance(extrema, tuple):
                if max(extrema) > 255:
                    return 16
        return 8
