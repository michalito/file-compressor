import hashlib

import pytest
import numpy as np

from upscaler_service.backends.base import BackendError, BackendModelSpec
from upscaler_service.backends.torch_cpu import TorchCPUBackend
from upscaler_service.memory import TilePlan
from upscaler_service.service import UpscalerServiceConfig


def make_backend(tmp_path):
    config = UpscalerServiceConfig(
        model_cache_dir=str(tmp_path / 'models'),
        work_root=str(tmp_path / 'work'),
        auto_download_models=True,
        preload_models=False,
        cpu_threads=4,
        interop_threads=1,
    )
    return TorchCPUBackend(config)


def test_model_registry_maps_expected_official_models():
    photo_2x = TorchCPUBackend.resolve_model_spec('photo', 2)
    photo_4x = TorchCPUBackend.resolve_model_spec('photo', 4)
    anime_2x = TorchCPUBackend.resolve_model_spec('anime', 2)
    anime_4x = TorchCPUBackend.resolve_model_spec('anime', 4)

    assert photo_2x.backend_model_name == 'RealESRGAN_x2plus'
    assert photo_4x.backend_model_name == 'RealESRGAN_x4plus'
    assert anime_2x.backend_model_name == 'RealESRGAN_x4plus_anime_6B'
    assert anime_2x.output_scale == 2
    assert anime_2x.downscaled_from_native is True
    assert anime_4x.output_scale == 4


def test_prepare_models_downloads_missing_weights_and_reuses_valid_cache(tmp_path, monkeypatch):
    content = b'fake-model-bytes'
    spec = BackendModelSpec(
        key='fake',
        backend_model_name='FakeModel',
        file_name='FakeModel.pth',
        url='https://example.com/FakeModel.pth',
        sha256=hashlib.sha256(content).hexdigest(),
        architecture='rrdb_x2',
        model_scale=2,
        output_scale=2,
        native_scale=2,
        downscaled_from_native=False,
    )
    monkeypatch.setattr('upscaler_service.backends.torch_cpu.MODEL_SPECS', {'fake': spec})

    backend = make_backend(tmp_path)
    calls = {'count': 0}

    def fake_download_model(download_spec, path):
        calls['count'] += 1
        path.write_bytes(content)

    monkeypatch.setattr(backend, '_download_model', fake_download_model)

    backend.prepare_models()
    backend.prepare_models()

    assert calls['count'] == 1
    assert (tmp_path / 'models' / 'FakeModel.pth').read_bytes() == content


def test_prepare_models_rejects_checksum_mismatch(tmp_path, monkeypatch):
    spec = BackendModelSpec(
        key='fake',
        backend_model_name='FakeModel',
        file_name='FakeModel.pth',
        url='https://example.com/FakeModel.pth',
        sha256='abc123',
        architecture='rrdb_x2',
        model_scale=2,
        output_scale=2,
        native_scale=2,
        downscaled_from_native=False,
    )
    monkeypatch.setattr('upscaler_service.backends.torch_cpu.MODEL_SPECS', {'fake': spec})

    backend = make_backend(tmp_path)
    monkeypatch.setattr(backend, '_download_model', lambda download_spec, path: path.write_bytes(b'bad-model'))

    with pytest.raises(BackendError):
        backend.prepare_models()


def test_bootstrap_sets_ready_health_after_preload(tmp_path, monkeypatch):
    content = b'fake-model-bytes'
    spec = BackendModelSpec(
        key='fake',
        backend_model_name='FakeModel',
        file_name='FakeModel.pth',
        url='https://example.com/FakeModel.pth',
        sha256=hashlib.sha256(content).hexdigest(),
        architecture='rrdb_x2',
        model_scale=2,
        output_scale=2,
        native_scale=2,
        downscaled_from_native=False,
    )
    monkeypatch.setattr('upscaler_service.backends.torch_cpu.MODEL_SPECS', {'fake': spec})

    backend = make_backend(tmp_path)
    monkeypatch.setattr(backend, '_download_model', lambda download_spec, path: path.write_bytes(content))
    monkeypatch.setattr(backend, '_configure_cpu_runtime', lambda: None)
    monkeypatch.setattr(backend, '_preload_models', lambda: None)

    backend._bootstrap()
    health = backend.health()

    assert health['healthy'] is True
    assert health['state'] == 'ready'


