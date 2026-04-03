#!/usr/bin/env bash
#
# sandbox.sh - One command to spin up Claude Code dev environment
#
# Features:
#   - Retry logic for network resilience
#   - Idempotent operations (safe to re-run)
#   - SSH keepalive for connection stability
#
# Prerequisites:
#   brew install doctl jq
#   doctl auth init
#   echo "$GITHUB_DEPLOY_KEY" > ~/.sandbox-github-key
#
# Usage: sandbox git@github.com:user/repo.git
#

set -euo pipefail

# =============================================================================
# FIXED CONFIG
# =============================================================================
DROPLET_NAME="devbox"
REGION="nyc2"
SIZE="s-8vcpu-16gb-amd"
IMAGE="ubuntu-24-04-x64"
SSH_KEY="96:78:51:00:78:0b:86:30:47:b7:d0:01:a4:5a:ff:27"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/setup.sh"
GITHUB_KEY_FILE="$HOME/.sandbox-github-key"
GITHUB_TOKEN_FILE="$HOME/.sandbox-github-token"
ENV_FILE="$HOME/.sandbox-env"
DO_TOKEN_FILE="$HOME/.sandbox-do-token"

# Retry settings
MAX_RETRIES=3
RETRY_DELAY=5

# SSH options for stability
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3"

# =============================================================================
# COLORS
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()     { echo -e "${CYAN}[sandbox]${NC} $*"; }
success() { echo -e "${GREEN}[sandbox]${NC} $*"; }
warn()    { echo -e "${YELLOW}[sandbox]${NC} $*"; }
die()     { echo -e "${RED}[sandbox]${NC} ERROR: $*" >&2; exit 1; }

# =============================================================================
# SSH WITH RETRY
# =============================================================================
ssh_retry() {
    local attempt=1
    local cmd="$*"

    while [[ $attempt -le $MAX_RETRIES ]]; do
        if ssh $SSH_OPTS root@"$IP" "$cmd" 2>/dev/null; then
            return 0
        fi

        if [[ $attempt -lt $MAX_RETRIES ]]; then
            warn "SSH failed (attempt $attempt/$MAX_RETRIES), retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        fi
        ((attempt++))
    done

    die "SSH command failed after $MAX_RETRIES attempts: $cmd"
}

# SSH with heredoc and retry
ssh_retry_heredoc() {
    local attempt=1

    while [[ $attempt -le $MAX_RETRIES ]]; do
        if ssh $SSH_OPTS root@"$IP" bash -s; then
            return 0
        fi

        if [[ $attempt -lt $MAX_RETRIES ]]; then
            warn "SSH failed (attempt $attempt/$MAX_RETRIES), retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        fi
        ((attempt++))
    done

    die "SSH heredoc command failed after $MAX_RETRIES attempts"
}

# =============================================================================
# VALIDATION
# =============================================================================
REPO="${1:-}"

[[ -n "$REPO" ]] || die "Usage: sandbox <repo-url>"

# Convert SSH URL to HTTPS (PAT auth only works with HTTPS)
if [[ "$REPO" == git@github.com:* ]]; then
    REPO="https://github.com/${REPO#git@github.com:}"
    REPO="${REPO%.git}.git"
fi
[[ -f "$SETUP_SCRIPT" ]] || die "Missing: $SETUP_SCRIPT"
[[ -f "$GITHUB_TOKEN_FILE" ]] || die "Missing: $GITHUB_TOKEN_FILE (GitHub PAT - see README)"
command -v doctl >/dev/null || die "doctl not installed. Run: brew install doctl"
command -v jq >/dev/null || die "jq not installed. Run: brew install jq"

# =============================================================================
# GET DO TOKEN (scoped token preferred, fallback to doctl config)
# =============================================================================
if [[ -f "$DO_TOKEN_FILE" ]]; then
    DO_TOKEN=$(cat "$DO_TOKEN_FILE" | tr -d '[:space:]')
