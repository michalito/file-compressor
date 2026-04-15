from upscaler_service import memory


def test_read_memory_limit_prefers_explicit_override():
    info = memory.read_memory_limit(12345)

    assert info.limit_bytes == 12345
    assert info.source == 'config'
    assert info.unlimited is False


def test_read_memory_limit_uses_cgroup_v2_when_present(tmp_path, monkeypatch):
    path = tmp_path / 'memory.max'
    path.write_text('987654321', encoding='utf-8')
    monkeypatch.setattr(memory, 'CGROUP_V2_MEMORY_MAX', path)
    monkeypatch.setattr(memory, 'CGROUP_V1_MEMORY_LIMIT', tmp_path / 'missing')

    info = memory.read_memory_limit(0)

    assert info.limit_bytes == 987654321
    assert info.source == 'cgroup-v2'
    assert info.unlimited is False


def test_read_memory_limit_falls_back_to_host_when_cgroup_is_unlimited(tmp_path, monkeypatch):
    path = tmp_path / 'memory.max'
    path.write_text('max', encoding='utf-8')
    monkeypatch.setattr(memory, 'CGROUP_V2_MEMORY_MAX', path)
    monkeypatch.setattr(memory, 'CGROUP_V1_MEMORY_LIMIT', tmp_path / 'missing')
    monkeypatch.setattr(memory, 'get_host_memory_bytes', lambda: 222222222)

    info = memory.read_memory_limit(0)

    assert info.limit_bytes == 222222222
    assert info.source == 'host'
    assert info.unlimited is True


def test_read_memory_limit_treats_cgroup_v2_max_as_authoritative_when_v1_exists(tmp_path, monkeypatch):
    v2 = tmp_path / 'memory.max'
    v1 = tmp_path / 'memory.limit_in_bytes'
    v2.write_text('max', encoding='utf-8')
    v1.write_text('987654321', encoding='utf-8')
    monkeypatch.setattr(memory, 'CGROUP_V2_MEMORY_MAX', v2)
    monkeypatch.setattr(memory, 'CGROUP_V1_MEMORY_LIMIT', v1)
    monkeypatch.setattr(memory, 'get_host_memory_bytes', lambda: 222222222)

    info = memory.read_memory_limit(0)

    assert info.limit_bytes == 222222222
    assert info.source == 'host'
    assert info.unlimited is True


def test_compute_memory_budget_uses_reserved_floor_and_soft_limits():
    budget = memory.compute_memory_budget(
        limit_bytes=2_000_000_000,
        target_percent=0.75,
        reserved_bytes=100_000_000,
    )

    assert budget.reserved_bytes == 400_000_000
    assert budget.target_bytes == 1_200_000_000
    assert budget.soft_limit_bytes == 1_104_000_000
    assert budget.hard_limit_bytes == 1_164_000_000
