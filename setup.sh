#!/usr/bin/env bash
#
# Claude Code Development Environment Setup Script
# Runs via cloud-init on DigitalOcean droplet
#
# Creates non-root 'dev' user (required for --dangerously-skip-permissions)
# Installs: Node.js, Bun, Claude Code, iop CLI, ngrok, dev tools
# Sets up 24h self-destruct timer (enabled after token written via SSH)
#

set -euo pipefail

# ============================================================================
# CONFIGURATION
# ============================================================================
NODE_VERSION="22"
DEV_USER="dev"
DEV_USER_PASSWORD="dev"
IOP_REPO="https://github.com/iop-ai/sandbox.git"

export DEBIAN_FRONTEND=noninteractive

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================
log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

# ============================================================================
# STEP 1: System Update and Prerequisites
# ============================================================================
log "Updating system and installing prerequisites..."
apt-get update
apt-get upgrade -y
apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    ca-certificates \
    gnupg \
    unzip \
    jq \
    htop \
    tmux \
    vim \
    sudo

log "Prerequisites installed."

# ============================================================================
# STEP 2: Create Non-Root User
# ============================================================================
log "Creating non-root user '${DEV_USER}'..."

if id "${DEV_USER}" &>/dev/null; then
    log "User '${DEV_USER}' already exists, skipping creation."
else
    useradd -m -s /bin/bash "${DEV_USER}"
    echo "${DEV_USER}:${DEV_USER_PASSWORD}" | chpasswd
    log "User '${DEV_USER}' created with password '${DEV_USER_PASSWORD}'"
fi

# Add to sudo group (passwordless sudo)
usermod -aG sudo "${DEV_USER}"
echo "${DEV_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${DEV_USER}
chmod 0440 /etc/sudoers.d/${DEV_USER}

# Create projects directory
mkdir -p /home/${DEV_USER}/projects
chown ${DEV_USER}:${DEV_USER} /home/${DEV_USER}/projects

