#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION_FILE="${REPO_ROOT}/VERSION"
PACKAGE_JSON_FILE="${REPO_ROOT}/package.json"
PACKAGE_LOCK_FILE="${REPO_ROOT}/package-lock.json"

temp_files=()

cleanup() {
    local path
    if [ "${#temp_files[@]}" -gt 0 ]; then
        for path in "${temp_files[@]}"; do
            if [ -n "${path}" ] && [ -e "${path}" ]; then
                rm -f "${path}"
            fi
        done
    fi
}

trap cleanup EXIT

die() {
    echo "Error: $*" >&2
    exit 1
}

require_file() {
    local path="$1"

    if [ ! -f "${path}" ]; then
        die "Required file not found: ${path}"
    fi
}

write_json_with_version() {
    local source_file="$1"
    local output_file="$2"
    local require_lock_root="${3:-false}"

    SOURCE_FILE="${source_file}" OUTPUT_FILE="${output_file}" NEW_VERSION="${next_version}" REQUIRE_LOCK_ROOT="${require_lock_root}" node <<'NODE'
const fs = require('fs');

const sourceFile = process.env.SOURCE_FILE;
const outputFile = process.env.OUTPUT_FILE;
const newVersion = process.env.NEW_VERSION;
const requireLockRoot = process.env.REQUIRE_LOCK_ROOT === 'true';

let data;

try {
  data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
} catch (error) {
  console.error(`Error: Failed to parse ${sourceFile}: ${error.message}`);
  process.exit(1);
}

if (!data || typeof data !== 'object' || Array.isArray(data)) {
  console.error(`Error: Expected ${sourceFile} to contain a JSON object.`);
  process.exit(1);
}

data.version = newVersion;

if (requireLockRoot) {
  if (!data.packages || typeof data.packages !== 'object' || Array.isArray(data.packages)) {
    console.error(`Error: ${sourceFile} is missing the packages object.`);
    process.exit(1);
  }

  if (!Object.prototype.hasOwnProperty.call(data.packages, '')) {
    console.error(`Error: ${sourceFile} is missing packages[""].`);
    process.exit(1);
  }

  if (!data.packages[''] || typeof data.packages[''] !== 'object' || Array.isArray(data.packages[''])) {
    console.error(`Error: ${sourceFile} has an invalid packages[""] entry.`);
    process.exit(1);
  }

  data.packages[''].version = newVersion;
}

fs.writeFileSync(outputFile, `${JSON.stringify(data, null, 2)}\n`);
NODE
}

require_file "${VERSION_FILE}"
require_file "${PACKAGE_JSON_FILE}"
require_file "${PACKAGE_LOCK_FILE}"

if ! command -v node >/dev/null 2>&1; then
    die "node is required but was not found in PATH"
fi

current_version="$(<"${VERSION_FILE}")"

if [[ ! "${current_version}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    die "VERSION must contain a semantic version in X.Y.Z format"
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"

echo "Current version: ${current_version}"
echo "Select release type:"
echo "1) Major"
echo "2) Minor"
echo "3) Patch"

while true; do
    read -r -p "Release type [1-3 or major/minor/patch]: " choice
    normalized_choice="$(printf '%s' "${choice}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

    case "${normalized_choice}" in
        1|major)
            next_version="$((major + 1)).0.0"
            break
            ;;
        2|minor)
            next_version="${major}.$((minor + 1)).0"
            break
            ;;
        3|patch)
            next_version="${major}.${minor}.$((patch + 1))"
            break
            ;;
        *)
            echo "Invalid choice. Enter 1, 2, 3, major, minor, or patch."
            ;;
    esac
done

read -r -p "Update version from ${current_version} to ${next_version}? [y/N] " confirm
normalized_confirm="$(printf '%s' "${confirm}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

if [[ "${normalized_confirm}" != "y" && "${normalized_confirm}" != "yes" ]]; then
    echo "Cancelled. No files were changed."
    exit 0
fi

version_tmp="$(mktemp "${REPO_ROOT}/VERSION.tmp.XXXXXX")"
package_json_tmp="$(mktemp "${REPO_ROOT}/package.json.tmp.XXXXXX")"
package_lock_tmp="$(mktemp "${REPO_ROOT}/package-lock.json.tmp.XXXXXX")"
temp_files+=("${version_tmp}" "${package_json_tmp}" "${package_lock_tmp}")

printf '%s\n' "${next_version}" > "${version_tmp}"
write_json_with_version "${PACKAGE_JSON_FILE}" "${package_json_tmp}"
write_json_with_version "${PACKAGE_LOCK_FILE}" "${package_lock_tmp}" true

mv "${version_tmp}" "${VERSION_FILE}"
mv "${package_json_tmp}" "${PACKAGE_JSON_FILE}"
mv "${package_lock_tmp}" "${PACKAGE_LOCK_FILE}"

echo "Updated version to ${next_version}"
echo "Files updated:"
echo " - VERSION"
echo " - package.json"
echo " - package-lock.json"
