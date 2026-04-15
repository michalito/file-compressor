import io
import os
import threading
import time
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from upscaler_service.backends.base import BackendCancelledError, BackendMemoryBudgetError, BackendRunResult
from upscaler_service.service import (
    ArtifactRecord,
    JobRecord,
    UpscalerService,
    UpscalerServiceConfig,
    UpscalerServiceError,
)


class FakeBackend:
    name = 'torch-cpu'

    def __init__(self, *, state='ready', reason='AI upscaling service ready'):
        self.state = state
        self.reason = reason
        self.started = False

    def start(self):
        self.started = True

    def health(self):
        return {
            'backend': self.name,
            'healthy': self.state == 'ready',
            'state': self.state,
            'reason': self.reason,
            'details': {
                'cached_models': ['RealESRGAN_x2plus'],
                'cpu_threads': 4,
                'memory_limit_bytes': 2_147_483_648,
                'memory_target_bytes': 1_073_741_824,
                'memory_reserved_bytes': 805_306_368,
                'memory_soft_limit_bytes': 987_842_478,
                'memory_hard_limit_bytes': 1_041_534_771,
                'model_cache_policy': 'lru',
                'model_cache_size': 1,
            },
        }

    def plan_job(self, *, job, image_info):
        del image_info
        return {
            'backend_model_name': 'RealESRGAN_x2plus',
            'tile_size': 256,
            'estimated_peak_bytes': 268_435_456,
            'candidate_tile_sizes': [256, 128, 64],
        }

    def submit(self, *, output_path: Path, job, **kwargs):
        image = Image.new('RGB', (job.settings['scale'] * 16, job.settings['scale'] * 16), (120, 90, 60))
        image.save(output_path, format='PNG')

        return BackendRunResult(
            output_path=output_path,
            backend_model_name='RealESRGAN_x2plus',
            native_scale=job.settings['scale'],
            downscaled_from_native=False,
        )

    def cancel(self, job):
        job.phase = 'cancelling'

    def serialize_job(self, job, *, queue_position):
        payload = {
            'backend': self.name,
            'queue_position': queue_position,
            'phase': job.phase,
            'progress': job.progress,
        }
        if job.execution_plan:
            payload['estimated_peak_bytes'] = job.execution_plan.get('estimated_peak_bytes')
            payload['tile_size'] = job.execution_plan.get('tile_size')
        return payload


class BlockingBackend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.started_event = threading.Event()
        self.release_event = threading.Event()

    def submit(self, *, output_path: Path, job, cancel_callback=None, **kwargs):
        self.started_event.set()
        while not self.release_event.is_set():
            if cancel_callback and cancel_callback():
                raise BackendCancelledError('AI upscaling cancelled.')
            time.sleep(0.01)
        return super().submit(output_path=output_path, job=job, **kwargs)


class BudgetRejectingBackend(FakeBackend):
    def plan_job(self, *, job, image_info):
        del job, image_info
        raise BackendMemoryBudgetError(
            'AI upscaling would exceed the worker memory budget.',
            payload={
                'code': 'memory_budget_exceeded',
                'estimated_peak_bytes': 123456,
                'memory_limit_bytes': 654321,
                'projected_output': {'width': 8000, 'height': 8000, 'pixels': 64_000_000},
                'suggested_scale': 2,
            },
        )


def make_service(tmp_path, monkeypatch, *, backend=None):
    backend = backend or FakeBackend()
    monkeypatch.setattr('upscaler_service.service.create_backend', lambda config: backend)
    config = UpscalerServiceConfig(
        model_cache_dir=str(tmp_path / 'models'),
        work_root=str(tmp_path / 'work'),
        auto_download_models=False,
        preload_models=False,
        artifact_ttl_seconds=1,
        max_workers=1,
    )
    service = UpscalerService(config, start_cleanup_thread=False, start_backend_thread=False)
    return service, backend


def make_png_bytes(size=(32, 32), color=(30, 80, 150, 255)):
    image = Image.new('RGBA', size, color)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def make_16bit_png_bytes(size=(32, 32), value=4096):
    image = Image.new('I;16', size)
    image.putdata([value] * (size[0] * size[1]))
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def test_submit_job_rejects_when_backend_is_not_ready(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch, backend=FakeBackend(state='starting', reason='Downloading models…'))

    with pytest.raises(UpscalerServiceError) as exc:
        service.submit_job(
            file_bytes=make_png_bytes(),
            filename='demo.png',
            content_type='image/png',
            settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
        )

    assert exc.value.status_code == 503
    assert exc.value.payload['state'] == 'starting'


def test_submit_job_sanitizes_source_filename_at_worker_boundary(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)
    escaped_target = tmp_path / 'escape.png'

    created = service.submit_job(
        file_bytes=make_png_bytes(),
        filename='../../escape.png',
        content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
    )

    job = service.jobs[created['job_id']]
    assert job.source_filename == 'escape.png'
    assert job.work_dir.joinpath('escape.png').exists()
    assert not escaped_target.exists()


