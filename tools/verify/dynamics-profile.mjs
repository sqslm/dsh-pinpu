/**
 * Measure the *character* of the spectrum dynamics, not just its correctness.
 *
 * The complaint this tool exists to answer was "the rail looks like a fixed-direction
 * scan". That is a claim about motion over time, so it needs a measurement over time:
 * a synthetic "music" signal (kick hits, a two-note melody, a little noise, then silence)
 * is pushed through the **real** analyser from `lib/spectrum.js`, and the resulting frames
 * are reduced to numbers that map onto the acceptance criteria:
 *
 * 1. *no fixed-direction scan* — the longest run of frames in which the loudest band keeps
 *    moving the same way (a travelling wave runs for many frames), plus reversals;
 * 2. *fast and slow, strong and weak* — the decay half-life of the lowest band against the
 *    highest one, measured separately;
 * 3. *not all in lockstep* — how correlated neighbouring bands' frame-to-frame changes are;
 * 4. *drums register* — the hit-against-steady contrast with the accent on, compared with
 *    the same signal and accent off, so the number is the accent's contribution and not
 *    just the kick's energy;
 * 5. *quiet means quiet* — activity decays to rest after the music stops, with no spikes.
 *
 * It also prints a strip chart of the frames, which is the same thing the rail draws.
 *
 * Usage: node tools/verify/dynamics-profile.mjs [--bands 12] [--seconds 4]
 */
import { createAnalyzer } from '../../lib/spectrum.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  const next = index >= 0 ? args[index + 1] : undefined
  return next === undefined || next.startsWith('--') ? fallback : next
}
const BANDS = Number(flag('bands', 12))
const SECONDS = Number(flag('seconds', 4))
const RATE = 48000
const HOP = 1024
const HOP_MS = (HOP / RATE) * 1000
const FRAMES = Math.round((SECONDS * RATE) / HOP)

/** Kick every 500 ms, a two-note melody, a little noise, then the last 40% silent. */
function music(index) {
  const t = index / RATE
  if (t >= SECONDS * 0.6) return 0
  const beat = t % 0.5
  const kick =
    beat < 0.12 ? Math.sin(2 * Math.PI * (55 + 40 * (1 - beat / 0.12)) * t) * Math.exp(-beat * 26) * 0.5 : 0
  const note = t % 0.75 < 0.375 ? 440 : 880
  const melody = Math.sin(2 * Math.PI * note * t) * 0.12 * (0.6 + 0.4 * Math.sin(2 * Math.PI * t * 2))
  const noise = (Math.random() * 2 - 1) * 0.01
  return kick + melody + noise
}

// Record the input once, so every pass below sees byte-identical audio (the noise term
// would otherwise make the A/B meaningless).
const slices = []
for (let frame = 0; frame < FRAMES; frame += 1) {
  const slice = new Float32Array(HOP)
  for (let index = 0; index < HOP; index += 1) slice[index] = music(frame * HOP + index)
  slices.push(slice)
}

const bands = BANDS
function run(options) {
  const analyzer = createAnalyzer({ fftSize: 1024, bands, sampleRate: RATE, smoothing: 0.78, autoGain: true, ...options })
  return slices.map((slice) => {
    const result = analyzer.analyze(slice)
    return { levels: Float32Array.from(result.levels), peak: result.peak, silent: result.silent }
  })
}

/** Longest run of frames where the loudest band keeps moving one way. */
function sweepOf(frames) {
  let longest = 0
  let run = 1
  let direction = 0
  let previous = frames[0].levels.indexOf(Math.max(...frames[0].levels))
  let reversals = 0
  for (let frame = 1; frame < frames.length; frame += 1) {
    const index = frames[frame].levels.indexOf(Math.max(...frames[frame].levels))
    const step = Math.sign(index - previous)
    if (step === 0) {
      run = 1
      direction = 0
    } else if (step === direction) {
      run += 1
    } else {
      run = 2
      direction = step
      reversals += 1
    }
    previous = index
    if (run > longest) longest = run
  }
  return { longest, reversals }
}

/** Decay half-life of one band, in frames, after the music stops (60% through). */
function halfLife(frames, band) {
  const start = Math.round(FRAMES * 0.6)
  if (start >= frames.length) return -1
  let peak = 0
  for (let frame = Math.max(0, start - 8); frame < start; frame += 1) peak = Math.max(peak, frames[frame].levels[band])
  for (let frame = start; frame < frames.length; frame += 1) {
    if (frames[frame].levels[band] < peak / 2) return frame - start
  }
  return -1
}

/** Mean correlation between neighbouring bands' frame-to-frame changes. */
function lockstep(frames) {
  const changes = []
  for (let frame = 1; frame < frames.length; frame += 1) {
    const row = []
    for (let band = 0; band < bands; band += 1) row.push(frames[frame].levels[band] - frames[frame - 1].levels[band])
    changes.push(row)
  }
  const corr = (a, b) => {
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
    const meanA = mean(a)
    const meanB = mean(b)
    let numerator = 0
    let denominatorA = 0
    let denominatorB = 0
    for (let index = 0; index < a.length; index += 1) {
      numerator += (a[index] - meanA) * (b[index] - meanB)
      denominatorA += (a[index] - meanA) ** 2
      denominatorB += (b[index] - meanB) ** 2
    }
    return denominatorA === 0 || denominatorB === 0 ? 0 : numerator / Math.sqrt(denominatorA * denominatorB)
  }
  const pairs = []
  for (let band = 0; band + 1 < bands; band += 1) {
    pairs.push(corr(changes.map((row) => row[band]), changes.map((row) => row[band + 1])))
  }
  return pairs.reduce((sum, value) => sum + value, 0) / pairs.length
}

