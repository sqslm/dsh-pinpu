/**
 * The rail take-over, driven end to end against a DOM.
 *
 * This is the test that would have caught every way the take-over can silently do
 * nothing: marks not discovered, attributes never set, the spectrum route never
 * polled, levels written outside the configured range, or silence failing to hand
 * the rail back. It uses the real engine from the bundle and a fake conversation
 * whose marks carry the shipped rail's geometry (28×10 buttons, a 10 px step, one
 * shared right edge).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHarness } from './helpers/harness.mjs'

const MARKS = 5

/**
 * A conversation with a rail of `count` marks; returns the pieces tests assert on.
 *
 * The nesting mirrors the shipped rail: the marks live in a `relative` container, which
 * sits in the app's `absolute` frame — that frame is what a left-side rail has to move.
 */
function buildConversation(harness, count = MARKS) {
  const scroller = harness.createElement('div')
  scroller.setAttribute('data-conversation-scroll', '')
  scroller.setRect({ top: 160, left: 200, width: 900, height: 540 })
  const frame = harness.createElement('div')
  frame.setRect({ top: 240, left: 1240, width: 28, height: count * 10 })
  frame.setComputed({ position: 'absolute', right: '12px', left: 'auto' })
  const rail = harness.createElement('div')
  rail.setRect({ top: 240, left: 1240, width: 28, height: count * 10 })
  rail.setComputed({ position: 'relative' })
  const marks = []
  for (let index = 0; index < count; index += 1) {
    const mark = harness.createElement('button')
    // Shipped geometry: 28×10, a 10 px step, right-aligned at the rail's edge.
    mark.setRect({ top: 240 + index * 10, left: 1240, width: 28, height: 10 })
    rail.appendChild(mark)
    marks.push(mark)
  }
  frame.appendChild(rail)
  scroller.appendChild(frame)
  harness.document.body.appendChild(scroller)
  return { scroller, frame, rail, marks }
}

function configure(engine, overrides = {}) {
  engine.configure({
    enabled: true,
    disableActiveHighlight: true,
    hoverHighlight: true,
    restoreOnSilence: true,
    minScale: 0.4,
    maxScale: 1,
    invert: false,
    side: 'right',
    colorMode: 'theme',
    customColor: '#4d93f8',
    demo: false,
    ...overrides,
  })
}

test('the rail sits on the configured edge, and switching edges moves it', async () => {
  // The app anchors the rail's frame at `right:12px`; only the frame controls which edge
  // the rail is on, so the plug-in has to tag and re-tag it rather than the marks.
  const harness = createHarness()
  const { frame } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  assert.equal(frame.getAttribute(harness.__test.FRAME_ATTR), '1', 'the positioning frame must be tagged')
  assert.equal(frame.getAttribute(harness.__test.SIDE_ATTR), 'right')
  assert.doesNotMatch(harness.document.getElementById(harness.__test.STYLE_ID).textContent, /left:12px/)

  configure(engine, { side: 'left' })
  await harness.settle()
  assert.equal(frame.getAttribute(harness.__test.SIDE_ATTR), 'left')
  const css = harness.document.getElementById(harness.__test.STYLE_ID).textContent
  assert.match(css, /\[data-pinpu-frame\]\[data-pinpu-side="left"\]\{left:12px !important;right:auto !important;\}/)
  assert.match(css, /transform-origin:0% 50% !important/, 'mirrored marks must grow away from the edge they sit on')

  configure(engine, { side: 'right' })
  await harness.settle()
  assert.equal(frame.getAttribute(harness.__test.SIDE_ATTR), 'right')
  assert.doesNotMatch(harness.document.getElementById(harness.__test.STYLE_ID).textContent, /left:12px/)

  engine.stop()
  assert.equal(frame.getAttribute(harness.__test.SIDE_ATTR), null, 'stopping must leave no attributes behind')
})

test('the marks are discovered, tagged bottom-first, and neutralised', async () => {
  const harness = createHarness()
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.RAIL_ATTR), '1', 'the container must be tagged')
  const tags = marks.map((mark) => mark.getAttribute(harness.__test.TICK_ATTR))
  assert.deepEqual(tags, ['4', '3', '2', '1', '0'], 'tick 0 is the bottom-most mark')
  assert.equal(rail.getAttribute(harness.__test.NEUTRAL_ATTR), '1', 'the default highlight must be neutralised')
  assert.equal(rail.getAttribute(harness.__test.HOVER_ATTR), '1', 'hover highlighting is on by default')
  assert.notEqual(harness.document.getElementById(harness.__test.STYLE_ID), null, 'the overrides must be injected')
  engine.stop()
})

