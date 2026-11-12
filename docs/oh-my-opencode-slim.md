# OpenCode orchestration plugin in the container

> [English](oh-my-opencode-slim.md) | [简体中文](oh-my-opencode-slim.zh-CN.md)

v2 images bundle [`oh-my-opencode-slim`](https://www.npmjs.com/package/oh-my-opencode-slim): an
orchestrator that plans work, dispatches specialist agents (`oracle`, `explorer`,
`designer`, `fixer`, `observer`) in child sessions, and keeps the main context small.
v1 images are untouched.

## What is in the image

```text
build time
  /opt/opencode-plugins.tar.zst        25 MB   zstd archive, v2 only
    └── node_modules/oh-my-opencode-slim        10 MB
    └── node_modules/…                          optional deps kept (see below)

boot time (every start)
  /opt/opencode-plugins/                229 MB  extracted to the instance disk
```

The archive is ~25 MB instead of ~229 MB because Cloudflare containers rebuild
their disk from the image on every start, so shipping the expanded tree would
only pad the image. Extraction is measured at **~0.4 s** on the instance-local
disk (`zstd -dc | tar -xf`), which keeps the plugin off the FUSE-mounted S3
workspace. `zstd` is installed in the image for this reason; gzip measured
1.0 s and produced a 38 MB archive.

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

| Goal                | Action                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Bump the plugin     | edit `docker/opencode-plugins/package.json`, regenerate `package-lock.json`, rebuild             |
| Drop it again       | set `image_vars.OPENCODE_MAJOR` to `"1"`, or remove the `RUN` block and the two entrypoint calls |
| Different preset    | edit `oh-my-opencode-slim.json` (image default or S3 copy)                                       |
| Disable, no rebuild | put `"-oh-my-opencode-slim"` in the `plugins` array and reload                                   |

Deleting the plugin path from `opencode.json` is not enough: `register_plugin`
re-adds it on the next boot while the bundle is present. The `-` prefixed entry
is respected instead — `register_plugin` sees it and leaves the array alone.

## Model presets

The bundled file contains two presets; `preset` selects the active one.

| preset                  | orchestrator                  | oracle                      | explorer                          | designer                     | fixer                       | observer                      |
| ----------------------- | ----------------------------- | --------------------------- | --------------------------------- | ---------------------------- | --------------------------- | ----------------------------- |
| `opencode-go` (default) | `opencode/gpt-6.1-sol` (high) | `opencode-go/glm-5.3`       | `opencode-go/deepseek-v4.1-flash` | `opencode/gemini-3.8-flash`  | `opencode-go/mimo-v2.6-pro` | `opencode-go/mimo-v2.6-flash` |
| `openai`                | `openai/gpt-6-sol` (high)     | `openai/gpt-6-astra` (high) | `openai/gpt-6-luna` (low)         | `openai/gpt-6-luna` (medium) | `openai/gpt-6-luna` (high)  | `openai/gpt-6-luna` (low)     |

Without a `preset`, every agent follows the session model: usable, but it gives
up the cost split between a strong orchestrator and cheap workers.

Roles, if you replace the preset:

| Agent          | Needs                                 | Usual tier             |
| -------------- | ------------------------------------- | ---------------------- |
| `orchestrator` | long context, reliable tool calls     | strong, high effort    |
| `oracle`       | strongest reasoning, read-only        | strongest, high effort |
| `explorer`     | fast, cheap, read-only search         | cheap, low effort      |
| `designer`     | **image input** (screenshots)         | mid, medium effort     |
| `fixer`        | multi-file edits                      | mid, high effort       |
| `observer`     | multimodal, disabled when unreachable | cheap vision model     |

### Confirm model IDs before saving

`model` is not validated: a wrong ID fails at subagent creation instead of
degrading. Read the catalog from inside the container:

```bash
curl -s -u "opencode:__PW__" http://127.0.0.1:2633/api/model \
| python3 -c 'import json,sys
for m in json.load(sys.stdin)["data"]:
    v = ",".join(x["id"] for x in (m.get("variants") or []))
    print(m["providerID"] + "/" + m["modelID"] + ("  #" + v if v else ""))'
```

`__PW__` is the container API password (`OPENCODE_PASSWORD`, or `SERVER_PASSWORD`
when that is unset). Variants are model specific: only use values printed after
`#`, and omit `variant` when unsure, an unknown one is a model-resolution error.

### Apply and verify

1. Edit `/root/s3/.opencode/config/opencode/oh-my-opencode-slim.json` (or the
   project-level `.opencode/oh-my-opencode-slim.jsonc`, which wins).
2. Validate: `python3 -m json.tool <file> >/dev/null && echo OK`.
3. Reload: `curl -s -X POST -u "opencode:__PW__" http://127.0.0.1:2633/api/location/reload`.
4. Confirm what each agent resolved to:

```bash
curl -s -u "opencode:__PW__" http://127.0.0.1:2633/api/agent \
| python3 -c 'import json,sys
for a in json.load(sys.stdin)["data"]:
    m = a.get("model") or {}
    print(a["id"], "->", m.get("providerID","?") + "/" + m.get("id","?"), m.get("variant",""))'
```

Agent registration does not re-run on a file change alone, and FUSE edits may not
fire the watcher, so always reload before inspecting `/api/agent`.

## Rollback

Remove `preset` (and `presets` if you like), then reload: new sessions fall back
to the session model. No container restart or image rebuild is needed.

For the whole feature, set `image_vars.OPENCODE_MAJOR` to `"1"` (v1 has no
bundle), or keep v2 and disable just this plugin with the `-` entry above.

## Troubleshooting

| Symptom                                  | Cause                                                          | Fix                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `orchestrator` missing from `/api/agent` | plugin not loaded                                              | check the boot log for `Registered OpenCode plugin`, and that `/opt/opencode-plugins.tar.zst` was extracted |
| `Cannot find module 'jsdom'`             | optional dependencies were omitted from the bundle             | rebuild without `--omit=optional`; the shipped bundle keeps them                                            |
| `sg: group 'run' does not exist`         | `ast_grep_*` fell back to `/usr/bin/sg`                        | ensure `@ast-grep/cli` is in the bundle (it is, in the default build)                                       |
| `PresetResolutionError`                  | `preset` name or `extends` target missing                      | align the names                                                                                             |
| `Model unavailable: provider/model`      | provider not connected, or an ID typo                          | re-list models and re-check the ID                                                                          |
| Model-resolution error naming a variant  | the model does not offer it                                    | remove `variant`                                                                                            |
| Agents still show the old model          | the session is bound to an old snapshot                        | create a new session, or reload                                                                             |
| Edits have no effect                     | wrong file (edited `/opt/config-init` or `~/.config/opencode`) | edit `/root/s3/.opencode/config/opencode/oh-my-opencode-slim.json`                                          |

## Verification

```text
payload            extract   disk    jsdom   @ast-grep/cli
full (default)     0.4 s     229 MB  ok      ok
--omit=optional    0.8 s      95 MB  missing missing
```

Both payloads load the plugin in a container started with `--network none`,
which is the important property: the image needs registry access only at build
time. After extraction, `GET /api/agent` lists the OMS roster next to the
built-in agents (`build`, `plan`, `compaction`, `title`, `summary`).
