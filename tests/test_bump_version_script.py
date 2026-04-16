import json
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SOURCE = REPO_ROOT / 'scripts' / 'bump-version.sh'


def make_repo(tmp_path, *, version='1.3.2', package_json=None, package_lock=None):
    repo_root = tmp_path / 'repo'
    scripts_dir = repo_root / 'scripts'
    scripts_dir.mkdir(parents=True)
    shutil.copy2(SCRIPT_SOURCE, scripts_dir / 'bump-version.sh')

    (repo_root / 'VERSION').write_text(f'{version}\n', encoding='utf-8')

    if package_json is None:
        package_json = {
            'name': 'file-compressor',
            'version': version,
            'private': True,
        }

    if package_lock is None:
        package_lock = {
            'name': 'file-compressor',
            'version': version,
            'lockfileVersion': 3,
            'packages': {
                '': {
                    'name': 'file-compressor',
                    'version': version,
                },
            },
        }

    (repo_root / 'package.json').write_text(
        json.dumps(package_json, indent=2) + '\n',
        encoding='utf-8',
    )
    (repo_root / 'package-lock.json').write_text(
        json.dumps(package_lock, indent=2) + '\n',
        encoding='utf-8',
    )

    return repo_root


def run_script(repo_root, user_input, *, cwd=None):
    return subprocess.run(
        [str(repo_root / 'scripts' / 'bump-version.sh')],
        input=user_input,
        text=True,
        capture_output=True,
        cwd=cwd or repo_root,
        check=False,
    )


def read_versions(repo_root):
    version = (repo_root / 'VERSION').read_text(encoding='utf-8')
    package_json = json.loads((repo_root / 'package.json').read_text(encoding='utf-8'))
    package_lock = json.loads((repo_root / 'package-lock.json').read_text(encoding='utf-8'))
    return version, package_json, package_lock


def test_patch_release_updates_all_files_from_any_working_directory(tmp_path):
    repo_root = make_repo(tmp_path)

    result = run_script(repo_root, 'patch\ny\n', cwd=tmp_path)

    assert result.returncode == 0
    assert 'Current version: 1.3.2' in result.stdout
    assert 'Updated version to 1.3.3' in result.stdout

    version, package_json, package_lock = read_versions(repo_root)
    assert version == '1.3.3\n'
    assert package_json['version'] == '1.3.3'
    assert package_lock['version'] == '1.3.3'
    assert package_lock['packages']['']['version'] == '1.3.3'

    package_json_text = (repo_root / 'package.json').read_text(encoding='utf-8')
    package_lock_text = (repo_root / 'package-lock.json').read_text(encoding='utf-8')
    assert package_json_text.endswith('\n')
    assert package_lock_text.endswith('\n')
    assert '  "version": "1.3.3"' in package_json_text
    assert '  "version": "1.3.3"' in package_lock_text


def test_numeric_minor_release_updates_to_next_minor(tmp_path):
    repo_root = make_repo(tmp_path)

    result = run_script(repo_root, '2\ny\n')

    assert result.returncode == 0

    version, package_json, package_lock = read_versions(repo_root)
    assert version == '1.4.0\n'
    assert package_json['version'] == '1.4.0'
    assert package_lock['version'] == '1.4.0'
    assert package_lock['packages']['']['version'] == '1.4.0'


def test_mixed_case_major_release_updates_to_next_major(tmp_path):
    repo_root = make_repo(tmp_path)

    result = run_script(repo_root, 'Major\ny\n')

    assert result.returncode == 0

    version, package_json, package_lock = read_versions(repo_root)
    assert version == '2.0.0\n'
    assert package_json['version'] == '2.0.0'
    assert package_lock['version'] == '2.0.0'
    assert package_lock['packages']['']['version'] == '2.0.0'


def test_invalid_choice_reprompts_before_succeeding(tmp_path):
    repo_root = make_repo(tmp_path)

    result = run_script(repo_root, 'banana\npatch\ny\n')

    assert result.returncode == 0
    assert 'Invalid choice. Enter 1, 2, 3, major, minor, or patch.' in result.stdout

    version, package_json, package_lock = read_versions(repo_root)
    assert version == '1.3.3\n'
    assert package_json['version'] == '1.3.3'
    assert package_lock['version'] == '1.3.3'


