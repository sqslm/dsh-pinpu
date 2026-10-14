/**
 * HTTP surface of the plugin: the spectrum the rail animates from, and the list of
 * loopback devices the settings card offers.
 *
 * Both are registered as `kind: 'exact'` routes. Exact routes are matched before
 * the connexion layer's `/api` prefix route, which means they bypass its Host/Origin
 * check and signed-cookie authentication — so they must authenticate themselves.
 * {@link isLoopbackRequest} is that check (loopback peer, loopback Host, and either
 * no Origin or a same-origin one); it is deliberately the same guard the
 * agent-notify plugin uses.
 *
 * @module lib/routes
 */
import { resample } from './spectrum.js'

export const SPECTRUM_PATH = '/api/dsh-pinpu/spectrum'
export const DEVICES_PATH = '/api/dsh-pinpu/devices'
/** Where the browser half reports that it is alive. */
export const CLIENT_PATH = '/api/dsh-pinpu/client'

/**
 * The browser half's liveness record.
 *
 * The two halves of a plugin are loaded by different systems — the host half by the
 * Loader, the browser half by the client module roster — so "nothing happens on
 * screen" has at least two very different causes. Recording what the browser half says
 * makes that distinction observable from outside the application window, and lets the
 * settings card show which half is missing.
 */
export function createClientState() {
  let record = { event: 'none', detail: '', at: 0, count: 0, errors: [] }
  return {
    note(event, detail) {
      const text = String(detail ?? '').slice(0, 400)
      const errors = String(event ?? '') === 'error' ? [...record.errors, text].slice(-4) : [...record.errors]
      record = { event: String(event ?? 'unknown'), detail: text, at: Date.now(), count: record.count + 1, errors }
      return record
    },
    snapshot() {
      return { ...record, errors: [...record.errors], ageMs: record.at === 0 ? null : Date.now() - record.at }
    },
  }
}

function writeJson(res, status, body) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  } catch {
    /* the client went away */
  }
}

/** Only loopback peers, addressed as loopback, may use these routes. */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const name = hostUrl.hostname
  if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Round to 3 decimals: the rail cannot show more, and this halves the payload. */
const compact = (value) => Math.round(value * 1000) / 1000

/**
 * @param ctx - plugin context (Cordis)
 * @param options.capture - the capture created by `lib/loopback.js`
 * @param options.log - plugin logger
 *
 * The payload is always ordered low band → high band: which *end* of the rail the
 * bass sits at is a presentation choice the browser makes (`invert` there), and
 * applying it on both sides would cancel out.
 */
export function registerRoutes(ctx, options) {
  const { capture, log, client } = options
  const clientState = client ?? createClientState()
  try {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => {
        const disposers = []
        disposers.push(
          scope.webServer.register({
            kind: 'exact',
            path: SPECTRUM_PATH,
            handler: (req, res) => {
              if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' })
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              }
              let ticks = 0
              let diag = false
              try {
                const url = new URL(req.url ?? SPECTRUM_PATH, 'http://127.0.0.1')
                ticks = Number(url.searchParams.get('ticks') ?? 0)
                diag = url.searchParams.get('diag') === '1'
              } catch {
                ticks = 0
                diag = false
              }
              const snapshot = capture.snapshot()
              const levels = capture.levels()
              const count = Number.isFinite(ticks) && ticks > 0 ? Math.min(512, Math.floor(ticks)) : 0
              const shaped = count > 0 ? resample(levels, count) : levels
              // Payload contract, relied on by `levelsFrom` in the browser half and pinned
              // by test/rail.test.mjs: the spectrum is **`levels`**, already resampled onto
              // the requested mark count when `?ticks=N` was given, low band → high band.
              writeJson(res, 200, {
                ok: true,
                ...snapshot,
                levels: Array.from(shaped, compact),
                ...(diag
                  ? {
                      client: clientState.snapshot(),
                      python: capture.python ? capture.python() : undefined,
                      bands: levels.length,
                    }
                  : {}),
              })
            },
          }),
        )
        disposers.push(
          scope.webServer.register({
            kind: 'exact',
            path: CLIENT_PATH,
            handler: (req, res) => {
              if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' })
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              }
              let event = 'heartbeat'
              let detail = ''
              try {
                const url = new URL(req.url ?? CLIENT_PATH, 'http://127.0.0.1')
                event = String(url.searchParams.get('event') ?? 'heartbeat').slice(0, 40)
                detail = String(url.searchParams.get('detail') ?? '')
              } catch {
                /* keep the defaults */
              }
              const record = clientState.note(event, detail)
              // An error from the browser half is worth a host-side line: it is the only
              // trace an application window leaves behind.
              if (record.event === 'error') {
                log({ event: 'client', result: 'error', detail: record.detail })
              }
              writeJson(res, 200, { ok: true, recorded: record.event, count: record.count })
            },
          }),
        )
        disposers.push(
          scope.webServer.register({
            kind: 'exact',
            path: DEVICES_PATH,
            handler: (req, res) => {
              if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'loopback requests only' })
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                return writeJson(res, 405, { ok: false, error: 'method not allowed' })
              }
              let force = false
              try {
                const url = new URL(req.url ?? DEVICES_PATH, 'http://127.0.0.1')
                force = url.searchParams.get('refresh') === '1'
              } catch {
                force = false
              }
              capture
                .devices(force)
                .then((result) =>
                  writeJson(res, 200, {
                    ok: true,
                    available: result.ok === true,
                    devices: Array.isArray(result.devices) ? result.devices : [],
                    error: String(result.error ?? ''),
                    python: capture.python ? capture.python() : undefined,
                  }),
                )
                .catch((error) => writeJson(res, 500, { ok: false, available: false, devices: [], error: String(error?.message ?? error) }))
            },
          }),
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch (error) {
              log({ event: 'error', result: 'route-dispose', error: String(error?.message ?? error) })
            }
          }
        }
      }, 'pinpu: spectrum routes')
    })
  } catch (error) {
    log({ event: 'error', result: 'routes-unavailable', error: String(error?.message ?? error) })
  }
}
