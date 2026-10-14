# Lessons Learned

Durable findings from building this plugin. Read before touching either half.

## 0. The two halves agreed only in my tests

**Symptom:** the settings card showed a *moving* peak while the rail's marks sat perfectly
still at their base length. The host capture was live, the client half was alive (`?diag=1`
reported `client.event=heartbeat, detail=live`), the marks were discovered and tagged
(`刻度数: 5`), and every test was green.

**Cause:** the spectrum field's name. The route answers with

```js
writeJson(res, 200, { ok: true, ...snapshot, levels: Array.from(shaped, compact) })
```

while the browser half read

```js
var source = payload && Array.isArray(payload.ticks) ? payload.ticks : null   // never true
```

`ticks` was `undefined`, so `levelsFrom` returned zeros, `paint()` wrote the same minimum
length to every mark, and the rail froze. `payload.peak` — a *different* field — was read
correctly, which is why the card looked healthy while the rail did not. The tests passed
because every stub (offline harness, rail tests, CDP preview page) fed `ticks` too: both
sides agreed with the *tests* and disagreed with each other.

**Fixes and guards:**

1. `levelsFrom` reads `payload.levels` (the route's field) and still accepts `ticks` for
   older payloads; a payload already resampled to the mark count is indexed straight
   through, a wider one goes through the band mapping; `invert` is applied once, here.
2. The stray `ticks` field is gone from `capture.snapshot()`, and the route documents the
   payload contract in one place, so one concept has exactly one name.
3. `test/host-schema.test.mjs` asserts the payload is `levels` **and** has no `ticks`;
   `test/rail.test.mjs` and the preview page now stub the *real* shape.
4. `tools/verify/payload-contract.mjs` closes the loop end to end: it takes the payload the
   running host answers with (or a recorded one) and asks a real client bundle what it
   would draw — `--installed` for the copy the window is running. On the bug above it
   printed `client levels: [0,0,0,0]` / `distinct scales: 1` for the broken bundle and
   `[1,0.839,0.722,0]` / `distinct scales: 4` for the fixed one, **without restarting
   anything**.

**Rule of thumb:** a contract between two processes is only as good as the test that feeds
one side's real output to the other. Stubbing the payload shape in both halves proves
nothing.

## 1. `slots.register` needs `options.name`; without it the whole browser half is rolled back

**Symptom:** after installing the plugin and restarting Harness, the host half ran
perfectly — the loopback capture was live and `/api/dsh-pinpu/spectrum` answered with real
audio levels — while the browser half did *nothing at all*: no settings section, no rail
animation, no attributes on the rail's marks.

**Cause:** the registration was written as

```js
ctx.slots.inject('settings.section', function () {
  return ctx.slots.register({ id: SECTION_ID, order: SECTION_ORDER, label: '频谱律动' }, Card)
})
```

The `inject(slot, …)` argument only waits for the slot's *namespace*; the registration is
routed by `options.name`. The shipped service rejects anything else — read straight out of
`@deepseek-ai/dsh-cordis-client-runner/lib/client.js`:

```
slots.register(options, component) needs an options object with a `name`
slots.register options need a string `name`
```

That rejection threw inside `apply`, and cordis then disposed everything the plugin had
already registered — including the effects that had just started the engine. One missing
key produced two apparently unrelated symptoms, and because a plugin's browser half fails
silently (nothing on screen, no log the user will read) it looked like the plugin had not
been installed at all.

**Fixes, in order of importance:**

1. Pass the name: `register({ name: 'settings.section', id, order, label }, Card)`.
2. The test harness now *enforces* it: `createContext()` throws when `options.name` is
   missing or names a different slot than the injected one. A permissive stub is how this
   shipped — the harness happily recorded `{id, order, label}`.
3. Make `apply` failure-tolerant: every stage runs inside `stage(label, run)`, which
   reports the error and returns instead of aborting, so one contribution cannot take the
   rest of the plugin down.
4. Give the browser half a voice: it reports `apply` / `ready` / `heartbeat` / `stop` /
   `error` to `/api/dsh-pinpu/client`, the host records the last event, and
   `GET /api/dsh-pinpu/spectrum?diag=1` returns it (with the interpreter in use and the
   band count). "Which half is missing?" now has an answer readable from outside the
   application window.

**Rule of thumb:** the host half is observable — it has a process, routes, logs. The
browser half is not. Anything the browser half does must leave a trace the host keeps.

## 1. Capturing "what the machine is playing" needs WASAPI loopback, not `getUserMedia`

**Goal:** the rail should dance to whatever the user *hears* — NetEase Cloud Music, a
browser, anything.

**What does not work.** `getUserMedia` can only open a Windows **capture endpoint**.
Measured on this machine (`tools/verify/probe-loopback.py`, and the earlier Chromium
probe):

- the registry has `立体声混音 (Realtek USB Audio)` under `MMDevices\Audio\Capture`, but
  with `DeviceState = 0x10000001`, while *every* endpoint Chromium lists has
  `DeviceState = 1`. A real Chromium enumerates three `audioinput` endpoints and none of
  them is Stereo Mix; `ffmpeg -f dshow` cannot see it either;
- more fundamentally, Stereo Mix mirrors **one** render device. This machine listens on
  `Speakers (Realtek Audio)`, so even an enabled Stereo Mix would carry nothing;
- so the whole "user picks a microphone-like device" design was wrong for this ask.

**What works.** PortAudio has a build with WASAPI loopback support, which exposes a
`[Loopback]` *input* for every render device — including the current default output.
`sounddevice`'s bundled PortAudio did **not** have it (no `[Loopback]` entries), while
**`pyaudiowpatch`** does:

```
python -m pip install --target <dir> pyaudiowpatch     # through the proxy
python probe-loopback.py 3
→ default loopback: Speakers (Realtek Audio) [Loopback] … OVERALL PEAK 0.4914
```

The package is tiny enough to ship: `pyaudiowpatch/__init__.py` + `__pycache__` and
`_portaudiowpatch.cp312-win_amd64.pyd` = **≈290 KB** (verified: 297114 bytes). It is
vendored into `vendor/`, and the host half runs it with the Python the desktop runtime
already ships — no install step for the user, no extra dependency in the profile.

Two practical notes: the loopback stream needs ~300–600 ms to start producing
non-silent samples after the stream opens, and a `[Loopback]` index is stable only
within a run — pin devices by name substring, not by index.

## 2. A plugin can and should take over another plugin's UI by geometry, not by class name

The turn rail is styled through a CSS-module map
(`TurnNavigator_module_css_default`) whose values are build-hashed (`xpvNua_mark`,
`xpvNua_markActive`, …) and applied via object property access, so the names are not a
contract and cannot be resolved at runtime.

**What works instead** (all measured from the shipped stylesheet):

- the marks are `<button>`s with `height:10px; position:absolute; left:0; right:0` and a
  `::before` that draws the visible `20px × 2px` bar (`transform-origin:100%`,
  `transition: transform .14s, background-color .14s`);
- so the rail is "a group of sibling buttons sharing a size, a right edge and a ~10 px
  vertical step, inside `[data-conversation-scroll]`" — discoverable by
  `getBoundingClientRect()` alone;
- state lives in classes **and** in the pseudo-element's `animation-name` (the busy
  pulse), both readable with `getComputedStyle(el, '::before')`.

