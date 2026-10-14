/**
 * Minimal reader for this package's `cordis.patch.yml`.
 *
 * The patch dialect is YAML, but this file's shape is fixed and flat — one
 * `insert:` list, one row, one `config:` map of scalars — so the tests parse it
 * directly instead of depending on a YAML library the plugin does not ship.
 *
 * @module test/helpers/patch
 */
import { readText } from './harness.mjs'

/** Parse one scalar: `true`/`false`, a quoted string, a number, or a bare word. */
function scalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^'/.test(text)) return text.replace(/^'/, '').replace(/'$/, '')
  if (/^"/.test(text)) return text.replace(/^"/, '').replace(/"$/, '')
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/**
 * Read the single inserted row of a bundle patch.
 * @param relative - patch path inside the package.
 * @returns `{ id, name, config, rows, configKeys }`.
 */
export function parseInsertRow(relative = 'cordis.patch.yml') {
  const lines = readText(relative).split(/\r?\n/)
  const rows = []
  let current = null
  let inConfig = false
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const rowMatch = /^(\s*)-\s+id:\s*(.+)$/.exec(line)
    if (rowMatch !== null) {
      current = { id: scalar(rowMatch[2]), name: undefined, config: {} }
      rows.push(current)
      inConfig = false
      continue
    }
    if (current === null) continue
    const nameMatch = /^(\s+)name:\s*(.+)$/.exec(line)
    if (nameMatch !== null) {
      current.name = scalar(nameMatch[2])
      inConfig = false
      continue
    }
    if (/^\s+config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    const fieldMatch = /^(\s+)([A-Za-z][\w]*):\s*(.*)$/.exec(line)
    if (fieldMatch !== null && inConfig) {
      current.config[fieldMatch[2]] = scalar(fieldMatch[3])
      continue
    }
  }
  const row = rows[0]
  if (row === undefined) throw new Error(relative + ': no insert row found')
  row.rows = rows
  row.configKeys = Object.keys(row.config)
  return row
}