elif [[ -f "$HOME/Library/Application Support/doctl/config.yaml" ]]; then
    warn "Using doctl token. For better security, create scoped token:"
    warn "  1. DO Console → API → Generate Token (Droplets Write only)"
    warn "  2. echo 'dop_v1_xxx' > ~/.sandbox-do-token && chmod 600 ~/.sandbox-do-token"
    DOCTL_CONFIG="$HOME/Library/Application Support/doctl/config.yaml"
    DO_TOKEN=$(grep -E "^access-token:" "$DOCTL_CONFIG" | sed 's/access-token: *//' | tr -d '"' | tr -d "'")
elif [[ -f "$HOME/.config/doctl/config.yaml" ]]; then
    warn "Using doctl token. For better security, create scoped token."
    DOCTL_CONFIG="$HOME/.config/doctl/config.yaml"
    DO_TOKEN=$(grep -E "^access-token:" "$DOCTL_CONFIG" | sed 's/access-token: *//' | tr -d '"' | tr -d "'")
else
    die "No DO token found. Create ~/.sandbox-do-token or run: doctl auth init"
fi
[[ -n "$DO_TOKEN" ]] || die "Could not extract DO token"

# =============================================================================
# CREATE OR REUSE DROPLET (idempotent)
# =============================================================================
echo ""
log "Checking for existing droplet..."

IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header 2>/dev/null | grep "^${DROPLET_NAME} " | awk '{print $2}' || true)

if [[ -n "$IP" ]]; then
    log "Found existing droplet: $DROPLET_NAME ($IP)"
    log "Resuming configuration..."
else
    log "Creating droplet: $DROPLET_NAME"
    log "Size: $SIZE | Region: $REGION"
    echo ""

    doctl compute droplet create "$DROPLET_NAME" \
        --region "$REGION" \
        --image "$IMAGE" \
        --size "$SIZE" \
        --ssh-keys "$SSH_KEY" \
        --user-data-file "$SETUP_SCRIPT" \
        --wait

    IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^${DROPLET_NAME} " | awk '{print $2}')
    [[ -n "$IP" ]] || die "Failed to get droplet IP"
    success "Droplet created: $IP"
fi

# =============================================================================
# WAIT FOR SSH (with retry)
# =============================================================================
log "Waiting for SSH..."
for i in {1..30}; do
    if ssh $SSH_OPTS root@"$IP" "exit" 2>/dev/null; then
        break
    fi
    sleep 5
done

# Wait for cloud-init (idempotent - safe to check multiple times)
log "Waiting for cloud-init to finish..."
ssh_retry "cloud-init status --wait" || sleep 60

# =============================================================================
# CONFIGURE SECRETS (idempotent checks)
# =============================================================================
log "Configuring secrets..."

# Write DO token for self-destruct (idempotent - overwrites if exists)
ssh_retry "echo '$DO_TOKEN' > /etc/self-destruct-token && chmod 600 /etc/self-destruct-token"

# Enable self-destruct timer (idempotent - enable is safe to repeat)
ssh_retry "systemctl enable --now self-destruct.timer"
success "Self-destruct timer enabled (24 hours)"

# Configure GitHub PAT for HTTPS clones (idempotent - overwrites if exists)
GITHUB_TOKEN=$(cat "$GITHUB_TOKEN_FILE" | tr -d '[:space:]')
ssh_retry_heredoc << EOFGIT
# Store PAT in git credential helper so clone/push works over HTTPS
sudo -u dev git config --global credential.helper store
echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > /home/dev/.git-credentials
chmod 600 /home/dev/.git-credentials
chown dev:dev /home/dev/.git-credentials
EOFGIT
success "GitHub PAT configured"

# Set ANTHROPIC_API_KEY if provided (idempotent - check before adding)
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    ssh_retry "grep -q 'ANTHROPIC_API_KEY' /home/dev/.bashrc || echo 'export ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY\"' >> /home/dev/.bashrc"
    success "ANTHROPIC_API_KEY set"
else
    log "No API key - use 'claude login' on droplet for Claude Max"
fi

