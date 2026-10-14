/**
 * Manifest contract: what the launcher, the plugin manager, the client module
 * system and the display-metadata reader each read out of `package.json`.
 *
 * Every assertion here corresponds to a way a plugin silently disappears:
 * a missing `./client` export, a `dsh.client.inject` that names services instead
 * of packages, a stale `peerDependencies` range (the launcher mounts such a row
 * as `disabled` with no error), or locale metadata the reader cannot resolve.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { manifest, pluginRoot, readText } from './helpers/harness.mjs'

/**
 * The client packages that declare the slots this bundle registers into: the rail
 * itself belongs to the chat window (which provides no slot), and the only slot used
 * is the settings card.
 */
const CLIENT_DECLARERS = ['@deepseek-ai/dsh-client-ui-settings-general']

test('the package declares the two faces and the bundle patch', () => {
  assert.equal(manifest.name, 'dsh-pinpu')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.private, undefined, 'an installable bundle must not be private')
})

test('every face and resource the manifest points at exists', () => {
  for (const relative of ['lib/index.js', 'lib/client.js', 'lib/defaults.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(existsSync(join(pluginRoot, relative)), relative + ' is missing')
  }
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./package.json'], './package.json', 'the display-metadata reader resolves <name>/package.json')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'locale dictionaries are read through the exports map')
})

test('dsh.client names the packages that declare the slots this bundle registers into', () => {
  const client = manifest.dsh?.client
  assert.ok(client !== undefined, 'dsh.client is what makes the browser half load')
  assert.equal(client.platform, 'web')
  assert.equal(client.immediately, true, 'the rail must exist from the first paint, not on demand')
  for (const entry of client.inject ?? []) {
    assert.match(entry, /^@deepseek-ai\/dsh-client-/, 'dsh.client.inject takes package names, got ' + entry)
  }
  for (const declarer of CLIENT_DECLARERS) {
    assert.ok(client.inject.includes(declarer), 'dsh.client.inject must load ' + declarer)
  }
  assert.equal(client.external, undefined)
})

test('no peerDependencies: a mismatching range mounts the row as disabled without an error', () => {
  assert.equal(manifest.peerDependencies, undefined)
})

test('the icon is a relative, small, supported file inside the package', () => {
  const icon = manifest.icon
  assert.equal(typeof icon, 'string')
  assert.match(icon, /^\.\//)
  const absolute = join(pluginRoot, icon)
  assert.ok(existsSync(absolute))
  assert.ok(statSync(absolute).size <= 256 * 1024, 'the reader rejects icons over 256 KiB')
  assert.match(icon, /\.(svg|png|jpe?g|webp)$/i)
})

test('locale dictionaries carry the title and description the reader projects', () => {
  for (const language of ['en', 'zh']) {
    const dictionary = JSON.parse(readText('locale/' + language + '.json'))
    assert.equal(typeof dictionary.meta?.title, 'string')
    assert.ok(dictionary.meta.title.trim() !== '')
    assert.equal(typeof dictionary.meta?.description, 'string')
    assert.ok(dictionary.meta.description.trim() !== '')
  }
})

test('the browser half is a classic script that only registers a factory', () => {
  const source = readText('lib/client.js')
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/m)
  assert.doesNotMatch(source, /^\s*import\s/m, 'a classic script cannot use ESM imports')
  assert.doesNotMatch(source, /^\s*export\s/m, 'a classic script cannot use ESM exports')
  assert.equal(manifest.dsh.client.inject.includes('react'), false, 'react comes from the browser module table, not dsh.client.inject')
})
