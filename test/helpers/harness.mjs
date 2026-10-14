/**
 * Offline harness for the browser half.
 *
 * The client bundle is a classic script that only calls
 * `window.__ModuleLoader__.load({ id, factory })`, so it cannot be imported. This
 * harness evaluates the real file in a `vm` realm with a purpose-built DOM shim, a
 * controllable clock, and a stubbed `fetch`, then hands the module exports back.
 *
 * The shim only implements what the client actually uses. Everything is
 * deterministic: timers fire when the test advances the clock, and `Date.now()`
 * inside the realm follows it too.
 *
 * @module test/helpers/harness
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createReactStub } from './react-stub.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the plugin root. */
export const pluginRoot = join(here, '..', '..')

/** Read a UTF-8 file relative to the plugin root. */
export function readText(relative) {
  return readFileSync(join(pluginRoot, relative), 'utf8')
}

/** Read and parse a JSON file relative to the plugin root. */
export function readJson(relative) {
  return JSON.parse(readText(relative))
}

export const manifest = readJson('package.json')

/** Plain data that survives the `vm` realm boundary. */
export function realmPlain(value) {
  return JSON.parse(JSON.stringify(value))
}

/* -------------------------------------------------------------------- *
 * DOM shim
 * -------------------------------------------------------------------- */

function createStyle() {
  const properties = new Map()
  return {
    setProperty(name, value) {
      properties.set(name, String(value))
    },
    getPropertyValue(name) {
      return properties.has(name) ? properties.get(name) : ''
    },
    removeProperty(name) {
      properties.delete(name)
    },
    get length() {
      return properties.size
    },
  }
}

/**
 * An element. Geometry is explicit (`setRect`); `getBoundingClientRect` reports it,
 * which is what the rail discovery reads.
 */
export function createElement(tagName) {
  const attributes = new Map()
  const node = {
    tagName: String(tagName).toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    parentElement: null,
    parentNode: null,
    style: createStyle(),
    rect: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    pseudo: { animationName: 'none' },
    appendChild(child) {
      if (child === null || child === undefined) return child
      child.parentElement = node
      child.parentNode = node
      node.children.push(child)
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentElement = null
      child.parentNode = null
      return child
    },
    setAttribute(name, value) {
      attributes.set(String(name), String(value))
    },
    getAttribute(name) {
      return attributes.has(String(name)) ? attributes.get(String(name)) : null
    },
    removeAttribute(name) {
      attributes.delete(String(name))
    },
    hasAttribute(name) {
      return attributes.has(String(name))
    },
    getBoundingClientRect() {
      return { ...node.rect }
    },
    querySelectorAll(selector) {
      const out = []
      const walk = (element) => {
        for (const child of element.children) {
          if (matches(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(node)
      return out
    },
    querySelector(selector) {
      const all = node.querySelectorAll(selector)
      return all.length > 0 ? all[0] : null
    },
    /** Test helper: geometry in one call. */
    setRect(rect) {
      node.rect = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
      }
      return node
    },
    /** Test helper: the computed style the plugin may read (`position`, `left`, `right`). */
    setComputed(computed) {
      node.computed = { ...(node.computed ?? {}), ...computed }
      return node
    },
  }
  return node
}

/** The subset of selector syntax the client uses. */
export function matches(element, selector) {
  const text = String(selector).trim()
  if (text.startsWith('#')) return element.id === text.slice(1)
  const attribute = /^\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/.exec(text)
  if (attribute !== null) {
    if (!element.hasAttribute(attribute[1])) return false
    if (attribute[2] === undefined) return true
    return element.getAttribute(attribute[1]) === attribute[2]
  }
  if (text.startsWith('.')) return String(element.className).split(/\s+/).includes(text.slice(1))
  return element.tagName === text.toUpperCase()
}

function createDocument() {
  const head = createElement('head')
  const body = createElement('body')
  const document = {
    head,
    body,
    documentElement: createElement('html'),
    getElementById(id) {
      const walk = (element) => {
        for (const child of element.children) {
          if (child.id === id) return child
          const deeper = walk(child)
          if (deeper !== null) return deeper
        }
        return null
      }
      return walk(head) ?? walk(body)
    },
    querySelector(selector) {
      return document.documentElement.querySelector(selector) ?? head.querySelector(selector) ?? body.querySelector(selector)
    },
    querySelectorAll(selector) {
      return [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)]
    },
    createElement(tagName) {
      return createElement(tagName)
    },
  }
  document.documentElement.appendChild(head)
  document.documentElement.appendChild(body)
  return document
}

/* -------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------- */

/**
 * @param options.fetch - `(url, init) => payload | Error`; a returned Error rejects.
 * @returns a harness with the loaded module, the DOM, the clock and test helpers.
 */
export function createHarness(options = {}) {
  const document = createDocument()
  const clock = { now: 1000, timers: new Map(), nextId: 1 }
  const fetches = []
  const timeouts = []
  const intervals = []
  const observers = []

  const RealDate = Date
  function FakeDate(...args) {
    return args.length === 0 ? new RealDate(clock.now) : new RealDate(...args)
  }
  FakeDate.now = () => clock.now
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  FakeDate.prototype = RealDate.prototype

  function schedule(store, callback, delay) {
    const id = clock.nextId
    clock.nextId += 1
    store.set(id, { callback, delay: Math.max(0, Number(delay) || 0), due: clock.now + Math.max(0, Number(delay) || 0) })
    return id
  }

  const window = {
    setInterval(callback, delay) {
      const id = schedule(clock.timers, callback, delay)
      intervals.push(id)
      return id
    },
    clearInterval(id) {
      clock.timers.delete(id)
    },
    setTimeout(callback, delay) {
      const id = schedule(clock.timers, callback, delay)
      timeouts.push(id)
      return id
    },
    clearTimeout(id) {
      clock.timers.delete(id)
    },
    requestAnimationFrame(callback) {
      return window.setTimeout(callback, 16)
    },
    cancelAnimationFrame(id) {
      clock.timers.delete(id)
    },
    getComputedStyle(element) {
      // The plugin reads exactly one computed declaration — `position`, to find the rail's
      // positioning frame — plus the busy animation on `::before`. Model both; anything
      // else a test needs can be set with `setComputed`.
      const computed = (element && element.computed) || {}
      return {
        animationName: element && element.pseudo ? element.pseudo.animationName : 'none',
        position: typeof computed.position === 'string' ? computed.position : 'static',
        left: typeof computed.left === 'string' ? computed.left : 'auto',
        right: typeof computed.right === 'string' ? computed.right : 'auto',
      }
    },
    addEventListener() {},
    removeEventListener() {},
    location: { href: 'http://127.0.0.1:19387/' },
  }

  class MutationObserverShim {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  function fakeFetch(url, init) {
    fetches.push({ url: String(url), init })
    const handler = typeof options.fetch === 'function' ? options.fetch : () => ({ status: 'stopped', silent: true, levels: [] })
    let payload
    try {
      payload = handler(String(url), init)
    } catch (error) {
      return Promise.reject(error)
    }
    if (payload instanceof Error) return Promise.reject(payload)
    if (payload && typeof payload.then === 'function') return payload
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    })
  }

  const registration = { current: null }
  const sandbox = {
    window,
    document,
    fetch: fakeFetch,
    MutationObserver: MutationObserverShim,
    getComputedStyle: window.getComputedStyle,
    Date: FakeDate,
    console,
    Promise,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
  }
  window.document = document
  window.fetch = fakeFetch
  window.MutationObserver = MutationObserverShim
  window.Date = FakeDate

  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      registration.current = spec
    },
  }
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  const source = readText('lib/client.js')
  vm.runInContext(source, context, { filename: 'lib/client.js' })

  if (registration.current === null) throw new Error('client bundle did not register itself')
  if (registration.current.id === undefined) throw new Error('client bundle registered without an id')

  const React = createReactStub()
  const exports = registration.current.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected external: ' + specifier)
  })

  /** Run every timer that is due within `ms`, in time order. */
  function advance(ms) {
    const target = clock.now + ms
    for (let guard = 0; guard < 1000; guard += 1) {
      let nextId = null
      let nextDue = Infinity
      for (const [id, timer] of clock.timers) {
        if (timer.due <= target && timer.due < nextDue) {
          nextDue = timer.due
          nextId = id
        }
      }
      if (nextId === null) break
      const timer = clock.timers.get(nextId)
      if (timer.delay === 0 || timeouts.includes(nextId)) clock.timers.delete(nextId)
      else timer.due = clock.now + timer.delay
      clock.now = Math.max(clock.now, nextDue)
      timer.callback()
    }
    clock.now = target
  }

  /** Let pending microtasks (`fetch` promises) settle. */
  async function settle(times = 4) {
    for (let index = 0; index < times; index += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    for (let index = 0; index < times; index += 1) await Promise.resolve()
  }

  function findByAttribute(element, attributeName) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasAttribute(attributeName)) out.push(child)
        walk(child)
      }
    }
    walk(element)
    return out
  }

  return {
    document,
    window,
    clock,
    fetches,
    observers,
    registration: registration.current,
    exports,
    __test: exports.__test,
    React,
    advance,
    settle,
    findByAttribute,
    createElement,
    /** Number of live timers (used to prove the engine stops cleanly). */
    timerCount: () => clock.timers.size,
  }
}

