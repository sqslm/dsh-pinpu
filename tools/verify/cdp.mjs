/**
 * Minimal Chrome DevTools Protocol client for the verification tools.
 *
 * Both probes here drive a real Chromium (the installed Edge) over a loopback
 * debugging port: they open a page, evaluate JavaScript in it, and read the
 * result back. Nothing in this file touches the running Harness.
 *
 * @module tools/verify/cdp
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The browser this machine ships; override with DSH_VERIFY_BROWSER. */
export const BROWSER =
  process.env.DSH_VERIFY_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Launch a browser with its own profile and a loopback debugging port. */
export async function launch({ headless = true, port, extraArgs = [] } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-pinpu-cdp-'))
  const chosen = port ?? 9400 + Math.floor(Math.random() * 400)
  const args = [
    headless ? '--headless=new' : '--new-window',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // A hidden or occluded window has its timers throttled, and this page's whole job is
    // animation on a timer: without these flags the rail paints a couple of frames and then
    // holds them, which reads as "the rail does not move" when measuring over time.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${String(chosen)}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,900',
    ...extraArgs,
    'about:blank',
  ]
  if (headless) args.push('--no-sandbox')
  const child = spawn(BROWSER, args, { stdio: 'ignore' })
  return { child, port: chosen, profile }
}

/** Wait for the DevTools endpoint and return the first page target's websocket URL. */
export async function waitForTarget(port, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const list = await response.json()
      const page = list.find((entry) => entry.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('the DevTools endpoint never came up')
}

/**
 * Launch and wait for a page target, retrying with a fresh profile and port.
 *
 * The launch itself is the flakiest step in the whole verification set (a browser that is
 * already running, a port taken by something else, an update in progress). Rather than
 * leaving the caller to re-run by hand, retry here and make the failure explicit only after
 * several attempts, and never leave a half-started browser behind.
 *
 * @returns `{ child, port, profile, url }`
 */
export async function launchWithTarget({ headless = true, extraArgs = [], attempts = 3 } = {}) {
  let last = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const launched = await launch({ headless, extraArgs })
    try {
      const url = await waitForTarget(launched.port)
      return { ...launched, url }
    } catch (error) {
      last = error
      try {
        launched.child.kill()
      } catch {
        /* already gone */
      }
      rmSync(launched.profile, { recursive: true, force: true })
      await sleep(400)
    }
  }
  throw last ?? new Error('the browser would not start')
}

/** Connect to one target and return a `send(method, params)` client. */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const events = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined) {
        events.push(message)
        return
      }
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      entry(message)
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('open', () => {
      resolve({
        events,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId
            nextId += 1
            pending.set(id, (message) => (message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result)))
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          socket.close()
        },
      })
    })
  })
}

/**
 * Evaluate an expression in the page and return its JSON value.
 * @param client - connected CDP client.
 * @param expression - a JavaScript expression; `awaitPromise` is on.
 * @param timeoutMs - how long the expression may run.
 */
export async function evaluate(client, expression, timeoutMs = 60000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails).slice(0, 800))
  }
  return result.result?.value
}

/** Navigate to a local file and wait for the load event. */
export async function openFile(client, path, settleMs = 400) {
  const url = 'file:///' + path.replace(/\\/g, '/')
  await client.send('Page.navigate', { url })
  await sleep(settleMs)
  return url
}

/** Read a file for inlining into a probe page. */
export async function inline(path) {
  return readFile(path, 'utf8')
}

/** Capture a PNG screenshot of the page. */
export async function screenshot(client, path) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, Buffer.from(result.data, 'base64'))
  return path
}
