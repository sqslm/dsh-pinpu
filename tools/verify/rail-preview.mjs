/**
 * Visual verification of the rail take-over, in a real browser.
 *
 * The page is the strongest evidence available offline that the plugin does what the
 * user asked, because it uses the **real** ingredients and only fakes the data:
 *
 * - the shipped turn rail's **own stylesheet and class names**, extracted from the
 *   installed `@deepseek-ai/dsh-client-ui-chat` bundle (`tools/verify/rail-css.mjs`),
 *   so the plugin's `!important` overrides are tested against the actual cascade —
 *   including `markActive`, `markPreview` and the busy animation;
 * - the **real** `lib/client.js`, loaded through a `__ModuleLoader__` shim and applied
 *   with a stand-in ctx, so the rail discovery, the injected stylesheet, the polling
 *   loop and the per-mark writes are all the shipped code;
 * - the app's dark-theme tokens, resolved from its own theme bundle.
 *
 * Only `/api/dsh-pinpu/spectrum` is stubbed, with a moving multi-band spectrum.
 *
 * Screenshots: the rail as shipped (the newest turn highlighted), after the
 * take-over with audio (dancing, all dim), with the pointer on one mark (bright and
 * full length), and with the capture silent again.
 *
 * Usage:
 *   node tools/verify/rail-preview.mjs [--headless] [--out-dir .verify]
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, evaluate, launch, openFile, screenshot, sleep, waitForTarget } from './cdp.mjs'
import { darkTokenCss } from './theme.mjs'
import { loadRailCss } from './rail-css.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const clientSource = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
const { css: railCss, names } = loadRailCss()
const tokens = darkTokenCss()

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf('--' + name)
  if (index < 0) return fallback
  const next = args[index + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const headless = flag('headless', true) === true
const outDir = String(flag('out-dir', join(pluginRoot, '.verify')))
/** Which edge the rail is asked to sit on: `right` (the app's own) or `left`. */
const side = String(flag('side', 'right')) === 'left' ? 'left' : 'right'
const suffix = side === 'left' ? '-left' : ''

/** 15 turns: the last one is the app's "active" mark, one earlier one is "busy". */
const TURNS = 15
const ACTIVE_INDEX = TURNS - 1
const BUSY_INDEX = TURNS - 4

function marks() {
  const out = []
  for (let index = 0; index < TURNS; index += 1) {
    const classes = [names.mark]
    if (index === ACTIVE_INDEX) classes.push(names.markActive)
    if (index === BUSY_INDEX) classes.push(names.markBusy)
    out.push(`<button type="button" class="${classes.join(' ')}" data-turn="${String(index)}" style="top:${String(index * 10)}px" aria-label="turn ${String(index + 1)}"></button>`)
  }
  return out.join('\n      ')
}