def test_declining_confirmation_leaves_files_unchanged(tmp_path):
    repo_root = make_repo(tmp_path)
    original_package_json = (repo_root / 'package.json').read_text(encoding='utf-8')
    original_package_lock = (repo_root / 'package-lock.json').read_text(encoding='utf-8')

    result = run_script(repo_root, 'patch\nn\n')

    assert result.returncode == 0
    assert 'Cancelled. No files were changed.' in result.stdout
    assert (repo_root / 'VERSION').read_text(encoding='utf-8') == '1.3.2\n'
    assert (repo_root / 'package.json').read_text(encoding='utf-8') == original_package_json
    assert (repo_root / 'package-lock.json').read_text(encoding='utf-8') == original_package_lock


def test_invalid_version_file_fails_without_modifying_json_files(tmp_path):
    repo_root = make_repo(tmp_path, version='1.3')
    original_package_json = (repo_root / 'package.json').read_text(encoding='utf-8')
    original_package_lock = (repo_root / 'package-lock.json').read_text(encoding='utf-8')

    result = run_script(repo_root, '')

    assert result.returncode != 0
    assert 'VERSION must contain a semantic version in X.Y.Z format' in result.stderr
    assert (repo_root / 'VERSION').read_text(encoding='utf-8') == '1.3\n'
    assert (repo_root / 'package.json').read_text(encoding='utf-8') == original_package_json
    assert (repo_root / 'package-lock.json').read_text(encoding='utf-8') == original_package_lock


def test_missing_package_lock_root_entry_fails_without_partial_updates(tmp_path):
    repo_root = make_repo(
        tmp_path,
        package_lock={
            'name': 'file-compressor',
            'version': '1.3.2',
            'lockfileVersion': 3,
            'packages': {},
        },
    )
    original_version = (repo_root / 'VERSION').read_text(encoding='utf-8')
    original_package_json = (repo_root / 'package.json').read_text(encoding='utf-8')
    original_package_lock = (repo_root / 'package-lock.json').read_text(encoding='utf-8')

    result = run_script(repo_root, 'patch\ny\n')

    assert result.returncode != 0
    assert 'missing packages[""]' in result.stderr
    assert (repo_root / 'VERSION').read_text(encoding='utf-8') == original_version
    assert (repo_root / 'package.json').read_text(encoding='utf-8') == original_package_json
    assert (repo_root / 'package-lock.json').read_text(encoding='utf-8') == original_package_lock


def test_malformed_package_json_fails_without_changing_files(tmp_path):
    repo_root = make_repo(tmp_path)
    (repo_root / 'package.json').write_text('{"version": }\n', encoding='utf-8')
    original_version = (repo_root / 'VERSION').read_text(encoding='utf-8')
    original_package_lock = (repo_root / 'package-lock.json').read_text(encoding='utf-8')

    result = run_script(repo_root, 'patch\ny\n')

    assert result.returncode != 0
    assert 'Failed to parse' in result.stderr
    assert (repo_root / 'VERSION').read_text(encoding='utf-8') == original_version
    assert (repo_root / 'package.json').read_text(encoding='utf-8') == '{"version": }\n'
    assert (repo_root / 'package-lock.json').read_text(encoding='utf-8') == original_package_lock


def test_malformed_package_lock_fails_without_changing_files(tmp_path):
    repo_root = make_repo(tmp_path)
    (repo_root / 'package-lock.json').write_text('{"version": }\n', encoding='utf-8')
    original_version = (repo_root / 'VERSION').read_text(encoding='utf-8')
    original_package_json = (repo_root / 'package.json').read_text(encoding='utf-8')

    result = run_script(repo_root, 'patch\ny\n')

    assert result.returncode != 0
    assert 'Failed to parse' in result.stderr
    assert (repo_root / 'VERSION').read_text(encoding='utf-8') == original_version
    assert (repo_root / 'package.json').read_text(encoding='utf-8') == original_package_json
    assert (repo_root / 'package-lock.json').read_text(encoding='utf-8') == '{"version": }\n'