**Neutralising a state you cannot name.** The built-in "newest turn is highlighted"
state sets both a colour and `scaleX(1)`. Rather than detecting it, override *all* marks
with `!important`: a uniform dim colour and a uniform base length erase the state
whatever class expresses it. `!important` is also what beats the app's keyframe
animation on the same property. Then add `:hover` for the Codex-style highlight — and
only the hovered mark changes, which satisfies "no highlight while the pointer is away".

Ordering matters in the generated sheet: base → `:hover` → live spectrum → live
`:hover`, because the live rule must win over the base one while a hovered mark must
still win over both.

## 3. The rail is virtualised; a faithful replica needs the marks' inline height

While building the preview page the hover test reported `hoverMatches: false` and
`elementFromPoint` returned the scrollport instead of the button. Cause: the marks are
absolutely positioned inside `.marks{position:relative}`, so a marks box with no height
is **clipped by the scroller's `overflow-y:auto`**, and nothing is hit-testable. The app
does not hit this because its rail virtualises and writes the total height onto the
marks container inline. The replica now does the same (`style="height:150px"`).

⇒ When reproducing an app's DOM, reproduce the inline geometry its own JS writes, not
just its stylesheet.

## 4. Reusing one parameter on both sides of a boundary cancels it out

`invert` (draw the low band at the top) was applied by the host when resampling *and*
by the browser when mapping marks to bands — net effect: no inversion at all, and a
confusing test failure that looked like a mapping bug. The contract is now explicit:
the route always answers **low band → high band**, and the browser owns presentation.
A general rule for this plugin: the host owns signal, the browser owns presentation,
and no setting is interpreted on both sides.

