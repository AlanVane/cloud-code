#!/usr/bin/env node
// Runtime smoke tests for the v2 container image and the Worker path.
//
// Phase A boots the built image (CMD /entrypoint.sh) with a dummy
// OPENCODE_PASSWORD only: no model, S3 or cloud credentials and no host mounts.
// Phase B repeats the checks through `pnpm exec wrangler dev` (Worker -> DO ->
// container) with dummy --var credentials and no .dev.vars. No prompts or model
// calls are ever made; sessions are created empty (title only).
//
// Contracts pinned from docs/local-e2e.md, docs/oh-my-opencode-slim.md and the
// pinned OpenCode 2.2.5 release:
//   - GET /api/info -> { version, pid, ... } at the top level (no ready field).
//   - GET /api/agent -> { location, data: [{ id, ... }] }; the plugin-loaded
//     sentinel is the agent id "orchestrator" (oh-my-opencode-slim). Archive
//     presence alone never counts as "plugin loaded".
//   - GET /api/plugin (experimental) -> { location, data: [{ source: { type,
//     path }, state: { status } }] }; used as an optional stronger check only.
//   - SSE /api/event: first frame is `server.connected`; POST /api/session
//     { title } -> 200 and emits `session.created`.
//   - wrangler dev accepts repeated `--var KEY:VALUE` (verified on 4.158).
// Uncertainty: session id field names beyond the above are handled leniently;
// the id assertion runs only when the POST response exposes an id. Root HTML
// asset checks are HTTP-level only (no browser rendering claim). FUSE/R2 are
// intentionally not tested: without S3 config the entrypoint uses local mode.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXPECTED_VERSION = '2.2.5'
const IMAGE = process.env.SMOKE_IMAGE ?? 'cloud-code:ci-v2'
const CONTAINER_PORT = 2633
const WORKER_PORT = 8787
// Distinct on purpose: a 200 from /api/info through the Worker proves the
// Authorization header was replaced with the container credential.
const CONTAINER_PASSWORD = 'smoke-opencode-pass'
const GATE_USER = 'smoke-gate'
const GATE_PASSWORD = 'smoke-worker-pass'
const SMOKE_TITLE = 'runtime-smoke'
const READY_TIMEOUT_MS = 120_000
const WORKER_READY_TIMEOUT_MS = 180_000
const EVENT_TIMEOUT_MS = 60_000
const RENEW_TIMEOUT_MS = 30_000
const POLL_MS = 500

const LOG_DIR = join(
  process.env.RUNNER_TEMP ?? '/tmp',
  `runtime-smoke-${process.pid}-${Date.now()}`,
)
const failures = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
const eventType = (event) => event?.type ?? event?.data?.type ?? event?.payload?.type

function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    failures.push(label)
  }
  return ok
}

function info(label) {
  console.log(`INFO  ${label}`)
}

function saveLog(name, text) {
  const path = join(LOG_DIR, name)
  writeFileSync(path, text)
  info(`logs saved: ${path}`)
}

function docker(args, timeoutMs = 30_000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs })
}

function dockerLogs(name) {
  const res = docker(['logs', name])
  return `${res.stdout ?? ''}${res.stderr ?? ''}`
}

async function http(url, { method = 'GET', auth, headers = {}, body, timeoutMs = 15_000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(auth ? { Authorization: auth } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json }
  } catch (error) {
    return { status: 0, contentType: '', text: '', json: undefined, error: String(error) }
  }
}

// SSE framing that survives chunk splits and multi-line data fields.
function createSseParser(onEvent) {
  let buffer = ''
  let dataLines = []
  const flush = () => {
    if (dataLines.length === 0) {
      return
    }
    const payload = dataLines.join('\n')
    dataLines = []
    try {
      onEvent(JSON.parse(payload))
    } catch {
      // Ignore non-JSON frames (pings, comments)
    }
  }
  return {
    push(chunk) {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          flush()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        nl = buffer.indexOf('\n')
      }
    },
    end() {
      flush()
    },
  }
}

