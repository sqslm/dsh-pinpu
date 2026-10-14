/**
 * Where the DeepSeek Harness installation lives, for the tools in this repository.
 *
 * Developed tools tend to grow absolute paths to one developer's checkout, which then
 * silently break for everyone else — and quietly publish that developer's directory
 * layout. Everything here resolves from the environment instead, with the two locations the
 * desktop app actually uses as fallbacks, so the tools work on a fresh machine.
 *
 * Overrides, in order of precedence:
 * - `DSH_INSTALL` — the install root (`…/deepseek-harness` or `…/DeepSeek Harness`)
 * - `DSH_RUNTIME` — the bundled runtime directory (node/python live here)
 * - `DSH_APP_MODULES` — the app's own `node_modules`
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Candidate install roots: an explicit override first, then the usual per-user location. */
export function installCandidates() {
  const list = []
  const explicit = process.env.DSH_INSTALL
  if (explicit !== undefined && explicit !== '') list.push(explicit)
  const local = process.env.LOCALAPPDATA
  if (local !== undefined && local !== '') list.push(join(local, 'Programs', 'deepseek-harness'))
  list.push(join(homedir(), 'AppData', 'Local', 'Programs', 'deepseek-harness'))
  return list
}

/** The first install root that exists, or the first candidate so callers can report it. */
export function installRoot() {
  const candidates = installCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** The app's bundled runtime (node, python, pnpm). */
export function runtimeRoot() {
  const explicit = process.env.DSH_RUNTIME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(installRoot(), 'resources', 'runtime')
}

/** The app's own `node_modules`, where the shipped client bundles can be read. */
export function appModules() {
  const explicit = process.env.DSH_APP_MODULES
  if (explicit !== undefined && explicit !== '') return explicit
  // A development checkout links the app's modules in at the repository root — that is the
  // most reliable signal, and it needs no absolute path from anyone's machine.
  const linked = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
  if (existsSync(join(linked, '@deepseek-ai'))) return linked
  return join(installRoot(), 'resources', 'app', 'dsh', 'node_modules')
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
