/**
 * Host-half schema, validated with the deployment's own `schemastery`.
 *
 * The plugin ships no dependencies, so the module is loaded against copies of the
 * two core packages the running Harness uses, taken from the installation
 * (`@deepseek-ai/schemastery` and its only runtime dependency, `@deepseek-ai/cosmokit`).
 * Point `DSH_CORE_MODULES` at a different installation, or at a source checkout's
 * `node_modules`, to validate against another build. The whole file is skipped when
 * no installation can be found, so the rest of the suite still runs offline.
 *
 * What it proves:
 * - `Config` builds, accepts an empty row config, resolves every field to a cosmokit
 *   volatile reference (the precondition for the settings form), and rejects values
 *   the form can never send;
 * - unwrapping that resolved config reproduces `lib/defaults.js` exactly;
 * - `apply()` registers the two routes on `webServer`, starts the capture when
 *   enabled, and stops it again when the switch is turned off — without a real
 *   Python or audio device anywhere near it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULTS } from '../lib/defaults.js'
import { appModules, installCandidates } from '../tools/app-paths.mjs'
import { readText } from './helpers/harness.mjs'

const CANDIDATE_ROOTS = [
  process.env.DSH_CORE_MODULES,
  appModules(),
  // The schemastery/cosmokit packages ship inside the app; a dev checkout may have them in
  // a sibling `node_modules` instead, so the install itself is probed first.
  ...installCandidates().map((root) => join(root, 'resources', 'app', 'dsh', 'node_modules')),
].filter((entry) => typeof entry === 'string' && entry !== '')

function findCoreRoot() {
  for (const root of CANDIDATE_ROOTS) {
    const schemastery = join(root, '@deepseek-ai', 'schemastery', 'package.json')
    const cosmokit = join(root, '@deepseek-ai', 'cosmokit', 'package.json')
    if (existsSync(schemastery) && existsSync(cosmokit)) return root
  }
  return undefined
}

const coreRoot = findCoreRoot()

/** Unwrap volatile references the way the host half does. */
function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap)
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function' && Object.isFrozen(value) && Object.keys(value).length === 1 && Object.getOwnPropertySymbols(value).length > 0) {
    return unwrap(value.get())
  }
  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = unwrap(child)
  return out
}

/** Copy the host half next to the core packages' copies and import it. */
async function loadHostSchema() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pinpu-schema-'))
  const modules = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(modules, { recursive: true })
  for (const name of ['schemastery', 'cosmokit']) {
    // Copy the whole package: the exports map (not `main`) decides which file an ESM
    // import resolves to, and both packages are a few tens of kilobytes.
    cpSync(join(coreRoot, '@deepseek-ai', name), join(modules, name), { recursive: true })
  }
  const plugin = join(root, 'plugin')
  mkdirSync(plugin, { recursive: true })
  for (const file of ['index.js', 'defaults.js', 'loopback.js', 'routes.js', 'spectrum.js']) {
    writeFileSync(join(plugin, file), readText('lib/' + file))
  }
  writeFileSync(join(plugin, 'package.json'), readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return import(pathToFileURL(join(plugin, 'index.js')).href)
}

let host
let loadFailure
if (coreRoot !== undefined) {
  try {
    host = await loadHostSchema()
  } catch (error) {
    loadFailure = error
  }
}

const skip =
  coreRoot === undefined
    ? 'no @deepseek-ai/schemastery installation found; set DSH_CORE_MODULES'
    : loadFailure === undefined
      ? false
      : 'could not load the host half against ' + coreRoot + ': ' + String(loadFailure && loadFailure.message)

test('an installation of the core packages was found for this validation', { skip }, () => {
  assert.ok(host !== undefined)
  assert.equal(host.name, 'pinpu')
  assert.deepEqual(host.inject, [])
})

test('Config resolves an empty row to the documented defaults', { skip }, () => {
  assert.deepEqual(unwrap(host.Config({})), DEFAULTS)
})

test('every field is volatile, which is what puts it in the settings form', { skip }, () => {
  const resolved = host.Config({})
  for (const field of Object.keys(DEFAULTS)) {
    const value = resolved[field]
    assert.equal(typeof value, 'object', field + ' must resolve to a reference, not a plain value')
    assert.equal(typeof value.get, 'function', field + ' must carry a getter')
    assert.ok(Object.isFrozen(value), field + ' must be a frozen reference')
  }
})

test('the schema rejects a value the settings form can never send', { skip }, () => {
  assert.throws(() => host.Config({ fftSize: 'large' }))
  assert.throws(() => host.Config({ minScale: {} }))
})

test('plain() reads through a volatile reference and leaves values alone', { skip }, () => {
  assert.equal(host.plain(host.Config({}).enabled), true)
  assert.equal(host.plain(host.Config({ device: '31' }).device), '31')
  assert.equal(host.plain(42), 42)
  assert.equal(host.plain('text'), 'text')
  assert.equal(host.plain(undefined), undefined)
})

/** A ctx stub that records routes and runs effects, without a web server. */
function createHostContext() {
  const routes = new Map()
  const disposers = []
  const scope = {
    effect: (run) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register: (options) => {
        routes.set(options.path, options.handler)
        return () => routes.delete(options.path)
      },
    },
  }
  return {
    routes,
    logger: { info: () => {} },
    effect: scope.effect,
    inject: (names, run) => run(scope),
    disposeAll: () => disposers.forEach((dispose) => dispose()),
  }
}