A sibling bug from the same review: `levels` was indexed by *mark position* while it is
produced in *tick order* (0 = bottom mark), so the spectrum arrived vertically flipped.
The engine now stores each mark's tick and indexes `levels[mark.tick]`.

## 5. Streaming PCM from a child process: what actually broke

- **A ring whose write cursor is clamped replays one frame forever.** The PCM ring kept
  its position as `min(capacity, position + count)` and addressed slots with
  `(position + i) % capacity`. Once the ring filled, the position stopped growing, so
  *every* new chunk restarted at slot 0 — and `view()`, which derived the read start from
  that same clamped value, kept handing the FFT the same untouched slice. The analyser ran
  (the tick counter advanced ~22/s), the bytes arrived (~192 KB/s), the device was right,
  and `peak`/`levels` were byte-identical for minutes: `0.7365` every single poll. The fix
  is a cursor that is never clamped (modulo only when addressing the ring), a `view()` that
  returns exactly the newest `fftSize` samples, and a `createRing` seam that
  `test/loopback.test.mjs` drives with identifiable sample values — including past the
  first wrap, which is where the old code went wrong. **A ring is not correct because the
  first half second works.**
- **A respawn path that forgets to resume analysis looks exactly like a dead microphone.**
  The helper can die and be respawned (device change, a WASAPI hiccup, another capture
  holding the endpoint). The backoff path spawned the new helper but never re-armed the
  analysis timer, so the plugin reported `status: live` while `frames` stood still. Every
  respawn path now funnels through one `resumeAnalysis()` call.
  The diagnostic habit that found both: **poll the payload twice and compare every field.**
  `bytes` climbing with `frames` frozen → the analysis loop; `frames` climbing with
  `peak`/`levels` frozen → the window the analysis reads.
- **Silence is not a bug.** The first end-to-end run reported `peak 0` for 3 s and
  looked broken; the Python probe at the same moment showed the same 300–600 ms of
  silence before audio. Print byte counters (`bytes`, `frames`) in the diagnostic — they
  separated "no PCM" from "PCM that the DSP reads as zero" immediately.
- **Filter the environment before concluding anything about the interpreter.**
  `findPython()` fell back to `PATH` and picked an Anaconda Python 3.13, which
  cannot import a `cp312` wheel, producing `pyaudiowpatch-missing`. The capture now walks a
  candidate *list* (env → argv entry containing `runtime` → around `process.execPath` →
  `PATH`) and moves to the next one when the failure is an import error rather than an
  audio error.
- The vendored module must be found by the helper: spawn with
  `PYTHONPATH=<plugin>/vendor` (and `-u`, or stdout buffering adds latency).
- **Installing over a running application has two Windows traps.** The loaded modules can
  be locked (Windows refuses to replace an open file — one extraction stopped after the
  first directory while still reporting success), and the native PortAudio `.pyd` is held
  by the live capture process. The installer stops *only* this plugin's helpers (matched by
  the helper path in the command line), retries the unpack, and verifies the installed copy
  file-by-file afterwards.

## 6. Tests: a DOM shim plus a real browser beats either one alone

- The offline suite drives the real bundle in a `vm` with a purpose-built DOM shim, a
  controllable clock and a stubbed `fetch`. That is what caught the two indexing bugs in
  §4 and the "silence must hand the rail back" rule — mechanics that no amount of
  reading would have settled.
- The FFT is checked **band by band against a naive O(n²) DFT** of the same Hann-windowed
  frame, and a two-tone test checks *placement* (both tones peak, far bands are quiet).
  Two traps found while writing it: amplitudes above ~0.056 per bin saturate the
  `-25 dB` ceiling (a saturated pair of peaks cannot be ranked), and a tone can straddle
  two adjacent bands, so assert a local *region* peaks rather than one exact index.
- The preview page is the only place the real cascade exists, so it is where "our
  `!important` wins" is actually proven: it loads the shipped rail stylesheet and class
  names, applies the real bundle, and asserts the computed `::before` background and
  transform for a native mark, a dancing mark, and the hovered mark — plus that a click
  still reaches the app's own listener.

## 7. A `link:`-installed plugin cannot import the Harness's own packages

