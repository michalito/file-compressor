from .base import BackendCancelledError, BackendError, BackendMemoryBudgetError, BackendNotReadyError, UpscalerBackend
from .torch_cpu import TorchCPUBackend


def create_backend(config):
    backend_name = (config.backend or 'torch-cpu').strip().lower()
    if backend_name == 'torch-cpu':
        return TorchCPUBackend(config)
    raise ValueError(f'Unsupported AI upscaler backend: {config.backend}')


__all__ = [
    'BackendCancelledError',
    'BackendError',
    'BackendMemoryBudgetError',
    'BackendNotReadyError',
    'TorchCPUBackend',
    'UpscalerBackend',
    'create_backend',
]