def test_submit_job_rejects_16bit_inputs(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)

    with pytest.raises(UpscalerServiceError) as exc:
        service.submit_job(
            file_bytes=make_16bit_png_bytes(),
            filename='sixteen-bit.png',
            content_type='image/png',
            settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
        )

    assert exc.value.status_code == 400
    assert exc.value.payload['code'] == 'unsupported_bit_depth'
    assert exc.value.payload['bit_depth'] == 16
    assert list(service.work_root.iterdir()) == []


def test_save_image_uses_balanced_lossless_png_settings(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)
    image = Image.new('RGBA', (8, 8), (10, 20, 30, 255))
    captured = {}

    def fake_save(self, fp, format=None, **kwargs):
        captured['fp'] = fp
        captured['format'] = format
        captured['kwargs'] = kwargs

    monkeypatch.setattr(Image.Image, 'save', fake_save)

    service._save_image(image, tmp_path / 'out.png', 'png', None)

    assert captured['format'] == 'PNG'
    assert captured['kwargs']['compress_level'] == 6
    assert 'optimize' not in captured['kwargs']


def test_submit_job_rejects_memory_budget_overflow_before_queueing(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch, backend=BudgetRejectingBackend())

    with pytest.raises(UpscalerServiceError) as exc:
        service.submit_job(
            file_bytes=make_png_bytes(),
            filename='demo.png',
            content_type='image/png',
            settings={'model_preset': 'photo', 'scale': 4, 'output_format': 'png', 'quality': None},
        )

    assert exc.value.status_code == 409
    assert exc.value.payload['code'] == 'memory_budget_exceeded'
    assert service.jobs == {}


def test_submit_job_completes_and_serializes_backend_metadata(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)

    created = service.submit_job(
        file_bytes=make_png_bytes(),
        filename='demo.png',
        content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
    )
    job_id = created['job_id']
    service.jobs[job_id].future.result(timeout=5)

    payload = service.serialize_job(job_id)

    assert payload['status'] == 'done'
    assert payload['backend'] == 'torch-cpu'
    assert payload['phase'] == 'done'
    assert payload['progress'] == 100
    assert payload['worker_instance_id'] == service.worker_instance_id
    assert payload['result']['metadata']['upscale']['backend_model_name'] == 'RealESRGAN_x2plus'


def test_serialize_job_includes_queue_position(tmp_path, monkeypatch):
    service, backend = make_service(tmp_path, monkeypatch)
    now = time.time()
    first = JobRecord(
        id='job-1',
        created_at=now,
        updated_at=now,
        work_dir=Path(tmp_path / 'work' / 'job-1'),
        source_filename='a.png',
        source_content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
        original_size=10,
        status='queued',
        phase='queued',
        progress=0,
        backend=backend.name,
        execution_plan={'tile_size': 256, 'estimated_peak_bytes': 268_435_456},
    )
    second = JobRecord(
        id='job-2',
        created_at=now + 1,
        updated_at=now + 1,
        work_dir=Path(tmp_path / 'work' / 'job-2'),
        source_filename='b.png',
        source_content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
        original_size=10,
        status='queued',
        phase='queued',
        progress=0,
        backend=backend.name,
        execution_plan={'tile_size': 256, 'estimated_peak_bytes': 268_435_456},
    )
    service.jobs[first.id] = first
    service.jobs[second.id] = second

    payload = service.serialize_job('job-2')

    assert payload['queue_position'] == 2
    assert payload['phase'] == 'queued'
    assert payload['progress'] == 0
    assert payload['estimated_peak_bytes'] == 268_435_456
    assert payload['tile_size'] == 256


def test_cleanup_expired_jobs_removes_artifacts_and_workdir(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)
    work_dir = service.work_root / 'expired-job'
    work_dir.mkdir(parents=True)
    output_path = work_dir / 'out.png'
    output_path.write_bytes(b'out')

    artifact = ArtifactRecord(
        id='artifact-1',
        job_id='expired-job',
        kind='download',
        filename='out.png',
        path=output_path,
        mime_type='image/png',
        size=3,
    )
    job = JobRecord(
        id='expired-job',
        created_at=time.time() - 10,
        updated_at=time.time() - 10,
        work_dir=work_dir,
        source_filename='sample.png',
        source_content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
        original_size=10,
        status='done',
        phase='done',
        completed_at=time.time() - 10,
        artifacts={artifact.id: artifact},
    )

    service.jobs[job.id] = job
    service.artifacts[artifact.id] = artifact

    service.cleanup_expired_jobs()

    assert job.id not in service.jobs
    assert artifact.id not in service.artifacts
    assert not work_dir.exists()


