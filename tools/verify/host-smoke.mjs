/**
 * End-to-end verification of the host half, against whatever is playing right now.
 *
 * It imports the *shipped* `lib/index.js`, builds the real `Config` schema, calls
 * `apply()` with a stand-in Cordis context that records the routes instead of
 * serving them, then requests the spectrum route directly and reports the measured
 * levels, peak and status.
 *
 * This is the whole host path: config → capture process → loopback PCM → FFT →
 * per-band levels → HTTP route payload. Nothing here is simulated except the ctx.
 *
 * Usage:
 *   node tools/verify/host-smoke.mjs [--seconds 3] [--device <name|index>]
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf('--' + name)
  if (index < 0) return fallback
  const next = args[index + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const seconds = Number(flag('seconds', 3))
const device = String(flag('device', ''))

const host = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)

const routes = new Map()
const disposers = []
const lines = []
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
const ctx = {
  logger: { info: (line) => lines.push(line) },
  effect: scope.effect,
  inject: (names, run) => run(scope),
}

const config = host.Config({ device, enabled: true, autoGain: true })
console.log('config fields:', Object.keys(config).length)
host.apply(ctx, config)
console.log('routes registered:', [...routes.keys()].join(', '))

/** Minimal request/response stand-ins for the route handlers. */
function callRoute(path, query) {
  return new Promise((resolve) => {
    const handler = routes.get(path)
    if (handler === undefined) return resolve({ status: 0, body: undefined })
    const req = {
      method: 'GET',
      url: path + (query ?? ''),
      headers: { host: '127.0.0.1:19387' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        let body
        try {
          body = JSON.parse(payload)
        } catch {
          body = payload
        }
        resolve({ status: this.status, body })
      },
    }
    Promise.resolve(handler(req, res)).catch((error) => resolve({ status: -1, body: String(error) }))
  })
}

const devices = await callRoute('/api/dsh-pinpu/devices')
console.log('devices route:', devices.status, devices.body?.ok === true ? (devices.body.devices?.length ?? 0) + ' loopback devices' : devices.body?.error)
if (devices.body?.devices !== undefined) {
  for (const entry of devices.body.devices) {
    console.log('  ' + (entry.default ? '*' : ' ') + ' ' + entry.index + '  ' + entry.name)
  }
}
const unauthorized = await (async () => {
  const handler = routes.get('/api/dsh-pinpu/spectrum')
  return await new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/dsh-pinpu/spectrum', headers: { host: 'evil.example' }, socket: { remoteAddress: '127.0.0.1' } }
    const res = { status: 0, writeHead(status) { this.status = status }, end() { resolve(this.status) } }
    handler(req, res)
  })
})()
console.log('non-loopback Host rejected with:', unauthorized)

const frames = []
const deadline = Date.now() + seconds * 1000
while (Date.now() < deadline) {
  const response = await callRoute('/api/dsh-pinpu/spectrum', '?ticks=15')
  frames.push(response.body)
  await new Promise((resolve) => setTimeout(resolve, 120))
}

const last = frames[frames.length - 1]
const peaks = frames.map((frame) => frame?.peak ?? 0)
console.log('status:', last?.status, '| device:', last?.device, '| rate:', last?.rate, '| channels:', last?.channels)
console.log('analysis frames:', last?.frames, '| PCM bytes received:', last?.bytes)
console.log('frames polled:', frames.length, '| peak min/max:', Math.min(...peaks), Math.max(...peaks))
console.log('ticks payload:', JSON.stringify(last?.levels))
const bars = (last?.levels ?? []).map((level) => '#'.repeat(Math.round(level * 24)).padEnd(24, ' ')).join('\n  ')
console.log('levels (15 ticks, bottom band first):\n  ' + bars)
const distinct = new Set((last?.levels ?? []).map((level) => Math.round(level * 20)))
console.log('distinct bar lengths at this frame:', distinct.size)
console.log(
  'VERDICT:',
  last?.status === 'live' && Math.max(...peaks) > 0.05
    ? 'captured system audio and produced a spectrum'
    : 'no live capture (status ' + String(last?.status) + ')',
)

for (const dispose of disposers) dispose()
console.log('plugin log lines:')
for (const line of lines.slice(0, 12)) console.log('  ' + line)
