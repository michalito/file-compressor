#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# run-prod.sh — Production deployment script for file-compressor
#
# Usage:
#   ./run-prod.sh              # Full deploy (default)
#   ./run-prod.sh deploy       # Full deploy: pull → build → start → verify
#   ./run-prod.sh rollback     # Roll back to previous image
#   ./run-prod.sh status       # Show container & image status
#   ./run-prod.sh health       # Run health check only
#   ./run-prod.sh logs         # Tail container logs
#   ./run-prod.sh help         # Show usage
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_NAME="file-compressor"
SERVICE_NAME="web"
IMAGE_NAME="${PROJECT_NAME}-${SERVICE_NAME}"
HEALTH_URL="http://localhost:8000/login"
HEALTH_RETRIES=15
HEALTH_INTERVAL=2

# -- Colors ----------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

# -- Error trap ------------------------------------------------------------

on_exit() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo ""
        error "Deployment failed (exit code: $exit_code)"
        if docker image inspect "${IMAGE_NAME}:rollback" &>/dev/null; then
            warn "A rollback image exists. Run: $0 rollback"
        fi
    fi
}
trap on_exit EXIT

# -- Prerequisites ---------------------------------------------------------

check_prerequisites() {
    step "Checking prerequisites"

    local missing=0

    if ! command -v docker &>/dev/null; then
        error "Docker is not installed"
        info "Install: https://docs.docker.com/engine/install/ubuntu/"
        missing=1
    else
        success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
    fi

    if ! docker compose version &>/dev/null; then
        error "Docker Compose v2 plugin is not available"
        info "Install: sudo apt install docker-compose-plugin"
        missing=1
    else
        success "Docker Compose $(docker compose version --short)"
    fi

    if ! docker info &>/dev/null 2>&1; then
        error "Docker daemon is not running"
        info "Start it: sudo systemctl start docker"
        missing=1
    fi

    if ! command -v git &>/dev/null; then
        error "Git is not installed"
        info "Install: sudo apt install git"
        missing=1
    fi

    if ! command -v curl &>/dev/null; then
        error "curl is not installed"
        info "Install: sudo apt install curl"
        missing=1
    fi

    if [ ! -f "${SCRIPT_DIR}/${COMPOSE_FILE}" ]; then
        error "Cannot find ${COMPOSE_FILE} in ${SCRIPT_DIR}"
        missing=1
    fi

    if [ $missing -ne 0 ]; then
        error "Missing prerequisites. Install them and re-run."
        exit 1
    fi
}

# -- Environment setup -----------------------------------------------------

setup_env() {
    step "Checking environment configuration"

    local env_file="${SCRIPT_DIR}/.env"

    if [ -f "$env_file" ]; then
        success ".env file exists"

        local valid=1
        if ! grep -q '^SECRET_KEY=.' "$env_file"; then
            error "SECRET_KEY is missing or empty in .env"
            valid=0
        fi
        if ! grep -q '^APP_PASSWORD=.' "$env_file"; then
            error "APP_PASSWORD is missing or empty in .env"
            valid=0
        fi

        if [ $valid -eq 0 ]; then
            error "Fix the .env file and re-run"
            exit 1
        fi

        success "Required variables validated"
        return
    fi

    # First-time setup
    warn "No .env file found — first-time setup"
    info "Two values are required: SECRET_KEY and APP_PASSWORD"
    echo ""

    local suggested_key=""
    suggested_key=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))" 2>/dev/null) \
        || suggested_key=$(openssl rand -base64 48 2>/dev/null) \
        || true

    read -rp "SECRET_KEY [press Enter to auto-generate]: " secret_key
    if [ -z "$secret_key" ]; then
        if [ -n "$suggested_key" ]; then
            secret_key="$suggested_key"
            info "Auto-generated SECRET_KEY"
        else
            error "Could not auto-generate key. Please provide one manually."
            exit 1
        fi
    fi

    read -rsp "APP_PASSWORD: " app_password
    echo ""
    if [ -z "$app_password" ]; then
        error "APP_PASSWORD cannot be empty"
        exit 1
    fi

    cat > "$env_file" << EOF
SECRET_KEY=${secret_key}
APP_PASSWORD=${app_password}
EOF
    chmod 600 "$env_file"
    success "Created .env with secure permissions (600)"
}

# -- Git pull --------------------------------------------------------------

pull_latest() {
    step "Pulling latest code"

    cd "$SCRIPT_DIR"

    if ! git diff --quiet HEAD 2>/dev/null; then
        warn "Working directory has uncommitted changes"
        read -rp "Continue anyway? (y/N): " confirm
        if [[ ! "$confirm" =~ ^[yY]$ ]]; then
            error "Aborting. Commit or stash changes first."
            exit 1
        fi
    fi

    local current_commit
    current_commit=$(git rev-parse --short HEAD)
    info "Current commit: ${current_commit}"

    git pull origin main

    local new_commit
    new_commit=$(git rev-parse --short HEAD)

    if [ "$current_commit" = "$new_commit" ]; then
        info "Already up to date"
    else
        success "Updated: ${current_commit} → ${new_commit}"
    fi
}