/** A `configForms.get()` stand-in. */
export function createForm(snapshot) {
  const writes = []
  const subscribers = new Set()
  const form = {
    getSnapshot: () => (typeof snapshot === 'function' ? snapshot() : snapshot),
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    set(field, value) {
      writes.push([field, value])
      return Promise.resolve(true)
    },
  }
  return { form, writes, notify: (listener) => listener === undefined ? subscribers.forEach((entry) => entry()) : listener() }
}

/** Slot/configForms context stub that records slot registrations and disposes effects. */
export function createContext(form, overrides = {}) {
  const registrations = []
  const disposers = []
  const context = {
    requestedIds: [],
    injected: [],
    configForms: {
      get(id) {
        context.requestedIds.push(id)
        return form
      },
    },
    slots: {
      inject(name, run) {
        context.injected.push(name)
        // Registrations are scoped to the slot being injected: the real service routes
        // by `options.name`, so a registration without it — or naming another slot —
        // never reaches the dialog. Enforce that here so a plugin cannot pass the suite
        // while contributing a section nobody will ever see.
        openSlots.push(name)
        try {
          run()
        } finally {
          openSlots.pop()
        }
        return () => {}
      },
      register(options, component) {
        if (options === null || typeof options !== 'object') throw new Error('slots.register needs options')
        if (typeof options.name !== 'string' || options.name === '') {
          throw new Error('slots.register requires the target slot name in options.name')
        }
        const expected = openSlots[openSlots.length - 1]
        if (expected !== undefined && options.name !== expected) {
          throw new Error('slots.register names "' + options.name + '" while "' + expected + '" is being injected')
        }
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(run) {
      const cleanup = run()
      const dispose = typeof cleanup === 'function' ? cleanup : () => {}
      disposers.push(dispose)
      return dispose
    },
    ...overrides,
  }
  const openSlots = []
  context.registrations = registrations
  context.disposeAll = () => disposers.forEach((dispose) => dispose())
  return context
}