function extractAssets(html) {
  const urls = []
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = match[1]
    if (/\.(?:js|mjs|css)(?:[?#]|$)/.test(url)) {
      urls.push(url)
    }
  }
  return [...new Set(urls)]
}

function extractSessionId(json) {
  return (
    json?.id ??
    json?.data?.id ??
    json?.data?.session?.id ??
    json?.session?.id ??
    json?.data?.sessionID ??
    json?.data?.sessionId
  )
}

function hasAgent(json, id) {
  return Array.isArray(json?.data) && json.data.some((agent) => agent?.id === id)
}

function isExpectedVersion(version) {
  const value = String(version ?? '').replace(/^v/, '')
  return value === EXPECTED_VERSION || value.startsWith(`${EXPECTED_VERSION}-`)
}

// Triage startup logs: real errors fail the smoke, warnings are reported only.
function scanStartupLog(text) {
  const errors = []
  const warnings = []
  for (const line of text.split('\n')) {
    if (/\[ERROR\]|FATAL|panic:/.test(line)) {
      errors.push(line.trim())
    } else if (/\[WARN\]/.test(line)) {
      warnings.push(line.trim())
    }
  }
  return { errors, warnings }
}

async function waitForReady(base, auth, timeoutMs, keepWaiting) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    if (keepWaiting && !keepWaiting()) {
      return { ready: false, response: last, aborted: true }
    }
    last = await http(`${base}/api/info`, { auth })
    if (last.status === 200 && last.json && typeof last.json.version === 'string') {
      return { ready: true, response: last, aborted: false }
    }
    await sleep(POLL_MS)
  }
  return { ready: false, response: last, aborted: false }
}

async function pollFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(POLL_MS)
  }
  return predicate()
}

function checkInfoContract(response, label) {
  check(response.json !== undefined, `${label}: /api/info returns JSON, not SPA fallback`)
  check(!response.contentType.includes('text/html'), `${label}: /api/info is not text/html`)
  check(
    isExpectedVersion(response.json?.version),
    `${label}: /api/info version is ${EXPECTED_VERSION}`,
  )
}

async function checkAuthNegatives(base, wrongAuth, label) {
  const missing = await http(`${base}/api/info`)
  check(missing.status === 401, `${label}: /api/info without credentials is 401`)
  const wrong = await http(`${base}/api/info`, { auth: wrongAuth })
  check(wrong.status === 401, `${label}: /api/info with wrong password is 401`)
}

async function checkHtmlAssets(base, auth, label) {
  const root = await http(`${base}/`, { auth })
  const rootOk = check(
    root.status === 200 && root.contentType.includes('text/html'),
    `${label}: root HTML is 200 text/html`,
  )
  if (!rootOk) {
    return
  }
  const assets = extractAssets(root.text).slice(0, 8)
  if (!check(assets.length > 0, `${label}: root HTML references a JS/CSS entrypoint`)) {
    return
  }
  const rootUrl = new URL(base)
  let fetchedOk = 0
  for (const asset of assets) {
    const url = new URL(asset, rootUrl)
    if (url.host !== rootUrl.host) {
      info(`${label}: skipping cross-origin asset ${asset}`)
      continue
    }
    const res = await http(url.toString(), { auth })
    const ok = res.status === 200 && !res.contentType.includes('text/html')
    check(ok, `${label}: asset ${asset} fetched OK`)
    if (ok) {
      fetchedOk += 1
    }
  }
  check(fetchedOk > 0, `${label}: at least one same-origin JS/CSS asset fetched successfully`)
}

async function checkSseSession(base, auth, label) {
  const controller = new AbortController()
  const events = []
  const parser = createSseParser((event) => events.push(event))
  let pump = null
  try {
    let res
    try {
      res = await fetch(`${base}/api/event`, {
        headers: { Authorization: auth, Accept: 'text/event-stream' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(EVENT_TIMEOUT_MS)]),
      })
    } catch (error) {
      check(false, `${label}: /api/event reachable (${error})`)
      return
    }
    const sseOk = res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')
    if (!check(sseOk, `${label}: /api/event is a text/event-stream`)) {
      return
    }
    pump = (async () => {
      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          parser.push(decoder.decode(value, { stream: true }))
        }
        parser.end()
      } catch {
        // Aborted on purpose once the checks are done
      }
    })()

    // Create one empty session (title only, never a prompt) while the reader is
    // already attached, so session.created cannot be missed.
    const created = await http(`${base}/api/session`, {
      method: 'POST',
      auth,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: SMOKE_TITLE }),
      timeoutMs: 20_000,
    })
    check(created.status === 200, `${label}: POST /api/session {title} returns 200`)
    const postSessionId = extractSessionId(created.json)

    const deadline = Date.now() + EVENT_TIMEOUT_MS
    let first = null
    let createdEvent = null
    while (Date.now() < deadline) {
      first ??= events[0] ?? null
      createdEvent ??= events.find((event) => eventType(event) === 'session.created') ?? null
      if (first && createdEvent) {
        break
      }
      await sleep(POLL_MS)
    }

    if (check(Boolean(first), `${label}: SSE initial frame received`)) {
      check(
        eventType(first) === 'server.connected',
        `${label}: first SSE frame is server.connected`,
      )
    }
    if (check(Boolean(createdEvent), `${label}: session.created emitted after POST /api/session`)) {
      if (postSessionId) {
        check(
          JSON.stringify(createdEvent).includes(postSessionId),
          `${label}: session.created carries the created session id`,
        )
      } else {
        info(`${label}: session id not exposed by the POST response; id assertion skipped`)
      }
    }
  } finally {
    // Always release the stream, including the early return paths above.
    controller.abort()
    if (pump) {
      await pump
    }
  }
}

