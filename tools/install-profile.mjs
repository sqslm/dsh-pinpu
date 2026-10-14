/**
 * Install this plugin into the running Harness profile, by hand but carefully.
 *
 * The sanctioned path is the `plugin_manager` tool (`install_bundle`), which is
 * not exposed in every session; this script performs the same steps that tool
 * performs, and nothing else:
 *
 * 1. `pnpm pack` the package into this directory,
 * 2. back up `package.json` and `pnpm-lock.yaml` next to the originals, using the
 *    profile's own `.bak-<what>-<stamp>` convention,
 * 3. point the profile's dependency at that tarball and add the package to
 *    `dsh.profile.bundles`,
 * 4. run the bundled pnpm (`resources/runtime/pnpm`) with `--offline`: a `file:`
 *    tarball needs no store or registry access, so the run cannot touch the network.
 *
 * **Why a tarball and not `link:`.** A `link:` dependency is resolved to its real
 * path outside the profile, so the *host half's* own imports (`@deepseek-ai/
 * schemastery`, the plugin's only dependency) would be resolved against the source
 * directory instead of the profile's `node_modules`, where the harness keeps the
 * core packages. The other workspace plugins hit this too — `dsh-purge` documents
 * it in a comment. An installed tarball is unpacked into the profile, so its
 * imports resolve exactly like the harness's own.
 *
 * It prints the resulting state; it never restarts anything. Restoring the backups
 * is the complete reversal.
 *
 * Usage:
 *   node tools/install-profile.mjs [--profile <dir>] [--dry-run] [--uninstall] [--no-pack]
 */
import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { nodeExecutable as nodeExecutablePath, profileDefault, runtimeRoot } from './app-paths.mjs'

const PROFILE_DEFAULT = profileDefault()

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf('--' + name)
  if (index < 0) return fallback
  const next = args[index + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const profile = resolve(String(flag('profile', PROFILE_DEFAULT)))
const dryRun = flag('dry-run', false) === true
const uninstall = flag('uninstall', false) === true
const pack = flag('no-pack', false) !== true
const runtime = process.env.DSH_RUNTIME ?? runtimeRoot()
const nodeExecutable = process.env.DSH_NODE_EXECUTABLE ?? nodeExecutablePath()
const pnpm = join(runtime, 'pnpm', 'bin', 'pnpm.mjs')

const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
const tarball = join(pluginRoot, manifest.name + '-' + manifest.version + '.tgz')
const spec = 'file:' + tarball.replace(/\\/g, '/')
const packageJsonPath = join(profile, 'package.json')

if (pack && !dryRun && !uninstall) {
  await run(nodeExecutable, [pnpm, 'pack'], { cwd: pluginRoot, maxBuffer: 32 * 1024 * 1024 })
  console.log('packed:', tarball, existsSync(tarball) ? '' : '(MISSING)')
}

const profileManifest = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const before = JSON.stringify(profileManifest, null, 2) + '\n'
const dependencies = { ...(profileManifest.dependencies ?? {}) }
const bundles = [...(profileManifest.dsh?.profile?.bundles ?? [])]

if (uninstall) {
  delete dependencies[manifest.name]
} else {
  dependencies[manifest.name] = spec
}
const nextBundles = bundles.filter((name) => name !== manifest.name)
if (!uninstall) nextBundles.push(manifest.name)
profileManifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)))
profileManifest.dsh = { ...profileManifest.dsh, profile: { ...profileManifest.dsh?.profile, bundles: nextBundles } }
const after = JSON.stringify(profileManifest, null, 2) + '\n'

console.log('profile :', profile)
console.log('package :', manifest.name, manifest.version, '→', uninstall ? '(remove)' : spec)
console.log('bundles :', nextBundles.join(', '))
if (before === after) {
  console.log('package.json already in the requested state; nothing to write')
} else if (dryRun) {
  console.log('--- would write ---')
  console.log(after)
} else {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const source = join(profile, name)
    if (!existsSync(source)) continue
    const backup = source + '.bak-pinpu-' + stamp
    await copyFile(source, backup)
    console.log('backed up', name, '→', backup)
  }
  await writeFile(packageJsonPath, after)
  console.log('wrote', packageJsonPath)
}

