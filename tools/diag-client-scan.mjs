/**
 * Diagnose whether a plugin's browser half can be *discovered and mounted*.
 *
 * The browser half does not load through the Loader the way the host half does: the
 * `dsh-client-modules` service scans every mounted row's manifest for a `dsh.client`
 * declaration plus an `exports["./client"]` bundle, composes the module graph, and
 * serves it to the renderer. A row whose host half runs while its client half is
 * never served looks exactly like "the plugin does nothing on screen".
 *
 * The scan helpers are extracted from the installed `@deepseek-ai/dsh-client-modules`
 * bundle and run against real manifests, so a mismatch between what a plugin declares
 * and what the scan accepts is visible without restarting the application. Pass a
 * known-good package (e.g. `dsh-plugin-proxy`) to compare.
 *
 * Usage:
 *   node tools/diag-client-scan.mjs [packageName] [--profile <dir>] [--compare <name>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { appModules, clientBundle, profileDefault } from './app-paths.mjs'

const PROFILE_DEFAULT = profileDefault()
// The loader lives in the package's host entry (`lib/index.js`), not its browser bundle.
const BUNDLE = process.env.DSH_CLIENT_MODULES_BUNDLE ?? clientBundle('dsh-client-modules', 'lib/index.js')
const APP_MODULES = appModules()

const args = process.argv.slice(2)
const packageName = args.find((argument) => !argument.startsWith('--')) ?? 'dsh-pinpu'
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const profile = resolve(flag('profile', PROFILE_DEFAULT))
const compare = flag('compare', 'dsh-plugin-proxy')

/** Pull one top-level `function name(...) { ... }` out of the bundle by brace matching. */
function extractFunction(source, name) {
  const signature = 'function ' + name + '('
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('not found in the bundle: ' + name)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

const bundle = readFileSync(BUNDLE, 'utf8')
const sandbox = { console, json: JSON, Object, Array, Error, String }
vm.createContext(sandbox)
vm.runInContext(
  ['optionalStringArray', 'parseDshClient', 'clientExportOf', 'exactPackageSpecifier', 'stripClientSuffix']
    .map((name) => extractFunction(bundle, name))
    .join('\n'),
  sandbox,
  { filename: 'client-modules-scan.js' },
)

const requireFromProfile = createRequire(join(profile, 'package.json'))

/** Where a specifier resolves for the profile, and for the application's own tree. */
function locate(specifier) {
  for (const [base, label] of [
    [profile, 'profile'],
    [APP_MODULES, 'app'],
  ]) {
    try {
      return { path: createRequire(join(base, 'noop.js')).resolve(specifier + '/package.json'), from: label }
    } catch {
      /* try the next base */
    }
  }
  return undefined
}

function inspect(name) {
  const located = locate(name)
  console.log('\n=== ' + name + ' ===')
  if (located === undefined) {
    console.log('manifest: NOT RESOLVABLE from the profile or the app tree')
    return
  }
  const manifest = JSON.parse(readFileSync(located.path, 'utf8'))
  console.log('manifest     :', located.path, '(resolved via ' + located.from + ')')
  console.log('declares     :', JSON.stringify(manifest.dsh?.client ?? null))
  const decl = sandbox.parseDshClient(manifest.name, manifest.dsh?.client)
  if (decl === undefined) {
    console.log('verdict      : not a client package (scan skips it)')
    return
  }
  if (decl.platform !== 'web') {
    console.log('verdict      : platform is "' + String(decl.platform) + '", the web scan skips it')
    return
  }
  const relative = sandbox.clientExportOf(manifest.name, manifest.exports)
  console.log('clientExport :', relative === undefined ? 'UNDEFINED — the scan would throw' : relative)
  if (relative !== undefined) {
    const clientPath = join(dirname(located.path), relative)
    if (!existsSync(clientPath)) {
      console.log('bundle       : MISSING on disk:', clientPath)
    } else {
      const text = readFileSync(clientPath, 'utf8')
      const id = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)/.exec(text)
      console.log('bundle       :', text.length, 'bytes |', 'registers as', id === null ? '(no id found!)' : '"' + id[1] + '"')
      // `<id>/client` is what a bundle *importing* another client half asks for, and the
      // graph normalizes it onto the bare package name; both spellings are valid ids.
      if (id !== null && id[1] !== manifest.name && id[1] !== manifest.name + '/client') {
        console.log('             : MISMATCH — the loader looks for "' + manifest.name + '"')
      }
    }
  }
  for (const target of decl.inject ?? []) {
    const found = locate(target)
    if (found === undefined) {
      console.log('inject       :', target, '-> NOT RESOLVABLE (composition may drop this row)')
      continue
    }
    const dependency = JSON.parse(readFileSync(found.path, 'utf8'))
    const isClient = sandbox.parseDshClient(dependency.name, dependency.dsh?.client) !== undefined
    console.log('inject       :', target, '->', isClient ? 'client package (ok)' : 'NOT a client package (no graph edge)')
  }
}

inspect(packageName)
if (compare !== '' && compare !== packageName) inspect(compare)

// The Loader resolves a row's name from the tree that owns it; both must work.
console.log('\n=== loader resolution ===')
for (const name of [packageName, compare].filter((entry, index, list) => entry !== '' && list.indexOf(entry) === index)) {
  for (const specifier of [name, name + '/client']) {
    try {
      console.log(specifier.padEnd(28), '->', requireFromProfile.resolve(specifier))
    } catch (error) {
      console.log(specifier.padEnd(28), '-> FAILED:', error.code ?? error.message)
    }
  }
}