test('a spectrum payload becomes per-mark lengths inside the configured range', async () => {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const harness = createHarness({ fetch: () => ({ status: 'live', silent: false, peak: 0.8, device: 'Test [Loopback]', ticks }) })
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine, { minScale: 0.4, maxScale: 1 })
  await harness.settle()
  harness.advance(60)
  await harness.settle()

  assert.ok(harness.fetches.length >= 1, 'the spectrum route must be polled')
  assert.match(harness.fetches[0].url, /^\/api\/dsh-pinpu\/spectrum\?ticks=5$/)
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1', 'a live spectrum takes the marks over')
  const scales = marks.map((mark) => Number(mark.style.getPropertyValue('--pinpu-scale')))
  assert.deepEqual(scales.map((value) => Math.round(value * 100) / 100), [1, 0.85, 0.7, 0.55, 0.4])
  for (const value of scales) assert.ok(value >= 0.4 && value <= 1, 'scale inside the configured range')
  assert.ok(engine.status().peak > 0)
  assert.equal(engine.status().device, 'Test [Loopback]')
  engine.stop()
})

test('each segment also carries its own brightness, and the switch turns it off', async () => {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const harness = createHarness({ fetch: () => ({ status: 'live', silent: false, peak: 0.8, ticks }) })
  const { marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  harness.advance(60)
  await harness.settle()

  const glow = marks.map((mark) => Number(mark.style.getPropertyValue('--pinpu-glow')))
  for (const value of glow) assert.ok(value >= 0.18 && value <= 1, 'brightness inside 0.18..1, got ' + String(value))
  // `marks` is in document order (top first) and the payload runs low band → high band, so
  // the fixture `[0, .25, .5, .75, 1]` is a rail that gets louder towards the top: the top
  // mark must be the bright one and the bottom mark the dim one.
  assert.equal(glow[0], 1, 'the loud end must be fully lit')
  assert.ok(glow[glow.length - 1] < 0.25, 'the quiet end must be dim, got ' + String(glow[glow.length - 1]))

  configure(engine, { glow: false })
  harness.advance(60)
  await harness.settle()
  for (const mark of marks) {
    assert.equal(Number(mark.style.getPropertyValue('--pinpu-glow')), 1, 'with the layer off, every segment is fully lit')
  }
  engine.stop()
})

test('while the host is falling through a pause the marks keep fading, then park', async () => {
  // `handlePayload` used to skip painting whenever the payload said `silent`, so a pause
  // froze the rail at its last length and then snapped it back. The host's per-band release
  // is the fade; it must reach the marks.
  let payload = { status: 'live', silent: false, levels: [1, 1, 1, 1, 1] }
  const harness = createHarness({ fetch: () => payload })
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine, { restoreOnSilence: true })
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1')

  payload = { status: 'live', silent: true, levels: [0.7, 0.5, 0.3, 0.1, 0] }
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1', 'the fade is still running, so the take-over stays')
  // Document order is top → bottom, and payload index 0 is the bass at the bottom, so the
  // bottom mark is the one holding 0.7 here.
  const fading = Number(marks[marks.length - 1].style.getPropertyValue('--pinpu-scale'))
  assert.ok(fading > 0.4 && fading < 1, 'the marks must show the falling level, got ' + String(fading))

  // Past the hold, the rail is handed back.
  payload = { status: 'live', silent: true, levels: [0, 0, 0, 0, 0] }
  harness.advance(2000)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), null, 'after the hold the marks go back to the app')
  for (const mark of marks) assert.equal(mark.style.getPropertyValue('--pinpu-scale'), '', 'and the inline overrides are gone')
  engine.stop()
})

test('inverting puts the lowest band at the top of the rail', async () => {
  // The payload is ordered low band → high band. With `invert`, the *bottom* mark must
  // carry the highest band while the top mark carries the lowest.
  const harness = createHarness({ fetch: () => ({ status: 'live', silent: false, levels: [1, 1, 1, 1, 0] }) })
  const { marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine, { invert: true, minScale: 0.4, maxScale: 1 })
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  const scales = marks.map((mark) => Number(mark.style.getPropertyValue('--pinpu-scale')))
  // marks[0] is the top mark, marks[4] the bottom one.
  assert.ok(Math.abs(scales[4] - 0.4) < 1e-6, 'the bottom mark takes the highest band when inverted')
  assert.ok(scales[0] > 0.99, 'the top mark takes the lowest band when inverted')
  engine.stop()
})