async function smokeContainer() {
  console.log('\n=== phase A: container /entrypoint.sh ===')
  const name = `runtime-smoke-${process.pid}-${Date.now()}`
  const auth = basic('opencode', CONTAINER_PASSWORD)
  let ready = false
  let created = false
  try {
    const run = docker(
      [
        'run',
        '-d',
        '--name',
        name,
        '-e',
        `OPENCODE_PASSWORD=${CONTAINER_PASSWORD}`,
        '-p',
        `127.0.0.1::${CONTAINER_PORT}`,
        IMAGE,
      ],
      60_000,
    )
    if (
      !check(run.status === 0 && run.stdout.trim().length > 0, `container started from ${IMAGE}`)
    ) {
      info(`docker run output: ${run.stdout}${run.stderr}`)
      return
    }
    info(`container id=${run.stdout.trim()} name=${name}`)
    created = true

    const portRes = docker(['port', name, `${CONTAINER_PORT}/tcp`])
    const port = Number(portRes.stdout.trim().split(':').pop())
    if (!check(Number.isInteger(port) && port > 0, 'ephemeral port published on 127.0.0.1')) {
      return
    }
    const base = `http://127.0.0.1:${port}`

    const readyResult = await waitForReady(base, auth, READY_TIMEOUT_MS)
    ready = readyResult.ready
    if (
      !check(ready, `container /api/info ready within ${READY_TIMEOUT_MS / 1000}s (opencode:dummy)`)
    ) {
      info(
        `last response: status=${readyResult.response?.status} error=${readyResult.response?.error ?? ''}`,
      )
      return
    }
    checkInfoContract(readyResult.response, 'container')
    await checkAuthNegatives(base, basic('opencode', 'wrong-password'), 'container')
    await checkHtmlAssets(base, auth, 'container')
    await checkSseSession(base, auth, 'container')

    // Plugin extraction/registration, then the runtime proof that the plugin
    // actually loaded: its sentinel agent must be exposed by /api/agent.
    const logs = dockerLogs(name)
    check(
      logs.includes('[INFO] Extracted OpenCode plugin bundle'),
      'container: plugin bundle extracted',
    )
    const grep = docker([
      'exec',
      name,
      'grep',
      '-c',
      'oh-my-opencode-slim',
      '/root/s3/.opencode/config/opencode/opencode.json',
    ])
    check(
      grep.status === 0 && Number(grep.stdout.trim()) > 0,
      'container: plugin registered in opencode.json',
    )
    const agents = await http(`${base}/api/agent`, { auth })
    const agentIds = Array.isArray(agents.json?.data)
      ? agents.json.data.map((agent) => agent?.id)
      : []
    info(`container: /api/agent ids: ${JSON.stringify(agentIds)}`)
    check(
      hasAgent(agents.json, 'orchestrator'),
      'container: /api/agent exposes plugin agent "orchestrator"',
    )
    if (!hasAgent(agents.json, 'fixer')) {
      info('container: agent "fixer" not listed (optional)')
    }
    const plugins = await http(`${base}/api/plugin`, { auth })
    if (plugins.status === 200 && Array.isArray(plugins.json?.data)) {
      const oms = plugins.json.data.find((plugin) =>
        String(plugin?.source?.path ?? '').includes('oh-my-opencode-slim'),
      )
      if (oms) {
        check(
          oms?.state?.status === 'active',
          'container: /api/plugin reports oh-my-opencode-slim active',
        )
      } else {
        info('container: /api/plugin lists no oh-my-opencode-slim entry (id optional)')
      }
    } else {
      info(
        'container: /api/plugin unavailable (experimental); /api/agent sentinel is authoritative',
      )
    }

    // Scan logs collected after the plugin API checks so late startup errors
    // are visible; warnings are reported only.
    const { errors, warnings } = scanStartupLog(dockerLogs(name))
    for (const line of warnings) {
      info(`container log warn: ${line}`)
    }
    check(
      errors.length === 0,
      `container: no startup errors in logs${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}`,
    )
  } finally {
    if (ready) {
      const stopRes = docker(['stop', '-t', '20', name], 60_000)
      check(stopRes.status === 0, 'docker stop exited 0')
      const stateRes = docker(['inspect', '-f', '{{json .State}}', name])
      let state
      try {
        state = JSON.parse(stateRes.stdout)
      } catch {
        state = undefined
      }
      if (check(Boolean(state), 'container state inspectable after stop')) {
        check(state.Running === false, 'container no longer running after stop')
        check(
          state.OOMKilled !== true && state.ExitCode !== 137,
          'container exited without OOM/137',
        )
        if (state.ExitCode !== 0) {
          info(`container exit code ${state.ExitCode} (docker error: ${state.Error || 'none'})`)
        }
      }
      const finalLogs = dockerLogs(name)
      check(
        finalLogs.includes('[INFO] Shutting down...'),
        'entrypoint cleanup log observed on stop',
      )
      saveLog('container.log', finalLogs)
    } else {
      saveLog('container.log', dockerLogs(name))
    }
    const rmRes = docker(['rm', '-f', name], 30_000)
    if (created) {
      check(rmRes.status === 0, `owned container ${name} removed`)
    }
  }
}

