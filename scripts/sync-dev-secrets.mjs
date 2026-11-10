#!/usr/bin/env node
// Upload provider keys from .dev.vars to the deployed Worker as secrets.
// Only the keys listed below are read; local-only values such as HTTP_PROXY stay local.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const KEYS = ['OPENCODE_API_KEY']
const FILE = process.env.DEV_VARS_FILE ?? '.dev.vars'

if (!existsSync(FILE)) {
  console.error(`[WARN] ${FILE} not found; skipping secret sync`)
  process.exit(0)
}

const values = {}

for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) {
    continue
  }

  const [, key, raw] = match
  if (!KEYS.includes(key)) {
    continue
  }

  let value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  } else {
    const comment = value.search(/\s#/)
    if (comment !== -1) {
      value = value.slice(0, comment).trim()
    }
  }

  if (value) {
    values[key] = value
  }
}

const found = Object.keys(values)
if (found.length === 0) {
  console.error(`[WARN] no provider keys found in ${FILE}; skipping secret sync`)
  process.exit(0)
}

if (process.argv.includes('--dry-run')) {
  console.error(`[INFO] dry run: would sync ${found.join(', ')}`)
  process.exit(0)
}

console.error(`[INFO] syncing ${found.join(', ')}`)

try {
  execFileSync('pnpm', ['exec', 'wrangler', 'secret', 'bulk'], {
    input: JSON.stringify(values),
    stdio: ['pipe', 'inherit', 'inherit'],
  })
} catch {
  // A first deployment has no Worker yet; deploy and run this command again.
  console.error(
    '[ERROR] secret upload failed; deploy first if the Worker does not exist yet, then re-run this command',
  )
  process.exit(1)
}
