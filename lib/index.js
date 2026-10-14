/**
 * Host half of dsh-pinpu.
 *
 * It owns the one thing a browser half cannot do here: **capturing what the machine
 * is playing**. `getUserMedia` only reaches *capture* endpoints — measured on this
 * machine, Chromium does not even list a disabled Stereo Mix, and Stereo Mix mirrors
 * one specific render device rather than the default output. So the host spawns the
 * vendored PortAudio loopback helper (`vendor/loopback.py`, via the harness's own
 * Python) and turns its PCM into a per-band spectrum. The browser half then animates
 * the transcript's **own turn rail** with it.
 *
 * This side also owns the two exact HTTP routes the browser polls (`lib/routes.js`)
 * and the configuration schema. It never touches the DOM.
 *
 * Every field is `.volatile()`, so the settings card's edits take effect without a
 * reload; `apply` re-reads the live values on a slow timer rather than caching them,
 * which is why there is no watcher plumbing to get wrong.
 *
 * @module dsh-pinpu
 */
import z from '@deepseek-ai/schemastery'
import { BANDS, DEFAULTS } from './defaults.js'
import { createCapture, findPython } from './loopback.js'
import { registerRoutes, createClientState } from './routes.js'

/** Cordis plugin name; the Loader row's `id` in `cordis.patch.yml` must match it. */
export const name = 'pinpu'

/** No host service is required up front: the routes ask for `webServer` lazily. */
export const inject = []

/** How often the capture is reconciled with the live configuration, in ms. */
const RECONCILE_MS = 500

/**
 * A `.volatile()` field resolves to a frozen `{ get, [symbol] }` reference, not to
 * the configured value. Recognise one and read through it; anything else is the
 * value itself. (Same recogniser as `dsh-plugin-proxy`'s `lib/settings.js`.)
 *
 * @param value - whatever `config[key]` holds.
 * @returns the configured value.
 */
export function plain(value) {
  if (value === null || typeof value !== 'object') return value
  if (!Object.isFrozen(value)) return value
  if (typeof value.get !== 'function') return value
  if (Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'get') return value
  if (Object.getOwnPropertySymbols(value).length !== 1) return value
  try {
    return plain(value.get())
  } catch {
    return undefined
  }
}

/**
 * Every configuration field, with the type, default and description the settings
 * form renders. The browser half reads the same snapshot, so a field added here
 * reaches both the capture loop and the settings card.
 */
