/**
 * PCM plumbing: the ring the capture keeps between the helper process and the FFT.
 *
 * This is the seam the whole spectrum depends on and that no test covered, which is how
 * a frozen write cursor survived: the analyser received the same slice of the ring
 * forever, so the rail repeated one frame while audio kept flowing. These tests compare
 * the ring's *content* over time, not just its shape.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRing, pythonCandidates } from '../lib/loopback.js'
import { createAnalyzer } from '../lib/spectrum.js'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the helper is loaded from a private copy, never from the installed package', () => {
  // `pyaudiowpatch` ships a native `.pyd` that a live capture keeps mapped, and Windows
  // then refuses to rename or replace the package directory — which is how the
  // application's own `pnpm install` died with ERR_PNPM_EPERM and left a half-pruned
  // package behind. The private copy is what keeps the installed tree replaceable.
  const source = readFileSync(join(pluginRoot, 'lib', 'loopback.js'), 'utf8')
  assert.match(source, /function vendorRoot\(\)/, 'the vendor root must be resolved per run')
  assert.match(source, /cpSync\(source, target, \{ recursive: true \}\)/, 'the copy is what removes the lock')
  assert.match(source, /tmpdir\(\)/, 'the copy belongs in the OS temp directory')
  assert.doesNotMatch(source, /PYTHONPATH: vendorPath\(\)/, 'no spawn may point at the installed vendor directory')
  assert.match(source, /releaseVendor\(\)/, 'stopping the capture must drop the copy')
})

test('the shipped vendor tree contains everything the helper imports', () => {
  for (const relative of ['vendor/loopback.py', 'vendor/pyaudiowpatch/__init__.py', 'vendor/_portaudiowpatch.cp312-win_amd64.pyd']) {
    assert.ok(existsSync(join(pluginRoot, relative)), relative + ' must ship in the package')
  }
})

test('an installed directory stays replaceable, which is what pnpm needs', () => {
  // The guarantee the take-over depends on: renaming the installed package directory must
  // not need any process to die first (a locked file is exactly how it failed in the app).
  const probe = join(pluginRoot, 'node_modules', 'dsh-pinpu-replace-probe')
  const renamed = probe + '-renamed'
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'marker.txt'), 'x')
  try {
    renameSync(probe, renamed)
    renameSync(renamed, probe)
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
  assert.equal(existsSync(probe), false, 'the probe must clean up after itself')
})

/** A float32 LE buffer of consecutive values, so the ring's content is identifiable. */
function samples(from, count) {
  const buffer = Buffer.alloc(count * 4)
  for (let index = 0; index < count; index += 1) buffer.writeFloatLE(from + index, index * 4)
  return buffer
}

test('the ring hands back the newest samples, oldest first', () => {
  const ring = createRing(8)
  ring.ingest(samples(1, 4), 4)
  assert.deepEqual([...ring.view(4)], [1, 2, 3, 4])
  assert.equal(ring.fill(), 4)

  ring.ingest(samples(5, 4), 4)
  assert.deepEqual([...ring.view(4)], [5, 6, 7, 8])
  assert.deepEqual([...ring.view(8)], [1, 2, 3, 4, 5, 6, 7, 8])
})

test('the window keeps advancing after the ring has wrapped', () => {
  // The regression: a clamped write cursor made every later chunk overwrite the same
  // slots, so `view()` returned a frozen slice and the spectrum never changed again.
  const ring = createRing(16)
  const seen = []
  for (let round = 0; round < 6; round += 1) {
    ring.ingest(samples(round * 4 + 1, 4), 4)
    seen.push([...ring.view(4)])
  }
  for (const window of seen) assert.deepEqual(window, [...window].sort((a, b) => a - b), 'a window is in order')
  assert.deepEqual(seen[seen.length - 1], [21, 22, 23, 24], 'the last window is the newest audio')
  assert.notDeepEqual(seen[0], seen[1])
  assert.notDeepEqual(seen[1], seen[2])
  assert.notDeepEqual(seen[2], seen[3], 'windows must differ even after the first wrap')
  assert.notDeepEqual(seen[4], seen[5], 'and keep differing on every later round')
})

test('a window larger than what has arrived is served as-is, never padded with stale samples', () => {
  const ring = createRing(16)
  ring.ingest(samples(1, 3), 3)
  assert.deepEqual([...ring.view(8)], [1, 2, 3])
  assert.equal(ring.fill(), 3)
})

test('a burst bigger than the ring keeps its tail', () => {
  const ring = createRing(4)
  ring.ingest(samples(1, 10), 10)
  assert.deepEqual([...ring.view(4)], [7, 8, 9, 10])
})

test('resize drops the buffer, because the old samples no longer mean the same thing', () => {
  const ring = createRing(8)
  ring.ingest(samples(1, 8), 8)
  ring.resize(4)
  assert.equal(ring.fill(), 0)
  ring.ingest(samples(50, 2), 2)
  assert.deepEqual([...ring.view(4)], [50, 51])
})

test('clear() is what makes a dead capture report silence instead of replaying', () => {
  const ring = createRing(8)
  ring.ingest(samples(1, 8), 8)
  ring.clear()
  assert.equal(ring.fill(), 0)
  assert.equal(ring.view(4).length, 0, 'an empty ring yields no window at all')
  // …and the analyser reads that as silence, not as the audio it stopped receiving.
  const analyzer = createAnalyzer({ fftSize: 1024, bands: 8, sampleRate: 48000, autoGain: false, smoothing: 0 })
  const frame = analyzer.analyze(ring.view(1024))
  assert.equal(frame.silent, true)
  assert.deepEqual([...frame.levels], new Array(8).fill(0))
})

test('interpreter candidates are deduplicated and absolute-looking', () => {
  const candidates = pythonCandidates()
  assert.equal(new Set(candidates).size, candidates.length, 'no interpreter is offered twice')
  for (const candidate of candidates) assert.match(candidate, /python/i)
})
