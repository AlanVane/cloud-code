# OpenCode orchestration plugin in the container

> [English](oh-my-opencode-slim.md) | [简体中文](oh-my-opencode-slim.zh-CN.md)

v2 images bundle [`oh-my-opencode-slim`](https://www.npmjs.com/package/oh-my-opencode-slim): an
orchestrator that plans work, dispatches specialist agents (`oracle`, `explorer`,
`designer`, `fixer`, `observer`) in child sessions, and keeps the main context small.
v1 images are untouched.

## What is in the image

```text
build time
  /opt/opencode-plugins.tgz            49 MB   compressed bundle, v2 only
    └── node_modules/oh-my-opencode-slim        10 MB
    └── node_modules/…                          optional deps kept (see below)

boot time (every start)
  /opt/opencode-plugins/                300 MB  extracted to the instance disk
```

The tarball is ~49 MB instead of ~300 MB because Cloudflare containers rebuild
their disk from the image on every start, so shipping the expanded tree would
only pad the image. Extraction is measured at **1.8 s** on the instance-local
disk, which keeps the plugin off the FUSE-mounted S3 workspace.

`optionalDependencies` stay installed deliberately: dropping them removes
`jsdom` (breaks `webfetch` on HTML pages) and `@ast-grep/cli` (breaks the
`ast_grep_*` tools).

## What the entrypoint does

```text
setup_workspace
  └── copies config/opencode/opencode.json, AGENTS.md and
      oh-my-opencode-slim.json into $XDG_CONFIG_HOME/opencode when missing
extract_plugins
  └── tar -xzf /opt/opencode-plugins.tgz -C /opt/opencode-plugins
register_plugin
  └── merges /opt/opencode-plugins/node_modules/oh-my-opencode-slim
      into the `plugins` array of the global opencode.json
```

`register_plugin` is idempotent, keeps any entries you added, and leaves the
file untouched if it is not valid JSON.

## Configuration

Two different files, two owners:

| File                       | Owner      | Contains                                                               |
| -------------------------- | ---------- | ---------------------------------------------------------------------- |
| `opencode.json`            | OpenCode   | `plugins`, `permission`, `autoupdate`                                  |
| `oh-my-opencode-slim.json` | the plugin | `preset`, `presets`, `disabled_agents`, `autoUpdate`, `tui`, `sidebar` |

Both land in `/root/s3/.opencode/config/opencode/` (S3-backed, so edits survive
restarts).

The bundled preset is `opencode-go` with all agents pinned to `opencode` /
`opencode-go` models. Change it in place:

```bash
# inside the container
$EDITOR /root/s3/.opencode/config/opencode/oh-my-opencode-slim.json
```

Deleting the file re-seeds it from the image on the next boot; editing it is
never overwritten.

### Project-level override

The plugin also reads `<project>/.opencode/oh-my-opencode-slim.jsonc`, which
takes precedence over the user config above. Verified on OpenCode 2.2.5 with
plugin 3.0.7: a project file setting `orchestrator` to `gpt-6.1-sol` and
`disabled_agents: ["explorer"]` won over a conflicting user config, and
`/api/agent` reflected it.

### Provider credentials

The preset needs `OPENCODE_API_KEY` (one key covers `opencode` and
`opencode-go`). The Worker forwards every string environment variable to the
container, and `scripts/sync-dev-secrets.mjs` uploads that key with
`pnpm secrets:sync`. See [Deploying to Cloudflare](deployment.md).

## Changing or removing the plugin

| Goal             | Action                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Bump the plugin  | change `ARG OMS_VERSION` in `Dockerfile`, rebuild, redeploy                                      |
| Drop it again    | set `image_vars.OPENCODE_MAJOR` to `"1"`, or remove the `RUN` block and the two entrypoint calls |
| Different preset | edit `oh-my-opencode-slim.json` (image default or S3 copy)                                       |

Removing the plugin path from `opencode.json` by hand is not enough on its own:
`register_plugin` re-adds it on the next boot while the bundle is present.

## Verification

```text
payload            extract   disk    jsdom   @ast-grep/cli
full (default)     1.8 s     300 MB  ok      ok
--omit=optional    0.8 s      95 MB  missing missing
```

Both payloads load the plugin in a container started with `--network none`,
which is the important property: the image needs registry access only at build
time. After extraction, `GET /api/agent` lists the OMS roster next to the
built-in agents (`build`, `plan`, `compaction`, `title`, `summary`).
