/**
 * dsh-pinpu — browser face.
 *
 * Takes over the transcript's **own** turn rail (the strip the screenshot
 * circled): the marks that DSH already draws down the right edge of the
 * conversation become the spectrum. Nothing new is drawn on top of them, and the
 * app's own click-to-jump listeners, hover preview card and hit areas are left
 * exactly as they are.
 *
 * Three things happen to the rail:
 * 1. Every mark is dimmed to the same neutral colour and the same short length,
 *    which removes the shipped "newest turn is highlighted" state without
 *    touching the class names that express it (all marks are overridden at once).
 * 2. While audio is playing, each mark's length follows one frequency band, with
 *    bass at the bottom next to the newest turn.
 * 3. The mark under the pointer is brightened and drawn full length (Codex's
 *    behaviour); a busy mark keeps the app's own pulse animation.
 *
 * ## Why this file never looks for a class name
 *
 * `dsh-client-ui-chat` styles the rail through a CSS-module map
 * (`TurnNavigator_module_css_default`) whose values are build-hashed
 * (`xpvNua_mark`, `xpvNua_markActive`, …), so names are not a contract. The rail
 * is therefore found by geometry — a group of sibling `button`s sharing a size,
 * right edge and vertical step — and every override is expressed through plugin
 * attributes, never through the app's selectors.
 *
 * ## Where the audio comes from
 *
 * The spectrum is produced by the host half (WASAPI loopback of the default
 * render device, via the vendored `pyaudiowpatch` helper) and read here from
 * `/api/dsh-pinpu/spectrum?ticks=N` — a relative URL on the same origin, the
 * same pattern the shipped plugins use. Nothing is captured in the renderer:
 * `getUserMedia` cannot see system output, and reading the output device's
 * loopback is the only way to hear what the user actually hears.
 *
 * `exports.__test` exposes the pure helpers for the offline suite.
 *
 * @module dsh-pinpu/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-pinpu',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useRef = React.useRef;
    var useState = React.useState;
    var useSyncExternalStore = React.useSyncExternalStore;

    /** Host entry id; also the `configForms` key. Must equal cordis.patch.yml's row id. */
    var ENTRY_ID = 'pinpu';
    var SECTION_ID = 'pinpu';
    /** Settings card order: right after the shipped 代理设置 section (16). */
    var SECTION_ORDER = 17;
    var cssId = 'dsh-pinpu/client';
    var STYLE_ID = 'dsh-pinpu-rail-style';

    var SPECTRUM_URL = '/api/dsh-pinpu/spectrum';
    var DEVICES_URL = '/api/dsh-pinpu/devices';
    /** Where the browser half reports that it is alive; the host records it. */
    var CLIENT_URL = '/api/dsh-pinpu/client';
    /** The slot this bundle contributes its settings card to. */
    var SETTINGS_SLOT = 'settings.section';
    /** Heartbeat cadence: often enough to notice a dead half, rare enough to ignore. */
    var HEARTBEAT_MS = 15000;

    /** Attributes the plugin owns. `data-*` only, so no app selector can collide. */
    var RAIL_ATTR = 'data-pinpu-rail';
    var TICK_ATTR = 'data-pinpu-tick';
    var LIVE_ATTR = 'data-pinpu-live';
    var NEUTRAL_ATTR = 'data-pinpu-neutral';
    var HOVER_ATTR = 'data-pinpu-hover';
    var BUSY_ATTR = 'data-pinpu-busy';
    /** The rail's positioning container: the app's absolutely positioned frame. */
    var FRAME_ATTR = 'data-pinpu-frame';
    /** Which edge of the conversation the rail sits on. */
    var SIDE_ATTR = 'data-pinpu-side';

    /** Scrollport attribute the conversation itself uses; a published contract. */
    var SCROLL_SELECTOR = '[data-conversation-scroll]';

    /** Spectrum poll cadence. ~21 Hz: smooth behind the .09s CSS transition. */
    var POLL_MS = 48;
    /** Fallback re-discovery when no mutation can be observed. */
    var RESCAN_MS = 1200;
    /** How long silence must last before the marks stop moving. */
    var IDLE_HOLD_MS = 700;
    /** Retry delay after a failed spectrum request. */
    var RETRY_MS = 1500;

    var MIN_MARKS = 2;
    /** Shipped rail geometry, used only to score candidates. */
    var MARK_WIDTH = 28;
    var MARK_HEIGHT = 10;
    var MARK_STEP = 10;

    /**
     * The settings card's stylesheet. Only published tokens (`--dsw-alias-*`) with
     * literal fallbacks: an undefined `var()` would invalidate the whole
     * declaration, so a fallback is mandatory, never optional.
     */
    var CARD_CSS = [
      '.dshpp-card{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.dshpp-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9a9a9a)}',
      '.dshpp-block{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;',
      'background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)));',
      'border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3,rgba(127,127,127,.24)))}',
      '.dshpp-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary,#c4c4c4)}',
      '.dshpp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}',
      '.dshpp-label{color:var(--dsw-alias-label-tertiary,#9a9a9a);white-space:nowrap}',
      '.dshpp-value{color:var(--dsw-alias-label-primary,#e8e8e8);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpp-status{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}',
      '.dshpp-status-text{color:var(--dsw-alias-label-primary,#e8e8e8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpp-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8a8a8a)}',
      '.dshpp-dot-live{background:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.dshpp-dot-demo{background:var(--dsw-alias-state-warn-primary,#d29922)}',
      '.dshpp-dot-starting{background:var(--dsw-alias-state-warn-primary,#d29922)}',
      '.dshpp-dot-error,.dshpp-dot-python-missing{background:var(--dsw-alias-state-error-primary,#f85149)}',
      '.dshpp-toggle{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary,#c4c4c4)}',
      '.dshpp-field{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}',
      '.dshpp-input{box-sizing:border-box;min-width:0;padding:4px 8px;border-radius:6px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.10));',
      'border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24))}',
      '.dshpp-devices{display:flex;gap:8px;align-items:center}',
      '.dshpp-select{flex:1 1 auto}',
      '.dshpp-button{flex:none;padding:4px 10px;border-radius:6px;font-size:12px;line-height:18px;cursor:pointer;',
      'color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.10));',
      'border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24))}',
      '.dshpp-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
      '.dshpp-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.dshpp-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f85149)}',
    ].join('');

    if (typeof document !== 'undefined') {
      // Refresh the text of an injected tag instead of skipping, so a hot
      // re-mount keeps the current stylesheet rather than a stale one.
      var cardTag = document.querySelector('style[data-plugin-css="' + cssId + '"]');
      if (cardTag === null) {
        cardTag = document.createElement('style');
        cardTag.dataset.plugin = 'dsh-pinpu';
        cardTag.dataset.pluginCss = cssId;
        document.head.appendChild(cardTag);
      }
      cardTag.textContent = CARD_CSS;
    }

    /* ------------------------------------------------------------------ *
     * Pure helpers
     * ------------------------------------------------------------------ */

    function clamp(value, min, max) {
      var lower = Math.min(min, max);
      var upper = Math.max(min, max);
      if (!Number.isFinite(value)) return lower;
      return value < lower ? lower : value > upper ? upper : value;
    }

    function num(value, fallback) {
      if (value === undefined || value === null || value === '') return fallback;
      var parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function bool(value, fallback) {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      return fallback;
    }

    /** A level (0..1) becomes a length multiplier between `minScale` and `maxScale`. */
    function scaleFor(level, minScale, maxScale) {
      // A floor of 0 is legal: it means a band can vanish entirely.
      var low = clamp(num(minScale, 0.4), 0, 1);
      var high = clamp(num(maxScale, 1), 0, 1.4);
      var value = clamp(num(level, 0), 0, 1);
      if (high < low) {
        var swap = high;
        high = low;
        low = swap;
      }
      return low + value * (high - low);
    }

    /**
     * Which spectrum band a rail mark shows. Mark 0 is the bottom-most mark, i.e.
     * the newest turn, so the low bands sit at the bottom by default.
     */
    function bandForTick(tick, count, invert, bands) {
      var marks = Math.max(1, Math.floor(num(count, 1)));
      var available = Math.max(1, Math.floor(num(bands, marks)));
      var index = Math.floor(num(tick, 0));
      if (index < 0) index = 0;
      if (index >= marks) index = marks - 1;
      var band = Math.round((index * available) / marks);
      if (band >= available) band = available - 1;
      return invert ? available - 1 - band : band;
    }

    /**
     * Rank mark rects bottom-first: the result is aligned with the input order and
     * holds each mark's tick index (0 = lowest on screen).
     * @param {{top: number, bottom: number}[]} rects
     */
    function assignTicks(rects) {
      var order = rects.map(function (rect, index) {
        return { index: index, centre: (num(rect.top, 0) + num(rect.bottom, 0)) / 2 };
      });
      order.sort(function (a, b) {
        return b.centre - a.centre;
      });
      var ticks = new Array(rects.length);
      for (var rank = 0; rank < order.length; rank += 1) ticks[order[rank].index] = rank;
      return ticks;
    }

    function median(values) {
      if (values.length === 0) return 0;
      var sorted = values.slice().sort(function (a, b) {
        return a - b;
      });
      var middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    }

    function within(value, target, tolerance) {
      return Math.abs(value - target) <= tolerance;
    }

    /**
     * Score one group of candidate marks from plain geometry, so the offline suite
     * can exercise the discovery rule without a DOM.
     * @param {{top: number, bottom: number, left: number, right: number}[]} rects
     * @returns {number} negative when the group cannot be the rail
     */
    function scoreGroup(rects) {
      if (!Array.isArray(rects) || rects.length < MIN_MARKS) return -1;
      var widths = rects.map(function (rect) {
        return num(rect.right, 0) - num(rect.left, 0);
      });
      var heights = rects.map(function (rect) {
        return num(rect.bottom, 0) - num(rect.top, 0);
      });
      var width = median(widths), height = median(heights);
      if (width < 12 || width > 64 || height < 4 || height > 24) return -1;
      for (var index = 0; index < rects.length; index += 1) {
        if (!within(widths[index], width, 3)) return -1;
        if (!within(heights[index], height, 3)) return -1;
        // Right-aligned column: every mark shares the same right edge.
        if (!within(rects[index].right, rects[0].right, 3)) return -1;
      }
      var tops = rects.map(function (rect) {
        return num(rect.top, 0);
      }).sort(function (a, b) {
        return a - b;
      });
      var steps = [];
      for (var step = 1; step < tops.length; step += 1) {
        var delta = tops[step] - tops[step - 1];
        if (delta < 2) return -1;
        steps.push(delta);
      }
      var gap = median(steps);
      if (gap < 4 || gap > 32) return -1;
      for (var check = 0; check < steps.length; check += 1) {
        if (!within(steps[check], gap, 2)) return -1;
      }
      // Prefer the biggest group, then the one whose geometry matches the shipped rail.
      var shape = 1 / (1 + Math.abs(width - MARK_WIDTH) + Math.abs(height - MARK_HEIGHT));
      var rhythm = 1 / (1 + Math.abs(gap - MARK_STEP));
      var aligned = 0;
      for (var align = 0; align < rects.length; align += 1) {
        if (within(rects[align].left, rects[0].left, 3)) aligned += 1;
      }
      if (aligned !== rects.length) return -1;
      return rects.length * 100 + shape * 20 + rhythm * 10;
    }

    /** The best candidate index in `groups` (`{rects: [...]}`), or -1. */
    function pickRail(groups) {
      var best = -1;
      var bestScore = 0;
      for (var index = 0; index < groups.length; index += 1) {
        var score = scoreGroup(groups[index].rects);
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      }
      return best;
    }

    /**
     * A synthetic spectrum for the no-capture case (`demo`).
     *
     * Deliberately *not* one shared oscillator: every segment gets its own period, phase
     * and slow random walk, and the periods are incommensurate so the pattern never
     * repeats visibly. Nothing here is white noise either — each segment keeps a slow
     * envelope, so the result reads as motion with a pulse rather than as flicker.
     */
    function demoLevels(count, time, bands) {
      var marks = Math.max(1, Math.floor(num(count, 1)));
      var available = Math.max(1, Math.floor(num(bands, marks)));
      if (demoState === null || demoState.length !== marks) {
        demoState = [];
        for (var seed = 0; seed < marks; seed += 1) {
          // Irrational-ish spreads: no two segments share a period or a phase.
          demoState.push({
            rate: 0.13 + 0.11 * ((seed * 0.6180339887) % 1),
            phase: ((seed * 0.7548776662) % 1) * Math.PI * 2,
            walk: 0,
          });
        }
      }
      var out = new Array(marks);
      var seconds = time / 1000;
      for (var index = 0; index < marks; index += 1) {
        var state = demoState[index];
        state.walk = state.walk * 0.94 + (Math.random() * 2 - 1) * 0.22;
        var band = bandForTick(index, marks, false, available);
        var position = available === 1 ? 0 : band / (available - 1);
        var slow = 0.5 + 0.5 * Math.sin(seconds * state.rate * 6.283185307 + state.phase);
        var fast = 0.5 + 0.5 * Math.sin(seconds * state.rate * 3.7 * 6.283185307 + state.phase * 1.7);
        var envelope = 0.62 + 0.38 * Math.sin(seconds * 0.19 * 6.283185307 + position * 2.4);
        var value = (slow * 0.55 + fast * 0.28 + Math.max(0, state.walk) * 0.25) * envelope;
        out[index] = clamp(value, 0, 1);
      }
      return out;
    }

    /**
     * Publish the spectrum payload into a flat level array of `count` entries.
     *
     * **The field name matters.** The route answers with `levels`: already resampled onto
     * the mark count when the request said `?ticks=N`, otherwise the host's own band
     * resolution. Reading only `ticks` (as this once did) silently produced all zeros
     * against the real route — every mark pinned at the base length while the settings
     * card's peak, which comes from `payload.peak`, moved normally. `ticks` is still
     * accepted because older payloads and the preview stub used it.
     */
    function levelsFrom(payload, count, invert, bands) {
      var marks = Math.max(1, Math.floor(num(count, 1)));
      var source = null;
      if (payload && Array.isArray(payload.levels)) source = payload.levels;
      else if (payload && Array.isArray(payload.ticks)) source = payload.ticks;
      var out = new Array(marks);
      for (var index = 0; index < marks; index += 1) {
        var value = 0;
        if (source !== null && source.length > 0) {
          if (source.length === marks) {
            // Already one entry per mark: index straight through, and apply `invert`
            // here — the presentation side owns which end the bass sits at.
            value = num(source[invert ? marks - 1 - index : index], 0);
          } else {
            value = num(source[bandForTick(index, marks, invert, source.length)], 0);
          }
        }
        out[index] = clamp(value, 0, 1);
      }
      return out;
    }

    /* ------------------------------------------------------------------ *
     * Stylesheet
     * ------------------------------------------------------------------ */

    /**
     * The rail overrides. Everything is scoped to the plugin's own attributes and
     * uses `!important`, because the app's rules are CSS-module classes with the
     * same pseudo-element; `!important` also wins over the app's keyframe animation.
     */
    function cssText(options) {
      var settings = options || {};
      var dim = String(settings.dim ?? 'var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.22))');
      var bright = String(settings.bright ?? 'var(--dsw-alias-label-primary, rgba(255, 255, 255, 0.95))');
      var base = clamp(num(settings.base, 0.6), 0.05, 1.4);
      var side = String(settings.side ?? 'right') === 'left' ? 'left' : 'right';
      var rules = [
        '[' + RAIL_ATTR + '][' + NEUTRAL_ATTR + ']>[' + TICK_ATTR + ']::before{',
        'background:' + dim + ' !important;',
        'transform:translateY(-50%) scaleX(' + base + ') !important;',
        'transition:transform 90ms linear,background-color 140ms ease,opacity 90ms linear !important;',
        '}',
        '[' + RAIL_ATTR + '][' + NEUTRAL_ATTR + '][' + HOVER_ATTR + ']>[' + TICK_ATTR + ']:hover::before{',
        'background:' + bright + ' !important;',
        'transform:translateY(-50%) scaleX(1) !important;',
        'opacity:1 !important;',
        '}',
        '[' + RAIL_ATTR + '][' + NEUTRAL_ATTR + '][' + LIVE_ATTR + ']>[' + TICK_ATTR + ']:not([' + BUSY_ATTR + '])::before{',
        'transform:translateY(-50%) scaleX(var(--pinpu-scale,' + base + ')) !important;',
        // Brightness is a second axis of the same level: a segment that is only just
        // moving is dim, a hit is both long and clear. Multiplied rather than toggled, so
        // quiet music loses contrast progressively instead of stepping.
        'opacity:calc(0.35 + 0.65 * var(--pinpu-glow,0.4)) !important;',
        '}',
        '[' + RAIL_ATTR + '][' + NEUTRAL_ATTR + '][' + LIVE_ATTR + '][' + HOVER_ATTR + ']>[' + TICK_ATTR + ']:hover::before{',
        'transform:translateY(-50%) scaleX(1) !important;',
        'opacity:1 !important;',
        '}',
      ];
      if (side === 'left') {
        // Mirror the rail onto the left edge. The app anchors the frame at `right:12px`
        // and hangs each bar off the mark's right edge (`right:0`, origin 100%), so the
        // mirror has to move all three: the frame, the bar's anchor, and its origin.
        rules.push(
          '[' + FRAME_ATTR + '][' + SIDE_ATTR + '="left"]{',
          'left:12px !important;',
          'right:auto !important;',
          '}',
          '[' + FRAME_ATTR + '][' + SIDE_ATTR + '="left"] [' + RAIL_ATTR + ']>[' + TICK_ATTR + ']::before{',
          'left:0 !important;',
          'right:auto !important;',
          'transform-origin:0% 50% !important;',
          '}',
          // The app's hover preview card is `right: calc(100% + 10px)`, i.e. it opens to
          // the rail's left — off-screen once the rail is on the left. `:has()` keeps this
          // off the rail's own ancestors whatever else the frame contains.
          '[' + FRAME_ATTR + '][' + SIDE_ATTR + '="left"] > *:not([' + RAIL_ATTR + ']):not(:has([' + RAIL_ATTR + '])){',
          'left:calc(100% + 10px) !important;',
          'right:auto !important;',
          '}',
        );
      }
      return rules.join('');
    }

    function ensureStyle(doc, text) {
      var existing = doc.getElementById(STYLE_ID);
      if (existing !== null) {
        if (existing.textContent !== text) existing.textContent = text;
        return existing;
      }
      var style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = text;
      doc.head.appendChild(style);
      return style;
    }

    function removeStyle(doc) {
      var existing = doc.getElementById(STYLE_ID);
      if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing);
    }

    /* ------------------------------------------------------------------ *
     * Rail discovery (DOM)
     * ------------------------------------------------------------------ */

    function rectOf(element) {
      if (!element || typeof element.getBoundingClientRect !== 'function') return null;
      var rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    }

    /**
     * The rail's positioning container: the nearest ancestor with an out-of-flow
     * position.
     *
     * Only used when the rail is asked to sit on the other edge — moving the frame is
     * what moves the rail. `relative`/`static` ancestors are skipped, because the app's
     * marks container is itself `relative` and only its frame is `absolute`.
     */
    function frameOf(element, stopAt) {
      var node = element === null || element === undefined ? null : element.parentElement;
      while (node !== null && node !== undefined && node !== stopAt && node.nodeType === 1) {
        var position = '';
        try {
          var style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(node) : null;
          position = style && typeof style.position === 'string' ? style.position : '';
        } catch (error) {
          position = '';
        }
        if (position === 'absolute' || position === 'fixed') return node;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Find the rail: the best-scoring group of sibling buttons in the conversation.
     * @returns {{marks: {element: Element, tick: number}[], rail: Element} | null}
     */
    function discover(doc) {
      var scopes = doc.querySelectorAll(SCROLL_SELECTOR);
      var roots = [];
      for (var index = 0; index < scopes.length; index += 1) roots.push(scopes[index]);
      if (roots.length === 0) roots.push(doc.body);
      var groups = [];
      var seen = [];
      for (var root = 0; root < roots.length; root += 1) {
        var buttons = roots[root].querySelectorAll('button');
        for (var button = 0; button < buttons.length; button += 1) {
          var element = buttons[button];
          var parent = element.parentElement;
          if (parent === null || parent === undefined) continue;
          if (seen.indexOf(parent) >= 0) continue;
          var siblings = parent.children;
          var marks = [];
          for (var child = 0; child < siblings.length; child += 1) {
            var node = siblings[child];
            if (node.tagName !== 'BUTTON') continue;
            var rect = rectOf(node);
            if (rect === null) continue;
            marks.push({ element: node, rect: rect });
          }
          seen.push(parent);
          if (marks.length < MIN_MARKS) continue;
          groups.push({
            rail: parent,
            marks: marks,
            rects: marks.map(function (mark) {
              return mark.rect;
            }),
          });
        }
      }
      var best = pickRail(groups);
      if (best < 0) return null;
      var winner = groups[best];
      var ticks = assignTicks(winner.rects);
      return {
        rail: winner.rail,
        frame: frameOf(winner.rail, roots[0] === doc.body ? null : roots[0]),
        marks: winner.marks.map(function (mark, index) {
          return { element: mark.element, tick: ticks[index] };
        }),
      };
    }

    /** A mark carries the app's busy pulse when its `::before` runs an animation. */
    function isBusy(element) {
      if (typeof window.getComputedStyle !== 'function') return false;
      try {
        var style = window.getComputedStyle(element, '::before');
        var name = style ? style.animationName : '';
        return typeof name === 'string' && name !== '' && name !== 'none';
      } catch (error) {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Engine: rail + spectrum feed, driven by the host config
     * ------------------------------------------------------------------ */

    /** Per-segment oscillator state for `demoLevels`; one table per page. */
    var demoState = null;

    var DEFAULTS = {
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
      glow: true,
      demo: false,
      bands: 64,
    };

    function withDefaults(config) {
      var source = config && typeof config === 'object' ? config : {};
      var merged = {};
      for (var key in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) merged[key] = DEFAULTS[key];
      }
      for (var field in source) {
        if (Object.prototype.hasOwnProperty.call(source, field)) merged[field] = source[field];
      }
      return merged;
    }

    /** Theme colours: the app's own dim/bright rail tokens, with literal fallbacks. */
    function themeColors(mode, custom) {
      if (mode === 'custom' && typeof custom === 'string' && custom.trim() !== '') {
        return { dim: custom.trim(), bright: custom.trim() };
      }
      return {
        dim: 'var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.22))',
        bright: 'var(--dsw-alias-label-primary, rgba(255, 255, 255, 0.95))',
      };
    }

    function createEngine() {
      var config = withDefaults();
      var rail = null;
      var frame = null;
      var marks = [];
      var listeners = [];
      var status = {
        state: 'idle',
        message: '',
        device: '',
        peak: 0,
        marks: 0,
        values: 0,
        updated: 0,
      };
      var timer = null;
      var rescan = null;
      var observer = null;
      var inflight = false;
      var nextPoll = 0;
      var silentSince = 0;
      var running = false;
      var lastLevels = [];

      function emit(patch) {
        var changed = false;
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key) && status[key] !== patch[key]) {
            status[key] = patch[key];
            changed = true;
          }
        }
        if (!changed) return;
        for (var index = 0; index < listeners.length; index += 1) {
          try {
            listeners[index](status);
          } catch (error) {
            /* a listener must never break the loop */
          }
        }
      }

      function doc() {
        return typeof document === 'undefined' ? null : document;
      }

      function applyStyle() {
        var target = doc();
        if (target === null) return;
        var colors = themeColors(config.colorMode, config.customColor);
        ensureStyle(target, cssText({ dim: colors.dim, bright: colors.bright, base: 0.6, side: config.side }));
      }

      /** Tag every discovered mark; the tick index counts from the bottom. */
      function scan() {
        var target = doc();
        if (target === null) return;
        var found = discover(target);
        if (rail !== null && (found === null || found.rail !== rail)) {
          clearAttributes();
        }
        if (found === null) {
          rail = null;
          frame = null;
          marks = [];
          emit({ marks: 0 });
          return;
        }
        rail = found.rail;
        frame = found.frame;
        marks = found.marks;
        rail.setAttribute(RAIL_ATTR, '1');
        applySide();
        for (var index = 0; index < marks.length; index += 1) {
          var mark = marks[index];
          mark.element.setAttribute(TICK_ATTR, String(mark.tick));
          if (isBusy(mark.element)) mark.element.setAttribute(BUSY_ATTR, '1');
          else mark.element.removeAttribute(BUSY_ATTR);
        }
        emit({ marks: marks.length });
      }

      /** Put the configured edge on the rail's frame, which is what actually moves it. */
      function applySide() {
        if (frame === null) return;
        frame.setAttribute(FRAME_ATTR, '1');
        frame.setAttribute(SIDE_ATTR, String(config.side) === 'left' ? 'left' : 'right');
      }

      function clearAttributes() {
        if (rail !== null) {
          rail.removeAttribute(RAIL_ATTR);
          rail.removeAttribute(NEUTRAL_ATTR);
          rail.removeAttribute(HOVER_ATTR);
          rail.removeAttribute(LIVE_ATTR);
        }
        if (frame !== null) {
          frame.removeAttribute(FRAME_ATTR);
          frame.removeAttribute(SIDE_ATTR);
        }
        for (var index = 0; index < marks.length; index += 1) {
          var element = marks[index].element;
          element.removeAttribute(TICK_ATTR);
          element.removeAttribute(BUSY_ATTR);
          element.style.removeProperty('--pinpu-scale');
          element.style.removeProperty('--pinpu-glow');
        }
        marks = [];
        rail = null;
        frame = null;
      }

      function setToggle(attribute, on) {
        if (rail === null) return;
        if (on) rail.setAttribute(attribute, '1');
        else rail.removeAttribute(attribute);
      }

      /** True when at least one mark moved, so the caller can skip redundant work. */
      function paint(levels) {
        if (rail === null) return false;
        var moved = false;
        var glowOn = bool(config.glow, true);
        for (var index = 0; index < marks.length; index += 1) {
          var element = marks[index].element;
          // `levels` is indexed by tick (0 = the bottom-most mark), while `marks` is in
          // document order, so the two only line up through the stored tick index.
          var value = num(levels[marks[index].tick], 0);
          var scale = Number(scaleFor(value, config.minScale, config.maxScale).toFixed(3));
          // Brightness is a *layer* on the same level, not a second animation: a segment
          // that has barely moved stays dim while a hit is long and clear. The curve is
          // concave so small motions still register, and it is multiplicative, so quiet
          // music loses contrast gracefully rather than switching.
          var glow = glowOn ? clamp(0.18 + 0.82 * Math.pow(value, 0.6), 0, 1) : 1;
          var glowText = Number(glow.toFixed(3));
          if (element.style.getPropertyValue('--pinpu-scale') !== scale.toFixed(3)) {
            element.style.setProperty('--pinpu-scale', scale.toFixed(3));
            moved = true;
          }
          if (element.style.getPropertyValue('--pinpu-glow') !== glowText.toFixed(3)) {
            element.style.setProperty('--pinpu-glow', glowText.toFixed(3));
            moved = true;
          }
        }
        return moved;
      }

      function park() {
        for (var index = 0; index < marks.length; index += 1) {
          marks[index].element.style.removeProperty('--pinpu-scale');
          marks[index].element.style.removeProperty('--pinpu-glow');
        }
        setToggle(LIVE_ATTR, false);
      }

      function poll() {
        if (!running || inflight) return;
        if (Date.now() < nextPoll) return;
        var target = doc();
        if (target === null) return;
        if (marks.length < MIN_MARKS) {
          scan();
          if (marks.length < MIN_MARKS) return;
        }
        if (config.demo) {
          var fake = demoLevels(marks.length, Date.now(), DEFAULTS.bands);
          lastLevels = fake;
          if (!truthyToggle(LIVE_ATTR)) setToggle(LIVE_ATTR, true);
          paint(fake);
          emit({ state: 'demo', message: '', peak: Math.max.apply(null, fake.concat([0])), values: marks.length, updated: Date.now() });
          return;
        }
        inflight = true;
        var url = SPECTRUM_URL + '?ticks=' + String(marks.length);
        var request = typeof fetch === 'function' ? fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } }) : Promise.reject(new Error('fetch-unavailable'));
        request.then(function (response) {
          if (!response.ok) throw new Error('http-' + String(response.status));
          return response.json();
        }).then(function (payload) {
          inflight = false;
          nextPoll = 0;
          handlePayload(payload);
        }).catch(function (error) {
          inflight = false;
          nextPoll = Date.now() + RETRY_MS;
          if (truthyToggle(LIVE_ATTR)) park();
          emit({ state: 'error', message: String((error && error.message) || error) });
        });
      }

      function truthyToggle(attribute) {
        return rail !== null && rail.hasAttribute(attribute);
      }

      function handlePayload(payload) {
        // The route answers with `levels`, already resampled to the mark count;
        // `levelsFrom` also accepts the older `ticks` array and an empty payload.
        var levels = levelsFrom(payload, marks.length, bool(config.invert, false), DEFAULTS.bands);
        var state = payload && typeof payload.status === 'string' ? payload.status : 'unknown';
        var silent = payload ? payload.silent === true : true;
        if (state !== 'live' && state !== 'demo') {
          if (truthyToggle(LIVE_ATTR)) park();
          emit({
            state: state,
            message: String((payload && payload.error) || ''),
            device: String((payload && payload.device) || ''),
            peak: 0,
            values: 0,
            updated: Date.now(),
          });
          return;
        }
        if (silent) {
          if (silentSince === 0) silentSince = Date.now();
          if (config.restoreOnSilence && Date.now() - silentSince > IDLE_HOLD_MS && truthyToggle(LIVE_ATTR)) park();
        } else {
          silentSince = 0;
          if (!truthyToggle(LIVE_ATTR)) setToggle(LIVE_ATTR, true);
        }
        // Paint while the take-over is on — including through the silent frames, where the
        // host's per-band release *is* the natural decay at a pause. Once parked (after the
        // hold above), painting stops, so the inline overrides stay removed instead of
        // being written back at the minimum length.
        if (truthyToggle(LIVE_ATTR)) {
          lastLevels = levels;
          paint(levels);
        }
        emit({
          state: 'live',
          message: '',
          device: String((payload && payload.device) || ''),
          peak: num(payload && payload.peak, 0),
          values: levels.length,
          updated: Date.now(),
        });
      }

      function startTimers() {
        if (timer !== null) return;
        timer = window.setInterval(poll, POLL_MS);
        rescan = window.setInterval(function () {
          if (!running) return;
          scan();
          applyToggles();
        }, RESCAN_MS);
      }

      function stopTimers() {
        if (timer !== null) window.clearInterval(timer);
        if (rescan !== null) window.clearInterval(rescan);
        timer = null;
        rescan = null;
      }

      function applyToggles() {
        if (rail === null) return;
        setToggle(NEUTRAL_ATTR, bool(config.disableActiveHighlight, true));
        setToggle(HOVER_ATTR, bool(config.hoverHighlight, true));
        if (!bool(config.disableActiveHighlight, true)) setToggle(LIVE_ATTR, false);
      }

      function observe() {
        var target = doc();
        if (target === null || observer !== null || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(function () {
          scan();
          applyToggles();
        });
        observer.observe(target.body, { childList: true, subtree: true });
      }

      function start() {
        if (running) return;
        running = true;
        applyStyle();
        scan();
        applyToggles();
        observe();
        startTimers();
        emit({ state: 'starting', message: '' });
      }

      function stop() {
        if (!running) return;
        running = false;
        stopTimers();
        if (observer !== null) {
          observer.disconnect();
          observer = null;
        }
        clearAttributes();
        removeStyle(doc());
        emit({ state: 'idle', message: '', device: '', peak: 0, marks: 0, values: 0 });
      }

      function configure(next) {
        config = withDefaults(next);
        if (!bool(config.enabled, true)) {
          stop();
          return;
        }
        if (!running) {
          start();
          return;
        }
        applyStyle();
        applyToggles();
        if (config.demo && !truthyToggle(LIVE_ATTR)) setToggle(LIVE_ATTR, true);
        scan();
        emit({ state: config.demo ? 'demo' : status.state });
      }

      return {
        configure: configure,
        start: start,
        stop: stop,
        status: function () {
          return status;
        },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
        rescan: function () {
          scan();
          applyToggles();
        },
        levels: function () {
          return lastLevels;
        },
      };
    }

    /** One engine per page, so the rail dances even if Settings is never opened. */
    var engine = createEngine();

    function useStatus() {
      if (typeof useSyncExternalStore === 'function') {
        return useSyncExternalStore(engine.subscribe, engine.status, engine.status);
      }
      var pair = useState(engine.status());
      useEffect(function () {
        return engine.subscribe(function (next) {
          pair[1](next);
        });
      }, []);
      return pair[0];
    }

    /* ------------------------------------------------------------------ *
     * Settings card
     * ------------------------------------------------------------------ */

    var LABELS = {
      status: '状态',
      device: '采集设备',
      peak: '当前峰值',
      marks: '刻度数',
      enabled: '启用律动',
      disableActiveHighlight: '关闭默认高亮',
      hoverHighlight: '悬停高亮',
      restoreOnSilence: '静音时停止律动',
      minScale: '最短长度',
      maxScale: '最长长度',
      invert: '高频在上',
      side: '刻度条位置',
      punch: '打击感',
      flutter: '灵动',
      glow: '亮度层次',
      colorMode: '颜色',
      customColor: '自定义颜色',
      demo: '演示模式',
      refresh: '刷新设备列表',
      rescan: '重新识别刻度条',
    };

    var STATE_TEXT = {
      idle: '未启用',
      starting: '启动中',
      live: '采集中',
      demo: '演示',
      'python-missing': '未找到 Python 运行时',
      error: '错误',
      stopped: '已停止',
    };

    function StatusRow(props) {
      return h('div', { className: 'dshpp-status' }, [
        h('span', { key: 'dot', className: 'dshpp-dot dshpp-dot-' + String(props.state || 'idle') }),
        h('span', { key: 'text', className: 'dshpp-status-text' }, props.text),
      ]);
    }

    function Row(props) {
      return h('div', { className: 'dshpp-row' }, [
        h('span', { key: 'label', className: 'dshpp-label' }, props.label),
        h('span', { key: 'value', className: 'dshpp-value' }, props.value),
      ]);
    }

    function Toggle(props) {
      var id = 'dshpp-' + props.field;
      return h('label', { className: 'dshpp-toggle', htmlFor: id }, [
        h('input', {
          key: 'input',
          id: id,
          type: 'checkbox',
          checked: props.checked,
          onChange: function (event) {
            props.onChange(event.target.checked);
          },
        }),
        h('span', { key: 'label' }, props.label),
      ]);
    }

    function NumberInput(props) {
      var id = 'dshpp-' + props.field;
      return h('label', { className: 'dshpp-field', htmlFor: id }, [
        h('span', { key: 'label', className: 'dshpp-label' }, props.label),
        h('input', {
          key: 'input',
          id: id,
          type: 'number',
          className: 'dshpp-input',
          value: props.value,
          min: props.min,
          max: props.max,
          step: props.step,
          onChange: function (event) {
            var parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) props.onChange(parsed);
          },
        }),
      ]);
    }

    /** A labelled `<select>` for small closed sets (the rail's edge, for now). */
    function ChoiceSelect(props) {
      var id = 'dshpp-' + props.field;
      return h('label', { className: 'dshpp-field', htmlFor: id }, [
        h('span', { key: 'label', className: 'dshpp-label' }, props.label),
        h('select', {
          key: 'select',
          id: id,
          className: 'dshpp-input dshpp-select',
          value: props.value,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
        }, props.options.map(function (option) {
          return h('option', { key: option.value, value: option.value }, option.label);
        })),
      ]);
    }

    function DeviceSelect(props) {
      var list = props.devices;
      return h('div', { className: 'dshpp-devices' }, [
        h('select', {
          key: 'select',
          className: 'dshpp-input dshpp-select',
          value: props.value,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
        }, [h('option', { key: 'auto', value: '' }, '自动（跟随系统默认输出）')].concat(
          list.map(function (device) {
            var name = String(device.name || '') + (device.isDefault ? '（默认）' : '');
            return h('option', { key: String(device.index), value: String(device.index) }, name);
          }),
        )),
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dshpp-button',
          onClick: function () {
            props.onRefresh();
          },
        }, LABELS.refresh),
      ]);
    }

    function useController(ctx) {
      var controller = useMemo(function () {
        return ctx.configForms.get(ENTRY_ID);
      }, [ctx]);
      var snapshot = useSyncExternalStore(
        useCallback(function (listener) {
          return controller.subscribe(listener);
        }, [controller]),
        useCallback(function () {
          return controller.getSnapshot();
        }, [controller]),
        useCallback(function () {
          return controller.getSnapshot();
        }, [controller]),
      );
      return { controller: controller, snapshot: snapshot };
    }

    function PinpuSettingsCard(props) {
      var pair = useController(props.ctx);
      var snapshot = pair.snapshot;
      var controller = pair.controller;
      var value = useMemo(function () {
        var raw = withDefaults(snapshot && snapshot.value);
        for (var key in raw) {
          if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === 'object' && raw[key] !== null) {
            var inner = raw[key];
            if (typeof inner.get === 'function') raw[key] = inner.get();
          }
        }
        return raw;
      }, [snapshot]);
      var status = useStatus();
      var devicesPair = useState({ list: [], error: '' });
      var devices = devicesPair[0];

      var refresh = useCallback(function (force) {
        var url = DEVICES_URL + (force ? '?refresh=1' : '');
        fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('http-' + String(response.status));
            return response.json();
          })
          .then(function (payload) {
            devicesPair[1]({ list: Array.isArray(payload.devices) ? payload.devices : [], error: '' });
          })
          .catch(function (error) {
            devicesPair[1]({ list: [], error: String((error && error.message) || error) });
          });
      }, []);

      useEffect(function () {
        refresh(false);
      }, [refresh]);

      var set = useCallback(function (field, next) {
        controller.set(field, next);
      }, [controller]);

      var writable = !snapshot || snapshot.writable !== false;
      var state = status.state || 'idle';
      var statusText = STATE_TEXT[state] || state;
      if (status.message !== '') statusText = statusText + '（' + status.message + '）';

      var card = h('div', { className: 'dshpp-card' }, [
        h('p', { key: 'intro', className: 'dshpp-intro' },
          '让对话边上的轮次刻度条随系统声音律动。刻度条本身被接管：默认不再高亮最新一条，鼠标移上去才高亮，点击跳转照旧；位置可以在左右两侧之间切换。'),
        h('div', { key: 'status', className: 'dshpp-block' }, [
          h(StatusRow, { key: 'state', state: state, text: statusText }),
          h(Row, { key: 'device', label: LABELS.device, value: status.device || '（等待采集）' }),
          h(Row, { key: 'peak', label: LABELS.peak, value: status.peak.toFixed(3) }),
          h(Row, { key: 'marks', label: LABELS.marks, value: String(status.marks) }),
        ]),
        h('div', { key: 'source', className: 'dshpp-block' }, [
          h('div', { key: 'title', className: 'dshpp-title' }, LABELS.device),
          h(DeviceSelect, {
            key: 'select',
            value: String(value.device ?? ''),
            devices: devices.list,
            onRefresh: function () {
              refresh(true);
            },
            onChange: function (next) {
              set('device', next);
            },
          }),
          devices.error !== '' ? h('div', { key: 'error', className: 'dshpp-error' }, devices.error) : null,
        ]),
        h('div', { key: 'look', className: 'dshpp-block' }, [
          h('div', { key: 'title', className: 'dshpp-title' }, '外观'),
          h(ChoiceSelect, {
            key: 'side',
            field: 'side',
            label: LABELS.side,
            value: String(value.side ?? 'right'),
            options: [
              { value: 'right', label: '右侧（默认）' },
              { value: 'left', label: '左侧' },
            ],
            onChange: function (next) {
              set('side', next);
            },
          }),
          h(Toggle, { key: 'active', field: 'disableActiveHighlight', label: LABELS.disableActiveHighlight, checked: bool(value.disableActiveHighlight, true), onChange: function (next) { set('disableActiveHighlight', next); } }),
          h(Toggle, { key: 'hover', field: 'hoverHighlight', label: LABELS.hoverHighlight, checked: bool(value.hoverHighlight, true), onChange: function (next) { set('hoverHighlight', next); } }),
          h(Toggle, { key: 'silence', field: 'restoreOnSilence', label: LABELS.restoreOnSilence, checked: bool(value.restoreOnSilence, true), onChange: function (next) { set('restoreOnSilence', next); } }),
          h(Toggle, { key: 'invert', field: 'invert', label: LABELS.invert, checked: bool(value.invert, false), onChange: function (next) { set('invert', next); } }),
          h(NumberInput, { key: 'min', field: 'minScale', label: LABELS.minScale, value: num(value.minScale, 0.4), min: 0.05, max: 1, step: 0.05, onChange: function (next) { set('minScale', next); } }),
          h(NumberInput, { key: 'max', field: 'maxScale', label: LABELS.maxScale, value: num(value.maxScale, 1), min: 0.05, max: 1.2, step: 0.05, onChange: function (next) { set('maxScale', next); } }),
          h(Toggle, { key: 'glow', field: 'glow', label: LABELS.glow, checked: bool(value.glow, true), onChange: function (next) { set('glow', next); } }),
        ]),
        h('div', { key: 'response', className: 'dshpp-block' }, [
          h('div', { key: 'title', className: 'dshpp-title' }, '响应'),
          h(NumberInput, { key: 'gate', field: 'gate', label: '静音阈值', value: num(value.gate, 0.04), min: 0, max: 0.5, step: 0.01, onChange: function (next) { set('gate', next); } }),
          h(NumberInput, { key: 'gain', field: 'gain', label: '增益', value: num(value.gain, 1), min: 0.2, max: 4, step: 0.1, onChange: function (next) { set('gain', next); } }),
          h(NumberInput, { key: 'smooth', field: 'smoothing', label: '平滑', value: num(value.smoothing, 0.78), min: 0, max: 0.95, step: 0.01, onChange: function (next) { set('smoothing', next); } }),
          h(NumberInput, { key: 'punch', field: 'punch', label: LABELS.punch, value: num(value.punch, 0.55), min: 0, max: 2, step: 0.05, onChange: function (next) { set('punch', next); } }),
          h(NumberInput, { key: 'flutter', field: 'flutter', label: LABELS.flutter, value: num(value.flutter, 0.08), min: 0, max: 0.35, step: 0.01, onChange: function (next) { set('flutter', next); } }),
          h(Toggle, { key: 'auto', field: 'autoGain', label: '自动增益', checked: bool(value.autoGain, true), onChange: function (next) { set('autoGain', next); } }),
          h(NumberInput, { key: 'low', field: 'minHz', label: '最低频率', value: num(value.minHz, 45), min: 20, max: 500, step: 5, onChange: function (next) { set('minHz', next); } }),
          h(NumberInput, { key: 'high', field: 'maxHz', label: '最高频率', value: num(value.maxHz, 16000), min: 2000, max: 22000, step: 500, onChange: function (next) { set('maxHz', next); } }),
        ]),
        h('div', { key: 'misc', className: 'dshpp-block' }, [
          h(Toggle, { key: 'demo', field: 'demo', label: LABELS.demo, checked: bool(value.demo, false), onChange: function (next) { set('demo', next); } }),
          h('div', { key: 'actions', className: 'dshpp-actions' }, [
            h('button', {
              key: 'rescan',
              type: 'button',
              className: 'dshpp-button',
              onClick: function () {
                engine.rescan();
              },
            }, LABELS.rescan),
          ]),
        ]),
        writable ? null : h('div', { key: 'readonly', className: 'dshpp-error' }, '当前配置只读'),
      ]);

      return card;
    }

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */

    function plain(value) {
      if (value && typeof value === 'object' && typeof value.get === 'function') {
        try {
          return value.get();
        } catch (error) {
          return value;
        }
      }
      return value;
    }

    function readConfig(controller) {
      if (!controller || typeof controller.getSnapshot !== 'function') return {};
      var snapshot = null;
      try {
        snapshot = controller.getSnapshot();
      } catch (error) {
        return {};
      }
      var raw = snapshot && snapshot.value;
      if (!raw || typeof raw !== 'object') return {};
      var out = {};
      for (var key in raw) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = plain(raw[key]);
      }
      return out;
    }

    /**
     * Tell the host what the browser half is doing.
     *
     * Fire-and-forget on purpose: a diagnostic must never be able to break the plugin,
     * and the host is the only place that can be read from outside the application
     * window — which is what turned "the card is missing and the rail is still" into a
     * question with an answer.
     */
    function report(event, detail) {
      try {
        var suffix = detail === undefined || detail === '' ? '' : '&detail=' + encodeURIComponent(String(detail).slice(0, 400));
        if (typeof fetch !== 'function') return;
        fetch(CLIENT_URL + '?event=' + encodeURIComponent(event) + suffix, { credentials: 'same-origin' }).catch(function () {});
      } catch (error) {
        /* reporting must never throw */
      }
    }

    /**
     * Run one stage of `apply`, reporting a failure instead of letting it abort the
     * rest. A throw inside `apply` makes cordis dispose everything the plugin already
     * registered, so one wrong call would otherwise take the whole half down silently.
     */
    function stage(label, run) {
      try {
        return run();
      } catch (error) {
        var message = String((error && error.message) || error);
        report('error', label + ': ' + message);
        try {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn('[pinpu] ' + label + ' failed: ' + message);
        } catch (ignored) {
          /* no console, no problem */
        }
        return undefined;
      }
    }

    function apply(ctx) {
      report('apply', 'start');
      var controller = stage('configForms', function () {
        return ctx.configForms.get(ENTRY_ID);
      });
      if (controller === undefined) controller = null;
      stage('engine', function () {
        engine.configure(readConfig(controller));
      });
      stage('config-subscription', function () {
        ctx.effect(function () {
          if (controller === null || typeof controller.subscribe !== 'function') return function () {};
          return controller.subscribe(function () {
            engine.configure(readConfig(controller));
          });
        }, 'pinpu:config');
      });
      stage('engine-teardown', function () {
        ctx.effect(function () {
          return function () {
            engine.stop();
          };
        }, 'pinpu:engine');
      });
      stage('settings-section', function () {
        ctx.slots.inject(SETTINGS_SLOT, function () {
          return ctx.slots.register(
            {
              // `name` is what routes a registration to its slot; the `inject(slot, …)`
              // argument above only waits for that slot's namespace to exist. Both
              // shipped plugins pass it, and the harness now requires it.
              name: SETTINGS_SLOT,
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: '频谱律动',
            },
            function () {
              return h(PinpuSettingsCard, { ctx: ctx });
            },
          );
        });
      });
      var heartbeat = stage('heartbeat', function () {
        return window.setInterval(function () {
          report('heartbeat', String((engine.status() || {}).state || ''));
        }, HEARTBEAT_MS);
      });
      stage('heartbeat-teardown', function () {
        ctx.effect(function () {
          return function () {
            if (heartbeat !== undefined) window.clearInterval(heartbeat);
            report('stop', '');
          };
        }, 'pinpu:heartbeat');
      });
      report('apply', 'ready');
    }

    exports.name = 'dsh-pinpu-ui';
    exports.apply = apply;
    /** Cordis *service* names, never package names. */
    exports.inject = ['slots', 'configForms'];
    exports.__test = {
      ENTRY_ID: ENTRY_ID,
      SECTION_ID: SECTION_ID,
      SECTION_ORDER: SECTION_ORDER,
      cssId: cssId,
      STYLE_ID: STYLE_ID,
      SPECTRUM_URL: SPECTRUM_URL,
      DEVICES_URL: DEVICES_URL,
      CLIENT_URL: CLIENT_URL,
      SETTINGS_SLOT: SETTINGS_SLOT,
      HEARTBEAT_MS: HEARTBEAT_MS,
      RAIL_ATTR: RAIL_ATTR,
      TICK_ATTR: TICK_ATTR,
      LIVE_ATTR: LIVE_ATTR,
      NEUTRAL_ATTR: NEUTRAL_ATTR,
      HOVER_ATTR: HOVER_ATTR,
      BUSY_ATTR: BUSY_ATTR,
      FRAME_ATTR: FRAME_ATTR,
      SIDE_ATTR: SIDE_ATTR,
      frameOf: frameOf,
      POLL_MS: POLL_MS,
      RESCAN_MS: RESCAN_MS,
      IDLE_HOLD_MS: IDLE_HOLD_MS,
      MIN_MARKS: MIN_MARKS,
      DEFAULTS: DEFAULTS,
      clamp: clamp,
      num: num,
      bool: bool,
      scaleFor: scaleFor,
      bandForTick: bandForTick,
      assignTicks: assignTicks,
      scoreGroup: scoreGroup,
      pickRail: pickRail,
      demoLevels: demoLevels,
      levelsFrom: levelsFrom,      cssText: cssText,
      withDefaults: withDefaults,
      themeColors: themeColors,
      createEngine: createEngine,
      readConfig: readConfig,
    };

    return module.exports;
  },
});