async function smokeWorker() {
  console.log('\n=== phase B: wrangler dev (Worker -> DO -> container) ===')
  const base = `http://127.0.0.1:${WORKER_PORT}`
  const gateAuth = basic(GATE_USER, GATE_PASSWORD)
  if (!check(!existsSync('.dev.vars'), 'worktree has no .dev.vars (dummy --var only)')) {
    info('remove or rename .dev.vars before this smoke; refusing to mix config sources')
    return
  }

  const args = [
    'exec',
    'wrangler',
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(WORKER_PORT),
    '--show-interactive-dev-session',
    'false',
    '--var',
    `SERVER_USERNAME:${GATE_USER}`,
    '--var',
    `SERVER_PASSWORD:${GATE_PASSWORD}`,
    '--var',
    `OPENCODE_PASSWORD:${CONTAINER_PASSWORD}`,
  ]
  info(`spawning: pnpm ${args.join(' ')}`)
  const logPath = join(LOG_DIR, 'wrangler.log')
  const logStream = createWriteStream(logPath)
  logStream.on('error', (error) => info(`wrangler log writer error: ${error}`))
  let wranglerOut = ''
  const child = spawn('pnpm', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  let exitResult = null
  let settleExit
  const exitPromise = new Promise((resolve) => {
    settleExit = resolve
  })
  child.once('exit', (code, signal) => {
    exitResult = { code, signal }
    settleExit(exitResult)
  })
  child.once('error', (error) => {
    check(false, `worker: failed to spawn pnpm exec wrangler dev (${error})`)
    // Settle immediately so readiness polling aborts instead of timing out.
    exitResult = { code: null, signal: null, error: String(error) }
    settleExit(exitResult)
  })
  const record = (chunk) => {
    wranglerOut += chunk
    if (wranglerOut.length > 400_000) {
      wranglerOut = wranglerOut.slice(-200_000)
    }
    logStream.write(chunk)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  try {
    const readyResult = await waitForReady(
      base,
      gateAuth,
      WORKER_READY_TIMEOUT_MS,
      () => exitResult === null,
    )
    if (
      !check(
        readyResult.ready,
        `worker: /api/info ready within ${WORKER_READY_TIMEOUT_MS / 1000}s${readyResult.aborted ? ' (wrangler exited early)' : ''}`,
      )
    ) {
      info(
        `last response: status=${readyResult.response?.status} error=${readyResult.response?.error ?? ''}`,
      )
      return
    }
    // A 200 here also proves the Worker replaced Authorization with
    // opencode:<container password>, because the two passwords differ.
    checkInfoContract(readyResult.response, 'worker')
    await checkAuthNegatives(base, basic(GATE_USER, 'wrong-password'), 'worker')
    await checkHtmlAssets(base, gateAuth, 'worker')
    await checkSseSession(base, gateAuth, 'worker')

    // The DO prints this when its own event stream sees session.created.
    const renewSeen = () => wranglerOut.includes('Renewed container activity timeout')
    let renewed = await pollFor(renewSeen, RENEW_TIMEOUT_MS)
    if (!renewed) {
      info('worker: renew log not seen yet; creating one more empty session')
      await http(`${base}/api/session`, {
        method: 'POST',
        auth: gateAuth,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `${SMOKE_TITLE}-retry` }),
        timeoutMs: 20_000,
      })
      renewed = await pollFor(renewSeen, RENEW_TIMEOUT_MS)
    }
    check(renewed, "worker: stdout shows 'Renewed container activity timeout' for session.created")
  } finally {
    // Kill only the process group we spawned, then verify it exited.
    if (exitResult === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone
      }
      const first = await Promise.race([exitPromise, sleep(20_000).then(() => null)])
      if (!first) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone
        }
      }
    }
    const final = exitResult ?? (await Promise.race([exitPromise, sleep(10_000).then(() => null)]))
    if (final?.error) {
      info(`wrangler spawn error: ${final.error}`)
    } else {
      check(Boolean(final), 'worker: wrangler dev process exited after signal')
      if (final) {
        info(`wrangler exit: code=${final.code} signal=${final.signal}`)
      }
    }
    // Stop the writer and wait for flush; the stream file is the full log and
    // must not be overwritten with the truncated wranglerOut buffer.
    await new Promise((resolve) => {
      logStream.once('finish', resolve)
      logStream.end()
    })
    info(`logs saved: ${logPath}`)
    info('no docker cleanup performed (wrangler owns its containers)')
  }
}