function pageHtml() {
  return `<!doctype html><html data-ds-dark-theme><head><meta charset="utf-8"><title>dsh-pinpu rail take-over</title>
<style>
:root{${tokens}--dsh-composer-height:117px}
html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base,#16181d);color:var(--dsw-alias-label-primary,#e6e8eb);
  font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
#stage{height:100vh;display:flex;justify-content:center;align-items:flex-start}
/* The conversation scrollport: the two facts the rail is banded by. */
#conversation{position:relative;width:995px;height:543px;margin-top:160px;overflow:hidden;border-left:.5px solid var(--dsw-alias-border-l3,#33343a)}
/* The shipped rail's own stylesheet, verbatim. */
${railCss}
#composer{position:absolute;left:0;right:0;bottom:0;height:117px;background:var(--dsw-specific-input-major,#1d1f24);border-top:.5px solid var(--dsw-alias-border-l1,#ffffff14)}
#label{position:absolute;left:16px;top:8px;font-size:11px;color:var(--dsw-alias-label-caption,#878d99)}
#turnlog{position:absolute;right:60px;top:12px;font-size:11px;color:var(--dsw-alias-label-caption,#878d99);text-align:right}
</style></head>
<body>
<div id="stage">
  <div id="conversation" data-conversation-scroll>
    <div id="label">conversation scrollport · data-conversation-scroll</div>
    <div id="turnlog"></div>
    <div class="${names.slot}">
      <div class="${names.frame}" id="rail-frame">
        <div class="${names.scroller}">
          <!-- The app's rail virtualises its marks and writes the total height inline; a
               zero-height marks box would be clipped by the scroller's overflow. -->
          <div class="${names.marks}" id="rail-marks" style="height:${String(TURNS * 10)}px">
      ${marks()}
          </div>
        </div>
        <!-- The shipped hover preview card, which the app anchors to the rail's left. -->
        <div class="${names.preview}" id="turn-preview">
          <div class="${names.previewPrompt}">turn 8 · sample prompt text — the fixture only needs two lines of body copy</div>
          <div class="${names.previewResponse}">Sample answer text, so the preview card has a realistic second line.</div>
        </div>
      </div>
    </div>
    <div id="composer">composer · --dsh-composer-height: 117px</div>
  </div>
</div>
<script>
// ── module-system stand-in (the app supplies the real one) ────────────────────
window.__ModuleLoader__ = { load: function (registration) { window.__registration = registration } }
window.__errors = []
window.addEventListener('error', function (event) { window.__errors.push(String(event.message)) })
// The settings card is not rendered here (its own test covers that), so the React
// face only has to exist for the factory to capture its hooks.
window.__reactStub = {
  createElement: function () { return null },
  useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
  useRef: function () { return { current: null } },
  useMemo: function (factory) { return factory() },
  useCallback: function (factory) { return factory },
  useEffect: function () {},
  useSyncExternalStore: function (subscribe, getSnapshot) { return getSnapshot() },
}
window.__clicks = []
document.getElementById('rail-marks').addEventListener('click', function (event) {
  var button = event.target.closest('button')
  if (button) window.__clicks.push(button.getAttribute('data-turn'))
})
</script>
<script>${clientSource}</script>
<script>
// ── a stubbed spectrum feed; nothing else about the plugin is simulated ───────
window.__mode = 'live'
// Per-segment state, because the *shape* of the feed decides what the rail looks like:
// one shared travelling wave (what this used to generate) photographs as the fixed-order
// scan the rail is supposed to avoid, so the fixture has to be as varied as real audio.
var __segments = null
function spectrum(ticks, time) {
  if (__segments === null || __segments.length !== ticks) {
    __segments = []
    for (var seed = 0; seed < ticks; seed += 1) {
      __segments.push({
        rate: 0.15 + 0.2 * ((seed * 0.6180339887) % 1),
        phase: ((seed * 0.7548776662) % 1) * Math.PI * 2,
        walk: 0,
      })
    }
  }
  var beat = (time % 500) / 500
  var kick = beat < 0.14 ? Math.exp(-beat * 18) : 0
  var out = []
  for (var index = 0; index < ticks; index += 1) {
    var pos = ticks === 1 ? 0 : index / (ticks - 1)
    var state = __segments[index]
    state.walk = state.walk * 0.9 + (Math.random() * 2 - 1) * 0.25
    var body = 0.35 + 0.3 * Math.sin(time / 1000 * state.rate * 6.283 + state.phase)
    var detail = 0.2 * Math.sin(time / 1000 * state.rate * 3.7 * 6.283 + state.phase * 1.7)
    // The kick lands hardest at the bass end (the bottom of the rail by default).
    var low = Math.exp(-pos * 3.2) * kick * 0.85
    out.push(Math.min(1, Math.max(0, body + detail + low + state.walk * 0.12)))
  }
  return out
}
window.__fetchCalls = []
window.fetch = function (url, init) {
  var text = String(url)
  window.__fetchCalls.push(text)
  var payload
  if (text.indexOf('/api/dsh-pinpu/devices') === 0) {
    payload = { ok: true, available: true, devices: [
      { index: 31, name: 'Speakers (Realtek Audio) [Loopback]', default: true },
      { index: 30, name: '扬声器 (Realtek USB Audio) [Loopback]', default: false },
    ] }
  } else if (text.indexOf('/api/dsh-pinpu/client') === 0) {
    payload = { ok: true, recorded: 'heartbeat', count: 1 }
  } else {
    var ticks = 15
    var match = /ticks=(\\d+)/.exec(text)
    if (match) ticks = Number(match[1])
    var silent = window.__mode === 'silent'
    payload = {
      ok: true,
      status: window.__mode === 'stopped' ? 'error' : 'live',
      error: window.__mode === 'stopped' ? 'python-not-found' : '',
      device: 'Speakers (Realtek Audio) [Loopback]',
      peak: silent ? 0 : 0.72,
      silent: silent,
      levels: silent ? new Array(ticks).fill(0) : spectrum(ticks, performance.now()),
    }
  }
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload) } })
}

// ── boot the real plugin with a stand-in ctx ──────────────────────────────────
var exports = window.__registration.factory(function (specifier) {
  if (specifier === 'react') return window.__reactStub
  throw new Error('unexpected require: ' + specifier)
})
var config = {
  enabled: true,
  device: '',
  disableActiveHighlight: true,
  hoverHighlight: true,
  restoreOnSilence: true,
  minScale: 0.4,
  maxScale: 1,
  invert: false,
  side: '${side}',
  colorMode: 'theme',
  customColor: '#4d93f8',
  demo: false,
}
window.__sections = []
var cleanups = []
/** Apply the plugin — deferred so the rail can be photographed as shipped first. */
window.__start = function () {
  exports.apply({
    configForms: { get: function () { return { getSnapshot: function () { return { status: 'ready', writable: true, value: config } }, subscribe: function () { return function () {} }, set: function () { return Promise.resolve(true) } } } },
    slots: {
      inject: function (name, run) { run() },
      register: function (options) { window.__sections.push(options); return function () {} },
    },
    effect: function (run) { var cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup); return function () {} },
  })
  return window.__sections.length
}

window.__report = function () {
  var rail = document.getElementById('rail-marks')
  var frame = document.getElementById('rail-frame')
  var preview = document.getElementById('turn-preview')
  var marks = Array.prototype.slice.call(rail.querySelectorAll('button'))
  var previewRect = preview.getBoundingClientRect()
  var frameRect = frame.getBoundingClientRect()
  return {
    side: frame.getAttribute('data-pinpu-side'),
    frameTagged: frame.getAttribute('data-pinpu-frame'),
    // Where the rail physically ended up, and which side the preview card opens on.
    frameLeft: Math.round(frameRect.left),
    previewOpensTo: previewRect.left >= frameRect.right ? 'right' : 'left',
    discovered: marks.length,
    tags: marks.map(function (mark) { return mark.getAttribute('data-pinpu-tick') }),
    railAttributes: {
      rail: rail.getAttribute('data-pinpu-rail'),
      neutral: rail.getAttribute('data-pinpu-neutral'),
      hover: rail.getAttribute('data-pinpu-hover'),
      live: rail.getAttribute('data-pinpu-live'),
      busy: marks.filter(function (mark) { return mark.hasAttribute('data-pinpu-busy') }).length,
    },
    scales: marks.map(function (mark) {
      var value = mark.style.getPropertyValue('--pinpu-scale')
      return value === '' ? null : Number(value)
    }),
    // The app's own state must still be on the elements: we restyle, never rewrite.
    appClassesIntact: marks[14].className.indexOf('${names.markActive}') >= 0 && marks[11].className.indexOf('${names.markBusy}') >= 0,
    styleTag: document.getElementById('dsh-pinpu-rail-style') !== null,
    sections: window.__sections.map(function (section) { return section.id + ':' + section.order }),
    fetchCalls: window.__fetchCalls.slice(-2),
  }
}
window.__setMode = function (mode) { window.__mode = mode; return mode }
</script>
</body></html>`
}

