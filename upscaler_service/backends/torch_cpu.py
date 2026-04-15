from __future__ import annotations

import gc
import hashlib
import importlib
import logging
import os
import threading
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass, replace
from pathlib import Path

from upscaler_service.memory import (
    TilePlan,
    compute_memory_budget,
    get_process_rss_bytes,
    read_memory_limit,
)

from .base import (
    BackendCancelledError,
    BackendError,
    BackendMemoryBudgetError,
    BackendModelSpec,
    BackendNotReadyError,
    BackendRunResult,
    UpscalerBackend,
)


LOG = logging.getLogger(__name__)
DEFAULT_TILE_SIZES = (512, 384, 256, 192, 128, 96, 64)
MODEL_MEMORY_MULTIPLIER = 4


MODEL_SPECS = {
    'RealESRGAN_x2plus': BackendModelSpec(
        key='RealESRGAN_x2plus',
        backend_model_name='RealESRGAN_x2plus',
        file_name='RealESRGAN_x2plus.pth',
        url='https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
        sha256='49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb',
        architecture='rrdb_x2',
        model_scale=2,
        output_scale=2,
        native_scale=2,
        downscaled_from_native=False,
    ),
    'RealESRGAN_x4plus': BackendModelSpec(
        key='RealESRGAN_x4plus',
        backend_model_name='RealESRGAN_x4plus',
        file_name='RealESRGAN_x4plus.pth',
        url='https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
        sha256='4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1',
        architecture='rrdb_x4',
        model_scale=4,
        output_scale=4,
        native_scale=4,
        downscaled_from_native=False,
    ),
    'RealESRGAN_x4plus_anime_6B': BackendModelSpec(
        key='RealESRGAN_x4plus_anime_6B',
        backend_model_name='RealESRGAN_x4plus_anime_6B',
        file_name='RealESRGAN_x4plus_anime_6B.pth',
        url='https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth',
        sha256='f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da',
        architecture='rrdb_x4_anime_6b',
        model_scale=4,
        output_scale=4,
        native_scale=4,
        downscaled_from_native=False,
    ),
}

JOB_MODEL_MAP = {
    ('photo', 2): 'RealESRGAN_x2plus',
    ('photo', 4): 'RealESRGAN_x4plus',
    ('anime', 2): 'RealESRGAN_x4plus_anime_6B',
    ('anime', 4): 'RealESRGAN_x4plus_anime_6B',
}


def _format_bytes_compact(value: int) -> str:
    size = float(max(0, int(value)))
    units = ('bytes', 'KB', 'MB', 'GB', 'TB')
    for unit in units:
        if size < 1024 or unit == units[-1]:
            if unit == 'bytes':
                return f'{int(size):,} bytes'
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{int(value):,} bytes'


@dataclass
class LoadedModelBundle:
    spec: BackendModelSpec
    model_path: Path
    upsampler: object
    estimated_bytes: int