# Copy environment variables (idempotent - check marker before adding)
if [[ -f "$ENV_FILE" ]]; then
    log "Copying environment variables from ~/.sandbox-env..."
    ENV_CONTENT=$(cat "$ENV_FILE")
    ssh_retry_heredoc << EOFENV
if ! grep -q "Sandbox Environment Variables" /home/dev/.bashrc 2>/dev/null; then
    cat >> /home/dev/.bashrc << 'ENVBLOCK'

# === Sandbox Environment Variables ===
$ENV_CONTENT
# === End Sandbox Environment Variables ===
ENVBLOCK
    chown dev:dev /home/dev/.bashrc
fi
EOFENV
    success "Environment variables copied ($(grep -c '^export' "$ENV_FILE" 2>/dev/null || echo 0) vars)"
else
    log "No ~/.sandbox-env file found (optional)"
fi

# =============================================================================
# CLONE REPO (idempotent - check if already cloned)
# =============================================================================
log "Cloning repo: $REPO"
ssh_retry "sudo -u dev bash -c 'if [[ ! -d ~/projects/repo ]]; then cd ~/projects && git clone $REPO repo; else echo \"Repo already exists, pulling latest...\"; cd ~/projects/repo && git pull; fi'"
success "Repo ready at /home/dev/projects/repo"

# Create .env file for Next.js (idempotent - overwrites)
if [[ -f "$ENV_FILE" ]]; then
    log "Creating .env file for Next.js..."
    # Convert "export VAR=value" to "VAR=value" format for .env
    ENV_DOTENV=$(cat "$ENV_FILE" | sed 's/^export //')
    ssh_retry_heredoc << EOFENV2
cat > /home/dev/projects/repo/.env << 'DOTENVBLOCK'
$ENV_DOTENV
DOTENVBLOCK
chown dev:dev /home/dev/projects/repo/.env
chmod 600 /home/dev/projects/repo/.env
EOFENV2
    success "Created /home/dev/projects/repo/.env"
fi

# Install dependencies (idempotent - npm install is safe to re-run)
log "Installing dependencies (npm install)..."
ssh $SSH_OPTS root@"$IP" "sudo -u dev bash -c 'cd ~/projects/repo && npm install'" 2>&1 | tail -5 || true
ssh $SSH_OPTS root@"$IP" "sudo -u dev bash -c 'cd ~/projects/repo && npm audit fix --force'" 2>&1 | tail -5 || true
success "Dependencies installed"

# =============================================================================
# UPDATE LOCAL SSH CONFIG & KNOWN HOSTS
# =============================================================================
# Remove existing devbox entry if present, then add fresh one
if [[ -f ~/.ssh/config ]]; then
    awk -v host="$DROPLET_NAME" '
        /^Host / { if ($2 == host) skip=1; else skip=0 }
        !skip { print }
    ' ~/.ssh/config > ~/.ssh/config.tmp
    mv ~/.ssh/config.tmp ~/.ssh/config
fi
echo -e "\nHost $DROPLET_NAME\n    HostName $IP\n    User dev\n    ForwardAgent yes" >> ~/.ssh/config
log "Updated $DROPLET_NAME in ~/.ssh/config"

# Add host key to known_hosts (prevents VS Code fingerprint prompt)
log "Adding host key to known_hosts..."
ssh-keygen -R "$IP" 2>/dev/null || true
ssh-keyscan -H "$IP" >> ~/.ssh/known_hosts 2>/dev/null

# =============================================================================
# LAUNCH VS CODE
# =============================================================================
log "Launching VS Code..."
code --remote ssh-remote+$DROPLET_NAME /home/dev/projects/repo

# =============================================================================
# DONE
# =============================================================================
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
success "Sandbox ready!"
echo ""
echo "  Droplet:  $DROPLET_NAME ($IP)"
echo "  SSH:      ssh $DROPLET_NAME"
echo "  Destroy:  doctl compute droplet delete $DROPLET_NAME --force"
echo ""
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "  Auth:     Run 'claude login' for Claude Max"
    echo ""
fi
echo "  ⏰ Auto-destruct in 24 hours"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