/** Colours of the visible `::before` bars, so the state can be asserted numerically. */
const PROBE = `(function () {
  var marks = Array.prototype.slice.call(document.querySelectorAll('#rail-marks button'))
  return marks.map(function (mark) {
    var style = getComputedStyle(mark, '::before')
    return { background: style.backgroundColor, transform: style.transform, width: style.width }
  })
})()`

async function main() {
  const page = join(await mkdtemp(join(tmpdir(), 'dsh-pinpu-preview-')), 'preview.html')
  await writeFile(page, pageHtml())
  await mkdir(outDir, { recursive: true })
  const { child, port } = await launch({ headless })
  const shots = []
  try {
    const client = await connect(await waitForTarget(port))
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await openFile(client, page, 600)

    // 1. The rail as shipped: the newest turn is the bright, full-length mark.
    const before = await evaluate(client, PROBE)
    const beforePath = join(outDir, 'preview-native' + suffix + '.png')
    await screenshot(client, beforePath)
    shots.push(beforePath)

    // 2. With audio: every mark dim, lengths following the spectrum.
    const sections = await evaluate(client, 'window.__start()')
    await sleep(900)
    const live = await evaluate(client, 'window.__report()')
    const liveBars = await evaluate(client, PROBE)
    const livePath = join(outDir, 'preview-live' + suffix + '.png')
    await screenshot(client, livePath)
    shots.push(livePath)

    // 2b. Sample the rail *while it is live* — the later sections switch the page to the
    // silent and hover states, and sampling after those reads a parked rail (every
    // `--pinpu-scale` removed, which `Number(null)` turns into a constant zero).
    const samples = []
    for (let step = 0; step < 28; step += 1) {
      const report = await evaluate(client, 'window.__report()')
      if (Array.isArray(report.scales)) {
        const frame = report.scales.filter((value) => value !== null).map((value) => Number(value))
        if (frame.length > 0) samples.push(frame)
      }
      await new Promise((done) => setTimeout(done, 45))
    }
    let moved = 0
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]
      const current = samples[index]
      const width = Math.min(previous.length, current.length)
      for (let at = 0; at < width; at += 1) {
        if (Math.abs(current[at] - previous[at]) > 0.02) {
          moved += 1
          break
        }
      }
    }
    const flat = samples.flat()
    const spread = flat.length === 0 ? 0 : Math.max(...flat) - Math.min(...flat)

    // 3. The pointer on the middle mark: bright and full length, only there.
    const box = await evaluate(
      client,
      `(function () {
        var mark = document.querySelectorAll('#rail-marks button')[7]
        var rect = mark.getBoundingClientRect()
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      })()`,
    )
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
    await sleep(320)
    const hover = await evaluate(client, PROBE)
    const hoverState = await evaluate(
      client,
      `(function () {
        var mark = document.querySelectorAll('#rail-marks button')[7]
        var at = document.elementFromPoint(${String(box.x)}, ${String(box.y)})
        return {
          position: { x: ${String(box.x)}, y: ${String(box.y)} },
          hoverMatches: mark.matches(':hover'),
          elementAtPoint: at === null ? null : at.tagName + '.' + at.className,
          tokenLabelPrimary: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-label-primary').trim(),
        }
      })()`,
    )
    const hoverPath = join(outDir, 'preview-hover' + suffix + '.png')
    await screenshot(client, hoverPath)
    shots.push(hoverPath)

    // A click must still reach the app's own handler.
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(120)
    const clicks = await evaluate(client, 'window.__clicks')

    // 4. Silence: the marks park at the neutral floor, nothing highlights.
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' })
    await evaluate(client, "window.__setMode('silent')")
    await sleep(1500)
    const silent = await evaluate(client, 'window.__report()')
    const silentPath = join(outDir, 'preview-silent' + suffix + '.png')
    await screenshot(client, silentPath)
    shots.push(silentPath)

    const active = (list) => list[14]
    console.log('sections registered by apply():', sections)
    console.log('native rail, last mark (the built-in highlight):', JSON.stringify(active(before)))
    console.log('after take-over, last mark:', JSON.stringify(active(liveBars)))
    console.log('after take-over, first mark:', JSON.stringify(before[0]))
    console.log('live report:', JSON.stringify(live, null, 2))
    console.log('hovered mark (index 7):', JSON.stringify(hover[7]))
    console.log('un-hovered mark (index 3) while hovering:', JSON.stringify(hover[3]))
    console.log('hover diagnostics:', JSON.stringify(hoverState))
    console.log('silent report:', JSON.stringify(silent, null, 2))
    console.log('clicks delivered to the app handler:', JSON.stringify(clicks))
    const distinct = new Set(live.scales.filter((value) => value !== null).map((value) => value.toFixed(2)))
    console.log('distinct mark lengths while playing:', distinct.size)
    console.log('samples taken while playing:', samples.length)
    console.log('samples where the rail moved:', moved, 'of', Math.max(0, samples.length - 1))
    console.log('mark length range across samples:', spread.toFixed(2))
    console.log('(the no-scan measurement lives in tools/verify/dynamics-profile.mjs, on real audio)')
    console.log(
      'VERDICT:',
      live.discovered === TURNS &&
        live.railAttributes.neutral === '1' &&
        live.railAttributes.live === '1' &&
        distinct.size >= 5 &&
        hover[7].transform !== hover[3].transform &&
        clicks.length === 1 &&
        samples.length > 10 &&
        moved >= samples.length - 8 &&
        spread > 0.2
        ? 'the shipped rail was taken over and dances'
        : 'take-over incomplete (see the report above)',
    )
    console.log('screenshots:')
    for (const shot of shots) console.log('  ' + shot)
    const pageErrors = await evaluate(client, 'window.__errors')
    if (pageErrors.length > 0) console.log('page errors:', JSON.stringify(pageErrors))
    client.close()
  } finally {
    child.kill()
  }
}

await main()
