/**
 * The tools' own path discovery.
 *
 * These tools are published, so they must not hardcode one machine's layout — but making
 * them portable is exactly how a resolver starts pointing at a directory that is not there,
 * and then a broken installer still *looks* like a working one (the failure surfaces several
 * layers down as `Cannot find module '…/pnpm.mjs'`). So: resolve, then prove the result.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { appModules, installCandidates, nodeExecutable, profileDefault, pythonExecutable, resourcesRoot, runtimeRoot } from '../tools/app-paths.mjs'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('install candidates are absolute and deduplicated', () => {
  const candidates = installCandidates()
  assert.ok(candidates.length >= 1, 'at least the per-user location must be a candidate')
  for (const candidate of candidates) {
    assert.match(candidate, /^[A-Za-z]:[\\/]|^\//, 'a candidate must be absolute: ' + candidate)
  }
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicates')
})

test('no source file bakes in an account name or a developer’s checkout', () => {
  // A *derived* per-user path legitimately contains the account name at runtime; a literal
  // one in the source is what leaks a machine and breaks for everyone else. This is the
  // sanitisation rule, kept honest by a test instead of by remembering.
  const roots = [join(pluginRoot, 'tools'), join(pluginRoot, 'test'), join(pluginRoot, 'lib')]
  const forbidden = [
    { pattern: /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+[\\/]/, label: 'a hardcoded user profile path' },
    { pattern: /[A-Za-z]:[\\/]+softwares[\\/]/, label: 'a developer checkout root' },
  ]
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path)
        continue
      }
      if (!/\.(mjs|js|py|json|md|yml)$/.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      for (const rule of forbidden) {
        if (rule.pattern.test(text)) offenders.push(path.replace(pluginRoot + sep, '') + ' → ' + rule.label)
      }
    }
  }
  for (const root of roots) walk(root)
  assert.deepEqual(offenders, [], 'these files would publish a machine-specific path')
})

test('the desktop profile default is under the current home directory', () => {
  const profile = profileDefault()
  assert.match(profile, /\.dsh[\\/]profiles[\\/]desktop$/, 'the profile path shape')
  assert.ok(existsSync(join(profile, '..')) || existsSync(profile), 'and it belongs to a real home')
})

test('with an installation present, every resolver lands on something real', () => {
  const resources = resourcesRoot()
  if (!existsSync(resources)) {
    // A machine with no app installed: the resolvers still have to answer, just not with a
    // directory. Skipping here is honest — asserting would be asserting the environment.
    assert.ok(typeof resources === 'string' && resources.length > 0, 'still resolves to a path')
    return
  }
  assert.ok(existsSync(join(resources, 'app', 'dsh', 'node_modules', '@deepseek-ai')), 'the app modules must be there')
  assert.equal(appModules().endsWith(join('app', 'dsh', 'node_modules')), true, 'appModules points at the app')
  const runtime = runtimeRoot()
  if (existsSync(runtime)) {
    assert.ok(existsSync(join(runtime, 'primary-runtime')), 'the bundled runtime must be under resources/runtime')
  }
  // The executables either come from the bundle or fall back to PATH — never a dangling path.
  for (const executable of [nodeExecutable(), pythonExecutable()]) {
    assert.ok(executable === 'node' || executable === 'python' || existsSync(executable), 'executable or PATH fallback: ' + executable)
  }
})