class TorchCPUBackend(UpscalerBackend):
    name = 'torch-cpu'

    def __init__(self, config):
        self.config = config
        self.model_cache_dir = Path(config.model_cache_dir)
        self.model_cache_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.state = 'starting'
        self.reason = 'Bootstrapping AI upscaling models…'
        self.error_details = {}
        self.cpu_threads = None
        self._runtime = None
        self._model_paths: dict[str, Path] = {}
        self._loaded_models: OrderedDict[str, LoadedModelBundle] = OrderedDict()
        self._bootstrap_thread = None
        self._memory_limit_info = read_memory_limit(config.memory_limit_bytes)
        self._memory_budget = compute_memory_budget(
            limit_bytes=self._memory_limit_info.limit_bytes,
            target_percent=config.memory_target_percent,
            reserved_bytes=config.memory_reserved_bytes,
        )

    def start(self) -> None:
        with self.lock:
            if self._bootstrap_thread:
                return
            self._bootstrap_thread = threading.Thread(target=self._bootstrap, daemon=True)
            self._bootstrap_thread.start()

    def _bootstrap(self) -> None:
        try:
            self._set_state('starting', 'Preparing CPU AI upscaling backend…')
            self.prepare_models()
            self._configure_cpu_runtime()
            if self.config.preload_models:
                self._set_state('starting', 'Preloading AI upscaling models into memory…')
                self._preload_models()
            self._set_state('ready', 'AI upscaling service ready', details={})
        except Exception as exc:  # pragma: no cover - defensive path
            LOG.exception('CPU AI upscaler bootstrap failed')
            self._set_state('error', f'Failed to initialize CPU AI upscaling backend: {exc}', details={'error': str(exc)})

    def prepare_models(self) -> None:
        prepared = {}
        for spec in MODEL_SPECS.values():
            path = self.model_cache_dir / spec.file_name
            if path.exists():
                self._verify_checksum(path, spec)
                prepared[spec.key] = path
                continue

            if not self.config.auto_download_models:
                raise BackendError(f'Missing required model file: {path}')

            self._set_state('starting', f'Downloading {spec.backend_model_name}…')
            self._download_model(spec, path)
            self._verify_checksum(path, spec)
            prepared[spec.key] = path

        with self.lock:
            self._model_paths = prepared

    def health(self) -> dict:
        with self.lock:
            return {
                'backend': self.name,
                'healthy': self.state == 'ready',
                'state': self.state,
                'reason': self.reason,
                'details': {
                    'cached_models': list(self._loaded_models.keys()),
                    'cpu_threads': self.cpu_threads or self._resolve_cpu_threads(),
                    'model_cache_dir': str(self.model_cache_dir),
                    'memory_limit_bytes': self._memory_budget.limit_bytes,
                    'memory_target_bytes': self._memory_budget.target_bytes,
                    'memory_reserved_bytes': self._memory_budget.reserved_bytes,
                    'memory_soft_limit_bytes': self._memory_budget.soft_limit_bytes,
                    'memory_hard_limit_bytes': self._memory_budget.hard_limit_bytes,
                    'memory_limit_source': self._memory_limit_info.source,
                    'model_cache_policy': 'lru',
                    'model_cache_size': max(1, int(self.config.model_cache_size)),
                    **self.error_details,
                },
            }

    def plan_job(self, *, job, image_info: dict) -> dict:
        health = self.health()
        if health['state'] == 'starting':
            raise BackendNotReadyError(health['reason'])
        if health['state'] != 'ready':
            raise BackendError(health['reason'])

        spec = self.resolve_model_spec(job.settings['model_preset'], job.settings['scale'])
        plan = self._select_tile_plan(spec, image_info)
        return {
            'backend_model_name': spec.backend_model_name,
            'tile_size': plan.tile_size,
            'estimated_peak_bytes': plan.estimated_peak_bytes,
            'requires_alpha_pass': plan.requires_alpha_pass,
            'candidate_tile_sizes': self._candidate_tile_sizes(plan.tile_size),
            'memory_limit_bytes': self._memory_budget.limit_bytes,
            'projected_output': {
                'width': image_info['width'] * job.settings['scale'],
                'height': image_info['height'] * job.settings['scale'],
                'pixels': image_info['width'] * image_info['height'] * job.settings['scale'] * job.settings['scale'],
            },
            'model_spec': spec,
        }

    def submit(self, *, job, staged_path: Path, output_path: Path, image_info: dict, progress_callback, cancel_callback) -> BackendRunResult:
        health = self.health()
        if health['state'] == 'starting':
            raise BackendNotReadyError(health['reason'])
        if health['state'] != 'ready':
            raise BackendError(health['reason'])

        execution_plan = dict(job.execution_plan or self.plan_job(job=job, image_info=image_info))
        spec = execution_plan.pop('model_spec', self.resolve_model_spec(job.settings['model_preset'], job.settings['scale']))
        bundle = self._get_loaded_bundle(spec)
        runtime = self._load_runtime()
        cv2 = runtime['cv2']
        MemmapImageWriter = runtime['MemmapImageWriter']
        InferenceCancelledError = runtime['InferenceCancelledError']
        InferenceMemoryLimitError = runtime['InferenceMemoryLimitError']
        attempts = execution_plan.get('candidate_tile_sizes') or self._candidate_tile_sizes(execution_plan['tile_size'])
        last_error = None

        for tile_size in attempts:
            if cancel_callback():
                raise BackendCancelledError('AI upscaling cancelled.')

            memmap_path = None
            try:
                image = cv2.imread(str(staged_path), cv2.IMREAD_UNCHANGED)
                if image is None:
                    raise BackendError('Could not read staged image for AI upscaling.')

                plan = self._estimate_tile_plan(spec, image_info, tile_size)
                if plan.estimated_peak_bytes > self._memory_budget.soft_limit_bytes:
                    raise InferenceMemoryLimitError(
                        f'Estimated peak memory {plan.estimated_peak_bytes} exceeds soft limit '
                        f'{self._memory_budget.soft_limit_bytes}'
                    )

                memmap_path = output_path.with_suffix(f'.tile-{tile_size}.memmap')
                memmap_path.unlink(missing_ok=True)
                writer = MemmapImageWriter(memmap_path)

                bundle.upsampler.tile_size = tile_size
                bundle.upsampler.enhance_streaming(
                    image,
                    tile_size=tile_size,
                    outscale=spec.output_scale,
                    writer=writer,
                    progress_callback=progress_callback,
                    cancel_callback=cancel_callback,
                    rss_callback=lambda: self._raise_if_rss_exceeded(),
                )
                descriptor = writer.require_descriptor()
                return BackendRunResult(
                    output_path=descriptor.path,
                    backend_model_name=spec.backend_model_name,
                    native_scale=spec.native_scale,
                    downscaled_from_native=spec.downscaled_from_native,
                    output_kind='memmap',
                    output_width=descriptor.width,
                    output_height=descriptor.height,
                    output_channels=descriptor.channels,
                    output_dtype=descriptor.dtype_name,
                    output_mode=descriptor.mode,
                )
            except InferenceCancelledError as exc:
                raise BackendCancelledError(str(exc)) from exc
            except InferenceMemoryLimitError as exc:
                if memmap_path is not None:
                    memmap_path.unlink(missing_ok=True)
                last_error = exc
                gc.collect()
                LOG.warning(
                    'AI upscaling memory guard triggered for %s with tile=%s: %s',
                    job.id,
                    tile_size,
                    exc,
                )
            except BackendCancelledError:
                raise
            except Exception as exc:
                if memmap_path is not None:
                    memmap_path.unlink(missing_ok=True)
                last_error = exc
                gc.collect()
                if not self._looks_like_memory_failure(exc) and tile_size == attempts[-1]:
                    break
                LOG.warning('AI upscaling attempt failed for %s with tile=%s: %s', job.id, tile_size, exc)

        if isinstance(last_error, InferenceMemoryLimitError):
            raise self._memory_budget_error(spec, image_info, execution_plan, last_error)
        raise BackendError(f'CPU AI upscaling failed after tile retries: {last_error}')

    def cancel(self, job) -> None:
        with self.lock:
            if job.phase in {'queued', 'running'}:
                job.phase = 'cancelling'

    def serialize_job(self, job, *, queue_position):
        payload = {
            'backend': self.name,
            'queue_position': queue_position,
            'phase': job.phase,
            'progress': job.progress,
        }
        if job.backend_model_name:
            payload['backend_model_name'] = job.backend_model_name
        if job.execution_plan:
            if job.execution_plan.get('estimated_peak_bytes') is not None:
                payload['estimated_peak_bytes'] = job.execution_plan['estimated_peak_bytes']
            if job.execution_plan.get('tile_size') is not None:
                payload['tile_size'] = job.execution_plan['tile_size']
        return payload

    @staticmethod
    def resolve_model_spec(model_preset: str, scale: int) -> BackendModelSpec:
        try:
            key = JOB_MODEL_MAP[(model_preset, scale)]
            spec = MODEL_SPECS[key]
            if model_preset == 'anime' and scale == 2:
                return replace(
                    spec,
                    output_scale=2,
                    downscaled_from_native=True,
                )
            return spec
        except KeyError as exc:
            raise BackendError(f'Unsupported AI upscaling preset/scale combination: {model_preset} {scale}x') from exc

    def _candidate_tile_sizes(self, initial_tile_size: int):
        initial = int(initial_tile_size)
        candidates = [size for size in DEFAULT_TILE_SIZES if size <= initial]
        if initial not in candidates:
            candidates.insert(0, initial)
        return tuple(dict.fromkeys(candidates))

    def _select_tile_plan(self, spec: BackendModelSpec, image_info: dict) -> TilePlan:
        for tile_size in DEFAULT_TILE_SIZES:
            plan = self._estimate_tile_plan(spec, image_info, tile_size)
            if plan.estimated_peak_bytes <= self._memory_budget.soft_limit_bytes:
                return plan
        raise self._memory_budget_error(spec, image_info, {}, None)

    def _estimate_tile_plan(self, spec: BackendModelSpec, image_info: dict, tile_size: int) -> TilePlan:
        has_alpha = bool(image_info.get('has_transparency'))
        channels = 4 if has_alpha else 3
        bytes_per_sample = 2 if image_info.get('bit_depth') == 16 else 1
        input_width = int(image_info['width'])
        input_height = int(image_info['height'])
        native_width = input_width * spec.native_scale
        native_height = input_height * spec.native_scale
        final_width = input_width * spec.output_scale
        final_height = input_height * spec.output_scale
        tile_input_size = tile_size + 2 * 10
        tile_output_size = tile_input_size * spec.native_scale

        decoded_input_bytes = input_width * input_height * 3 * 4
        if has_alpha:
            decoded_input_bytes += input_width * input_height * 4
        memmap_output_bytes = native_width * native_height * channels * bytes_per_sample
        encode_reserve = final_width * final_height * channels * bytes_per_sample
        resize_reserve = encode_reserve if spec.downscaled_from_native else 0
        tile_input_bytes = tile_input_size * tile_input_size * 3 * 4
        tile_output_float_bytes = tile_output_size * tile_output_size * 3 * 4
        tile_output_bytes = tile_output_size * tile_output_size * channels * bytes_per_sample
        alpha_pass_bytes = tile_input_bytes + tile_output_float_bytes + tile_output_bytes if has_alpha else 0
        model_bytes = self._estimate_model_footprint(spec)
        rss_baseline = get_process_rss_bytes()
        estimated_peak = (
            rss_baseline
            + decoded_input_bytes
            + memmap_output_bytes
            + encode_reserve
            + resize_reserve
            + tile_input_bytes
            + tile_output_float_bytes
            + tile_output_bytes
            + alpha_pass_bytes
            + model_bytes
        )
        return TilePlan(
            tile_size=int(tile_size),
            estimated_peak_bytes=int(estimated_peak),
            requires_alpha_pass=has_alpha,
        )

    def _memory_budget_error(self, spec: BackendModelSpec, image_info: dict, execution_plan: dict, exc) -> BackendMemoryBudgetError:
        projected_output = execution_plan.get('projected_output') or {
            'width': image_info['width'] * spec.output_scale,
            'height': image_info['height'] * spec.output_scale,
            'pixels': image_info['width'] * image_info['height'] * spec.output_scale * spec.output_scale,
        }
        estimated_peak = execution_plan.get('estimated_peak_bytes')
        if estimated_peak is None:
            estimated_peak = self._estimate_tile_plan(spec, image_info, DEFAULT_TILE_SIZES[-1]).estimated_peak_bytes

        suggested_scale = 2 if spec.output_scale == 4 else None
        estimated_peak_human = _format_bytes_compact(estimated_peak)
        soft_limit_human = _format_bytes_compact(self._memory_budget.soft_limit_bytes)
        output_size_label = f"{projected_output['width']:,} x {projected_output['height']:,}"
        message = (
            f'This image is too large for {spec.output_scale}x AI upscaling on the current server. '
            f'The {output_size_label} result is estimated to need about {estimated_peak_human}, '
            f'which is above the safe working limit of about {soft_limit_human}.'
        )
        if suggested_scale:
            message += f' Try {suggested_scale}x instead.'
        else:
            message += ' Try a smaller image or a larger AI worker memory limit.'
        payload = {
            'code': 'memory_budget_exceeded',
            'user_message': message,
            'estimated_peak_bytes': estimated_peak,
            'memory_limit_bytes': self._memory_budget.limit_bytes,
            'memory_target_bytes': self._memory_budget.target_bytes,
            'memory_reserved_bytes': self._memory_budget.reserved_bytes,
            'memory_soft_limit_bytes': self._memory_budget.soft_limit_bytes,
            'memory_hard_limit_bytes': self._memory_budget.hard_limit_bytes,
            'projected_output': projected_output,
        }
        if suggested_scale:
            payload['suggested_scale'] = suggested_scale
        if exc is not None:
            payload['details'] = {'reason': str(exc)}
        return BackendMemoryBudgetError(message, payload=payload)

    def _get_loaded_bundle(self, spec: BackendModelSpec) -> LoadedModelBundle:
        with self.lock:
            bundle = self._loaded_models.pop(spec.key, None)
            if bundle is not None:
                self._loaded_models[spec.key] = bundle
                return bundle
            self._evict_if_needed_locked()
            bundle = self._load_model_bundle(spec)
            self._loaded_models[spec.key] = bundle
            return bundle

    def _preload_models(self) -> None:
        for spec in MODEL_SPECS.values():
            self._get_loaded_bundle(spec)

    def _load_model_bundle(self, spec: BackendModelSpec) -> LoadedModelBundle:
        runtime = self._load_runtime()
        RealESRGANer = runtime['RealESRGANer']
        model = self._build_model(spec, runtime)
        upsampler = RealESRGANer(
            scale=spec.model_scale,
            model_path=str(self._model_paths[spec.key]),
            model=model,
            tile=0,
            tile_pad=10,
            pre_pad=10,
            half=False,
            device=runtime['torch'].device('cpu'),
        )
        estimated_bytes = self._estimate_loaded_model_bytes(upsampler.model)
        return LoadedModelBundle(
            spec=spec,
            model_path=self._model_paths[spec.key],
            upsampler=upsampler,
            estimated_bytes=estimated_bytes,
        )

    def _evict_if_needed_locked(self) -> None:
        cache_size = max(1, int(self.config.model_cache_size))
        if len(self._loaded_models) < cache_size:
            return
        _, bundle = self._loaded_models.popitem(last=False)
        del bundle
        gc.collect()

    def _build_model(self, spec: BackendModelSpec, runtime):
        RRDBNet = runtime['RRDBNet']
        SRVGGNetCompact = runtime['SRVGGNetCompact']
        if spec.architecture == 'rrdb_x2':
            return RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
        if spec.architecture == 'rrdb_x4':
            return RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
        if spec.architecture == 'rrdb_x4_anime_6b':
            return RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=6, num_grow_ch=32, scale=4)
        if spec.architecture == 'srvgg_x4':
            return SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type='prelu')
        raise BackendError(f'Unsupported model architecture: {spec.architecture}')

    def _configure_cpu_runtime(self) -> None:
        torch = self._load_runtime()['torch']
        cpu_threads = self._resolve_cpu_threads()
        os.environ['OMP_NUM_THREADS'] = str(cpu_threads)
        os.environ['MKL_NUM_THREADS'] = str(cpu_threads)
        torch.set_num_threads(cpu_threads)
        try:
            torch.set_num_interop_threads(max(1, self.config.interop_threads))
        except RuntimeError:
            LOG.warning('PyTorch interop threads were already configured; keeping the existing setting.')
        with self.lock:
            self.cpu_threads = cpu_threads

    def _resolve_cpu_threads(self) -> int:
        configured = int(self.config.cpu_threads or 0)
        if configured > 0:
            return configured
        return max(1, min(4, os.cpu_count() or 1))

    def _load_runtime(self):
        if self._runtime is not None:
            return self._runtime

        cpu_threads = self._resolve_cpu_threads()
        os.environ['OMP_NUM_THREADS'] = str(cpu_threads)
        os.environ['MKL_NUM_THREADS'] = str(cpu_threads)
        torch = importlib.import_module('torch')
        cv2 = importlib.import_module('cv2')
        from upscaler_service.realesrgan_cpu.rrdbnet import RRDBNet
        from upscaler_service.realesrgan_cpu.srvgg import SRVGGNetCompact
        from upscaler_service.realesrgan_cpu.upsampler import (
            InferenceCancelledError,
            InferenceMemoryLimitError,
            MemmapImageWriter,
            RealESRGANer,
        )

        self._runtime = {
            'torch': torch,
            'cv2': cv2,
            'RRDBNet': RRDBNet,
            'SRVGGNetCompact': SRVGGNetCompact,
            'RealESRGANer': RealESRGANer,
            'MemmapImageWriter': MemmapImageWriter,
            'InferenceCancelledError': InferenceCancelledError,
            'InferenceMemoryLimitError': InferenceMemoryLimitError,
        }
        return self._runtime

    def _download_model(self, spec: BackendModelSpec, path: Path) -> None:
        tmp_path = path.with_suffix(f'{path.suffix}.tmp')
        tmp_path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(spec.url, timeout=300) as response, tmp_path.open('wb') as target:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
        tmp_path.replace(path)

    def _verify_checksum(self, path: Path, spec: BackendModelSpec) -> None:
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != spec.sha256:
            raise BackendError(
                f'Checksum mismatch for {spec.backend_model_name}: expected {spec.sha256}, got {actual}'
            )

    def _estimate_model_footprint(self, spec: BackendModelSpec) -> int:
        with self.lock:
            bundle = self._loaded_models.get(spec.key)
        if bundle is not None:
            return bundle.estimated_bytes
        path = self._model_paths.get(spec.key) or (self.model_cache_dir / spec.file_name)
        if path.exists():
            return max(int(path.stat().st_size) * MODEL_MEMORY_MULTIPLIER, int(path.stat().st_size))
        return 256 * 1024 * 1024

    @staticmethod
    def _estimate_loaded_model_bytes(model) -> int:
        total = 0
        for parameter in model.parameters():
            total += parameter.nelement() * parameter.element_size()
        for buffer in model.buffers():
            total += buffer.nelement() * buffer.element_size()
        return max(total, 1)

    def _raise_if_rss_exceeded(self) -> None:
        rss = get_process_rss_bytes()
        if rss >= self._memory_budget.hard_limit_bytes:
            raise self._load_runtime()['InferenceMemoryLimitError'](
                f'Process RSS {rss} exceeded hard limit {self._memory_budget.hard_limit_bytes}'
            )

    @staticmethod
    def _looks_like_memory_failure(exc: Exception) -> bool:
        message = str(exc).lower()
        return any(token in message for token in ('out of memory', 'memory', 'alloc'))

    def _set_state(self, state: str, reason: str, details: dict | None = None) -> None:
        with self.lock:
            self.state = state
            self.reason = reason
            self.error_details = details or {}
