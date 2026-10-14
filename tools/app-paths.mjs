/**
 * Where the DeepSeek Harness installation lives, for the tools in this repository.
 *
 * Developed tools tend to grow absolute paths to one developer's checkout, which then
 * silently break for everyone else — and quietly publish that developer's directory layout.
 * Everything here is resolved instead, from the environment, from the app's own layout, or
 * from the link a development checkout already has to the app's modules.
 *
 * Resolution order, most specific first:
 * 1. `DSH_INSTALL` — the install root (`…/deepseek-harness` or `…/DeepSeek Harness`)
 * 2. the repository's own `node_modules`: a dev checkout links it to
 *    `<install>/resources/app/dsh/node_modules`, which names the install exactly
 * 3. the per-user install location the desktop app uses by default
 *
 * Individual paths can be overridden with `DSH_RUNTIME`, `DSH_APP_MODULES`,
 * `DSH_NODE_EXECUTABLE` and `DSH_PYTHON`.
 *
 * Every resolver returns a path that **exists** when one can be found, and otherwise falls
 * back to the first candidate so callers can report it. (A resolver that quietly points at
 * a directory that is not there is how a broken installer still looks like a working one.)
 */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsRoot = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(toolsRoot, '..')

/** The plugin's own `node_modules`, which a dev checkout links into the app. */
function linkedModules() {
  const link = join(pluginRoot, 'node_modules')
  if (!existsSync(link)) return null
  try {
    return realpathSync(link)
  } catch {
    return null
  }
}

/** `<install>/resources`, derived from the app's own module path. */
function resourcesFromLink() {
  const linked = linkedModules()
  if (linked === null) return null
  const marker = join('resources', 'app', 'dsh', 'node_modules')
  if (!linked.endsWith(marker)) return null
  return linked.slice(0, linked.length - marker.length + 'resources'.length)
}

/** Every install root worth trying: the override, the link, then the usual per-user path. */
export function installCandidates() {
  const list = []
  const explicit = process.env.DSH_INSTALL
  if (explicit !== undefined && explicit !== '') list.push(explicit)
  const linked = resourcesFromLink()
  if (linked !== null) list.push(dirname(linked))
  const local = process.env.LOCALAPPDATA
  if (local !== undefined && local !== '') list.push(join(local, 'Programs', 'deepseek-harness'))
  // The home-relative form is the same directory in the normal case, but it is the only
  // candidate when `LOCALAPPDATA` is unset.
  list.push(join(homedir(), 'AppData', 'Local', 'Programs', 'deepseek-harness'))
  // `LOCALAPPDATA` and `~/AppData/Local` are the same directory in the normal case, so the
  // list would otherwise carry it twice; keep the first occurrence of each.
  const seen = new Set()
  return list.filter((candidate) => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The install root that exists, else the first candidate. */
export function installRoot() {
  const candidates = installCandidates()
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/** `<install>/resources`: the bundled runtime and the app's own code live here. */
export function resourcesRoot() {
  const candidates = [
    resourcesFromLink(),
    ...installCandidates().map((root) => join(root, 'resources')),
  ].filter((candidate) => typeof candidate === 'string')
  return candidates.find((candidate) => existsSync(candidate)) ?? join(installRoot(), 'resources')
}

/** The app's bundled runtime (node, python, pnpm). */
export function runtimeRoot() {
  const explicit = process.env.DSH_RUNTIME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(resourcesRoot(), 'runtime')
}

/** The app's own `node_modules`, where the shipped client bundles can be read. */
export function appModules() {
  const explicit = process.env.DSH_APP_MODULES
  if (explicit !== undefined && explicit !== '') return explicit
  const linked = linkedModules()
  if (linked !== null && existsSync(join(linked, '@deepseek-ai'))) return linked
  return join(resourcesRoot(), 'app', 'dsh', 'node_modules')
}

/** Path to one shipped package's browser bundle. */
export function clientBundle(packageName, file = 'lib/client.js') {
  return join(appModules(), '@deepseek-ai', packageName, file)
}

/** The bundled Node executable, or `node` from PATH when there is no bundle. */
export function nodeExecutable() {
  const explicit = process.env.DSH_NODE_EXECUTABLE
  if (explicit !== undefined && explicit !== '') return explicit
  const bundled = join(runtimeRoot(), 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  return existsSync(bundled) ? bundled : 'node'
}

/** The bundled Python interpreter, or `python` from PATH when there is no bundle. */
export function pythonExecutable() {
  const explicit = process.env.DSH_PYTHON
  if (explicit !== undefined && explicit !== '') return explicit
  const bundled = join(runtimeRoot(), 'primary-runtime', 'dependencies', 'python', 'python.exe')
  return existsSync(bundled) ? bundled : 'python'
}

/** The desktop profile directory, which is where an installed copy of this plugin ends up. */
export function profileDefault() {
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}
