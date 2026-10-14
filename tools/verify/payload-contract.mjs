/**
 * Cross-half payload contract check: feed the *live* spectrum payload to a client bundle.
 *
 * The two halves live in different processes and are loaded by different systems, so the
 * only thing holding them together is the shape of one JSON object. They drifted once —
 * the route sent `levels`, the browser half read `ticks`, every mark froze at its base
 * length while the settings card's peak (a different field) moved normally, and every
 * test passed because the stubs used the other name.
 *
 * This tool closes that gap without restarting anything: it takes the payload the running
 * host actually answers with and asks a real client bundle what it would draw.
 *
 * Usage:
 *   node tools/verify/payload-contract.mjs [--installed] [--ticks 5] [--url URL]
 *   node tools/verify/payload-contract.mjs --payload '{"status":"live","levels":[…]}"'
 *
 * `--installed` loads the copy in the profile (`node_modules/dsh-pinpu`), which is what
 * the application window is actually running; the default loads this working tree.
 * `--payload` checks a recorded payload instead of the live route, which makes the check
 * meaningful while the machine is quiet.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/** The desktop profile of whichever user runs this, so nothing is machine-specific. */
const PROFILE_DEFAULT = join(homedir(), '.dsh', 'profiles', 'desktop')

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  const next = index >= 0 ? args[index + 1] : undefined
  return next === undefined || next.startsWith('--') ? fallback : next
}
const ticks = Number(flag('ticks', 6))
const url = String(flag('url', 'http://127.0.0.1:19387/api/dsh-pinpu/spectrum?ticks=' + String(ticks)))
const installed = args.includes('--installed')
const root = installed
  ? String(flag('installed-dir', join(PROFILE_DEFAULT, 'node_modules', 'dsh-pinpu')))
  : pluginRoot
const recorded = flag('payload', undefined)

/** Load a client bundle the way the page does: a classic script registering a factory. */
function loadClient(bundlePath) {
  const registration = { current: null }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registration.current = entry
        },
      },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getComputedStyle: () => ({ animationName: 'none', position: 'static' }),
      location: { href: 'http://127.0.0.1:19387/' },
    },
    document: undefined,
    console,
    URL,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Error,
    String,
    Number,
    Boolean,
    Promise,
    fetch: () => Promise.reject(new Error('no network in the checker')),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: bundlePath })
  if (registration.current === null) throw new Error('the bundle registered nothing')
  const mod = registration.current.factory(() => ({}))
  return { id: registration.current.id, test: mod.__test }
}

const payload =
  recorded === undefined
    ? await (async () => {
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error('the host answered ' + String(response.status) + ' for ' + url)
        return response.json()
      })()
    : JSON.parse(recorded.startsWith('{') ? recorded : readFileSync(recorded, 'utf8'))

const bundle = join(root, 'lib', 'client.js')
const { id, test } = loadClient(bundle)
const levels = test.levelsFrom(payload, ticks, false, 64)
const scales = levels.map((level) => test.scaleFor(level, 0.4, 1))
const distinct = new Set(scales.map((value) => value.toFixed(3))).size
const quiet = payload.silent === true || (Array.isArray(payload.levels) && payload.levels.every((value) => Number(value) === 0))

console.log('client bundle     :', bundle, '(registers as "' + String(id) + '")')
console.log('payload source    :', recorded === undefined ? url : 'recorded')
console.log('host payload keys :', Object.keys(payload).join(', '))
console.log('host levels       :', JSON.stringify(payload.levels))
console.log('host peak/status  :', String(payload.peak), String(payload.status), 'silent=' + String(payload.silent))
console.log('client levels     :', JSON.stringify(levels.map((value) => Math.round(value * 1000) / 1000)))
console.log('client mark scales:', JSON.stringify(scales.map((value) => Math.round(value * 1000) / 1000)))
console.log('distinct scales   :', distinct)
if (quiet) {
  console.log('VERDICT: inconclusive — this payload is silence, so one length is correct')
} else {
  console.log(
    'VERDICT:',
    distinct >= 2
      ? 'the client turns this payload into a moving spectrum'
      : 'the client would draw every mark at the same length — the halves disagree',
  )
  process.exitCode = distinct >= 2 ? 0 : 1
}