def test_health_exposes_memory_budget_details(tmp_path):
    backend = make_backend(tmp_path)

    health = backend.health()

    assert health['details']['memory_limit_bytes'] > 0
    assert health['details']['memory_target_bytes'] > 0
    assert health['details']['memory_soft_limit_bytes'] <= health['details']['memory_hard_limit_bytes']
    assert health['details']['model_cache_policy'] == 'lru'
    assert health['details']['model_cache_size'] == 1


def test_select_tile_plan_chooses_largest_safe_tile(tmp_path, monkeypatch):
    backend = make_backend(tmp_path)
    calls = []

    def fake_estimate(spec, image_info, tile_size):
        del spec, image_info
        calls.append(tile_size)
        estimated = 10 if tile_size == 256 else 1_000_000_000
        return TilePlan(tile_size=tile_size, estimated_peak_bytes=estimated, requires_alpha_pass=False)

    monkeypatch.setattr(backend, '_estimate_tile_plan', fake_estimate)
    backend._memory_budget = backend._memory_budget.__class__(
        limit_bytes=2_000_000_000,
        reserved_bytes=100,
        target_bytes=1_500_000_000,
        soft_limit_bytes=500_000_000,
        hard_limit_bytes=600_000_000,
    )

    plan = backend._select_tile_plan(
        TorchCPUBackend.resolve_model_spec('photo', 2),
        {'width': 2000, 'height': 2000, 'has_transparency': False, 'bit_depth': 8},
    )

    assert plan.tile_size == 256
    assert calls[:3] == [512, 384, 256]


def test_loaded_model_cache_evicts_lru_entry(tmp_path, monkeypatch):
    config = UpscalerServiceConfig(
        model_cache_dir=str(tmp_path / 'models'),
        work_root=str(tmp_path / 'work'),
        preload_models=False,
        auto_download_models=False,
        model_cache_size=1,
    )
    backend = TorchCPUBackend(config)
    backend._model_paths = {
        spec.key: tmp_path / 'models' / spec.file_name
        for spec in (
            TorchCPUBackend.resolve_model_spec('photo', 2),
            TorchCPUBackend.resolve_model_spec('photo', 4),
        )
    }
    for path in backend._model_paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'model')

    loaded = []

    def fake_load_model_bundle(spec):
        loaded.append(spec.key)
        return type('Bundle', (), {
            'spec': spec,
            'model_path': backend._model_paths[spec.key],
            'upsampler': object(),
            'estimated_bytes': 10,
        })()

    monkeypatch.setattr(backend, '_load_model_bundle', fake_load_model_bundle)

    backend._get_loaded_bundle(TorchCPUBackend.resolve_model_spec('photo', 2))
    backend._get_loaded_bundle(TorchCPUBackend.resolve_model_spec('photo', 4))

    assert loaded == ['RealESRGAN_x2plus', 'RealESRGAN_x4plus']
    assert list(backend._loaded_models.keys()) == ['RealESRGAN_x4plus']


