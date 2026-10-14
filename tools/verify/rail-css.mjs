/**
 * Extract the shipped turn rail's own stylesheet and class-name map.
 *
 * The verification pages must exercise the *real* cascade — the app's rules for
 * `::before`, its `markActive` / `markPreview` / `markBusy` states and the
 * build-hashed class names — otherwise "our `!important` wins" proves nothing. Both
 * are read straight out of the installed `dsh-client-ui-chat` bundle.
 *
 * Point `DSH_CHAT_BUNDLE` at another installation if needed.
 *
 * @module tools/verify/rail-css
 */
import { existsSync, readFileSync } from 'node:fs'
import { clientBundle } from '../app-paths.mjs'

const DEFAULT_BUNDLE = clientBundle('dsh-client-ui-chat')

/**
 * @returns `{ css, names }` — the TurnNavigator stylesheet and its class map
 *   (`slot`, `frame`, `scroller`, `marks`, `mark`, `markActive`, `markBusy`,
 *   `markPreview`, `markUnloaded`, `preview`).
 */
export function loadRailCss(bundlePath = process.env.DSH_CHAT_BUNDLE ?? DEFAULT_BUNDLE) {
  if (!existsSync(bundlePath)) throw new Error('chat bundle not found: ' + bundlePath)
  const source = readFileSync(bundlePath, 'utf8')

  const start = source.indexOf('const css$11 = "')
  if (start < 0) throw new Error('could not find the TurnNavigator stylesheet in ' + bundlePath)
  const from = start + 'const css$11 = "'.length
  let end = from
  while (end < source.length) {
    if (source[end] === '\\') {
      end += 2
      continue
    }
    if (source[end] === '"') break
    end += 1
  }
  const css = source.slice(from, end).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  if (!css.includes('.xpvNua_slot{')) throw new Error('extracted stylesheet does not look like TurnNavigator')

  const mapStart = source.indexOf('TurnNavigator_module_css_default = {')
  if (mapStart < 0) throw new Error('could not find the TurnNavigator class map')
  const mapEnd = source.indexOf('};', mapStart)
  const mapText = source.slice(mapStart, mapEnd)
  const names = {}
  for (const match of mapText.matchAll(/"([A-Za-z0-9_]+)"\s*:\s*"([^"]+)"/g)) {
    names[match[1]] = match[2]
  }
  for (const required of ['slot', 'frame', 'scroller', 'marks', 'mark', 'markActive', 'markBusy', 'markPreview', 'markUnloaded']) {
    if (typeof names[required] !== 'string') throw new Error('class map is missing "' + required + '"')
  }
  return { css, names, bundlePath }
}
