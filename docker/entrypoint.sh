#!/bin/bash
set -e

MOUNT_POINT="/root/s3"
WORKSPACE_DIR="$MOUNT_POINT/workspace"
XDG_DIR="$MOUNT_POINT/.opencode"
GLOBAL_CONFIG_DIR="$XDG_DIR/config/opencode"
CONFIG_INIT_DIR="/opt/config-init/opencode"

# Bundled orchestration plugin (v2 images only).
PLUGIN_ARCHIVE="/opt/opencode-plugins.tar.zst"
PLUGIN_HOME="/opt/opencode-plugins"
PLUGIN_ENTRY="$PLUGIN_HOME/node_modules/oh-my-opencode-slim"

# Initialize workspace and XDG environment variables
setup_workspace() {
    mkdir -p "$WORKSPACE_DIR/project" "$GLOBAL_CONFIG_DIR" "$XDG_DIR"/{data,state}
    export XDG_CONFIG_HOME="$XDG_DIR/config"
    export XDG_DATA_HOME="$XDG_DIR/data"
    export XDG_STATE_HOME="$XDG_DIR/state"
    PROJECT_DIR="$WORKSPACE_DIR/project"

    # Copy config files only if they not exist
    for file in opencode.json AGENTS.md oh-my-opencode-slim.json; do
        if [ ! -f "$GLOBAL_CONFIG_DIR/$file" ]; then
            cp "$CONFIG_INIT_DIR/$file" "$GLOBAL_CONFIG_DIR/" 2>/dev/null && echo "[INFO] Initialized $file" || true
        fi
    done
}

# Cloudflare containers start from the image on every wake, so the plugin bundle
# has to be unpacked again each time. ~49 MB tarball in, ~300 MB on the
# instance-local disk, measured at ~1.8 s.
extract_plugins() {
    [ -f "$PLUGIN_ARCHIVE" ] || return 0
    rm -rf "$PLUGIN_HOME"
    mkdir -p "$PLUGIN_HOME"
    zstd -dc "$PLUGIN_ARCHIVE" | tar -xf - -C "$PLUGIN_HOME"
    echo "[INFO] Extracted OpenCode plugin bundle"
}

# Merge the plugin path into the `plugins` array, keeping entries the user added.
# A config that cannot be parsed is left untouched rather than overwritten.
register_plugin() {
    [ -d "$PLUGIN_ENTRY" ] || return 0

    node - "$GLOBAL_CONFIG_DIR/opencode.json" "$PLUGIN_ENTRY" <<'JS'
const fs = require('node:fs')

const [file, entry] = process.argv.slice(2)
let config = {}

if (fs.existsSync(file)) {
    try {
        config = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        console.error(`[WARN] ${file} is not valid JSON, leaving it untouched`)
        process.exit(0)
    }
}

const plugins = Array.isArray(config.plugins) ? config.plugins : []
// `-name` is OpenCode's disable prefix; leave such a config alone.
const disabled = plugins.some(
    (plugin) => typeof plugin === 'string' && plugin.startsWith('-') && plugin.includes('oh-my-opencode-slim'),
)
if (plugins.includes(entry) || disabled) process.exit(0)

plugins.push(entry)
config.plugins = plugins
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log('[INFO] Registered OpenCode plugin')
JS
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
extract_plugins
register_plugin

cleanup() {
    # Ignore further TERM/INT so cleanup never runs twice or dies mid-tail.
    trap '' SIGTERM SIGINT
    echo "[INFO] Shutting down..."
    local status=0
    if [ -n "$OPENCODE_PID" ]; then
        kill -TERM "$OPENCODE_PID" 2>/dev/null || true
        wait "$OPENCODE_PID" 2>/dev/null || status=$?
    fi
    # Normalize clean/signal-initiated stops; preserve other child failures.
    case "$status" in
        0 | 130 | 143) status=0 ;;
    esac
    if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        local unmount_status=0
        fusermount -u "$MOUNT_POINT" 2>/dev/null || unmount_status=$?
        if [ "$status" -eq 0 ] && [ "$unmount_status" -ne 0 ]; then
            status=$unmount_status
        fi
    fi
    if [ "$status" -eq 0 ]; then
        echo "[INFO] Cleanup complete (status 0)"
    else
        echo "[ERROR] Cleanup complete (status $status)"
    fi
    exit "$status"
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