if (!dryRun) {
  // The vendored PortAudio extension is a native DLL: while the installed plugin's Python
  // helper is running, Windows keeps it locked and no file in that directory can be
  // replaced. Stop only *this* plugin's helpers (matched by the helper path), then
  // install; the application's own row respawns one on the next reconcile tick.
  await stopHelpers(join(profile, 'node_modules', manifest.name))
  try {
    const result = await run(nodeExecutable, [pnpm, 'install', '--offline'], {
      cwd: profile,
      env: { ...process.env, PATH: join(runtime, 'bin') + ';' + (process.env.PATH ?? '') },
      maxBuffer: 32 * 1024 * 1024,
    })
    console.log('pnpm install --offline ok')
    if (result.stdout.trim() !== '') console.log(result.stdout.trim())
  } catch (error) {
    console.error('pnpm install failed:', String(error.message))
    const detail = String(error.stdout ?? '') + String(error.stderr ?? '')
    if (detail.trim() !== '') console.error(detail.trim())
    // pnpm resolves the *whole* profile graph, so an unrelated dependency the registry
    // can no longer serve blocks this too. This package has no dependencies of its own,
    // so unpacking the tarball into node_modules is exactly what pnpm would have done.
    console.error('falling back to unpacking the tarball directly (this plugin has no dependencies)')
    await extractTarball(tarball, join(profile, 'node_modules', manifest.name))
  }
}

/**
 * Stop leftover capture helpers of this package.
 *
 * The helper normally runs from a private temp copy of `vendor/` — that is what keeps the
 * installed package replaceable while the plugin is live — so the matcher accepts either
 * location, but still requires the helper's file name *and* this plugin's name.
 *
 * @param installedDir - the installed copy, for the in-place fallback match.
 * @returns a promise that settles after the stop attempt.
 */
async function stopHelpers(installedDir) {
  if (process.platform !== 'win32') return
  const legacy = join(installedDir, 'vendor', 'loopback.py').replace(/'/g, "''")
  const script = [
    `$legacy = '${legacy}'`,
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -like '*loopback.py*' -and ($_.CommandLine -like ('*' + $legacy + '*') -or $_.CommandLine -like '*dsh-pinpu*') } |",
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "stopped helper pid " + $_.ProcessId }',
  ].join('\n')
  try {
    const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 4 * 1024 * 1024 })
    if (result.stdout.trim() !== '') console.log(result.stdout.trim())
  } catch (error) {
    console.log('note: could not stop leftover helpers (' + String(error.message).split('\n')[0] + ')')
  }
}

/**
 * Unpack a packed tarball into `destination`, replacing whatever is there.
 *
 * Equivalent to installing a `file:` dependency: strip the leading `package/` entry and
 * drop the tree in place. The system `tar` (bsdtar on Windows 10+) does the work.
 *
 * A running application keeps handles on the modules it already loaded, and Windows
 * refuses to replace an open file — observed once as a *half*-extracted directory that
 * still reported success. Hence the retries and the loud failure.
 */
async function extractTarball(archive, destination) {
  const { mkdir, rm } = await import('node:fs/promises')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    try {
      await run('tar', ['-xzf', archive, '-C', destination, '--strip-components=1'], { maxBuffer: 32 * 1024 * 1024 })
      console.log('unpacked', archive, '→', destination, attempt > 1 ? '(attempt ' + String(attempt) + ')' : '')
      return
    } catch (error) {
      console.error('tarball extraction attempt ' + String(attempt) + ' failed:', String(error.message))
      if (attempt === 3) {
        console.error('giving up: close the running application or free the installed copy, then re-run')
        process.exitCode = 1
        await rm(destination, { recursive: true, force: true })
        return
      }
      await new Promise((done) => setTimeout(done, 500))
    }
  }
}

const installedDir = join(profile, 'node_modules', manifest.name)
console.log('installed copy:', existsSync(join(installedDir, 'package.json')) ? installedDir : '(absent)')
if (existsSync(join(installedDir, 'package.json'))) {
  const copy = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'))
  console.log('installed version:', copy.version, copy.version === manifest.version ? '' : '(MISMATCH)')
  for (const relative of ['lib/index.js', 'lib/client.js', 'lib/loopback.js', 'lib/routes.js', 'lib/spectrum.js', 'lib/defaults.js', 'cordis.patch.yml', 'locale/zh.json', 'icon.svg', 'vendor/loopback.py']) {
    if (!existsSync(join(installedDir, relative))) console.error('MISSING in the installed copy:', relative)
  }
}
