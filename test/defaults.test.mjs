/**
 * The places that restate the defaults must agree.
 *
 * 1. `lib/defaults.js` — the single source of truth.
 * 2. `lib/index.js` — the host schema's `.default(...)` arguments.
 * 3. `cordis.patch.yml` — what `--dump-config` shows and what a user-layer override
 *    has to restate in full.
 *
 * `lib/client.js` carries its own fallbacks too; `test/client-shape.test.mjs`
 * checks that its `DEFAULTS` matches this file's.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BANDS, DEFAULTS, FIELD_ORDER } from '../lib/defaults.js'
import { Config } from '../lib/index.js'
import { parseInsertRow } from './helpers/patch.mjs'

const BOOLEAN_FIELDS = [
  'enabled',
  'autoGain',
  'disableActiveHighlight',
  'hoverHighlight',
  'restoreOnSilence',
  'invert',
  'glow',
  'demo',
]

const NUMBER_FIELDS = ['fftSize', 'smoothing', 'gain', 'gate', 'minHz', 'maxHz', 'punch', 'flutter', 'minScale', 'maxScale', 'hotScale', 'spark']

const STRING_FIELDS = ['device', 'colorMode', 'customColor', 'side']

test('DEFAULTS is frozen and has the documented field order', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true)
  assert.deepEqual(FIELD_ORDER, Object.keys(DEFAULTS))
  assert.equal(BANDS, 64)
  assert.equal(FIELD_ORDER.length, 24)
})

test('the field types are the ones the schema and the settings card assume', () => {
  for (const field of BOOLEAN_FIELDS) assert.equal(typeof DEFAULTS[field], 'boolean', field)
  for (const field of NUMBER_FIELDS) assert.equal(typeof DEFAULTS[field], 'number', field)
  for (const field of STRING_FIELDS) assert.equal(typeof DEFAULTS[field], 'string', field)
  assert.deepEqual(
    [...BOOLEAN_FIELDS, ...NUMBER_FIELDS, ...STRING_FIELDS].sort(),
    [...FIELD_ORDER].sort(),
  )
})

test('the defaults are inside the ranges the settings card enforces', () => {
  assert.ok(DEFAULTS.fftSize >= 512 && DEFAULTS.fftSize <= 4096, 'fftSize')
  assert.ok(DEFAULTS.smoothing >= 0 && DEFAULTS.smoothing <= 0.95, 'smoothing')
  assert.ok(DEFAULTS.gate >= 0 && DEFAULTS.gate <= 0.5, 'gate')
  assert.ok(DEFAULTS.minScale > 0 && DEFAULTS.minScale <= 1, 'minScale')
  assert.ok(DEFAULTS.maxScale >= DEFAULTS.minScale && DEFAULTS.maxScale <= 1.2, 'maxScale')
  assert.ok(DEFAULTS.minHz >= 20 && DEFAULTS.minHz < DEFAULTS.maxHz, 'minHz')
  assert.ok(DEFAULTS.maxHz <= 22050, 'maxHz')
  assert.ok(DEFAULTS.punch >= 0 && DEFAULTS.punch <= 2, 'punch')
  assert.ok(DEFAULTS.flutter >= 0 && DEFAULTS.flutter <= 0.35, 'flutter')
  assert.ok(DEFAULTS.hotScale >= 0 && DEFAULTS.hotScale <= 1.2, 'hotScale')
  assert.ok(DEFAULTS.spark >= 0 && DEFAULTS.spark <= 10, 'spark')
  assert.ok(['theme', 'spectrum', 'custom'].includes(DEFAULTS.colorMode), 'colorMode')
  assert.ok(['left', 'right'].includes(DEFAULTS.side), 'side')
})

test('the bundle row configures every field, in order, and nothing else', () => {
  const row = parseInsertRow()
  assert.equal(row.id, 'pinpu')
  assert.equal(row.name, 'dsh-pinpu')
  assert.deepEqual(row.configKeys, FIELD_ORDER)
  for (const field of FIELD_ORDER) {
    assert.deepEqual(row.config[field], DEFAULTS[field], field + ' drifted from DEFAULTS')
  }
})

test('the host schema exposes exactly the documented fields', () => {
  const resolved = Config({})
  assert.deepEqual(Object.keys(resolved), FIELD_ORDER)
})