test('apply() registers the spectrum, device and client routes', { skip }, () => {
  const ctx = createHostContext()
  const dispose = host.apply(ctx, host.Config({ enabled: false }))
  void dispose
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/dsh-pinpu/client',
    '/api/dsh-pinpu/devices',
    '/api/dsh-pinpu/spectrum',
  ])
  ctx.disposeAll()
})

test('the client route records what the browser half reports, and ?diag=1 exposes it', { skip }, async () => {
  // The two halves load through different systems, so a browser half that never ran is
  // indistinguishable from a broken rail unless the host remembers what it heard.
  const ctx = createHostContext()
  host.apply(ctx, host.Config({ enabled: false }))
  const client = ctx.routes.get('/api/dsh-pinpu/client')
  const spectrum = ctx.routes.get('/api/dsh-pinpu/spectrum')
  const call = (handler, url, headers = { host: '127.0.0.1:19387' }) =>
    new Promise((resolve) => {
      const chunks = []
      handler({ method: 'GET', url, headers, socket: { remoteAddress: '127.0.0.1' } }, {
        writeHead: (status) => resolve({ status, body: () => Promise.resolve(Buffer.concat(chunks).toString('utf8')) }),
        end: (chunk) => chunks.push(Buffer.from(String(chunk ?? ''))),
      })
    })

  const recorded = await call(client, '/api/dsh-pinpu/client?event=error&detail=settings-section:%20boom')
  assert.equal(recorded.status, 200)
  assert.deepEqual(JSON.parse(await recorded.body()), { ok: true, recorded: 'error', count: 1 })

  await call(client, '/api/dsh-pinpu/client?event=apply&detail=ready')
  const diag = await call(spectrum, '/api/dsh-pinpu/spectrum?diag=1&ticks=2')
  const payload = JSON.parse(await diag.body())
  assert.equal(payload.client.event, 'apply')
  assert.equal(payload.client.count, 2)
  assert.deepEqual(payload.client.errors, ['settings-section: boom'])
  assert.ok(typeof payload.client.ageMs === 'number')

  const plainPayload = JSON.parse(await (await call(spectrum, '/api/dsh-pinpu/spectrum?ticks=2')).body())
  assert.equal(plainPayload.client, undefined, 'the ordinary poll must not carry diagnostics')
  ctx.disposeAll()
})

test('the spectrum route answers a loopback request and refuses anything else', { skip }, async () => {
  const ctx = createHostContext()
  host.apply(ctx, host.Config({ enabled: false }))
  const handler = ctx.routes.get('/api/dsh-pinpu/spectrum')

  const call = (headers) =>
    new Promise((resolve) => {
      const req = { method: 'GET', url: '/api/dsh-pinpu/spectrum?ticks=4', headers, socket: { remoteAddress: '127.0.0.1' } }
      const res = {
        status: 0,
        writeHead(status) {
          this.status = status
        },
        end(payload) {
          resolve({ status: this.status, body: payload === undefined ? undefined : JSON.parse(payload) })
        },
      }
      handler(req, res)
    })

  const ok = await call({ host: '127.0.0.1:19387' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  // Field-name contract with the browser half (`levelsFrom`): the spectrum is `levels`,
  // already resampled to the requested mark count, and there is no `ticks` field.
  assert.ok(Array.isArray(ok.body.levels), 'the spectrum must travel as `levels`')
  assert.equal(ok.body.levels.length, 4, 'ticks=4 must be resampled to four levels')
  assert.equal(ok.body.ticks, undefined, 'a second name for the same array is how the halves drifted')
  assert.equal(typeof ok.body.status, 'string')
  assert.equal(ok.body.status, 'stopped', 'nothing is capturing in a test')

  const crossSite = await call({ host: '127.0.0.1:19387', origin: 'https://evil.example' })
  assert.equal(crossSite.status, 403)
  const wrongHost = await call({ host: 'evil.example' })
  assert.equal(wrongHost.status, 403)
  ctx.disposeAll()
})

test('the device route reports why it cannot list devices instead of throwing', { skip }, async () => {
  const ctx = createHostContext()
  host.apply(ctx, host.Config({ enabled: false }))
  const handler = ctx.routes.get('/api/dsh-pinpu/devices')
  const answer = await new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/dsh-pinpu/devices', headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        resolve({ status: this.status, body: JSON.parse(payload) })
      },
    }
    handler(req, res)
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.ok(Array.isArray(answer.body.devices))
  ctx.disposeAll()
})

test('the capture is started when enabled, without spawning a real helper', { skip }, async () => {
  // The reconcile timer reads the *live* volatile values on every tick, so what this
  // proves is that an enabled row reaches `capture.start()` at all. The interpreter is
  // hidden (an empty PATH plus a bogus override) so the test spawns nothing: the
  // capture reports `python-missing` instead, which is also the honest status a machine
  // without the runtime would show.
  const ctx = createHostContext()
  const lines = []
  ctx.logger = { info: (text) => lines.push(text) }
  const previousPath = process.env.PATH
  const previousPython = process.env.DSH_PINPU_PYTHON
  process.env.PATH = ''
  process.env.DSH_PINPU_PYTHON = 'C:\\definitely-not-a-python\\python.exe'
  try {
    host.apply(ctx, host.Config({ enabled: true, device: '' }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(
      lines.some((line) => line.includes('"result":"started"')),
      'an enabled plugin must start capturing; log was ' + lines.join(' | '),
    )
    assert.ok(
      lines.some((line) => line.includes('python-missing')),
      'the status must name the missing interpreter; log was ' + lines.join(' | '),
    )
  } finally {
    ctx.disposeAll()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousPython === undefined) delete process.env.DSH_PINPU_PYTHON
    else process.env.DSH_PINPU_PYTHON = previousPython
  }
})
