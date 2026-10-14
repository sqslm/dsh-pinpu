/**
 * A React stand-in, only enough for the client factory to capture its hooks.
 *
 * The offline suite exercises the rail engine, the geometry rules and the
 * configuration plumbing — not React rendering (the app supplies the real React,
 * and `test/rail.test.mjs` drives the engine directly). The hooks exist so the
 * module loads and the settings card can be *constructed*; nothing here is a
 * renderer.
 *
 * @module test/helpers/react-stub
 */
export function createReactStub() {
  const createElement = (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { element: true, type, props: merged }
  }
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
}