function runSelfTest() {
  let failed = 0
  const expect = (ok, label) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  self-test: ${label}`)
    if (!ok) {
      failed += 1
    }
  }

  const events = []
  const parser = createSseParser((event) => events.push(event))
  parser.push('data: {"id":"1","type":"server.connected","data":{}}\n\ndata: {"id"')
  parser.push(':2,"type":"session.created","data":{"id":"s1"}}\n\n')
  parser.end()
  expect(
    events.length === 2 &&
      eventType(events[0]) === 'server.connected' &&
      events[1].data.id === 's1',
    'SSE parser survives chunk splits',
  )

  const split = []
  const splitParser = createSseParser((event) => split.push(event))
  splitParser.push(': ping\n\ndata: {"type":"a"}\n')
  splitParser.push('\ndata: {"type":"b"}\r\n\r\n')
  splitParser.end()
  expect(split.length === 2 && split[1].type === 'b', 'SSE parser ignores comments and CRLF')

  expect(
    JSON.stringify(extractAssets('<script src="/a.js"></script><link href="/a.css">')) ===
      '["/a.js","/a.css"]',
    'asset extraction finds JS and CSS entrypoints',
  )
  expect(
    extractAssets('<script src="x.svg"></script>').length === 0,
    'asset extraction skips non JS/CSS',
  )

  expect(isExpectedVersion('2.2.5') && isExpectedVersion('v2.2.5'), 'version check accepts 2.2.5')
  expect(
    !isExpectedVersion('2.2.50') && !isExpectedVersion('2.2.4'),
    'version check rejects neighbours',
  )

  expect(extractSessionId({ id: 's2' }) === 's2', 'session id from top level')
  expect(extractSessionId({ data: { id: 's3' } }) === 's3', 'session id from data')
  expect(extractSessionId({}) === undefined, 'session id absent -> undefined')

  expect(hasAgent({ data: [{ id: 'orchestrator' }] }, 'orchestrator'), 'agent sentinel matches')
  expect(
    !hasAgent({ data: [{ id: 'fixer' }] }, 'orchestrator'),
    'agent sentinel rejects missing id',
  )

  const scan = scanStartupLog('[WARN] Incomplete S3 config\n[ERROR] S3 mount failed\nFATAL boom')
  expect(
    scan.errors.length === 2 && scan.warnings.length === 1,
    'log triage separates errors from warnings',
  )

  process.exit(failed === 0 ? 0 : 1)
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('FAIL  global fetch unavailable; Node.js 18+ is required')
    process.exit(1)
  }
  mkdirSync(LOG_DIR, { recursive: true })
  info(`log dir: ${LOG_DIR}`)
  await smokeContainer().catch((error) => check(false, `phase A crashed: ${String(error)}`))
  await smokeWorker().catch((error) => check(false, `phase B crashed: ${String(error)}`))
  console.log('\n=== summary ===')
  if (failures.length === 0) {
    console.log('PASS  all runtime smoke checks passed')
  } else {
    console.log(`FAIL  ${failures.length} check(s) failed:`)
    for (const label of failures) {
      console.log(`  - ${label}`)
    }
    info('log tails follow')
    for (const name of ['container.log', 'wrangler.log']) {
      try {
        const text = readFileSync(join(LOG_DIR, name), 'utf8')
        console.log(`--- ${name} (tail) ---`)
        console.log(text.split('\n').slice(-120).join('\n'))
      } catch {
        info(`${name} not available`)
      }
    }
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  await main()
}