With the plugin linked into the profile rather than copied (`link:` instead of a tarball),
the host half's
`import z from '@deepseek-ai/schemastery'` resolves from the *source* directory (and up
its tree), where the core packages do not exist; they live in the profile's
`node_modules`. `dsh-purge` documents the same trap in a comment. Install a tarball
(`pnpm pack` → `"file:…/dsh-pinpu-x.y.z.tgz"`), which pnpm extracts into the profile, and
bump the version on every repack — an unchanged `name@version` with different bytes is
ambiguous to pnpm's install check.

For development only, a junction `node_modules` → the app's
`resources/app/dsh/node_modules` lets the source tree import the core packages (and is
excluded from the tarball by `files`).

## 8. Volatile config fields resolve to references, not values

`config.enabled === true` is **false** for an enabled row: a `.volatile()` field resolves
to a frozen `{ get, [symbol] }` reference. Unwrap it (frozen object, exactly one own key
`get`, at least one own symbol) before branching on it. `lib/index.js` re-reads the live
values on a timer instead of caching them, which is why there is no watcher plumbing to
get wrong — and the browser side never sees references, only a `configForms` snapshot of
plain JSON.

## 9. Dynamics: three defects that only a *time-series measurement* could see

The request was "the rail looks like a fixed-order scan; make it look alive". Correctness
tests cannot see that — every frame was individually correct. What found the problems was
`tools/verify/dynamics-profile.mjs`, which pushes a synthetic kick-and-melody signal
through the real analyser and reports motion statistics. The defects it caught:

1. **A release factor that fires when nothing is falling.** The envelope was
   `target > previous ? target : previous * release`. With a *steady* tone `target ===
   previous`, so the else-branch ran and the level decayed — a sustained note faded out
   instead of holding. Written as `max(target, previous * release)` it holds, because
   equality is not a fall.
2. **A shared peak-hold decay masking the per-band release.** The hold decayed at one rate
   for every band, and that rate was slower than the treble release — so bass *and* treble
   crossed the "gone quiet" threshold at the same frame (21), i.e. the per-band timing I
   had just added was invisible. The hold has to bleed off at each band's own rate.
3. **A transient accent that boosted the body, not the hits.** "Loud relative to this
   band's slow average" is true for *every* frame of a sustained note, so the accent lifted
   the steady level from 0.56 to 0.86 while the hits sat pinned at the ceiling: measured
   contrast went *down* (1.63× → 1.17×). Measuring against the band's recent peak instead —
   a rise above what this band has been doing lately — gives 2.13× with the accent against
   1.74× without, on the same audio.

Two more measurement traps, both mine: the isolated A/B has to be **mid-scale** (at the
ceiling no accent can be visible, which is a property of emphasis stages in general), and a
metric must isolate what it claims to (with auto-gain on, the contrast ratio barely moves
because the accent also raises the normalisation reference).

And two fixture traps in the browser preview — worth remembering before trusting a
screenshot: its stub spectrum was a **single travelling wave**, i.e. the preview was
photographing exactly the scan the rail is meant to avoid; and the sampling loop ran *after*
the tool had switched the page to its silent state, so every sample read a parked rail
(`Number(null) === 0` made that look like "0 range" rather than "no data").

## 10. One loopback endpoint, one capture client

A live check that starts *its own* helper while the application is already capturing gets
**no PCM at all** — not silence, nothing — while still reporting `status: live` and a
healthy-looking frame counter: the helper announces the device, then `stream.read()`
delivers nothing. Measured directly: my probe saw `bytes +0/s, frames +22/s`, while the
application's own helper (the only `python loopback.py` process running) showed
`bytes 35291136, frames 47171` — it had been reading the endpoint happily for minutes.

So: verify through the application's own route (`?diag=1`), which reads the capture that
already owns the endpoint, and start a private helper only when the application's is
stopped (the installer does exactly that before replacing files). And when reading a quiet
room through that route, `peak: 0` with `bytes` climbing is the healthy state; `bytes`
standing still is the fault.

## 11. A capture timer that keeps running looks exactly like a live capture

`frames +22/s` with `bytes +0/s` is not "quiet audio", it is no audio: the analysis timer
ticks on whatever is in the ring, so a dead or blocked helper still advances the frame
counter while the spectrum stays at rest. Read `bytes` (arrival) and `frames` (analysis)
separately, and always alongside `peak`. The same shape of fault appeared twice in this
project — once as a frozen ring cursor (`bytes` and `frames` both climbing, `levels`
constant) and once as a respawn that forgot to re-arm the timer (`bytes` climbing,
`frames` frozen) — and in all three cases the fix was found by comparing the pair, never
by looking at the rendered rail.
