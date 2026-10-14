/**
 * Resolve the app's own design tokens, so a verification page looks like the app.
 *
 * The theme bundle defines the static palette and the alias table twice, once for
 * the default theme and once under `[data-ds-dark-theme]`; aliases point at
 * statics through `var()`. This module extracts those blocks and follows the
 * references, so a preview or probe page can use the real colours instead of
 * hand-copied hex values.
 *
 * Point `DSH_THEME_BUNDLE` at another installation if needed.
 *
 * @module tools/verify/theme
 */
import { existsSync, readFileSync } from 'node:fs'
import { clientBundle } from '../app-paths.mjs'

const DEFAULT_BUNDLE = clientBundle('dsh-client-ui-theme')

/** Tokens this plugin reads, plus the surfaces a preview page needs. */
export const TOKENS = [
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-specific-sidebar-fill',
  '--dsw-specific-input-major',
]

/** Collect every `--name: value` declaration inside blocks matching `selector`. */
function declarations(source, selector, into) {
  const pattern = new RegExp(selector + '\\s*\\{([^}]*)\\}', 'g')
  let block
  while ((block = pattern.exec(source)) !== null) {
    for (const declaration of block[1].split(';')) {
      const match = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(declaration)
      if (match !== null) into.set(match[1], match[2])
    }
  }
  return into
}

/** Follow `var()` references until a literal or a missing token appears. */
function resolve(table, name, depth = 0) {
  const value = table.get(name)
  if (value === undefined) return undefined
  if (depth > 8) return value
  let resolved = value
  let changed = true
  while (changed) {
    changed = false
    resolved = resolved.replace(/var\((--[A-Za-z0-9_-]+)(?:\s*,\s*([^)]*))?\)/g, (_match, reference, fallback) => {
      const next = resolve(table, reference, depth + 1)
      if (next === undefined) return fallback === undefined ? '' : fallback
      changed = true
      return next
    })
  }
  return resolved
}

/**
 * The resolved values of `names` in the dark theme.
 * @param names - token names; defaults to {@link TOKENS}.
 * @returns a `--name: value;` stylesheet fragment.
 */
export function darkTokenCss(names = TOKENS) {
  const bundle = process.env.DSH_THEME_BUNDLE ?? DEFAULT_BUNDLE
  if (!existsSync(bundle)) throw new Error('theme bundle not found: ' + bundle)
  const source = readFileSync(bundle, 'utf8')
  const base = declarations(source, '(:root|html|body|\\[data-ds-light-theme\\])', new Map())
  const dark = declarations(source, '\\[data-ds-dark-theme\\]', new Map())
  const merged = new Map([...base, ...dark])
  const lines = []
  for (const name of names) {
    const value = resolve(merged, name)
    if (value !== undefined && value.trim() !== '' && !value.includes('var(')) lines.push(name + ':' + value + ';')
  }
  return lines.join('\n')
}