def test_startup_orphan_cleanup_only_removes_expired_entries(tmp_path, monkeypatch):
    backend = FakeBackend()
    monkeypatch.setattr('upscaler_service.service.create_backend', lambda config: backend)
    work_root = tmp_path / 'work'
    work_root.mkdir(parents=True, exist_ok=True)
    stale_dir = work_root / 'stale-job'
    stale_dir.mkdir()
    fresh_dir = work_root / 'fresh-job'
    fresh_dir.mkdir()
    stale_file = work_root / 'stale.tmp'
    stale_file.write_bytes(b'stale')
    fresh_file = work_root / 'fresh.tmp'
    fresh_file.write_bytes(b'fresh')

    now = time.time()
    stale_mtime = now - 7200
    os.utime(stale_dir, (stale_mtime, stale_mtime))
    os.utime(stale_file, (stale_mtime, stale_mtime))

    config = UpscalerServiceConfig(
        model_cache_dir=str(tmp_path / 'models'),
        work_root=str(work_root),
        auto_download_models=False,
        preload_models=False,
        artifact_ttl_seconds=3600,
        max_workers=1,
    )

    UpscalerService(config, start_cleanup_thread=False, start_backend_thread=False)

    assert not stale_dir.exists()
    assert not stale_file.exists()
    assert fresh_dir.exists()
    assert fresh_file.exists()


def test_get_health_includes_worker_identity(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)

    payload = service.get_health()

    assert payload['worker_instance_id'] == service.worker_instance_id
    assert payload['started_at'] == service.started_at
    assert payload['details']['memory_limit_bytes'] == 2_147_483_648


def test_create_download_bundle_builds_zip_and_cleans_up(tmp_path, monkeypatch):
    service, _ = make_service(tmp_path, monkeypatch)
    work_dir = service.work_root / 'job-1'
    work_dir.mkdir(parents=True)
    first_path = work_dir / 'first.png'
    first_path.write_bytes(b'first')
    second_path = work_dir / 'second.png'
    second_path.write_bytes(b'second')

    service.artifacts['artifact-1'] = ArtifactRecord('artifact-1', 'job-1', 'download', 'first.png', first_path, 'image/png', 5)
    service.artifacts['artifact-2'] = ArtifactRecord('artifact-2', 'job-1', 'download', 'second.png', second_path, 'image/png', 6)

    bundle = service.create_download_bundle([
        {'artifact_id': 'artifact-1', 'filename': 'first.png'},
        {'artifact_id': 'artifact-2', 'filename': 'second.png'},
    ])

    archive = zipfile.ZipFile(bundle.path)
    assert sorted(archive.namelist()) == ['first.png', 'second.png']
    assert archive.read('first.png') == b'first'
    assert archive.read('second.png') == b'second'

    bundle.cleanup()
    assert not bundle.path.exists()


def test_cancel_queued_job_removes_workdir_immediately_but_keeps_cancelled_tombstone(tmp_path, monkeypatch):
    backend = BlockingBackend()
    service, _ = make_service(tmp_path, monkeypatch, backend=backend)

    first = service.submit_job(
        file_bytes=make_png_bytes(),
        filename='first.png',
        content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
    )
    assert backend.started_event.wait(timeout=2)

    second = service.submit_job(
        file_bytes=make_png_bytes(),
        filename='second.png',
        content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
    )

    second_job = service.jobs[second['job_id']]
    assert second_job.status == 'queued'
    assert second_job.work_dir.exists()

    response = service.cancel_job(second['job_id'])

    assert response == {'job_id': second['job_id'], 'status': 'cancelled', 'phase': 'cancelled'}
    assert second_job.status == 'cancelled'
    assert second_job.phase == 'cancelled'
    assert second_job.metadata is None
    assert not second_job.work_dir.exists()

    payload = service.serialize_job(second['job_id'])
    assert payload['status'] == 'cancelled'
    assert payload['phase'] == 'cancelled'
    assert 'result' not in payload

    backend.release_event.set()
    service.jobs[first['job_id']].future.result(timeout=5)


def test_cancel_processing_job_removes_workdir_after_cooperative_cancel(tmp_path, monkeypatch):
    backend = BlockingBackend()
    service, _ = make_service(tmp_path, monkeypatch, backend=backend)

    created = service.submit_job(
        file_bytes=make_png_bytes(),
        filename='processing.png',
        content_type='image/png',
        settings={'model_preset': 'photo', 'scale': 2, 'output_format': 'png', 'quality': None},
    )
    job_id = created['job_id']
    assert backend.started_event.wait(timeout=2)

    response = service.cancel_job(job_id)
    assert response == {'job_id': job_id, 'status': 'processing', 'phase': 'cancelling'}

    service.jobs[job_id].future.result(timeout=5)
    payload = service.serialize_job(job_id)

    assert payload['status'] == 'cancelled'
    assert payload['phase'] == 'cancelled'
    assert service.jobs[job_id].metadata is None
    assert service.jobs[job_id].artifacts == {}
    assert not service.jobs[job_id].work_dir.exists()