test('silence hands the marks back after the hold, and loud audio takes them again', async () => {
  let payload = { status: 'live', silent: true, levels: [0, 0, 0, 0, 0] }
  const harness = createHarness({ fetch: () => payload })
  const { rail } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), null, 'silence must not hold the marks')

  payload = { status: 'live', silent: false, levels: [1, 1, 1, 1, 1] }
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1', 'audio takes the marks back')
  engine.stop()
})

test('a stopped or failing capture parks the marks and reports the reason', async () => {
  let payload = { status: 'live', silent: false, levels: [1, 1, 1, 1, 1] }
  const harness = createHarness({ fetch: () => payload })
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1')

  payload = { status: 'error', error: 'no-loopback-device', levels: [] }
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), null, 'an error must park the marks')
  assert.equal(engine.status().state, 'error')
  assert.equal(engine.status().message, 'no-loopback-device')
  for (const mark of marks) assert.equal(mark.style.getPropertyValue('--pinpu-scale'), '')

  // A rejected request is an error too, and is retried rather than hammered.
  const failing = createHarness({ fetch: () => new Error('offline') })
  buildConversation(failing)
  const engine2 = failing.__test.createEngine()
  configure(engine2)
  await failing.settle()
  failing.advance(60)
  await failing.settle()
  const first = failing.fetches.length
  failing.advance(200)
  await failing.settle()
  assert.equal(failing.fetches.length, first, 'the retry delay must hold the next poll back')
  failing.advance(1400)
  await failing.settle()
  assert.ok(failing.fetches.length > first, 'the poll must resume after the retry delay')
  assert.equal(engine2.status().state, 'error')
  engine.stop()
  engine2.stop()
})

test('the demonstration waveform needs no capture at all', async () => {
  const harness = createHarness({ fetch: () => { throw new Error('should not be called') } })
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine, { demo: true })
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  assert.equal(harness.fetches.length, 0, 'the demonstration must not touch the host')
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1')
  assert.equal(engine.status().state, 'demo')
  const first = marks.map((mark) => mark.style.getPropertyValue('--pinpu-scale'))
  harness.advance(400)
  await harness.settle()
  const later = marks.map((mark) => mark.style.getPropertyValue('--pinpu-scale'))
  assert.notDeepEqual(later, first, 'the demonstration must move')
  engine.stop()
})

test('disabling the plugin removes every trace it left on the rail', async () => {
  const harness = createHarness({ fetch: () => ({ status: 'live', silent: false, levels: [1, 1, 1, 1, 1] }) })
  const { rail, marks } = buildConversation(harness)
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  harness.advance(60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.LIVE_ATTR), '1')

  configure(engine, { enabled: false })
  assert.equal(rail.getAttribute(harness.__test.RAIL_ATTR), null)
  assert.equal(rail.getAttribute(harness.__test.NEUTRAL_ATTR), null)
  assert.equal(rail.getAttribute(harness.__test.HOVER_ATTR), null)
  for (const mark of marks) {
    assert.equal(mark.getAttribute(harness.__test.TICK_ATTR), null)
    assert.equal(mark.style.getPropertyValue('--pinpu-scale'), '')
  }
  assert.equal(harness.document.getElementById(harness.__test.STYLE_ID), null, 'the stylesheet must be gone')
  assert.equal(harness.timerCount(), 0, 'no timers may be left polling')
})

test('a rail that appears later is picked up, and a busy mark is left to the app', async () => {
  const harness = createHarness({ fetch: () => ({ status: 'live', silent: false, levels: [1, 0.5, 0.5, 0.5, 0] }) })
  const engine = harness.__test.createEngine()
  configure(engine)
  await harness.settle()
  assert.equal(engine.status().marks, 0, 'nothing to take over yet')

  const { rail, marks } = buildConversation(harness)
  marks[4].pseudo.animationName = 'rail-busy'
  harness.advance(harness.__test.RESCAN_MS + 60)
  await harness.settle()
  assert.equal(rail.getAttribute(harness.__test.RAIL_ATTR), '1', 'a late rail must be discovered')
  assert.equal(engine.status().marks, 5)
  assert.equal(marks[4].getAttribute(harness.__test.BUSY_ATTR), '1', 'the app animation must be recognised')
  assert.equal(marks[0].getAttribute(harness.__test.BUSY_ATTR), null)
  engine.stop()
})
