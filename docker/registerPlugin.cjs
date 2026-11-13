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
  (plugin) =>
    typeof plugin === 'string' && plugin.startsWith('-') && plugin.includes('oh-my-opencode-slim'),
)
if (plugins.includes(entry) || disabled) {
  process.exit(0)
}

plugins.push(entry)
config.plugins = plugins
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log('[INFO] Registered OpenCode plugin')
