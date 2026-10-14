/**
 * Spectrum analysis for the rail: PCM in, per-band levels out.
 *
 * Pure and self-contained on purpose — no dependency beyond the standard library —
 * so the same maths can be unit-tested offline against a known sine and reasoned
 * about without a sound card.
 *
 * The numbers come from measurement, not taste (see README): Chromium's own
 * `-100..-30 dB` analyser window pegs ordinary material, and raw band levels span
 * a narrow slice of any window, which draws as a flat wall. Hence `-100..-25 dB`
 * plus the optional per-band envelope normalisation.
 */

/** Radix-2 FFT over real input, iterative, with cached tables. */
class Fft {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('fft size must be a power of two')
    this.size = size
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let index = 0; index < size / 2; index += 1) {
      this.cos[index] = Math.cos((2 * Math.PI * index) / size)
      this.sin[index] = Math.sin((2 * Math.PI * index) / size)
    }
    this.reverse = new Uint32Array(size)
    for (let index = 0; index < size; index += 1) {
      let value = index
      let flipped = 0
      for (let bit = 0; bit < Math.log2(size); bit += 1) {
        flipped = (flipped << 1) | (value & 1)
        value >>>= 1
      }
      this.reverse[index] = flipped
    }
    this.real = new Float64Array(size)
    this.imag = new Float64Array(size)
  }

  /** In-place transform of `input` (length = size); returns the real/imag arrays. */
  forward(input) {
    const { size, cos, sin, reverse, real, imag } = this
    for (let index = 0; index < size; index += 1) {
      real[index] = input[reverse[index]]
      imag[index] = 0
    }
    for (let span = 2; span <= size; span *= 2) {
      const half = span / 2
      const step = size / span
      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * step
          const evenIndex = start + offset
          const oddIndex = evenIndex + half
          const oddReal = real[oddIndex] * cos[twiddle] + imag[oddIndex] * sin[twiddle]
          const oddImag = imag[oddIndex] * cos[twiddle] - real[oddIndex] * sin[twiddle]
          real[oddIndex] = real[evenIndex] - oddReal
          imag[oddIndex] = imag[evenIndex] - oddImag
          real[evenIndex] += oddReal
          imag[evenIndex] += oddImag
        }
      }
    }
    return { real, imag }
  }
}

/** Hann window, cached per size. */
const WINDOWS = new Map()
function window(size) {
  let table = WINDOWS.get(size)
  if (table === undefined) {
    table = new Float64Array(size)
    for (let index = 0; index < size; index += 1) {
      table[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)))
    }
    WINDOWS.set(size, table)
  }
  return table
}

export const MIN_DECIBELS = -100
export const MAX_DECIBELS = -25

/** Level shaping: a gentle power curve keeps quiet detail visible. */
const SHAPE = 0.85
/** Envelope release per analysis frame (≈0.24/s at 30 Hz). */
const ENVELOPE_RELEASE = 0.008

/**
 * Logarithmically spaced band edges (bin indices) between `minHz` and `maxHz`.
 * @returns a Uint32Array of `bands + 1` bin indices, ascending.
 */
export function computeBands(bands, binCount, sampleRate, minHz, maxHz) {
  const nyquist = sampleRate / 2
  const usableMaxBin = Math.max(1, Math.min(binCount - 1, binCount))
  const low = Math.max(minHz, 20)
  const high = Math.min(maxHz, nyquist * 0.98)
  const edges = new Uint32Array(bands + 1)
  for (let index = 0; index <= bands; index += 1) {
    const position = index / bands
    const frequency = low * Math.pow(high / low, position)
    const bin = Math.round((frequency / nyquist) * usableMaxBin)
    edges[index] = Math.min(usableMaxBin, Math.max(0, bin))
  }
  return edges
}

const toByte = (value) => {
  const decibels = 20 * Math.log10(value)
  const scaled = (decibels - MIN_DECIBELS) / (MAX_DECIBELS - MIN_DECIBELS)
  return scaled <= 0 ? 0 : scaled >= 1 ? 1 : scaled
}

/**
 * Stateful analyser: feed it mono PCM, ask it for levels.
 *
 * Keeping the envelope here (not in the renderer) means the rail's shape is a
 * property of the *audio*, identical no matter how often the renderer polls.
 */
