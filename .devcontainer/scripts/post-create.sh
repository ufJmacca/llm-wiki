#!/usr/bin/env bash
set -euo pipefail

VERIFY_ONLY="${1:-}"
AI_NATIVE_TOOL="git+https://github.com/ufJmacca/ai-native"
CODEX_HOME_DIR="/home/vscode/.codex"
HOST_CODEX_DIR="/mnt/host-codex"

export PATH="/home/vscode/.local/bin:${PATH}"

mkdir -p "${CODEX_HOME_DIR}"

for filename in auth.json config.toml; do
  source_path="${HOST_CODEX_DIR}/${filename}"
  target_path="${CODEX_HOME_DIR}/${filename}"

  if [[ ! -f "${target_path}" && -f "${source_path}" ]]; then
    cp "${source_path}" "${target_path}"
    chmod 0600 "${target_path}" || true
    echo "[seeded] ${target_path} from ${source_path}"
  fi
done

declare -a REQUIRED_FILES=(
  "/home/vscode/.codex/auth.json"
  "/home/vscode/.codex/config.toml"
  "/home/vscode/.gitconfig"
)

declare -a REQUIRED_DIRS=(
  "${CODEX_HOME_DIR}"
  "/home/vscode/.ssh"
)

declare -a OPTIONAL_DIRS=(
  "/home/vscode/.config/gh"
)

missing=0

for path in "${REQUIRED_FILES[@]}"; do
  if [[ -f "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[missing] ${path}"
    missing=1
  fi
done

for path in "${REQUIRED_DIRS[@]}"; do
  if [[ -d "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[missing] ${path}"
    missing=1
  fi
done

if [[ -d "${CODEX_HOME_DIR}" ]]; then
  if [[ -w "${CODEX_HOME_DIR}" ]]; then
    echo "[writable] ${CODEX_HOME_DIR}"
  else
    echo "[not-writable] ${CODEX_HOME_DIR}"
    missing=1
  fi
fi

if [[ -f "${CODEX_HOME_DIR}/config.toml" ]]; then
  if [[ -w "${CODEX_HOME_DIR}/config.toml" ]]; then
    echo "[writable] ${CODEX_HOME_DIR}/config.toml"
  else
    echo "[not-writable] ${CODEX_HOME_DIR}/config.toml"
    missing=1
  fi
fi

for path in "${OPTIONAL_DIRS[@]}"; do
  if [[ -d "${path}" ]]; then
    echo "[ok] ${path}"
  else
    echo "[optional-missing] ${path}"
  fi
done

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    echo "[ok] docker compose"
  else
    echo "[docker-unavailable] docker compose could not reach the host daemon"
  fi
else
  echo "[docker-unavailable] docker"
fi

if [[ -d "/mnt/host-config/gh" ]] && [[ ! -e "/home/vscode/.config/gh" ]]; then
  mkdir -p /home/vscode/.config
  ln -s /mnt/host-config/gh /home/vscode/.config/gh
  echo "[linked] /home/vscode/.config/gh -> /mnt/host-config/gh"
fi

if [[ "${missing}" -eq 1 ]]; then
  echo "Required devcontainer credentials or runtime directories are not available." >&2
  echo "Check .devcontainer/compose.yaml and confirm ~/.codex, ~/.ssh, and ~/.gitconfig exist on the host." >&2
  echo "Codex also requires ${CODEX_HOME_DIR} and ${CODEX_HOME_DIR}/config.toml to be writable by the vscode user so it can persist runtime state." >&2
fi

if [[ "${VERIFY_ONLY}" == "--verify-only" ]]; then
  exit "${missing}"
fi

if command -v uv >/dev/null 2>&1; then
  echo "[installing] ${AI_NATIVE_TOOL}"
  uv tool install --force --refresh "${AI_NATIVE_TOOL}"

  if [[ -f "./scripts/bootstrap.sh" ]]; then
    echo "[bootstrapping] workspace dependencies"
    bash ./scripts/bootstrap.sh
  fi

  if [[ -f "pyproject.toml" ]]; then
    uv sync || true
  fi
else
  echo "[missing] uv"
  echo "uv is required to install ${AI_NATIVE_TOOL}. Rebuild the devcontainer so .devcontainer/Dockerfile changes are applied." >&2
fi

exit "${missing}"
