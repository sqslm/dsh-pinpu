/**
 * The signal path: FFT, band mapping, level shaping, resampling.
 *
 * Everything here is pure, so it is checked against mathematics rather than against
 * a snapshot: a transform is compared with a naive DFT, a tone is checked to land in
 * the band its frequency belongs to, and the level contract (`0..1`, silence below
 * the gate) is asserted directly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_DECIBELS,
  MIN_DECIBELS,
  computeBands,
  createAnalyzer,
  resample,
} from '../lib/spectrum.js'

const RATE = 48000

function tone(hz, seconds, amplitude) {
  const length = Math.round(RATE * seconds)
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    out[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / RATE)
  }
  return out
}

/**
 * A naive O(n²) DFT magnitude for the first `bins` bins — the oracle the shipped
 * radix-2 transform is checked against, so a wrong twiddle or bit reversal fails
 * here instead of only showing up as a vaguely wrong-looking rail.
 */
function dft(samples, bins) {
  const out = new Float64Array(bins)
  for (let bin = 0; bin < bins; bin += 1) {
    let real = 0
    let imag = 0
    for (let index = 0; index < samples.length; index += 1) {
      const angle = (2 * Math.PI * bin * index) / samples.length
      real += samples[index] * Math.cos(angle)
      imag -= samples[index] * Math.sin(angle)
    }
    out[bin] = Math.hypot(real, imag)
  }
  return out
}

test('the transform matches a naive DFT band for band', () => {
  const size = 256
  const bands = 32
  const samples = new Float32Array(size)
  for (let index = 0; index < size; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 7 * index) / size) + 0.4 * Math.cos((2 * Math.PI * 23 * index) / size)
  }
  // The dynamics (transient accent, per-band micro-motion) are deliberately stochastic, so
  // a test that pins the *transform* has to switch them off.
  const analyzer = createAnalyzer({ fftSize: size, bands, sampleRate: RATE, autoGain: false, smoothing: 0, gain: 1, gate: 0, punch: 0, flutter: 0 })
  const analysed = analyzer.analyze(samples)

  // Independent oracle: the O(n²) DFT of the same Hann-windowed frame.
  const windowed = new Float64Array(size)
  for (let index = 0; index < size; index += 1) {
    windowed[index] = samples[index] * 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)))
  }
  const oracle = dft(windowed, size / 2)
  const scale = 2 / (size * 0.5)
  const toByte = (magnitude) => {
    const decibels = 20 * Math.log10(magnitude)
    const scaled = (decibels - MIN_DECIBELS) / (MAX_DECIBELS - MIN_DECIBELS)
    return scaled <= 0 ? 0 : scaled >= 1 ? 1 : scaled
  }
  // Band i averages the bins in [edges[i], max(edges[i + 1], edges[i] + 1)), exactly
  // as the analyser does; the edges themselves come from the shipped function.
  let checked = 0
  for (let band = 0; band < bands; band += 1) {
    const from = analyzer.edges[band]
    const to = Math.max(analyzer.edges[band + 1], from + 1)
    let sum = 0
    for (let bin = from; bin < to && bin < size / 2; bin += 1) sum += oracle[bin]
    const expected = Math.pow(toByte((sum / (to - from)) * scale), 0.85)
    if (expected <= 0 || expected >= 1) continue
    assert.ok(
      Math.abs(analysed.levels[band] - expected) < 1e-6,
      'band ' + String(band) + ': ' + String(analysed.levels[band]) + ' vs ' + String(expected),
    )
    checked += 1
  }
  assert.ok(checked >= 2, 'the oracle must produce at least two in-range bands, got ' + String(checked))
})

test('the analyser window is the one the level mapping assumes', () => {
  assert.equal(MIN_DECIBELS, -100)
  assert.equal(MAX_DECIBELS, -25)
  assert.ok(MAX_DECIBELS > MIN_DECIBELS)
})

test('band edges are monotonic, in range, and logarithmic', () => {
  const bands = 16
  const edges = computeBands(bands, 512, RATE, 45, 16000)
  assert.equal(edges.length, bands + 1)
  for (let index = 0; index < edges.length; index += 1) {
    assert.ok(edges[index] >= 0 && edges[index] <= 512, 'edge ' + String(index) + ' in range')
    if (index > 0) assert.ok(edges[index] >= edges[index - 1], 'edge ' + String(index) + ' monotonic')
  }
  // The first band starts at the low end, the last reaches the high end.
  assert.ok(edges[0] <= 2)
  assert.ok(edges[bands] >= 300)
})

test('computeBands tolerates a range wider than Nyquist', () => {
  const edges = computeBands(8, 512, 8000, 20, 96000)
  for (const edge of edges) assert.ok(edge >= 0 && edge <= 512)
})

