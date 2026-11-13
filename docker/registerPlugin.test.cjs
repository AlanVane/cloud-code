'use strict'
// Public-seam tests for docker/registerPlugin.cjs: each case invokes the
// helper as a CLI against fixture config files in owned temp dirs. Builtin
// node:test modules only; no network, keys, models or host config access.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HELPER = path.join(__dirname, 'registerPlugin.cjs')
const ENTRY = '/opt/opencode-plugins/node_modules/oh-my-opencode-slim'

function makeTmp(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registerPlugin-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}

// Spawn with an argv array (no shell) so the helper's process.exit stays in
// the child and cannot terminate the test runner.
function runHelper(file, entry = ENTRY) {
  return spawnSync(process.execPath, [HELPER, file, entry], { encoding: 'utf8' })
}

test('missing config file creates plugins array with the entry', (t) => {
  const dir = makeTmp(t)
  const file = path.join(dir, 'opencode.json')
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.match(res.stdout, /\[INFO\] Registered OpenCode plugin/)
  assert.strictEqual(
    fs.readFileSync(file, 'utf8'),
    `${JSON.stringify({ plugins: [ENTRY] }, null, 2)}\n`,
  )
})

test('preserves unknown fields and existing plugins, appends entry', (t) => {
  const dir = makeTmp(t, {
    'opencode.json':
      JSON.stringify({ theme: 'dark', permission: 'allow', plugins: ['./other.js'] }, null, 2) +
      '\n',
  })
  const file = path.join(dir, 'opencode.json')
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    theme: 'dark',
    permission: 'allow',
    plugins: ['./other.js', ENTRY],
  })
})

test('already registered keeps original bytes and mtime', (t) => {
  const content = `${JSON.stringify({ plugins: [ENTRY] }, null, 2)}\n`
  const dir = makeTmp(t, { 'opencode.json': content })
  const file = path.join(dir, 'opencode.json')
  const old = new Date('2000-01-01T00:00:00Z')
  fs.utimesSync(file, old, old)
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), content)
  assert.strictEqual(fs.statSync(file).mtimeMs, old.getTime())
  assert.ok(!res.stdout.includes('[INFO] Registered OpenCode plugin'))
})

test('disabled marker config is left untouched', (t) => {
  const content = `${JSON.stringify({ plugins: ['-oh-my-opencode-slim'] }, null, 2)}\n`
  const dir = makeTmp(t, { 'opencode.json': content })
  const file = path.join(dir, 'opencode.json')
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), content)
  assert.ok(!res.stdout.includes('[INFO] Registered OpenCode plugin'))
})

test('invalid JSON warns, exits 0 and leaves file untouched', (t) => {
  const content = '{ not json'
  const dir = makeTmp(t, { 'opencode.json': content })
  const file = path.join(dir, 'opencode.json')
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.match(res.stderr, /\[WARN\] .* is not valid JSON, leaving it untouched/)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), content)
})

test('non-array plugins is replaced with [entry] (current behavior)', (t) => {
  const dir = makeTmp(t, {
    'opencode.json': JSON.stringify({ plugins: { weird: true }, keep: 1 }, null, 2) + '\n',
  })
  const file = path.join(dir, 'opencode.json')
  const res = runHelper(file)
  assert.strictEqual(res.status, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    plugins: [ENTRY],
    keep: 1,
  })
})
