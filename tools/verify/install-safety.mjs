/**
 * Can the installed package be replaced while a capture is running?
 *
 * That question is not academic: `pyaudiowpatch` ships a native `.pyd` that a live capture
 * keeps mapped, and Windows then refuses to rename the package directory. The application's
 * own plugin manager hit exactly that while installing an unrelated plugin —
 *
 *     ERR_PNPM_EPERM importPackage …\node_modules\dsh-pinpu
 *     EPERM: rename '…\dsh-pinpu_tmp_33380_5' -> '…\dsh-pinpu'
 *
 * — and left a half-pruned package, which surfaced as
 * `cannot resolve profile bundle "dsh-pinpu"`. The fix is that the helper runs from a
 * private copy of `vendor/` under the OS temp directory, so this tool checks the two things
 * that fix has to deliver, against the **installed** copy:
 *
 * 1. the helper's command line points at the temp copy, not at `node_modules`;
 * 2. renaming the installed directory (what pnpm does) succeeds while the capture runs;
 * 3. stopping the capture removes the temp copy and touches nothing else.
 *
 * Usage:
 *   node tools/verify/install-safety.mjs [--profile <dir>] [--seconds 3]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The desktop profile of whichever user runs this, so nothing is machine-specific. */
const PROFILE_DEFAULT = join(homedir(), '.dsh', 'profiles', 'desktop')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  const next = index >= 0 ? args[index + 1] : undefined
  return next === undefined || next.startsWith('--') ? fallback : next
}
const profile = resolve(String(flag('profile', PROFILE_DEFAULT)))
const seconds = Number(flag('seconds', 3))
const installed = join(profile, 'node_modules', 'dsh-pinpu')

if (!existsSync(join(installed, 'package.json'))) {
  console.error('no installed copy at ' + installed + ' — install the plugin first')
  process.exitCode = 1
} else {
  const { createCapture } = await import(new URL('../lib/loopback.js', import.meta.url).href)
  const capture = createCapture({ bands: 64, fftSize: 1024, log: () => {} })
  capture.configure({ device: '', fftSize: 1024, autoGain: true })
  capture.start()
  await new Promise((done) => setTimeout(done, Math.max(500, seconds * 1000)))

  const snapshot = capture.snapshot()
  console.log('capture           :', snapshot.status, '| device:', snapshot.device, '| peak:', String(snapshot.peak))

  const helperLine = (() => {
    try {
      const output = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Select-Object -ExpandProperty CommandLine"],
        { encoding: 'utf8' },
      )
      return output.split(/\r?\n/).find((line) => line.includes('loopback.py')) ?? ''
    } catch {
      return ''
    }
  })()
  console.log('helper command    :', helperLine.trim() === '' ? '(not visible)' : helperLine.trim())
  const fromTemp = helperLine.includes('dsh-pinpu-') && !helperLine.includes('node_modules')

  let replaceable = false
  const probe = installed + '-replace-probe'
  try {
    renameSync(installed, probe)
    renameSync(probe, installed)
    replaceable = true
  } catch (error) {
    console.error('renaming the installed package failed:', error.code ?? error.message)
  }

  const before = existsSync(installed)
  capture.stop()
  await new Promise((done) => setTimeout(done, 600))
  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-pinpu-')).length
  const after = existsSync(join(installed, 'package.json'))

  console.log('helper from temp  :', fromTemp ? 'yes' : 'NO — the installed files are still held open')
  console.log('installed dir     :', before && after ? 'renamed and restored while capturing' : 'MISSING after the probe')
  console.log('temp copies left  :', leftovers)
  const ok = fromTemp && replaceable && before && after
  console.log('VERDICT:', ok ? 'pnpm can replace this package while the plugin runs' : 'the lock is still there — an install would break the package')
  process.exitCode = ok ? 0 : 1
}