export const Config = z.object({
  /** Master switch: off stops the capture process entirely. */
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  /**
   * Which loopback device to capture. Empty follows the **default output device**, so
   * whatever the machine is playing is what dances; a name substring or an index from
   * the settings card pins one device instead.
   */
  device: z.string().default(DEFAULTS.device).volatile(),
  /** FFT window: bigger resolves neighbouring bands better and reacts slower. */
  fftSize: z.number().default(DEFAULTS.fftSize).volatile(),
  /** Temporal smoothing across analysis frames, 0–0.95. */
  smoothing: z.number().default(DEFAULTS.smoothing).volatile(),
  /** Post-curve gain, before auto-gain. */
  gain: z.number().default(DEFAULTS.gain).volatile(),
  /**
   * Normalise each band by the loudest band's slow envelope. Measured: without it,
   * ordinary material spans a narrow slice of the dB window and the rail reads as a
   * flat wall.
   */
  autoGain: z.boolean().default(DEFAULTS.autoGain).volatile(),
  /** Levels at or below this count as silence, and the rail is handed back. */
  gate: z.number().default(DEFAULTS.gate).volatile(),
  /** Lowest frequency the spectrum shows. */
  minHz: z.number().default(DEFAULTS.minHz).volatile(),
  /** Highest frequency the spectrum shows. */
  maxHz: z.number().default(DEFAULTS.maxHz).volatile(),
  /**
   * Transient accent: the part of a band's level that jumped above its own slow average is
   * multiplied up, so a drum reads as a hit rather than as a slightly faster swell.
   */
  punch: z.number().default(DEFAULTS.punch).volatile(),
  /**
   * Per-band micro-motion: a slow random walk multiplied into each band's level. This is
   * what stops neighbouring segments from moving as one body; being multiplicative, it
   * fades out wherever the audio does.
   */
  flutter: z.number().default(DEFAULTS.flutter).volatile(),

  /** Turn off the rail's built-in "newest turn is highlighted" state. */
  disableActiveHighlight: z.boolean().default(DEFAULTS.disableActiveHighlight).volatile(),
  /** Highlight the mark under the pointer — and nothing while the pointer is away. */
  hoverHighlight: z.boolean().default(DEFAULTS.hoverHighlight).volatile(),
  /** While silent, remove the spectrum's take-over so the rail looks native. */
  restoreOnSilence: z.boolean().default(DEFAULTS.restoreOnSilence).volatile(),

  /** Shortest mark, as a fraction of its full 20 px (the rail's own dormant scale). */
  minScale: z.number().default(DEFAULTS.minScale).volatile(),
  /** Longest mark, as a fraction of its full 20 px. */
  maxScale: z.number().default(DEFAULTS.maxScale).volatile(),
  /** Draw the lowest band at the top of the rail instead of at its foot. */
  invert: z.boolean().default(DEFAULTS.invert).volatile(),
  /** Which edge the rail sits on: `right` (the app's own) or `left`. */
  side: z.string().default(DEFAULTS.side).volatile(),
  /** `theme` keeps the rail's own colour; `spectrum` hues by band; `custom` uses one colour. */
  colorMode: z.string().default(DEFAULTS.colorMode).volatile(),
  /** Colour for `colorMode: custom`. */
  customColor: z.string().default(DEFAULTS.customColor).volatile(),
  /** Let each segment's brightness follow its level, so a long mark also reads as strong. */
  glow: z.boolean().default(DEFAULTS.glow).volatile(),
  /** Light a mark up while its length is at or above this fraction of the full 20 px. */
  hotScale: z.number().default(DEFAULTS.hotScale).volatile(),
  /** Expected random highlights per second while audio plays (`0` switches them off). */
  spark: z.number().default(DEFAULTS.spark).volatile(),

  /** Draw a synthetic waveform while no capture is live (off by default). */
  demo: z.boolean().default(DEFAULTS.demo).volatile(),
})

/**
 * @param ctx - Cordis context.
 * @param config - the Loader row's configuration; every field is a volatile ref.
 */
export function apply(ctx, config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  /** Read one live field, falling back to the shipped default. */
  const read = (key) => {
    const value = plain(source[key])
    return value === undefined ? DEFAULTS[key] : value
  }
  const log = (entry) => {
    try {
      if (typeof ctx?.logger?.info === 'function') ctx.logger.info('[pinpu] ' + JSON.stringify(entry))
    } catch {
      /* logging must never break the plugin */
    }
  }

  const capture = createCapture({ bands: BANDS, fftSize: read('fftSize'), autoGain: read('autoGain') !== false, log })
  log({
    event: 'init',
    result: 'spectrum rail ready',
    python: findPython() ?? 'not found',
    note: 'capture starts on the first reconcile tick when enabled',
  })

  let running = false
  ctx.effect(() => {
    const reconcile = () => {
      if (read('enabled') === false) {
        if (running) {
          capture.stop()
          running = false
          log({ event: 'capture', result: 'stopped' })
        }
        return
      }
      const device = String(read('device') ?? '')
      capture.configure({
        device,
        fftSize: Number(read('fftSize')) || DEFAULTS.fftSize,
        autoGain: read('autoGain') !== false,
      })
      capture.tune({
        smoothing: Number(read('smoothing')),
        gain: Number(read('gain')),
        gate: Number(read('gate')),
        minHz: Number(read('minHz')),
        maxHz: Number(read('maxHz')),
        punch: Number(read('punch')),
        flutter: Number(read('flutter')),
        autoGain: read('autoGain') !== false,
      })
      if (!running) {
        capture.start()
        running = true
        log({ event: 'capture', result: 'started', device: device === '' ? '(default output)' : device })
      }
    }
    reconcile()
    const timer = setInterval(reconcile, RECONCILE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      capture.stop()
      running = false
    }
  }, 'pinpu: capture')

  registerRoutes(ctx, { capture, client: createClientState(), log })
}