test('a 1 kHz tone lands in the band that contains 1 kHz', () => {
  const bands = 16
  const analyzer = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, smoothing: 0, gate: 0, punch: 0, flutter: 0 })
  const result = analyzer.analyze(tone(1000, 0.05, 0.5))
  assert.ok(result.peak > 0.5, 'a half-scale tone should read loud, got ' + String(result.peak))
  let loudest = 0
  for (let index = 1; index < bands; index += 1) {
    if (result.levels[index] > result.levels[loudest]) loudest = index
    assert.ok(result.levels[index] >= 0 && result.levels[index] <= 1, 'level in range')
  }
  // Which band should contain 1 kHz? Invert the log mapping.
  const edges = computeBands(bands, 512, RATE, 45, 16000)
  const bin = Math.round((1000 / (RATE / 2)) * 512)
  let expected = 0
  for (let index = 0; index < bands; index += 1) {
    if (edges[index] <= bin && bin <= edges[index + 1]) expected = index
  }
  assert.ok(Math.abs(loudest - expected) <= 1, 'loudest band ' + String(loudest) + ' should be near ' + String(expected))
})

test('silence reads as silence and never crosses the gate', () => {
  const analyzer = createAnalyzer({ fftSize: 1024, bands: 8, sampleRate: RATE, smoothing: 0, gate: 0.04 })
  const result = analyzer.analyze(new Float32Array(2048))
  assert.equal(result.silent, true)
  assert.equal(result.peak, 0)
  for (const level of result.levels) assert.equal(level, 0)
})

test('two tones light two separate bands, and leakage decays away from them', () => {
  // A transform bug (wrong twiddles, wrong bit reversal, missing window) shows up as
  // energy in the wrong places, so this checks the shape rather than one number. The
  // amplitudes stay low enough that nothing clips the dB window: at −25 dBFS ceiling
  // a per-bin magnitude above ~0.056 saturates, and a saturated pair of peaks cannot
  // be ranked against each other.
  const bands = 24
  const analyzer = createAnalyzer({ fftSize: 2048, bands, sampleRate: RATE, autoGain: false, smoothing: 0, gain: 1, gate: 0, punch: 0, flutter: 0 })
  const samples = new Float32Array(4096)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.05 * Math.sin((2 * Math.PI * 500 * index) / RATE) + 0.04 * Math.sin((2 * Math.PI * 6000 * index) / RATE)
  }
  const result = analyzer.analyze(samples)
  const edges = computeBands(bands, 1024, RATE, 45, 16000)
  const bandOf = (hz) => {
    const bin = Math.round((hz / (RATE / 2)) * 1024)
    for (let index = 0; index < bands; index += 1) {
      if (edges[index] <= bin && bin <= edges[index + 1]) return index
    }
    return bands - 1
  }
  const low = bandOf(500)
  const high = bandOf(6000)
  const loudest = result.levels.indexOf(Math.max(...result.levels))
  assert.ok(high !== low, 'the two tones must not share a band')
  assert.ok(Math.abs(loudest - low) <= 2, 'the louder 500 Hz tone should own the loudest band, got ' + String(loudest) + ' vs ' + String(low))
  // A tone can straddle two adjacent bands, so assert a local *region* peaks rather
  // than one exact band index.
  const region = (centre) => {
    let best = 0
    for (let index = Math.max(0, centre - 1); index <= Math.min(bands - 1, centre + 1); index += 1) {
      if (result.levels[index] > best) best = result.levels[index]
    }
    return best
  }
  for (const [centre, label] of [[low, '500 Hz'], [high, '6 kHz']]) {
    for (const offset of [-4, -3, 3, 4]) {
      const index = centre + offset
      if (index < 0 || index >= bands) continue
      assert.ok(region(centre) > result.levels[index], label + ' should peak above its neighbour at offset ' + String(offset))
    }
  }
  // Far away from both tones the spectrum is comparatively empty.
  assert.ok(result.levels[bands - 1] < region(high) / 2, 'the top band should be well below the 6 kHz peak')
  assert.ok(result.levels[0] < region(low) / 2, 'the bottom band should be well below the 500 Hz peak')
})

test('auto-gain normalises towards the loudest band without leaving 0..1', () => {
  const bands = 12
  const flat = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, smoothing: 0, gain: 0.4, gate: 0, punch: 0, flutter: 0 })
  const auto = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: true, smoothing: 0, gain: 0.4, gate: 0, punch: 0, flutter: 0 })
  const samples = tone(300, 0.05, 0.35)
  let plain = null
  let gained = null
  for (let index = 0; index < 12; index += 1) {
    plain = flat.analyze(samples)
    gained = auto.analyze(samples)
  }
  const plainSpread = Math.max(...plain.levels) - Math.min(...plain.levels)
  const gainedSpread = Math.max(...gained.levels) - Math.min(...gained.levels)
  assert.ok(gainedSpread >= plainSpread - 1e-6, 'auto-gain must not flatten the shape')
  assert.ok(Math.max(...gained.levels) > 0.9, 'the loudest band should approach full scale')
  for (const level of gained.levels) assert.ok(level >= 0 && level <= 1, 'level in range')
})