/**
 * Hit contrast on the bass band: the peak of each kick against the steady level.
 *
 * The peak, not the mean over the hit window: the accent lives in the first frame or two
 * of a hit (after that the band's own recent peak has caught up, which is correct), so
 * averaging over the whole beat hides exactly the thing being measured.
 */
function kickContrast(frames) {
  const peaks = []
  const before = []
  let windowPeak = 0
  for (let frame = 1; frame < Math.round(frames.length * 0.6); frame += 1) {
    const beat = ((frame * HOP) / RATE) % 0.5
    const level = frames[frame].levels[0]
    if (beat < 0.12) {
      if (level > windowPeak) windowPeak = level
    } else {
      if (windowPeak > 0) peaks.push(windowPeak)
      windowPeak = 0
      if (beat > 0.3 && beat < 0.45) before.push(level)
    }
  }
  const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)
  const hit = mean(peaks)
  const steady = mean(before)
  return { hit, steady, contrast: steady === 0 ? 0 : hit / steady }
}

function chart(frames) {
  const ramp = ' .:-=+*#%@'
  const step = Math.max(1, Math.round(frames.length / 118))
  const lines = []
  for (let band = bands - 1; band >= 0; band -= 1) {
    let row = ''
    for (let frame = 0; frame < frames.length; frame += step) {
      const value = frames[frame].levels[band]
      row += ramp[Math.min(ramp.length - 1, Math.max(0, Math.round(value * (ramp.length - 1))))]
    }
    lines.push('  ' + row)
  }
  return lines.join('\n')
}

const frames = run({ punch: 0.55, flutter: 0.08 })
// With auto-gain on, the accent also raises the normalisation reference, so the contrast
// ratio alone cannot show what the accent does. The A/B that isolates it switches
// auto-gain off *and* keeps the fixture mid-scale: at the ceiling no accent can be
// visible, which is a real limit of any emphasis stage, not a property of this one.
const accentOn = run({ punch: 0.55, flutter: 0, autoGain: false, gain: 0.35 })
const accentOff = run({ punch: 0, flutter: 0, autoGain: false, gain: 0.35 })
const normalised = run({ punch: 0, flutter: 0.08 })
const sweep = sweepOf(frames)
const bassHalf = halfLife(frames, 0)
const trebleHalf = halfLife(frames, bands - 1)
const correlation = lockstep(frames)
const withAccent = kickContrast(accentOn)
const withoutAccent = kickContrast(accentOff)
const normalisedContrast = kickContrast(normalised)
const tail = frames.slice(Math.round(FRAMES * 0.9))
const tailPeak = Math.max(...tail.map((frame) => frame.peak))
const spikes = tail.filter((frame, index) => index > 0 && frame.peak > tail[index - 1].peak + 0.15).length

console.log('frames            :', FRAMES, '(' + HOP_MS.toFixed(1) + ' ms per frame, about ' + Math.round(1000 / HOP_MS) + ' fps)')
console.log('bands             :', bands, '| band 0 is the bass, band', bands - 1, 'the treble')
console.log('')
console.log('strip chart (top band first, one column = ' + String(Math.max(1, Math.round(frames.length / 118))) + ' frames)')
console.log(chart(frames))
console.log('')
console.log('longest one-direction run :', sweep.longest, 'frames (' + (sweep.longest * HOP_MS).toFixed(0) + ' ms), reversals:', sweep.reversals)
console.log('bass half-life            :', bassHalf, 'frames (' + (bassHalf * HOP_MS).toFixed(0) + ' ms)')
console.log('treble half-life          :', trebleHalf, 'frames (' + (trebleHalf * HOP_MS).toFixed(0) + ' ms)')
console.log('neighbour correlation     :', correlation.toFixed(3), '(-1..1; near 1 means the segments move as one body)')
console.log('kick contrast, accent on  :', withAccent.hit.toFixed(3), 'vs', withAccent.steady.toFixed(3), '=', withAccent.contrast.toFixed(2) + 'x', '(auto-gain off: the accent alone)')
console.log('kick contrast, accent off :', withoutAccent.hit.toFixed(3), 'vs', withoutAccent.steady.toFixed(3), '=', withoutAccent.contrast.toFixed(2) + 'x', '(auto-gain off)')
console.log('  with auto-gain on       :', normalisedContrast.contrast.toFixed(2) + 'x without the accent; the accent lifts the hit to full scale and the body to', kickContrast(frames).steady.toFixed(3))
console.log('after the music stops     : peak ' + tailPeak.toFixed(3) + ', upward spikes on the way down:', spikes)
console.log('')

const verdicts = [
  ['no fixed-direction scan', sweep.longest <= 6 && sweep.reversals >= 4],
  ['bass outlasts treble', bassHalf > trebleHalf && trebleHalf >= 0],
  ['segments are not one body', correlation < 0.75],
  ['the accent adds hit contrast', withAccent.contrast > withoutAccent.contrast],
  ['drums register', withAccent.contrast >= 1.15],
  ['quiet decays without spikes', tailPeak <= 0.06 && spikes === 0],
]
for (const [label, ok] of verdicts) console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
process.exitCode = verdicts.every(([, ok]) => ok) ? 0 : 1