# -- Build & deploy --------------------------------------------------------

build_and_deploy() {
    step "Building and deploying"

    cd "$SCRIPT_DIR"

    # Tag current image for rollback
    if docker image inspect "${IMAGE_NAME}:latest" &>/dev/null; then
        info "Tagging current image as rollback"
        docker tag "${IMAGE_NAME}:latest" "${IMAGE_NAME}:rollback"
    fi

    info "Building image..."
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" build

    info "Starting container..."
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up \
        --detach \
        --force-recreate \
        --remove-orphans

    success "Container started"
}

# -- Health check ----------------------------------------------------------

wait_for_healthy() {
    step "Waiting for application to become healthy"

    local attempt=1

    while [ $attempt -le $HEALTH_RETRIES ]; do
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

        if [ "$http_code" = "200" ]; then
            success "Health check passed (HTTP ${http_code}) on attempt ${attempt}"
            return 0
        fi

        info "Attempt ${attempt}/${HEALTH_RETRIES} — HTTP ${http_code} — waiting ${HEALTH_INTERVAL}s..."
        sleep "$HEALTH_INTERVAL"
        attempt=$((attempt + 1))
    done

    error "Health check failed after ${HEALTH_RETRIES} attempts"
    warn "Container logs:"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs --tail=20 "$SERVICE_NAME"
    return 1
}

# -- Rollback --------------------------------------------------------------

rollback() {
    step "Rolling back to previous version"

    if ! docker image inspect "${IMAGE_NAME}:rollback" &>/dev/null; then
        error "No rollback image found. Cannot roll back."
        exit 1
    fi

    docker tag "${IMAGE_NAME}:rollback" "${IMAGE_NAME}:latest"

    cd "$SCRIPT_DIR"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up \
        --detach \
        --force-recreate

    success "Rolled back to previous image"
    wait_for_healthy
}

# -- Cleanup ---------------------------------------------------------------

cleanup_resources() {
    step "Cleaning up"

    local dangling
    dangling=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l | tr -d ' ')
    if [ "$dangling" -gt 0 ]; then
        docker image prune -f >/dev/null
        info "Removed ${dangling} dangling image(s)"
    fi

    docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
    info "Cleaned build cache (>7 days)"

    success "Cleanup complete"
}

# -- Summary ---------------------------------------------------------------

show_summary() {
    step "Deployment Summary"

    echo ""
    echo -e "${BOLD}Container:${NC}"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" ps

    echo ""
    echo -e "${BOLD}Images:${NC}"
    docker images "${IMAGE_NAME}" --format "table {{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"

    echo ""
    echo -e "${BOLD}Recent Logs:${NC}"
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs --tail=10 "$SERVICE_NAME" 2>&1 | tail -10

    local commit
    commit=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    echo ""
    success "Deployed commit: ${commit}"
    success "Application running at: http://localhost:8000"
    echo ""
}

# -- Status ----------------------------------------------------------------

show_status() {
    step "Current Deployment Status"

    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" ps 2>/dev/null || info "No containers running"
    echo ""
    docker images "${IMAGE_NAME}" --format "table {{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" 2>/dev/null || true
}

# -- Logs ------------------------------------------------------------------

tail_logs() {
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs -f --tail=50 "$SERVICE_NAME"
}

# -- Usage -----------------------------------------------------------------

usage() {
    echo -e "${BOLD}Usage:${NC} $0 [command]"
    echo ""
    echo "Commands:"
    echo "  deploy     Full deploy: pull, build, start, health check (default)"
    echo "  rollback   Roll back to the previous image"
    echo "  status     Show current deployment status"
    echo "  health     Run health check only"
    echo "  logs       Tail container logs"
    echo "  help       Show this help message"
    echo ""
}

# -- Main ------------------------------------------------------------------

main() {
    local command="${1:-deploy}"

    case "$command" in
        deploy)
            check_prerequisites
            setup_env
            pull_latest
            build_and_deploy
            wait_for_healthy
            cleanup_resources
            show_summary
            ;;
        rollback)
            check_prerequisites
            rollback
            show_summary
            ;;
        status)
            cd "$SCRIPT_DIR"
            show_status
            ;;
        health)
            wait_for_healthy
            ;;
        logs)
            cd "$SCRIPT_DIR"
            tail_logs
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            error "Unknown command: $command"
            usage
            exit 1
            ;;
    esac
}

main "$@"
