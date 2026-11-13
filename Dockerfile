FROM nikolaik/python-nodejs:python3.15-nodejs26

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
# The apt caches are BuildKit mounts: they speed up rebuilds and never land in a
# layer, so there is nothing to clean up afterwards.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
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
      curl \
      zstd; \
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
    opencode --version

# Copy preset config
COPY config /opt/config-init

# Plugin manifest and lockfile. `npm ci` pins transitive versions, so a rebuild
# cannot pull a different `effect` beta or ast-grep release.
COPY docker/opencode-plugins /opt/opencode-plugins-src

# Bundle the orchestration plugin as a tarball, v2 only. Installing it into the
# image as-is would cost ~229 MB; the zstd archive is ~25 MB and the entrypoint
# extracts it to the instance's ephemeral disk (~0.4 s) on every boot.
# optionalDependencies stay installed on purpose: omitting them drops jsdom
# (webfetch on HTML pages) and @ast-grep/cli (ast_grep_* tools).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    if [ "${OPENCODE_MAJOR}" = "2" ]; then \
      set -eux; \
      cd /opt/opencode-plugins-src; \
      npm ci --omit=dev --no-audit --no-fund; \
      tar -cf - node_modules | zstd -19 -T0 -q -o /opt/opencode-plugins.tar.zst; \
      cd /; \
      rm -rf /opt/opencode-plugins-src/node_modules; \
    fi

# Create startup script
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

WORKDIR /root/s3/workspace
EXPOSE 2633

CMD ["/entrypoint.sh"]
