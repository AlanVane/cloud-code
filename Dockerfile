FROM nikolaik/python-nodejs:python3.12-nodejs22-bookworm

ENV NODE_ENV=production

ARG TIGRISFS_VERSION=1.2.1
ARG CLOUDFLARED_DEB_URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
# OpenCode major to install: 1 (`opencode web`, default) or 2 (`opencode serve`).
# The Worker speaks both APIs; switch majors by changing this build arg only.
ARG OPENCODE_MAJOR=1
# Pinned release per major; each installer refuses to install the other major.
ARG OPENCODE_VERSION_V1=1.19.5
ARG OPENCODE_VERSION_V2=2.2.5

# Install system dependencies + tigrisfs/cloudflared/opencode, then clean cache
RUN set -eux; \
    # Debian defaults to http:// mirrors. Networks that only allow egress on
    # 443 fail that first update, so retry once over https:// instead of
    # forcing one scheme for every host.
    if ! apt-get update; then \
      sed -i 's|URIs: http://|URIs: https://|' /etc/apt/sources.list.d/debian.sources; \
      apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends \
      fuse \
      ca-certificates \
      curl; \
    \
    curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.deb" -o /tmp/tigrisfs.deb; \
    dpkg -i /tmp/tigrisfs.deb; \
    rm -f /tmp/tigrisfs.deb; \
    \
    curl -fsSL "${CLOUDFLARED_DEB_URL}" -o /tmp/cloudflared.deb; \
    dpkg -i /tmp/cloudflared.deb; \
    rm -f /tmp/cloudflared.deb; \
    \
    if [ "${OPENCODE_MAJOR}" = "2" ]; then \
      OPENCODE_INSTALL_URL="https://opencode.ai/v2/install"; \
      OPENCODE_INSTALL_VERSION="${OPENCODE_VERSION_V2}"; \
    else \
      OPENCODE_INSTALL_URL="https://opencode.ai/install"; \
      OPENCODE_INSTALL_VERSION="${OPENCODE_VERSION_V1}"; \
    fi; \
    curl -fsSL "${OPENCODE_INSTALL_URL}" | bash -s -- --no-modify-path --version "${OPENCODE_INSTALL_VERSION}"; \
    mv /root/.opencode/bin/opencode /usr/local/bin/opencode; \
    rm -rf /root/.opencode; \
    opencode --version; \
    \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy preset config
COPY config /opt/config-init

# Create startup script
RUN install -m 755 /dev/stdin /entrypoint.sh <<'EOF'
#!/bin/bash
set -e

MOUNT_POINT="/root/s3"
WORKSPACE_DIR="$MOUNT_POINT/workspace"
XDG_DIR="$MOUNT_POINT/.opencode"
GLOBAL_CONFIG_DIR="$XDG_DIR/config/opencode"
CONFIG_INIT_DIR="/opt/config-init/opencode"

# Initialize workspace and XDG environment variables
setup_workspace() {
    mkdir -p "$WORKSPACE_DIR/project" "$GLOBAL_CONFIG_DIR" "$XDG_DIR"/{data,state}
    export XDG_CONFIG_HOME="$XDG_DIR/config"
    export XDG_DATA_HOME="$XDG_DIR/data"
    export XDG_STATE_HOME="$XDG_DIR/state"
    PROJECT_DIR="$WORKSPACE_DIR/project"

    # Copy config files only if they not exist
    for file in opencode.json AGENTS.md; do
        if [ ! -f "$GLOBAL_CONFIG_DIR/$file" ]; then
            cp "$CONFIG_INIT_DIR/$file" "$GLOBAL_CONFIG_DIR/" 2>/dev/null && echo "[INFO] Initialized $file" || true
        fi
    done
}

# Ensure mount point is a clean directory
reset_mountpoint() {
    mountpoint -q "$MOUNT_POINT" 2>/dev/null && fusermount -u "$MOUNT_POINT" 2>/dev/null || true
    rm -rf "$MOUNT_POINT"
    mkdir -p "$MOUNT_POINT"
}

reset_mountpoint

if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ] || [ -z "$S3_ACCESS_KEY_ID" ] || [ -z "$S3_SECRET_ACCESS_KEY" ]; then
    echo "[WARN] Incomplete S3 config, using local directory mode"
else
    echo "[INFO] Mounting S3: ${S3_BUCKET} -> ${MOUNT_POINT}"

    export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
    export AWS_REGION="${S3_REGION:-auto}"
    export AWS_S3_PATH_STYLE="${S3_PATH_STYLE:-false}"

    /usr/bin/tigrisfs --endpoint "$S3_ENDPOINT" ${TIGRISFS_ARGS:-} -f "${S3_BUCKET}${S3_PREFIX:+:$S3_PREFIX}" "$MOUNT_POINT" &
    sleep 3

    if ! mountpoint -q "$MOUNT_POINT"; then
        echo "[ERROR] S3 mount failed"
        exit 1
    fi
    echo "[OK] S3 mounted successfully"
fi

setup_workspace

cleanup() {
    echo "[INFO] Shutting down..."
    if [ -n "$OPENCODE_PID" ]; then
        kill -TERM "$OPENCODE_PID" 2>/dev/null
        wait "$OPENCODE_PID" 2>/dev/null
    fi
    if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        fusermount -u "$MOUNT_POINT" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGTERM SIGINT

# v1 and v2 expose different start commands, event streams and auth; branch on
# the installed major so a single image layout stays valid for both.
start_opencode() {
    local major
    major=$(opencode --version 2>/dev/null | sed -E 's/^[^0-9]*([0-9]+).*/\1/')

    if [ "${major:-1}" -ge 2 ]; then
        if [ -z "$OPENCODE_PASSWORD" ]; then
            echo "[WARN] OPENCODE_PASSWORD is not set: v2 generates an ephemeral password and the Worker cannot authenticate to /api/*"
        fi
        opencode serve --hostname 0.0.0.0 --port 2633 &
    else
        opencode web --port 2633 --hostname 0.0.0.0 &
    fi

    OPENCODE_PID=$!
}

echo "[INFO] Starting OpenCode..."
cd "$PROJECT_DIR"
start_opencode
wait $OPENCODE_PID
EOF

WORKDIR /root/s3/workspace
EXPOSE 2633

CMD ["/entrypoint.sh"]
