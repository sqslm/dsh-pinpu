/**
 * System-audio capture: supervise `vendor/loopback.py` and keep a spectrum ready.
 *
 * The helper prints one JSON header on stderr (`{rate, channels, device}`) and then
 * raw little-endian float32 mono PCM on stdout; this module parses the header,
 * keeps the newest samples, runs {@link createAnalyzer} at ~30 Hz and exposes the
 * latest frame for the HTTP route.
 *
 * Why a child process at all: Windows' WASAPI loopback — "capture what the default
 * output device is playing" — has no in-process API available here. `getUserMedia`
 * can only open *capture endpoints*, and (measured) Chromium does not even list a
 * disabled Stereo Mix; PortAudio's loopback build, vendored as PyAudioWPatch, does
 * expose a `[Loopback]` input for every render device, and the harness already
 * ships a Python runtime.
 *
 * @module lib/loopback
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createAnalyzer } from './spectrum.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
/** Set once per process: the private copy of `vendor/` the helper is loaded from. */
let copiedVendor

/** How many samples we keep: enough for the largest FFT plus slack. */
const RING_SECONDS = 0.5
/** Analysis rate. 30 Hz is smooth under the rail's 140 ms CSS transition. */
const TICK_MS = 33
/** Restart backoff after a failed helper run. */
const RESTART_MS = 1500
/** `--list` is cached for this long. */
const DEVICE_CACHE_MS = 10000

/**
 * Every plausible Python interpreter, best first.
 *
 * The vendored PortAudio wheel is built for one CPython ABI (currently `cp312`), so an
 * interpreter of another minor version cannot import it. That is why this returns an
 * ordered list rather than one path: the capture walks it when the first interpreter
 * turns out to be incompatible, and the settings card shows which one was used.
 *
 * The desktop host passes `<runtime dir>` as an argument after the entry script
 * (`… --expose-internals <host entry> <dsh root> <profile> <runtime> …`), which is the
 * only reliable pointer to the interpreter the harness ships.
 */