export function createAnalyzer(options = {}) {
  const fftSize = Number(options.fftSize ?? 1024)
  const bands = Math.max(1, Number(options.bands ?? 64))
  const sampleRate = Number(options.sampleRate ?? 48000)
  const minHz = Number(options.minHz ?? 45)
  const maxHz = Number(options.maxHz ?? 16000)
  const smoothing = Math.min(0.95, Math.max(0, Number(options.smoothing ?? 0.78)))
  const gain = Number(options.gain ?? 1)
  const gate = Number(options.gate ?? 0.04)
  /** Transient accent: how hard a jump above a band's own average is emphasised. */
  const punch = Math.min(2, Math.max(0, Number(options.punch ?? 0.55)))
  /** Per-band micro-motion. Multiplied into the level, so it dies with the audio. */
  const flutter = Math.min(0.35, Math.max(0, Number(options.flutter ?? 0.08)))
  let autoGain = options.autoGain !== false

  const fft = new Fft(fftSize)
  const frame = new Float64Array(fftSize)
  const taper = window(fftSize)
  const edges = computeBands(bands, fftSize / 2, sampleRate, minHz, maxHz)
  const levels = new Float32Array(bands)
  const envelope = new Float32Array(bands)
  const shaped = new Float32Array(bands)
  const output = new Float32Array(bands)
  /** Attack/release envelope per band — separate from the frame's output, because the
   *  output also carries the peak hold and feeding that back would decay a steady tone. */
  const ar = new Float32Array(bands)
  /** Peak-hold value per band, and how many frames it may still hold. */
  const held = new Float32Array(bands)
  const holdLeft = new Int32Array(bands)
  /** Decaying per-band accent, set by an onset and released at the band's own rate. */
  const accent = new Float32Array(bands)
  /** Slow per-band average: the "acoustic memory" a transient is measured against. */
  const slow = new Float32Array(bands)
  /** Per-band random walk. Deliberately not periodic: a shared period is what makes a
   *  rail look like it is scanning instead of playing. */
  const walk = new Float32Array(bands)
  /** Per-band release factor: bass rings on, treble lets go. */
  const release = new Float32Array(bands)
  const HOLD_FRAMES = 4
  const SLOW_RATE = 0.01
  const WALK_DRIFT = 0.94
  const WALK_GAIN = 0.22
  const fallBase = 0.5 + 0.45 * smoothing
  for (let band = 0; band < bands; band += 1) {
    const position = bands === 1 ? 0 : band / (bands - 1)
    release[band] = Math.min(0.97, Math.max(0.4, fallBase + 0.07 * (1 - position) - 0.1 * position))
  }
  let peak = 0

  return {
    fftSize,
    bands,
    sampleRate,
    edges,
    setAutoGain(value) {
      autoGain = value !== false
    },
    /**
     * Analyse `samples` (mono float32, typically a little more than `fftSize`;
     * only the newest `fftSize` are used, the front is zero-padded).
     *
     * Per band: rise immediately (`attack`), fall at that band's own rate, hold the peak
     * briefly with inertia, accent jumps above the band's slow average, and add a slow
     * random walk. A single one-pole filter over all bands (what this used to do) gives
     * every band one time constant, and the whole rail then moves as one body.
     *
     * @returns {{ peak: number, levels: Float32Array, silent: boolean }}
     */
    analyze(samples) {
      const size = fft.size
      const available = Math.min(size, samples.length)
      const offset = size - available
      for (let index = 0; index < offset; index += 1) frame[index] = 0
      for (let index = 0; index < available; index += 1) {
        frame[offset + index] = samples[samples.length - available + index] * taper[offset + index]
      }
      const { real, imag } = fft.forward(frame)
      const scale = 2 / (size * 0.5)
      let rawPeak = 0
      for (let band = 0; band < bands; band += 1) {
        const from = edges[band]
        const to = Math.max(edges[band + 1], from + 1)
        let sum = 0
        for (let bin = from; bin < to && bin < size / 2; bin += 1) {
          sum += Math.hypot(real[bin], imag[bin]) * scale
        }
        const raw = Math.pow(toByte(sum / (to - from)), SHAPE) * gain
        const value = raw > 1 ? 1 : raw
        shaped[band] = value
        if (value > rawPeak) rawPeak = value
      }
      // Silence is decided on the raw spectrum alone, so neither the accent nor the walk
      // can keep a quiet room looking alive.
      const silent = rawPeak <= gate

      for (let band = 0; band < bands; band += 1) {
        const target = shaped[band]
        // Attack: an instantaneous rise. Release: this band's own factor. `max` rather than
        // a branch, because `target === previous` must hold the value, not start a fall.
        const risen = target > ar[band] * release[band] ? target : ar[band] * release[band]
        ar[band] = risen
        // What this band has been doing lately, *before* this frame — the yardstick for a
        // transient. Comparing against the slow average instead (as this first did) boosts
        // every frame that is louder than the average, i.e. the whole sustained body:
        // measured on a kick-and-melody fixture it lifted the steady level from 0.56 to
        // 0.86 while the hits were pinned at the ceiling — less contrast, not more.
        const recent = held[band]
        // A transient is a *rise above this band's recent peak*, in absolute terms: gating
        // only on the recent level misses the case that matters most — a band that is quiet
        // between hits (the bass under a melody), where the level jumps from nearly nothing
        // and the relative overshoot would be meaningless. The denominator has a floor for
        // the same reason, which keeps a quiet-to-loud jump bounded instead of infinite.
        const rise = risen - recent
        const onset = rise > 0.06 && risen > 0.1 ? Math.min(1.5, rise / Math.max(recent, 0.25)) : 0
        accent[band] = onset > accent[band] ? onset : accent[band] * release[band]
        if (risen >= held[band]) {
          held[band] = risen
          holdLeft[band] = HOLD_FRAMES
        } else if (holdLeft[band] > 0) {
          holdLeft[band] -= 1
        } else {
          // The hold bleeds off at the band's own release rate rather than a shared one: a
          // shared decay is slower than the treble release and then masks the per-band
          // timing entirely (measured: bass and treble both crossed the threshold at frame
          // 21, because the hold, not the release, was driving both).
          held[band] *= release[band]
        }
        const average = slow[band]
        slow[band] = average + (risen - average) * SLOW_RATE
        // The boost rides on the envelope (not on the hold), so a hit stands out without
        // inflating the value the next frame is measured against.
        let value = risen * (1 + (silent ? 0 : punch * accent[band]))
        if (held[band] > value) value = held[band]
        if (!silent) {
          walk[band] = walk[band] * WALK_DRIFT + (Math.random() * 2 - 1) * WALK_GAIN
          value *= 1 + flutter * walk[band]
        }
        levels[band] = value > 1 ? 1 : value < 0 ? 0 : value
      }

      let loudest = 0
      for (let band = 0; band < bands; band += 1) {
        if (levels[band] > loudest) loudest = levels[band]
      }
      peak = loudest
      if (!autoGain) return { peak, levels, silent }
      if (silent) {
        envelope.fill(0)
        // Only once the fall has actually finished does the spectrum go fully quiet; until
        // then the decay is what makes a pause (or a stopped track) look natural.
        if (loudest <= gate) levels.fill(0)
        return { peak, levels, silent: true }
      }
      let reference = 0
      for (let band = 0; band < bands; band += 1) {
        const previousPeak = envelope[band]
        envelope[band] = levels[band] > previousPeak ? levels[band] : Math.max(levels[band], previousPeak - ENVELOPE_RELEASE)
        if (envelope[band] > reference) reference = envelope[band]
      }
      if (reference <= 0.25) return { peak, levels, silent: false }
      for (let band = 0; band < bands; band += 1) {
        output[band] = Math.min(1, levels[band] / reference)
      }
      return { peak, levels: output, silent: false }
    },
  }
}

/**
 * Resample `levels` onto `count` output slots.
 *
 * Used to map a fixed-resolution spectrum onto however many turn marks the
 * transcript currently has: the bottom mark gets the lowest band by default, so the
 * rail reads like an equaliser (bass at its foot).
 */
export function resample(levels, count, invert = false) {
  const out = new Float32Array(Math.max(0, count))
  if (out.length === 0) return out
  const source = levels.length
  if (source === 0) return out
  for (let slot = 0; slot < out.length; slot += 1) {
    const position = out.length === 1 ? 0 : slot / (out.length - 1)
    const from = (invert ? 1 - position : position) * (source - 1)
    const low = Math.floor(from)
    const high = Math.min(source - 1, low + 1)
    const mix = from - low
    out[slot] = levels[low] * (1 - mix) + levels[high] * mix
  }
  return out
}
