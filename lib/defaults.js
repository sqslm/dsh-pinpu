/**
 * Default configuration — the single source of truth.
 *
 * Three places restate these values and `test/defaults.test.mjs` fails if any of
 * them drifts from this file:
 *
 * 1. this object,
 * 2. the host schema's `.default(...)` arguments in `lib/index.js`,
 * 3. `cordis.patch.yml` (the bundle row).
 *
 * The split of responsibility is deliberate: **capture and spectrum analysis live
 * in the host**, **presentation lives in the browser**. Nothing here depends on
 * `getUserMedia`, so the rail needs no capture permission and no user gesture.
 *
 * @module dsh-pinpu/defaults
 */
export const DEFAULTS = Object.freeze({
  /** Master switch. Off means no capture process is spawned at all. */
  enabled: true,

  /**
   * Loopback device to capture: `''` follows the default output device, otherwise a
   * name substring or a `[Loopback]` device index from the settings card's list.
   */
  device: '',

  /** FFT window: 1024 ≈ 21 ms at 48 kHz — responsive without flicker. */
  fftSize: 1024,
  /** Temporal smoothing across analysis frames, 0–0.95. */
  smoothing: 0.78,
  /** Post-curve gain, applied before auto-gain. */
  gain: 1,
  /** Normalise each band by the loudest band's slow envelope (see README). */
  autoGain: true,
  /** Levels at or below this count as silence. */
  gate: 0.04,
  /** Spectrum range. */
  minHz: 45,
  maxHz: 16000,
  /**
   * Transient accent (0–2). Each band is compared with its own slow average, and the part
   * of a frame that jumped above it is multiplied up — so a drum reads as a hit instead of
   * as a slightly faster swell.
   */
  punch: 0.55,
  /**
   * Per-band micro-motion (0–0.35): a slow random walk per band, multiplied into its
   * level. Enough to stop neighbouring segments moving as one body, and it disappears by
   * itself wherever there is no audio, because it scales with the level.
   */
  flutter: 0.08,

  /** Turn the rail's built-in "newest turn is highlighted" state off. */
  disableActiveHighlight: true,
  /** Highlight the mark under the pointer, and only then. */
  hoverHighlight: true,
  /** While silent, hand the marks back to their own styles instead of holding a floor. */
  restoreOnSilence: true,

  /** Shortest mark, as a fraction of its full 20 px — the rail's own dormant scale. */
  minScale: 0.4,
  /** Longest mark, as a fraction of its full 20 px. */
  maxScale: 1,
  /** Draw the lowest band at the top of the rail instead of at its foot. */
  invert: false,
  /**
   * Which edge of the conversation the rail sits on: `right` (where the app puts it) or
   * `left`. Moving it mirrors the marks too — they hang off the edge they sit against.
   */
  side: 'right',
  /** `theme` keeps the rail's own colour; `spectrum` hues by band; `custom` uses one colour. */
  colorMode: 'theme',
  customColor: '#4d93f8',
  /** Brightness follows each segment's level, so a long mark also reads as a strong one. */
  glow: true,

  /** Drive the rail with a synthetic waveform when no capture is live. */
  demo: false,
})

/** The order the host schema, the bundle row and the settings card all use. */
export const FIELD_ORDER = Object.freeze(Object.keys(DEFAULTS))

/** Host-side spectrum resolution, before resampling onto however many marks exist. */
export const BANDS = 64