# Copy SSH keys from root
if [[ -d /root/.ssh ]]; then
    log "Copying SSH keys from root to ${DEV_USER}..."
    mkdir -p /home/${DEV_USER}/.ssh
    cp -r /root/.ssh/* /home/${DEV_USER}/.ssh/ 2>/dev/null || true
    chown -R ${DEV_USER}:${DEV_USER} /home/${DEV_USER}/.ssh
    chmod 700 /home/${DEV_USER}/.ssh
    chmod 600 /home/${DEV_USER}/.ssh/* 2>/dev/null || true
fi

log "User '${DEV_USER}' configured with sudo access."

# ============================================================================
# STEP 3: Install Node.js
# ============================================================================
log "Installing Node.js ${NODE_VERSION}.x..."

# Remove any existing Node.js
apt-get remove -y nodejs npm 2>/dev/null || true

# Install Node.js from NodeSource
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

log "Node.js installed: $(node --version)"
log "npm installed: $(npm --version)"

# ============================================================================
# STEP 4: Install Bun
# ============================================================================
log "Installing Bun..."

sudo -u ${DEV_USER} bash -c 'curl -fsSL https://bun.sh/install | bash'

log "Bun installed."

# ============================================================================
# STEP 5: Install Claude Code
# ============================================================================
log "Installing Claude Code..."

npm install -g @anthropic-ai/claude-code

log "Claude Code installed: $(claude --version 2>/dev/null || echo 'installed')"

# ============================================================================
# STEP 6: Install iop CLI
# ============================================================================
log "Installing iop CLI..."

sudo -u ${DEV_USER} bash -c "
    cd /home/${DEV_USER}
    git clone ${IOP_REPO} iop-cli
    cd iop-cli/cli
    ~/.bun/bin/bun install
"

log "iop CLI installed at /home/${DEV_USER}/iop-cli"

# ============================================================================
# STEP 7: Install ngrok
# ============================================================================
log "Installing ngrok..."

curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
    | tee /etc/apt/sources.list.d/ngrok.list

apt-get update
apt-get install -y ngrok

log "ngrok installed: $(ngrok version)"

# ============================================================================
# STEP 8: Configure Dev User Environment
# ============================================================================
log "Configuring environment for '${DEV_USER}'..."

cat >> /home/${DEV_USER}/.bashrc << 'BASHEOF'

# ============================================================================
# Claude Code Development Environment
# ============================================================================

# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# iop CLI alias
alias iop='bun run /home/dev/iop-cli/cli/src/index.ts'

# Claude Code aliases
alias cc='claude'
alias ccd='claude --dangerously-skip-permissions'

# Development aliases
alias ll='ls -la'
alias gs='git status'
alias gp='git pull'
alias gc='git commit'
alias gd='git diff'

# Navigation
alias proj='cd ~/projects'

# Show environment info on login
echo ""
echo "==================================="
echo "  IOP.ai - Claude Code Dev Enviro."
echo "==================================="
echo ""
echo "Node.js: $(node --version) | npm: $(npm --version)"
echo "Bun: $(bun --version 2>/dev/null || echo 'run: source ~/.bashrc')"
echo "Claude Code: $(claude --version 2>/dev/null || echo 'run: claude')"
echo ""
echo "Quick commands:"
echo "  iop  - Run iop CLI (task orchestrator)"
echo "  cc   - Run Claude Code (normal mode)"
echo "  ccd  - Run Claude Code (unrestricted mode)"
echo "  proj - Go to projects directory"
echo ""
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "Auth required! Choose one:"
    echo "  claude login                        # Claude Max"
    echo "  export ANTHROPIC_API_KEY='sk-...'   # API key"
    echo ""
fi
echo "========================================"
echo ""
BASHEOF

chown ${DEV_USER}:${DEV_USER} /home/${DEV_USER}/.bashrc

log "Environment configured for '${DEV_USER}'."

# ============================================================================
# STEP 9: Configure SSH Access
# ============================================================================
log "Configuring SSH access..."

# Disable password auth (SSH key only)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config 2>/dev/null || true
systemctl restart sshd 2>/dev/null || systemctl restart ssh 2>/dev/null || true

log "SSH access configured."

# ============================================================================
# STEP 10: Install Self-Destruct Timer (24 hours)
# ============================================================================
log "Installing self-destruct timer..."

# Create the self-destruct script
cat > /usr/local/bin/self-destruct.sh << 'SCRIPT_EOF'
#!/usr/bin/env bash
set -e

# Read the DO API token
if [[ ! -f /etc/self-destruct-token ]]; then
    echo "No self-destruct token found at /etc/self-destruct-token"
    exit 1
fi

DO_TOKEN=$(cat /etc/self-destruct-token)

# Get this droplet's ID from metadata
DROPLET_ID=$(curl -s http://169.254.169.254/metadata/v1/id)

if [[ -z "$DROPLET_ID" ]]; then
    echo "Failed to get droplet ID from metadata"
    exit 1
fi

echo "Self-destructing droplet $DROPLET_ID..."

# Delete this droplet
curl -X DELETE \
    -H "Authorization: Bearer $DO_TOKEN" \
    "https://api.digitalocean.com/v2/droplets/$DROPLET_ID"

echo "Self-destruct request sent"
SCRIPT_EOF

chmod +x /usr/local/bin/self-destruct.sh

# Create systemd service
cat > /etc/systemd/system/self-destruct.service << 'SERVICE_EOF'
[Unit]
Description=Self-destruct this droplet
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/self-destruct.sh
SERVICE_EOF

# Create systemd timer (triggers 24 hours after boot)
cat > /etc/systemd/system/self-destruct.timer << 'TIMER_EOF'
[Unit]
Description=Self-destruct droplet after 24 hours

[Timer]
OnBootSec=24h
AccuracySec=1min

[Install]
WantedBy=timers.target
TIMER_EOF

# Reload systemd (timer will be enabled by sandbox.sh after token is written)
systemctl daemon-reload

log "Self-destruct timer installed (will be enabled after token is written)"

# ============================================================================
# DONE
# ============================================================================
DROPLET_IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || hostname -I | awk '{print $1}')

log "=========================================="
log "Setup Complete!"
log "=========================================="
log ""
log "Installed:"
log "  - Node.js $(node --version)"
log "  - npm $(npm --version)"
log "  - Bun"
log "  - Claude Code (global)"
log "  - iop CLI (/home/${DEV_USER}/iop-cli)"
log "  - ngrok $(ngrok version)"
log "  - git, tmux, vim, htop"
log "  - Self-destruct timer (24h)"
log ""
log "Dev user: ${DEV_USER} (password: ${DEV_USER_PASSWORD})"
log "Projects: /home/${DEV_USER}/projects"
log ""
log "Waiting for secrets via SSH..."