test('resample maps a spectrum onto any tick count, including inversion', () => {
  const levels = new Float32Array([0, 0.25, 0.5, 0.75, 1])
  const up = resample(levels, 9)
  const down = resample(levels, 3)
  assert.equal(up.length, 9)
  assert.equal(down.length, 3)
  assert.equal(up[0], 0)
  assert.ok(Math.abs(up[up.length - 1] - 1) < 1e-6)
  assert.ok(Math.abs(down[0] - 0) < 1e-6 && Math.abs(down[2] - 1) < 1e-6)
  const inverted = resample(levels, 5, true)
  assert.ok(Math.abs(inverted[0] - 1) < 1e-6)
  assert.equal(resample(new Float32Array(0), 3).length, 3)
  assert.equal(resample(levels, 0).length, 0)
  assert.equal(resample(levels, 1)[0], 0)
})

test('a steady tone settles without wobbling when the micro-motion is off', () => {
  const analyzer = createAnalyzer({ fftSize: 1024, bands: 4, sampleRate: RATE, autoGain: false, smoothing: 0.8, gate: 0, punch: 0, flutter: 0 })
  const samples = tone(500, 0.05, 0.6)
  let previous = -1
  for (let index = 0; index < 6; index += 1) {
    const result = analyzer.analyze(samples)
    const loudest = Math.max(...result.levels)
    assert.ok(loudest >= previous - 1e-9, 'a steady tone must not move backwards frame to frame')
    previous = loudest
  }
  assert.ok(previous > 0, 'the tone should have raised the levels')
})

test('attack is immediate, release is gradual, and bass outlasts treble', () => {
  // The old single-pole filter gave every band the same time constant, which is what made
  // the rail move as one body. Rise is now immediate; the fall is per band. Each tone is
  // measured in the band it actually excites, so the comparison is real.
  const bands = 16
  const quiet = new Float32Array(2048)
  const fallFrames = (frequency) => {
    const analyzer = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, gate: 0, punch: 0, flutter: 0 })
    const samples = tone(frequency, 0.05, 0.5)
    const first = analyzer.analyze(samples)
    assert.ok(first.peak > 0.8, 'a hit must be visible on the very first frame at ' + String(frequency) + ' Hz')
    const edges = computeBands(bands, 512, RATE, 45, 16000)
    const bin = Math.round((frequency / (RATE / 2)) * 512)
    let band = 0
    for (let index = 0; index < bands; index += 1) if (edges[index] <= bin && bin <= edges[index + 1]) band = index
    const start = first.levels[band]
    let frames = 0
    while (frames < 60) {
      const levels = analyzer.analyze(quiet).levels
      frames += 1
      if (levels[band] < start * 0.3) break
    }
    return frames
  }
  const bass = fallFrames(60)
  const treble = fallFrames(8000)
  assert.ok(bass > 6, 'bass must ring for several frames, went quiet after ' + String(bass))
  assert.ok(treble < bass, 'treble must let go before bass: ' + String(treble) + ' vs ' + String(bass))
})

test('the transient accent lifts a hit above the band average it is measured against', () => {
  const bands = 8
  // Quiet enough to sit mid-scale: the level mapping is a dB window, so an amplitude of
  // 0.06 already reads ~0.94 and no accent could be visible above it.
  const quietTone = tone(300, 0.05, 0.003)
  const hitTone = tone(300, 0.05, 0.012)
  const measure = (punch) => {
    const analyzer = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, gate: 0, punch, flutter: 0 })
    for (let frame = 0; frame < 40; frame += 1) analyzer.analyze(quietTone)   // settle the average
    const steady = Math.max(...analyzer.analyze(hitTone).levels)
    return { steady, after: Math.max(...analyzer.analyze(hitTone).levels) }
  }
  const plain = measure(0)
  const accented = measure(1.5)
  assert.ok(plain.after < 0.95, 'the fixture must not saturate, got ' + String(plain.after))
  assert.ok(
    accented.after > plain.after * 1.05,
    'a jump above the band average must be emphasised: ' + String(accented.after) + ' vs ' + String(plain.after),
  )
  assert.ok(accented.after <= 1, 'and it must still respect the ceiling')
})

test('the micro-motion varies between frames without becoming flicker', () => {
  const bands = 8
  const analyzer = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, gate: 0, punch: 0, flutter: 0.08 })
  // Mid-scale, or the ceiling would clamp every frame to the same 1.0 and hide the effect.
  const samples = tone(300, 0.05, 0.003)
  for (let frame = 0; frame < 20; frame += 1) analyzer.analyze(samples)   // settle
  const seen = []
  for (let frame = 0; frame < 12; frame += 1) seen.push(Math.max(...analyzer.analyze(samples).levels))
  const distinct = new Set(seen.map((value) => value.toFixed(4))).size
  assert.ok(distinct >= 6, 'neighbouring frames must not be identical, got ' + String(distinct))
  const spread = (Math.max(...seen) - Math.min(...seen)) / Math.max(...seen)
  assert.ok(spread < 0.35, 'the micro-motion must stay subtle, spread ' + spread.toFixed(3))

  // And it is multiplicative: with no audio at all it cannot keep a quiet room alive.
  const silent = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, autoGain: false, gate: 0.04, punch: 1.5, flutter: 0.35 })
  const quiet = silent.analyze(new Float32Array(2048))
  assert.equal(quiet.silent, true)
  for (const level of quiet.levels) assert.equal(level, 0)
})
