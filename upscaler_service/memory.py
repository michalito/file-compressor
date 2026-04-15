from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path


CGROUP_V2_MEMORY_MAX = Path('/sys/fs/cgroup/memory.max')
CGROUP_V1_MEMORY_LIMIT = Path('/sys/fs/cgroup/memory/memory.limit_in_bytes')
PROC_STATUS = Path('/proc/self/status')
UNLIMITED_THRESHOLD = 1 << 60


@dataclass(frozen=True)
class MemoryLimitInfo:
    limit_bytes: int
    source: str
    unlimited: bool


@dataclass(frozen=True)
class MemoryBudget:
    limit_bytes: int
    reserved_bytes: int
    target_bytes: int
    soft_limit_bytes: int
    hard_limit_bytes: int


@dataclass(frozen=True)
class TilePlan:
    tile_size: int
    estimated_peak_bytes: int
    requires_alpha_pass: bool


def read_memory_limit(explicit_limit_bytes: int = 0) -> MemoryLimitInfo:
    explicit_limit = int(explicit_limit_bytes or 0)
    if explicit_limit > 0:
        return MemoryLimitInfo(limit_bytes=explicit_limit, source='config', unlimited=False)

    host_total = get_host_memory_bytes()
    for path, source in ((CGROUP_V2_MEMORY_MAX, 'cgroup-v2'), (CGROUP_V1_MEMORY_LIMIT, 'cgroup-v1')):
        found, parsed = _read_limit_file(path)
        if found:
            if parsed is None or _is_effectively_unlimited(parsed):
                return MemoryLimitInfo(limit_bytes=host_total, source='host', unlimited=True)
            return MemoryLimitInfo(limit_bytes=parsed, source=source, unlimited=False)

    return MemoryLimitInfo(limit_bytes=host_total, source='host', unlimited=True)


def compute_memory_budget(
    *,
    limit_bytes: int,
    target_percent: float,
    reserved_bytes: int,
) -> MemoryBudget:
    safe_limit = max(1, int(limit_bytes))
    requested_reserved = max(0, int(reserved_bytes))
    dynamic_reserved = math.floor(safe_limit * 0.2)
    resolved_reserved = max(requested_reserved, dynamic_reserved)
    usable = max(1, safe_limit - resolved_reserved)
    target = max(1, math.floor(usable * float(target_percent)))
    soft_limit = max(1, math.floor(target * 0.92))
    hard_limit = max(soft_limit, math.floor(target * 0.97))
    return MemoryBudget(
        limit_bytes=safe_limit,
        reserved_bytes=resolved_reserved,
        target_bytes=target,
        soft_limit_bytes=soft_limit,
        hard_limit_bytes=hard_limit,
    )


def get_host_memory_bytes() -> int:
    page_size = os.sysconf('SC_PAGE_SIZE')
    page_count = os.sysconf('SC_PHYS_PAGES')
    return max(1, int(page_size) * int(page_count))


def get_process_rss_bytes() -> int:
    try:
        for line in PROC_STATUS.read_text(encoding='utf-8').splitlines():
            if not line.startswith('VmRSS:'):
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) * 1024
            break
    except FileNotFoundError:
        return 0
    return 0


def _read_limit_file(path: Path) -> tuple[bool, int | None]:
    try:
        raw = path.read_text(encoding='utf-8').strip()
    except FileNotFoundError:
        return False, None
    except OSError:
        return False, None

    if not raw or raw == 'max':
        return True, None
    try:
        return True, int(raw)
    except ValueError:
        return True, None


def _is_effectively_unlimited(limit_bytes: int) -> bool:
    return limit_bytes <= 0 or limit_bytes >= UNLIMITED_THRESHOLD
