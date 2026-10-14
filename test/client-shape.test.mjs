/**
 * Browser-half contract: registration, service injects, and the pure helpers the
 * rail depends on.
 *
 * The bundle is loaded for real in a `vm` (see `test/helpers/harness.mjs`), so a
 * syntax error, a renamed constant or a missing export fails here instead of in the
 * running application.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContext, createForm, createHarness, realmPlain } from './helpers/harness.mjs'
import { DEFAULTS } from '../lib/defaults.js'

const harness = createHarness()
const { __test } = harness

test('the bundle registers itself under the package name', () => {
  assert.equal(harness.registration.id, 'dsh-pinpu')
  assert.equal(typeof harness.registration.factory, 'function')
})

test('the module face is the one Cordis expects', () => {
  assert.equal(harness.exports.name, 'dsh-pinpu-ui')
  assert.equal(typeof harness.exports.apply, 'function')
  // Cordis *service* names. A package name here would keep the fiber pending.
  assert.deepEqual(realmPlain(harness.exports.inject), ['slots', 'configForms'])
})

test('the test surface stays available to the suite', () => {
  for (const key of [
    'clamp',
    'num',
    'bool',
    'scaleFor',
    'bandForTick',
    'assignTicks',
    'scoreGroup',
    'pickRail',
    'demoLevels',
    'levelsFrom',
    'cssText',
    'withDefaults',
    'themeColors',
    'createEngine',
    'readConfig',
  ]) {
    assert.equal(typeof __test[key], 'function', key + ' must be a function')
  }
  assert.equal(__test.ENTRY_ID, 'pinpu')
  assert.equal(__test.SECTION_ID, 'pinpu')
  assert.equal(__test.SPECTRUM_URL, '/api/dsh-pinpu/spectrum')
  assert.equal(__test.DEVICES_URL, '/api/dsh-pinpu/devices')
})

test('the browser fallbacks cover every field the host publishes', () => {
  const fallback = realmPlain(__test.DEFAULTS)
  for (const field of [
    'enabled',
    'disableActiveHighlight',
    'hoverHighlight',
    'restoreOnSilence',
    'minScale',
    'maxScale',
    'invert',
    'side',
    'colorMode',
    'customColor',
    'demo',
  ]) {
    assert.deepEqual(fallback[field], DEFAULTS[field], field + ' drifted from lib/defaults.js')
  }
})

test('the stylesheet mirrors the rail only when the left edge is selected', () => {
  const right = realmPlain(__test.cssText({ side: 'right' }))
  assert.doesNotMatch(right, /left:12px/, 'the app already anchors the rail on the right')
  assert.doesNotMatch(right, /data-pinpu-side/)

  const left = realmPlain(__test.cssText({ side: 'left' }))
  assert.match(left, /\[data-pinpu-frame\]\[data-pinpu-side="left"\]\{left:12px !important;right:auto !important;\}/)
  assert.match(left, /\[data-pinpu-frame\]\[data-pinpu-side="left"\] \[data-pinpu-rail\]>\[data-pinpu-tick\]::before\{left:0 !important;right:auto !important;transform-origin:0% 50% !important;\}/)
  assert.match(left, /:has\(\[data-pinpu-rail\]\)/, 'the hover preview card has to move to the other side too')
  assert.ok(left.startsWith(right), 'the left rules are appended to the shared base rules')
})

test('clamp and the scalar readers refuse nonsense', () => {
  assert.equal(__test.clamp(5, 0, 1), 1)
  assert.equal(__test.clamp(-5, 0, 1), 0)
  assert.equal(__test.clamp(Number.NaN, 0.2, 1), 0.2)
  assert.equal(__test.clamp(0.5, 1, 0), 0.5, 'reversed bounds still work')
  assert.equal(__test.num('0.5', 1), 0.5)
  assert.equal(__test.num('nope', 7), 7)
  assert.equal(__test.num('', 7), 7)
  assert.equal(__test.num(undefined, 7), 7)
  assert.equal(__test.bool(undefined, true), true)
  assert.equal(__test.bool('false', true), false)
  assert.equal(__test.bool(0, true), false)
  assert.equal(__test.bool('yes', false), false)
})

test('a level maps into the configured length range', () => {
  assert.equal(__test.scaleFor(0, 0.4, 1), 0.4)
  assert.equal(__test.scaleFor(1, 0.4, 1), 1)
  assert.ok(Math.abs(__test.scaleFor(0.5, 0.4, 1) - 0.7) < 1e-9)
  assert.equal(__test.scaleFor(2, 0.4, 1), 1, 'levels above 1 clamp')
  assert.equal(__test.scaleFor(-1, 0.4, 1), 0.4, 'levels below 0 clamp')
  assert.equal(__test.scaleFor(0.5, 1, 0.4), 0.7, 'swapped bounds still interpolate')
  assert.equal(__test.scaleFor(0.5, 0, 1), 0.5)
})

test('bands are assigned low-to-high from the bottom mark', () => {
  // 4 marks, 8 bands: each mark owns two bands, starting at the bottom.
  assert.equal(__test.bandForTick(0, 4, false, 8), 0)
  assert.equal(__test.bandForTick(1, 4, false, 8), 2)
  assert.equal(__test.bandForTick(3, 4, false, 8), 6)
  assert.equal(__test.bandForTick(3, 4, true, 8), 1, 'inverted order puts the top band at the top mark')
  assert.equal(__test.bandForTick(99, 4, false, 8), 6, 'out-of-range ticks clamp')
  assert.equal(__test.bandForTick(-3, 4, false, 8), 0)
  assert.ok(__test.bandForTick(2, 3, false, 2) < 2, 'never addresses a band outside the spectrum')
})

test('marks are ranked from the bottom of the screen', () => {
  const rects = [
    { top: 100, bottom: 110 },
    { top: 130, bottom: 140 },
    { top: 110, bottom: 120 },
  ]
  assert.deepEqual(realmPlain(__test.assignTicks(rects)), [2, 0, 1])
  assert.deepEqual(realmPlain(__test.assignTicks([])), [])
})

test('the rail is recognised by geometry, and impostors are rejected', () => {
  const rail = []
  for (let index = 0; index < 6; index += 1) {
    rail.push({ top: 200 + index * 10, bottom: 210 + index * 10, left: 1240, right: 1268 })
  }
  assert.ok(__test.scoreGroup(rail) > 0, 'the shipped geometry must score')

  assert.equal(__test.scoreGroup([]), -1, 'an empty group is not a rail')
  assert.equal(__test.scoreGroup([rail[0]]), -1, 'one mark is not a rail')
  // A toolbar: wide buttons, side by side, same top.
  const toolbar = [
    { top: 10, bottom: 40, left: 0, right: 120 },
    { top: 10, bottom: 40, left: 130, right: 250 },
    { top: 10, bottom: 40, left: 260, right: 380 },
  ]
  assert.equal(__test.scoreGroup(toolbar), -1, 'a horizontal toolbar must not be taken for the rail')
  // A vertical list of big list rows is not a rail either.
  const rows = []
  for (let index = 0; index < 5; index += 1) {
    rows.push({ top: index * 60, bottom: index * 60 + 48, left: 100, right: 500 })
  }
  assert.equal(__test.scoreGroup(rows), -1, 'list rows must not be taken for the rail')
  // A column of unequal, misaligned items is rejected too.
  const sloppy = rail.slice(0, 4).map((rect, index) => ({ ...rect, right: rect.right - index * 6 }))
  assert.equal(__test.scoreGroup(sloppy), -1, 'unaligned marks must not be taken for the rail')

  const groups = [{ rects: toolbar }, { rects: rail }, { rects: rows }]
  assert.equal(__test.pickRail(groups), 1, 'the rail must win among candidates')
  assert.equal(__test.pickRail([{ rects: toolbar }]), -1)
  assert.equal(__test.pickRail([]), -1)
})

test('the spectrum payload is projected onto the marks', () => {
  // The bug this pins: reading only `ticks` while the route sends `levels` made every
  // level zero against the real host — marks pinned at the base length while the settings
  // card's peak (from `payload.peak`) updated normally.
  const routeShaped = { status: 'live', peak: 0.4, levels: [0, 0.5, 1] }
  assert.deepEqual(realmPlain(__test.levelsFrom(routeShaped, 3, false, 64)), [0, 0.5, 1])
  assert.deepEqual(realmPlain(__test.levelsFrom(routeShaped, 3, true, 64)), [1, 0.5, 0])
  // An unresampled host payload still maps onto however many marks exist.
  const wide = { status: 'live', levels: new Array(64).fill(0).map((_, index) => index / 63) }
  const mapped = realmPlain(__test.levelsFrom(wide, 5, false, 64))
  assert.equal(mapped.length, 5)
  for (let index = 1; index < mapped.length; index += 1) {
    assert.ok(mapped[index] > mapped[index - 1], 'low band first, rising towards the top')
  }
  // The older shape stays accepted.
  assert.deepEqual(realmPlain(__test.levelsFrom({ status: 'live', ticks: [0, 0.5, 1] }, 3, false, 64)), [0, 0.5, 1])
  // A payload with no spectrum at all is silence, not an exception.
  assert.deepEqual(realmPlain(__test.levelsFrom({ status: 'live' }, 4, false, 64)), [0, 0, 0, 0])
  assert.deepEqual(realmPlain(__test.levelsFrom(null, 2, false, 64)), [0, 0])
  // Values are clamped, so a bad payload cannot produce an out-of-range length.
  assert.deepEqual(realmPlain(__test.levelsFrom({ levels: [4, -4] }, 2, false, 64)), [1, 0])
})

test('the demonstration waveform is bounded, moves, and does not move as one body', () => {
  const first = __test.demoLevels(12, 1000, 64)
  const later = __test.demoLevels(12, 2400, 64)
  assert.equal(first.length, 12)
  for (const value of first) assert.ok(value >= 0 && value <= 1, 'demo level in range')
  assert.notDeepEqual(realmPlain(first), realmPlain(later), 'the demonstration must move')

  // The old generator used one shared set of periods, so the segments swung together and
  // the eye read a scan. Each segment now has its own period, phase and walk: over a
  // second of frames, the segments must not all move in the same direction at once.
  const frames = []
  for (let step = 0; step < 30; step += 1) frames.push(__test.demoLevels(12, 1000 + step * 33, 64))
  let sameDirection = 0
  for (let step = 1; step < frames.length; step += 1) {
    const changes = frames[step].map((value, index) => value - frames[step - 1][index])
    const rising = changes.filter((value) => value > 0.001).length
    const falling = changes.filter((value) => value < -0.001).length
    if (rising === 0 || falling === 0) sameDirection += 1
  }
  assert.ok(sameDirection < frames.length - 1, 'segments must not all move together every frame')
  const spread = new Set(frames[10].map((value) => value.toFixed(2))).size
  assert.ok(spread >= 4, 'the segments must differ from each other, got ' + String(spread) + ' distinct values')
})

test('the injected stylesheet overrides every state that matters', () => {
  const css = __test.cssText({ dim: '#111', bright: '#eee', base: 0.6 })
  assert.match(css, /data-pinpu-rail/)
  assert.match(css, /data-pinpu-tick/)
  assert.match(css, /:hover/)
  assert.match(css, /data-pinpu-live/)
  assert.match(css, /data-pinpu-neutral/)
  assert.match(css, /var\(--pinpu-scale/)
  assert.match(css, /scaleX\(0\.6\)/)
  assert.ok((css.match(/!important/g) ?? []).length >= 5, 'the app owns these pseudo-elements, so !important is required')
  assert.ok(css.indexOf(':hover') < css.indexOf('data-pinpu-live'), 'hover must be declared before the live rule it refines')
})

test('brightness is a second axis of the same level, and hover still wins', () => {
  const css = __test.cssText({ dim: '#111', bright: '#eee', base: 0.6 })
  // The live rule has to drive opacity from `--pinpu-glow` …
  assert.match(css, /opacity:calc\([^)]*var\(--pinpu-glow/, 'the live rule must fade with the level')
  // … and both hover rules must override it, so a hovered mark is always fully lit.
  const hoverRules = css.split('}').filter((rule) => rule.includes(':hover'))
  assert.equal(hoverRules.length, 2, 'hover is handled in the neutral and the live state')
  for (const rule of hoverRules) assert.match(rule, /opacity:1 !important/, 'hover must be fully lit: ' + rule)
  // The transition list has to include opacity, or the fade would step at the poll rate.
  assert.match(css, /transition:[^;]*opacity/)
})

test('a highlighted mark gets the bright colour, and the pointer still outranks it', () => {
  const css = __test.cssText({ dim: '#111', bright: '#eee', base: 0.6 })
  const rules = css.split('}').map((rule) => rule.trim() + '}')
  const hotRule = rules.find((rule) => rule.includes('[data-pinpu-hot]') && rule.includes('::before'))
  assert.ok(hotRule !== undefined, 'the highlight rule must exist')
  assert.match(hotRule, /background:#eee !important/, 'a highlighted mark uses the bright colour')
  assert.match(hotRule, /opacity:1 !important/, 'and full strength')
  assert.match(hotRule, /:not\(\[data-pinpu-busy\]\)/, 'a busy mark is never covered by it')

  // Hover and the highlight have equal specificity, so the live+hover rule must come last
  // for the pointer to win — otherwise a highlight would pin the mark being pointed at.
  const hotAt = rules.findIndex((rule) => rule.includes('[data-pinpu-hot]'))
  const liveHoverAt = rules.findIndex((rule) => rule.includes('[data-pinpu-live][data-pinpu-hover]'))
  assert.ok(hotAt >= 0 && liveHoverAt > hotAt, 'the hover rule must be declared after the highlight rule')
})

test('theme colours follow the configured mode', () => {
  const theme = realmPlain(__test.themeColors('theme'))
  assert.match(theme.dim, /--dsw-alias-border-l4/)
  assert.match(theme.bright, /--dsw-alias-label-primary/)
  const custom = realmPlain(__test.themeColors('custom', '#ff0000'))
  assert.equal(custom.dim, '#ff0000')
  assert.equal(custom.bright, '#ff0000')
  const fallback = realmPlain(__test.themeColors('custom', '   '))
  assert.match(fallback.dim, /--dsw-alias-border-l4/, 'a blank colour must fall back to the theme')
})

test('withDefaults fills the gaps without dropping unknown host fields', () => {
  const merged = realmPlain(__test.withDefaults({ minScale: 0.9, device: '31', somethingElse: true }))
  assert.equal(merged.minScale, 0.9)
  assert.equal(merged.device, '31')
  assert.equal(merged.somethingElse, true, 'host fields the browser does not use must survive')
  assert.equal(merged.maxScale, 1)
  assert.equal(realmPlain(__test.withDefaults(undefined)).enabled, true)
})

test('readConfig unwraps volatile references and survives a missing form', () => {
  const plainRef = { get: () => true }
  Object.freeze(plainRef)
  const values = {
    enabled: plainRef,
    device: '31',
    minScale: 0.5,
  }
  const controller = { getSnapshot: () => ({ value: values }) }
  assert.deepEqual(realmPlain(__test.readConfig(controller)), { enabled: true, device: '31', minScale: 0.5 })
  assert.equal(__test.readConfig(null).enabled, undefined)
  const throwing = { getSnapshot: () => { throw new Error('no form') } }
  assert.deepEqual(realmPlain(__test.readConfig(throwing)), {})
})

test('apply() registers only the settings section and wires the config form', () => {
  const harness2 = createHarness()
  const form = createForm({
    status: 'ready',
    writable: true,
    value: { enabled: false, device: '', minScale: 0.4, maxScale: 1, invert: false, colorMode: 'theme', customColor: '#4d93f8', demo: false, disableActiveHighlight: true, hoverHighlight: true, restoreOnSilence: true },
  })
  const ctx = createContext(form.form)
  harness2.exports.apply(ctx)
  assert.deepEqual(ctx.requestedIds, ['pinpu'])
  assert.deepEqual(ctx.injected, ['settings.section'])
  assert.equal(ctx.registrations.length, 1)
  // The real slot service rejects a registration whose options carry no `name` — the
  // failure that made this plugin's card invisible while its host half ran fine.
  assert.equal(ctx.registrations[0].options.name, 'settings.section')
  assert.equal(ctx.registrations[0].options.id, 'pinpu')
  assert.equal(ctx.registrations[0].options.order, 17)
  assert.equal(typeof ctx.registrations[0].options.label, 'string')
  assert.equal(typeof ctx.registrations[0].component, 'function')
  ctx.disposeAll()
  assert.equal(harness2.timerCount(), 0, 'disposing must leave no timers behind')
})

test('apply() reports to the host so a missing browser half is visible from outside', () => {
  const harness2 = createHarness()
  const ctx = createContext(createForm({ status: 'ready', writable: true, value: {} }).form)
  harness2.exports.apply(ctx)
  const reported = harness2.fetches.filter((call) => call.url.startsWith('/api/dsh-pinpu/client'))
  assert.ok(reported.length >= 1, 'the browser half must announce itself')
  assert.match(reported[0].url, /event=apply/)
  assert.ok(
    reported.some((call) => call.url.includes('detail=ready')),
    'the ready report is what tells the host the browser half finished applying',
  )
  assert.ok(
    harness2.fetches.every((call) => call.init?.credentials === 'same-origin'),
    'these are same-origin diagnostics',
  )
  ctx.disposeAll()
  assert.ok(
    harness2.fetches.some((call) => call.url.includes('event=stop')),
    'disposing reports the browser half going away',
  )
})