export function pythonCandidates() {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  push(process.env.DSH_PINPU_PYTHON)
  for (const argument of process.argv ?? []) {
    if (typeof argument !== 'string' || !argument.includes('runtime')) continue
    push(join(argument, 'dependencies', 'python', 'python.exe'))
    push(join(argument, 'dependencies', 'python', 'bin', 'python3'))
  }
  if (typeof process.execPath === 'string') {
    const root = dirname(process.execPath)
    push(join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'))
    push(join(root, '..', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  const found = candidates.filter((candidate) => existsSync(candidate))
  for (const name of ['python3', 'python']) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (directory === '') continue
      const candidate = join(directory, process.platform === 'win32' ? name + '.exe' : name)
      if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

/** The best interpreter candidate, if any. */
export function findPython() {
  return pythonCandidates()[0]
}

const helperPath = () => join(vendorRoot(), 'loopback.py')

/**
 * Where the helper and its native module are loaded **from**.
 *
 * Never the installed package directory. `pyaudiowpatch` ships a native `.pyd`, and a
 * long-lived capture process keeps it mapped — which means Windows refuses to replace or
 * rename the package directory for as long as the plugin runs. That is not theoretical:
 * the application's own plugin manager ran `pnpm install` for an unrelated plugin and died
 * with
 *
 *     ERR_PNPM_EPERM importPackage node_modules\dsh-pinpu
 *     EPERM: rename '…\dsh-pinpu_tmp_33380_5' -> '…\dsh-pinpu'
 *
 * leaving a half-pruned package and a "cannot resolve profile bundle" error page.
 *
 * So a private copy is made under the OS temp directory (one per process), the helper runs
 * from there, and the installed files stay untouched and replaceable. The copy is removed
 * when the capture stops.
 */
function vendorRoot() {
  if (copiedVendor === undefined) {
    const source = join(pluginRoot, 'vendor')
    const target = join(tmpdir(), 'dsh-pinpu-' + String(process.pid) + '-' + Math.random().toString(36).slice(2, 8))
    try {
      cpSync(source, target, { recursive: true })
      copiedVendor = target
    } catch {
      // Nothing copied (read-only temp, exotic layout): fall back to the installed
      // directory. Capture still works; only an install-while-running can trip over it.
      copiedVendor = source
    }
  }
  return copiedVendor
}

/** Drop the private copy; called when the capture stops. */
function releaseVendor() {
  if (copiedVendor === undefined || copiedVendor === join(pluginRoot, 'vendor')) return
  const target = copiedVendor
  copiedVendor = undefined
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    /* a leftover in the temp directory is harmless */
  }
}

/**
 * Errors that mean "this interpreter cannot use the vendored wheel" rather than
 * "there is no audio": the extension is built for one CPython ABI, so a 3.13
 * interpreter cannot import a `cp312` `.pyd` at all. The capture walks to the next
 * candidate when it sees one of these.
 */
const INCOMPATIBLE_INTERPRETER = /pyaudiowpatch-missing|No module named/i

/**
 * Run `--list` and parse the loopback devices, trying each interpreter until one can
 * import the vendored PortAudio wheel.
 * @returns a promise of `{ ok, devices, error, python }`.
 */
export function listDevices() {
  const candidates = pythonCandidates()
  if (candidates.length === 0) return Promise.resolve({ ok: false, devices: [], error: 'python-not-found', python: undefined })
  return candidates.reduce(
    (chain, python) =>
      chain.then((result) => {
        if (result.ok) return result
        return listDevicesWith(python).then((next) => (next.ok ? next : { ...next, python }))
      }),
    Promise.resolve({ ok: false, devices: [], error: '', python: undefined }),
  )
}

function listDevicesWith(python) {
  return new Promise((resolve) => {
    const child = spawn(python, [helperPath(), '--list'], {
      env: { ...process.env, PYTHONPATH: vendorRoot(), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    const finish = (result) => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({ python, ...result })
    }
    child.on('error', (error) => finish({ ok: false, devices: [], error: String(error.message) }))
    child.on('close', (code) => {
      if (code !== 0 || out.trim() === '') {
        const detail = err.trim().split('\n').slice(-1)[0] ?? ''
        return finish({ ok: false, devices: [], error: detail === '' ? 'exit-' + String(code) : detail })
      }
      try {
        const devices = JSON.parse(out)
        finish({ ok: true, devices: Array.isArray(devices) ? devices : [], error: '' })
      } catch (error) {
        finish({ ok: false, devices: [], error: String(error.message) })
      }
    })
  })
}

/**
 * Create the capture. Nothing is spawned until {@link Capture.start} is called, and
 * a failed helper is retried with a backoff instead of hammering the machine.
 *
 * `status` is one of `stopped | python-missing | starting | live | error`; the
 * settings card and the route report it verbatim.
 */
/**
 * Ring of the newest PCM samples.
 *
 * The write cursor is an **absolute** sample count that is never clamped: the modulo
 * is taken only when addressing the ring. Clamping it (as this once did) makes the
 * write position restart at 0 once the ring is full, so every new chunk overwrites the
 * same first slots while `view()` keeps handing the analyser a frozen slice — the
 * spectrum then repeats the same frame forever even though samples keep arriving.
 *
 * @param length - capacity in samples.
 */
export function createRing(length) {
  let ring = new Float32Array(Math.max(1, Math.floor(length)))
  let written = 0

  const wrap = (value) => ((value % ring.length) + ring.length) % ring.length

  return {
    /** Capacity, which grows if the device reports another sample rate. */
    resize(next) {
      const wanted = Math.max(1, Math.floor(next))
      if (ring.length === wanted) return
      ring = new Float32Array(wanted)
      written = 0
    },
    /** How many samples are currently held (saturating at the capacity). */
    fill() {
      return Math.min(written, ring.length)
    },
    /** Append `count` samples read from `buffer` (float32 LE). */
    ingest(buffer, count) {
      if (count <= 0) return
      // Walk the cursor in chunks that never wrap twice, so the write position and
      // `view()` always agree — including for a burst larger than the whole ring.
      let consumed = 0
      while (consumed < count) {
        const take = Math.min(count - consumed, ring.length)
        for (let index = 0; index < take; index += 1) {
          ring[(written + index) % ring.length] = buffer.readFloatLE((consumed + index) * 4)
        }
        written += take
        consumed += take
      }
    },
    /** Drop everything (a dead capture must not replay its last second). */
    clear() {
      written = 0
    },
    /**
     * The newest `count` samples (or everything held), oldest → newest.
     *
     * Empty is a legitimate answer: nothing written means the analyser sees silence,
     * which is exactly what a dead capture should report.
     * @param count - the analyser's window size; the ring is much longer than this.
     */
    view(count) {
      const available = this.fill()
      if (available === 0) return new Float32Array(0)
      const wanted = Math.min(Math.max(1, Math.floor(count) || available), available)
      const out = new Float32Array(wanted)
      const start = wrap(written - wanted)
      for (let index = 0; index < wanted; index += 1) out[index] = ring[(start + index) % ring.length]
      return out
    },
  }
}


export function createCapture(options = {}) {
  const bands = Math.max(8, Number(options.bands ?? 64))
  const log = typeof options.log === 'function' ? options.log : () => {}

  let child = undefined
  let sampleRate = 48000
  let channels = 2
  let pending = Buffer.alloc(0)
  let analyzer = createAnalyzer({ fftSize: options.fftSize ?? 1024, bands, sampleRate: 48000 })
  let timer = undefined
  let restartTimer = undefined
  let restartDelay = RESTART_MS
  let device = ''
  let wantedDevice = ''
  let wantedFft = Number(options.fftSize ?? 1024)
  let wantedAutoGain = options.autoGain !== false
  /** Index into `pythonCandidates()`; advances past an interpreter that cannot import
   * the vendored wheel (it is built for one CPython ABI). */
  let pythonIndex = 0
  /** Set when the current child reported an unusable interpreter: on exit, retry. */
  let pendingRespawn = false
  let analysis = {
    smoothing: Number(options.smoothing ?? 0.78),
    gain: Number(options.gain ?? 1),
    gate: Number(options.gate ?? 0.04),
    minHz: Number(options.minHz ?? 45),
    maxHz: Number(options.maxHz ?? 16000),
    punch: Number(options.punch ?? 0.55),
    flutter: Number(options.flutter ?? 0.08),
  }
  let tuneKey = ''
  let status = 'stopped'
  let lastError = ''
  let frame = { peak: 0, levels: new Float32Array(bands), silent: true }
  let frames = 0
  let bytesTotal = 0
  let deviceCache = { at: 0, value: { ok: false, devices: [], error: '' } }

  function setStatus(next, error) {
    if (next === status && (error ?? '') === lastError) return
    status = next
    lastError = error ?? ''
    log({ event: 'status', result: next, device, error: lastError })
  }

  /** Rebuild the analyser whenever a parameter that shapes it changed. */
  function rebuild() {
    analyzer = createAnalyzer({
      fftSize: wantedFft,
      bands,
      sampleRate,
      autoGain: wantedAutoGain,
      ...analysis,
    })
  }

  const pcm = createRing(Math.ceil(48000 * RING_SECONDS))

  /** Grow the ring when the device's rate differs from the assumed one. */
  function sizeRing(rate) {
    pcm.resize(Math.ceil(rate * RING_SECONDS))
  }

  function ingest(buffer) {
    if (buffer.length === 0) return
    bytesTotal += buffer.length
    const usable = buffer.length - (buffer.length % 4)
    const count = usable / 4
    if (count === 0) return
    pcm.ingest(buffer, count)
  }

  /** The analyser window: exactly the newest frame, not the whole ring. */
  function view() {
    return pcm.view(analyzer.fftSize)
  }

  function tick() {
    try {
      frame = analyzer.analyze(view())
      frames += 1
    } catch (error) {
      setStatus('error', String(error?.message ?? error))
    }
  }

  function startTimer() {
    if (timer !== undefined) return
    timer = setInterval(tick, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  function spawnHelper() {
    const candidates = pythonCandidates()
    if (candidates.length === 0) {
      setStatus('python-missing', 'python-not-found')
      return
    }
    const python = candidates[Math.min(pythonIndex, candidates.length - 1)]
    setStatus('starting')
    pending = Buffer.alloc(0)
    try {
      child = spawn(python, ['-u', helperPath(), '--device', wantedDevice], {
        env: { ...process.env, PYTHONPATH: vendorRoot(), PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      child = undefined
      setStatus('error', String(error?.message ?? error))
      scheduleRestart()
      return
    }
    child.stdout.on('data', (chunk) => {
      const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      const usable = buffer.length - (buffer.length % 4)
      pending = usable === buffer.length ? Buffer.alloc(0) : buffer.subarray(usable)
      ingest(usable === buffer.length ? buffer : buffer.subarray(0, usable))
    })
    let header = ''
    let headerDone = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      if (!headerDone) {
        header += text
        const newline = header.indexOf('\n')
        if (newline >= 0) {
          headerDone = true
          const line = header.slice(0, newline).trim()
          header = header.slice(newline + 1)
          try {
            const parsed = JSON.parse(line)
            if (parsed.error !== undefined) {
              const detail = String(parsed.error) + (parsed.detail === undefined ? '' : ': ' + String(parsed.detail))
              setStatus('error', detail)
              // A wrong-ABI interpreter cannot import the vendored wheel; try the next
              // candidate once this child has exited, rather than backing off on a dead
              // end. `pendingRespawn` tells the close handler to do exactly that.
              if (INCOMPATIBLE_INTERPRETER.test(detail) && pythonIndex < candidates.length - 1) {
                pythonIndex += 1
                pendingRespawn = true
              }
            } else {
              sampleRate = Number(parsed.rate) || 48000
              channels = Number(parsed.channels) || 2
              device = String(parsed.device ?? '')
              sizeRing(sampleRate)
              rebuild()
              setStatus('live')
              restartDelay = RESTART_MS
              // Also on every *respawn*: the backoff path comes through here, and without
              // this the spectrum stayed frozen on the frame captured before the death.
              resumeAnalysis()
            }
          } catch {
            setStatus('error', 'bad-header')
          }
        }
      }
      if (headerDone && header.trim() !== '') {
        log({ event: 'helper', result: 'stderr', text: header.trim().slice(0, 400) })
        header = ''
      }
    })
    child.on('error', (error) => setStatus('error', String(error.message)))
    child.on('close', () => {
      child = undefined
      stopTimer()
      // Drop the buffered audio: a dead capture must report silence, not the last
      // spectrum it happened to see.
      pcm.clear()
      frame = { peak: 0, levels: new Float32Array(bands), silent: true }
      pending = Buffer.alloc(0)
      if (status === 'stopped') return
      if (pendingRespawn) {
        // Another interpreter candidate is waiting: retry at once, keeping the
        // analysis timer running.
        pendingRespawn = false
        spawnHelper()
        startTimer()
        return
      }
      setStatus('error', lastError === '' ? 'helper-exited' : lastError)
      scheduleRestart()
    })
  }

  function scheduleRestart() {
    if (restartTimer !== undefined) return
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      restartDelay = Math.min(15000, restartDelay * 1.5)
      if (status !== 'stopped') spawnHelper()
    }, restartDelay)
    if (typeof restartTimer.unref === 'function') restartTimer.unref()
  }

  /**
   * Bring an analysis frame into existence for the helper that just announced itself.
   *
   * Every respawn path funnels through here — the first start, an interpreter retry, and
   * the backoff after a helper died. Missing this in the backoff path froze the spectrum
   * on the last frame before the death while PCM kept arriving: `status: live`, `bytes`
   * growing, and a peak that never moved again. `startTimer` is idempotent.
   */
  function resumeAnalysis() {
    startTimer()
    if (frame === undefined) tick()
  }

  return {
    start() {
      if (child !== undefined || restartTimer !== undefined) return
      spawnHelper()
      startTimer()
    },
    stop() {
      setStatus('stopped')
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer)
        restartTimer = undefined
      }
      stopTimer()
      const running = child
      child = undefined
      if (running !== undefined) {
        try {
          running.kill()
        } catch {
          /* already gone */
        }
      }
      pcm.clear()
      frame = { peak: 0, levels: new Float32Array(bands), silent: true }
      pending = Buffer.alloc(0)
      pendingRespawn = false
      // The private copy of `vendor/` exists only to keep the installed package
      // replaceable while this runs; nothing needs it once the helper is gone.
      releaseVendor()
    },
    /** Apply live settings; restarts the helper only when the device changed. */
    configure(next = {}) {
      const nextDevice = typeof next.device === 'string' ? next.device : ''
      const nextFft = Number(next.fftSize ?? wantedFft)
      const nextAutoGain = next.autoGain !== false
      const wasFft = wantedFft
      const wasAutoGain = wantedAutoGain
      wantedFft = nextFft
      wantedAutoGain = nextAutoGain
      if (nextFft !== wasFft || nextAutoGain !== wasAutoGain) rebuild()
      if (nextDevice !== wantedDevice) {
        wantedDevice = nextDevice
        if (child !== undefined) {
          const running = child
          child = undefined
          try {
            running.kill()
          } catch {
            /* already gone */
          }
          setStatus('starting')
          spawnHelper()
        }
        deviceCache = { at: 0, value: deviceCache.value }
      }
    },
    /**
     * Live analysis parameters. Cheap to call every reconcile tick: it only rebuilds
     * the analyser when a shaping parameter actually changed.
     */
    tune(next = {}) {
      const merged = {
        smoothing: next.smoothing === undefined ? analysis.smoothing : Number(next.smoothing),
        gain: next.gain === undefined ? analysis.gain : Number(next.gain),
        gate: next.gate === undefined ? analysis.gate : Number(next.gate),
        minHz: next.minHz === undefined ? analysis.minHz : Number(next.minHz),
        maxHz: next.maxHz === undefined ? analysis.maxHz : Number(next.maxHz),
        punch: next.punch === undefined ? analysis.punch : Number(next.punch),
        flutter: next.flutter === undefined ? analysis.flutter : Number(next.flutter),
      }
      const key = JSON.stringify([merged, wantedFft, wantedAutoGain, bands, sampleRate])
      if (key === tuneKey) return
      tuneKey = key
      analysis = merged
      rebuild()
    },
    /**
     * Latest frame, plus everything the UI needs to explain itself.
     *
     * Deliberately no `ticks` field: the spectrum travels as the route's `levels` array,
     * and a second name for the same thing is how the two halves drifted apart once
     * already (the browser half read `ticks`, the route sent `levels`, every mark froze at
     * its base length while the peak moved).
     */
    snapshot() {
      return {
        status,
        error: lastError,
        device,
        rate: sampleRate,
        channels,
        peak: Number(frame.peak.toFixed(4)),
        silent: frame.silent,
        frames,
        bytes: bytesTotal,
      }
    },
    levels() {
      return frame.levels
    },
    devices(force = false) {
      const now = Date.now()
      if (!force && now - deviceCache.at < DEVICE_CACHE_MS) return Promise.resolve(deviceCache.value)
      return listDevices().then((value) => {
        deviceCache = { at: Date.now(), value }
        return value
      })
    },
    stats() {
      return { status, device, frames, bytes: bytesTotal, sampleRate, channels }
    },
    /** Absolute path of the interpreter in use, for the settings card's diagnostics. */
    python: () => {
      const candidates = pythonCandidates()
      return candidates.length === 0 ? undefined : candidates[Math.min(pythonIndex, candidates.length - 1)]
    },
    analyze: (samples) => analyzer.analyze(samples),
  }
}