def test_memory_budget_error_uses_soft_limit_in_message_and_payload(tmp_path):
    backend = make_backend(tmp_path)
    backend._memory_budget = backend._memory_budget.__class__(
        limit_bytes=2_147_483_648,
        reserved_bytes=805_306_368,
        target_bytes=1_006_632_960,
        soft_limit_bytes=926_102_323,
        hard_limit_bytes=976_433_971,
    )
    spec = TorchCPUBackend.resolve_model_spec('photo', 4)
    image_info = {'width': 1000, 'height': 1000, 'has_transparency': False, 'bit_depth': 8}
    execution_plan = {
        'projected_output': {'width': 4000, 'height': 4000, 'pixels': 16_000_000},
        'estimated_peak_bytes': 926_563_636,
    }

    error = backend._memory_budget_error(spec, image_info, execution_plan, None)

    assert 'This image is too large for 4x AI upscaling on the current server.' in str(error)
    assert 'Try 2x instead.' in str(error)
    assert error.payload['user_message'] == str(error)
    assert error.payload['memory_limit_bytes'] == 2_147_483_648
    assert error.payload['memory_target_bytes'] == 1_006_632_960
    assert error.payload['memory_reserved_bytes'] == 805_306_368
    assert error.payload['memory_soft_limit_bytes'] == 926_102_323
    assert error.payload['memory_hard_limit_bytes'] == 976_433_971


def test_submit_removes_failed_memmap_files_between_tile_retries(tmp_path, monkeypatch):
    backend = make_backend(tmp_path)
    backend._memory_budget = backend._memory_budget.__class__(
        limit_bytes=4_000_000_000,
        reserved_bytes=100,
        target_bytes=3_000_000_000,
        soft_limit_bytes=3_000_000_000,
        hard_limit_bytes=3_500_000_000,
    )

    class FakeInferenceMemoryLimitError(Exception):
        pass

    class FakeWriter:
        def __init__(self, path):
            self.path = path
            path.write_bytes(b'partial')

        def require_descriptor(self):
            raise AssertionError('descriptor should not be requested on failed attempts')

    fake_cv2 = type('FakeCV2', (), {
        'IMREAD_UNCHANGED': -1,
        'imread': staticmethod(lambda *_args, **_kwargs: np.zeros((16, 16, 3), dtype=np.uint8)),
    })

    class FakeUpsampler:
        tile_size = None

        @staticmethod
        def enhance_streaming(*_args, **_kwargs):
            raise FakeInferenceMemoryLimitError('memory guard')

    fake_bundle = type('FakeBundle', (), {
        'upsampler': FakeUpsampler(),
        'estimated_bytes': 10,
    })()

    monkeypatch.setattr(backend, '_get_loaded_bundle', lambda spec: fake_bundle)
    monkeypatch.setattr(backend, '_load_runtime', lambda: {
        'cv2': fake_cv2,
        'MemmapImageWriter': FakeWriter,
        'InferenceCancelledError': type('InferenceCancelledError', (Exception,), {}),
        'InferenceMemoryLimitError': FakeInferenceMemoryLimitError,
    })
    monkeypatch.setattr(backend, '_estimate_tile_plan', lambda spec, image_info, tile_size: TilePlan(
        tile_size=tile_size,
        estimated_peak_bytes=1024,
        requires_alpha_pass=False,
    ))

    job = type('Job', (), {
        'id': 'job-memmap-cleanup',
        'execution_plan': {
            'candidate_tile_sizes': [512, 256],
            'projected_output': {'width': 32, 'height': 32, 'pixels': 1024},
            'estimated_peak_bytes': 2048,
        },
        'settings': {'model_preset': 'photo', 'scale': 2},
    })()

    output_path = tmp_path / 'work' / 'backend-output'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    staged_path = tmp_path / 'work' / 'staged.png'
    staged_path.write_bytes(b'not-used')

    with pytest.raises(BackendError):
        backend.submit(
            job=job,
            staged_path=staged_path,
            output_path=output_path,
            image_info={'width': 16, 'height': 16, 'has_transparency': False, 'bit_depth': 8},
            progress_callback=lambda *_args: None,
            cancel_callback=lambda: False,
        )

    assert not output_path.with_suffix('.tile-512.memmap').exists()
    assert not output_path.with_suffix('.tile-256.memmap').exists()
