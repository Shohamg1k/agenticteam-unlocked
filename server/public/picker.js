/**
 * Agentic Team preview overlay.
 *
 * Injected by the preview proxy into every HTML response from the user's dev
 * server. Three jobs:
 *
 *  1. Element picker — the user clicks something and we resolve it back to a
 *     source file and line, as far as we can.
 *  2. Console capture — so agents can debug what they just built.
 *  3. Network error capture — same.
 *
 * Constraints this file lives under:
 *  - It runs inside the USER'S app. It must not break it. Everything is
 *    wrapped, nothing global is replaced destructively, and every original is
 *    called through.
 *  - It is plain ES5-compatible JavaScript with no build step, because it is
 *    injected as a string into an app whose toolchain we do not control.
 *  - It talks to the parent window by postMessage only. It never calls the
 *    Agentic Team API directly — the page is untrusted, and giving it API
 *    access would hand it to whatever the app under development renders.
 */
(function () {
  'use strict';

  if (window.__agenticOverlayInstalled) return;
  window.__agenticOverlayInstalled = true;

  var MAX_TEXT = 200;
  var MAX_HTML = 800;
  var picking = false;
  var highlight = null;
  var label = null;

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function send(type, payload) {
    try {
      var message = { source: 'agentic-preview', type: type, payload: payload };
      // The app hosts this in an iframe/webview, so the parent is the app.
      if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
    } catch (err) {
      // Never let telemetry break the page being previewed.
    }
  }

  // -------------------------------------------------------------------------
  // Source resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve an element to a source location, best effort, in three layers.
   * Layer 3 always works, so the picker never hard-fails — at worst the agent
   * gets a selector to search for instead of a file and line.
   */
  function resolveSource(el) {
    var result = {};

    // Layer 1: explicit attributes, from a dev plugin (ours, or the ones
    // Vite/Next/Babel already add in development).
    var node = el;
    while (node && node !== document.documentElement) {
      var attr =
        node.getAttribute('data-agentic-source') ||
        node.getAttribute('data-source-loc') ||
        node.getAttribute('data-inspector-line') ||
        null;
      if (attr) {
        // Formats seen in the wild: "file:line:col" and "file:line".
        var parts = String(attr).split(':');
        if (parts.length >= 2) {
          result.column = parts.length >= 3 ? parseInt(parts.pop(), 10) : undefined;
          result.line = parseInt(parts.pop(), 10);
          result.file = parts.join(':');
          break;
        }
      }
      // Next.js and some Babel plugins use separate attributes.
      var f = node.getAttribute('data-inspector-relative-path');
      if (f) {
        result.file = f;
        var l = node.getAttribute('data-inspector-line');
        if (l) result.line = parseInt(l, 10);
        break;
      }
      node = node.parentElement;
    }

    // Layer 2: React fibre. In a development build the fibre carries
    // _debugSource (file/line) and the component name.
    try {
      for (var key in el) {
        if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue;
        var fiber = el[key];
        var hops = 0;
        while (fiber && hops++ < 30) {
          if (!result.file && fiber._debugSource && fiber._debugSource.fileName) {
            result.file = fiber._debugSource.fileName;
            result.line = fiber._debugSource.lineNumber;
            result.column = fiber._debugSource.columnNumber;
          }
          if (!result.componentName && typeof fiber.type === 'function') {
            result.componentName = fiber.type.displayName || fiber.type.name;
          }
          if (result.file && result.componentName) break;
          fiber = fiber._debugOwner || fiber.return;
        }
        break;
      }
    } catch (err) {
      // Not React, or a production build. Layer 3 covers it.
    }

    // Layer 3: always available.
    result.selector = cssPath(el);
    result.tagName = el.tagName.toLowerCase();
    result.className = typeof el.className === 'string' ? el.className : undefined;
    result.text = (el.textContent || '').trim().slice(0, MAX_TEXT);
    result.html = el.outerHTML ? el.outerHTML.slice(0, MAX_HTML) : undefined;
    return result;
  }

  /**
   * A CSS path specific enough to find the element again. An id short-circuits
   * it; otherwise nth-of-type keeps it unambiguous.
   */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + cssEscape(el.id);

    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var siblings = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
        }
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  // -------------------------------------------------------------------------
  // Picker UI
  // -------------------------------------------------------------------------

  function ensureChrome() {
    if (highlight) return;

    highlight = document.createElement('div');
    highlight.setAttribute('data-agentic-ui', '');
    highlight.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483646',
      'border:2px solid #6366f1',
      'background:rgba(99,102,241,0.14)',
      'border-radius:3px',
      'transition:all 40ms linear',
      'display:none',
    ].join(';');

    label = document.createElement('div');
    label.setAttribute('data-agentic-ui', '');
    label.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'background:#4338ca',
      'color:#fff',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:3px 7px',
      'border-radius:4px',
      'white-space:nowrap',
      'max-width:70vw',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      'display:none',
    ].join(';');

    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(label);
  }

  function paint(el) {
    ensureChrome();
    var rect = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    var info = resolveSource(el);
    label.style.display = 'block';
    label.textContent =
      (info.componentName ? '<' + info.componentName + '> ' : '') +
      info.tagName +
      (info.file ? '  ' + shortPath(info.file) + (info.line ? ':' + info.line : '') : '');
    // Above the element, unless that would be off-screen.
    var top = rect.top > 26 ? rect.top - 24 : rect.bottom + 4;
    label.style.left = Math.max(4, rect.left) + 'px';
    label.style.top = top + 'px';
  }

  function shortPath(file) {
    var parts = String(file).split(/[\\/]/);
    return parts.slice(-2).join('/');
  }

  function hideChrome() {
    if (highlight) highlight.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  function isOurs(el) {
    return !el || (el.getAttribute && el.getAttribute('data-agentic-ui') !== null);
  }

  function onMove(event) {
    if (!picking) return;
    var el = event.target;
    if (isOurs(el)) return;
    paint(el);
  }

  function onClick(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();

    var el = event.target;
    if (isOurs(el)) return;

    send('element-picked', resolveSource(el));
    setPicking(false);
  }

  function onKey(event) {
    if (picking && event.key === 'Escape') {
      event.preventDefault();
      setPicking(false);
      send('picker-cancelled', {});
    }
  }

  function setPicking(on) {
    picking = !!on;
    document.documentElement.style.cursor = picking ? 'crosshair' : '';
    if (!picking) hideChrome();
    send('picker-state', { picking: picking });
  }

  // Capture phase, so the picker sees the click before the app's own handlers
  // do and the app does not navigate away mid-pick.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'agentic-app') return;
    if (data.type === 'set-picking') setPicking(data.picking);
    if (data.type === 'set-annotating') setAnnotating(data.annotating, data.kind);
    if (data.type === 'set-annotations') {
      annotations = Array.isArray(data.annotations) ? data.annotations : [];
      repaintAnnotations();
    }
    if (data.type === 'ping') send('pong', {});
  });

  // -------------------------------------------------------------------------
  // Annotations
  // -------------------------------------------------------------------------

  /**
   * Drawing on the running page.
   *
   * The element picker answers "which element", and that is often not the
   * question. "This heading is too big", "these three cards should be a row",
   * "there is too much space here" are all about a REGION, and about several
   * of them at once. So: drag a box, type a note, repeat, then send the round.
   *
   * Every annotation still resolves the element under its centre, because a
   * selector is what lets the agent find the thing in source. The box is how
   * the user says it; the selector is how the agent finds it.
   *
   * Coordinates are stored in PAGE space, not viewport space, so a note stays
   * on the thing it was drawn on when the page is scrolled.
   */

  var annotating = false;
  var annotations = [];
  var layer = null;
  var draft = null;
  var dragFrom = null;

  var COLOURS = { box: '#f97316', note: '#6366f1', arrow: '#10b981' };
  var annotationKind = 'box';

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.setAttribute('data-agentic-ui', '');
    layer.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:0',
      'height:0',
      'z-index:2147483645',
      'pointer-events:none',
    ].join(';');
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  }

  function pageRectFrom(a, b) {
    var left = Math.min(a.x, b.x);
    var top = Math.min(a.y, b.y);
    return {
      x: left,
      y: top,
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function pointOf(event) {
    return {
      x: event.clientX + (window.scrollX || window.pageXOffset || 0),
      y: event.clientY + (window.scrollY || window.pageYOffset || 0),
    };
  }

  /** The element a note is about: whatever is under the middle of its box. */
  function targetUnder(rect) {
    var cx = rect.x + rect.width / 2 - (window.scrollX || window.pageXOffset || 0);
    var cy = rect.y + rect.height / 2 - (window.scrollY || window.pageYOffset || 0);
    var el = null;
    try {
      // Hide our own layer first, or every annotation resolves to itself.
      var previous = layer ? layer.style.display : null;
      if (layer) layer.style.display = 'none';
      el = document.elementFromPoint(cx, cy);
      if (layer) layer.style.display = previous;
    } catch (err) {
      return undefined;
    }
    if (!el || isOurs(el)) return undefined;
    return resolveSource(el);
  }

  function drawBox(annotation, index) {
    var box = document.createElement('div');
    box.setAttribute('data-agentic-ui', '');
    box.setAttribute('data-agentic-annotation', annotation.id);
    var colour = COLOURS[annotation.kind] || COLOURS.box;
    box.style.cssText = [
      'position:absolute',
      'left:' + annotation.rect.x + 'px',
      'top:' + annotation.rect.y + 'px',
      'width:' + annotation.rect.width + 'px',
      'height:' + annotation.rect.height + 'px',
      'border:2px solid ' + colour,
      'background:' + colour + '1f',
      'border-radius:4px',
      'pointer-events:none',
      'box-sizing:border-box',
    ].join(';');

    var badge = document.createElement('div');
    badge.setAttribute('data-agentic-ui', '');
    badge.textContent = String(index + 1);
    badge.title = annotation.text || 'Click to remove this note';
    badge.style.cssText = [
      'position:absolute',
      'left:' + annotation.rect.x + 'px',
      'top:' + Math.max(0, annotation.rect.y - 22) + 'px',
      'min-width:20px',
      'height:20px',
      'padding:0 6px',
      'border-radius:10px',
      'background:' + colour,
      'color:#fff',
      'font:600 12px/20px ui-sans-serif,system-ui,sans-serif',
      'text-align:center',
      'cursor:pointer',
      'pointer-events:auto',
      'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
    ].join(';');
    badge.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      removeAnnotation(annotation.id);
    });

    var caption = null;
    if (annotation.text) {
      caption = document.createElement('div');
      caption.setAttribute('data-agentic-ui', '');
      caption.textContent = annotation.text;
      caption.style.cssText = [
        'position:absolute',
        'left:' + annotation.rect.x + 'px',
        'top:' + (annotation.rect.y + annotation.rect.height + 4) + 'px',
        'max-width:' + Math.max(180, annotation.rect.width) + 'px',
        'padding:4px 8px',
        'border-radius:5px',
        'background:#111827',
        'color:#f9fafb',
        'font:13px/1.45 ui-sans-serif,system-ui,sans-serif',
        'pointer-events:none',
        'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
      ].join(';');
    }

    ensureLayer().appendChild(box);
    ensureLayer().appendChild(badge);
    if (caption) ensureLayer().appendChild(caption);
  }

  function repaintAnnotations() {
    if (!layer) {
      if (!annotations.length) return;
      ensureLayer();
    }
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    for (var i = 0; i < annotations.length; i++) drawBox(annotations[i], i);
    if (draft) drawBox(draft, annotations.length);
  }

  function removeAnnotation(id) {
    annotations = annotations.filter(function (a) {
      return a.id !== id;
    });
    repaintAnnotations();
    send('annotation-removed', { id: id });
  }

  /**
   * Ask for the note text.
   *
   * A DOM input rather than `window.prompt`, for two reasons that both matter:
   * `prompt` is blocked in cross-origin iframes and in some Electron
   * configurations, and it steals focus from the page in a way that changes
   * what is being annotated (a focus ring appears, a dropdown closes).
   */
  function askForNote(rect, onDone) {
    var wrap = document.createElement('div');
    wrap.setAttribute('data-agentic-ui', '');
    wrap.style.cssText = [
      'position:absolute',
      'left:' + rect.x + 'px',
      'top:' + (rect.y + rect.height + 6) + 'px',
      'z-index:2147483647',
      'display:flex',
      'gap:6px',
      'align-items:center',
      'padding:6px',
      'border-radius:8px',
      'background:#111827',
      'box-shadow:0 4px 16px rgba(0,0,0,0.45)',
      'pointer-events:auto',
    ].join(';');

    var input = document.createElement('input');
    input.setAttribute('data-agentic-ui', '');
    input.type = 'text';
    input.placeholder = 'What should change here?';
    input.style.cssText = [
      'width:280px',
      'padding:6px 8px',
      'border:1px solid #374151',
      'border-radius:5px',
      'background:#1f2937',
      'color:#f9fafb',
      'font:13px/1.4 ui-sans-serif,system-ui,sans-serif',
      'outline:none',
    ].join(';');

    var save = document.createElement('button');
    save.setAttribute('data-agentic-ui', '');
    save.type = 'button';
    save.textContent = 'Add';
    save.style.cssText = [
      'padding:6px 12px',
      'border:0',
      'border-radius:5px',
      'background:#6366f1',
      'color:#fff',
      'font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif',
      'cursor:pointer',
    ].join(';');

    function finish(text) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      onDone(text);
    }

    save.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      finish(input.value);
    });
    input.addEventListener('keydown', function (event) {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    });

    wrap.appendChild(input);
    wrap.appendChild(save);
    ensureLayer().appendChild(wrap);
    // The page may steal focus during layout; a frame's delay is enough.
    setTimeout(function () {
      try {
        input.focus();
      } catch (err) {
        /* focus is a nicety, not a requirement */
      }
    }, 0);
  }

  function onAnnotateDown(event) {
    if (!annotating || isOurs(event.target)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragFrom = pointOf(event);
    draft = { id: 'draft', kind: annotationKind, text: '', rect: pageRectFrom(dragFrom, dragFrom) };
    repaintAnnotations();
  }

  function onAnnotateMove(event) {
    if (!annotating || !dragFrom) return;
    event.preventDefault();
    draft.rect = pageRectFrom(dragFrom, pointOf(event));
    repaintAnnotations();
  }

  function onAnnotateUp(event) {
    if (!annotating || !dragFrom) return;
    event.preventDefault();
    event.stopPropagation();

    var rect = pageRectFrom(dragFrom, pointOf(event));
    dragFrom = null;

    // A click rather than a drag: annotate the element that was clicked, at its
    // own size. Requiring a deliberate drag to leave a note would make the
    // common case — "this button" — the awkward one.
    if (rect.width < 8 || rect.height < 8) {
      var el = document.elementFromPoint(
        rect.x - (window.scrollX || window.pageXOffset || 0),
        rect.y - (window.scrollY || window.pageYOffset || 0),
      );
      if (el && !isOurs(el)) {
        var box = el.getBoundingClientRect();
        rect = {
          x: box.left + (window.scrollX || window.pageXOffset || 0),
          y: box.top + (window.scrollY || window.pageYOffset || 0),
          width: box.width,
          height: box.height,
        };
      }
    }

    draft = { id: 'draft', kind: annotationKind, text: '', rect: rect };
    repaintAnnotations();

    askForNote(rect, function (text) {
      draft = null;
      if (text === null) {
        repaintAnnotations();
        return;
      }
      var annotation = {
        id: 'an_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: annotationKind,
        text: text || '',
        rect: rect,
        target: targetUnder(rect),
        pageUrl: location.pathname + location.search,
        createdAt: Date.now(),
      };
      annotations.push(annotation);
      repaintAnnotations();
      send('annotation-added', annotation);
    });
  }

  function setAnnotating(on, kind) {
    annotating = !!on;
    if (kind) annotationKind = kind;
    dragFrom = null;
    draft = null;
    document.documentElement.style.cursor = annotating ? 'crosshair' : '';
    if (annotating) {
      // Picking and annotating both own the pointer; one of them has to yield.
      setPicking(false);
      // Text selection while dragging a box makes the whole page flash blue.
      document.documentElement.style.userSelect = 'none';
    } else {
      document.documentElement.style.userSelect = '';
    }
    repaintAnnotations();
    send('annotate-state', { annotating: annotating, kind: annotationKind });
  }

  document.addEventListener('mousedown', onAnnotateDown, true);
  document.addEventListener('mousemove', onAnnotateMove, true);
  document.addEventListener('mouseup', onAnnotateUp, true);

  // Annotations are absolutely positioned in page space, so scrolling needs no
  // repaint — but a resize reflows the page under them, and a stale box then
  // points at nothing.
  window.addEventListener('resize', function () {
    if (annotations.length) repaintAnnotations();
  });

  // -------------------------------------------------------------------------
  // Console capture
  // -------------------------------------------------------------------------

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(stringify(arguments[i]));
        send('console', { level: level, text: parts.join(' '), ts: Date.now() });
      } catch (err) {
        // Never let capture break logging.
      }
      // The app's own console must keep working exactly as before.
      return original.apply(console, arguments);
    };
  });

  function stringify(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  window.addEventListener('error', function (event) {
    send('console', {
      level: 'error',
      text: event.message + (event.error && event.error.stack ? '\n' + event.error.stack : ''),
      source: event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : undefined,
      ts: Date.now(),
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    send('console', {
      level: 'error',
      text: 'Unhandled promise rejection: ' + stringify(event.reason),
      ts: Date.now(),
    });
  });

  // -------------------------------------------------------------------------
  // Network capture — failures only
  // -------------------------------------------------------------------------

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || 'GET';
      var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      return originalFetch.apply(window, arguments).then(
        function (response) {
          if (!response.ok) send('network-error', { url: url, method: method, status: response.status, ts: Date.now() });
          return response;
        },
        function (err) {
          send('network-error', { url: url, method: method, status: 0, ts: Date.now() });
          throw err;
        },
      );
    };
  }

  var OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    var open = OriginalXHR.prototype.open;
    var xhrSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function (method, url) {
      this.__agenticMethod = method;
      this.__agenticUrl = url;
      return open.apply(this, arguments);
    };
    OriginalXHR.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        if (xhr.status >= 400) {
          send('network-error', {
            url: xhr.__agenticUrl,
            method: xhr.__agenticMethod || 'GET',
            status: xhr.status,
            ts: Date.now(),
          });
        }
      });
      xhr.addEventListener('error', function () {
        send('network-error', { url: xhr.__agenticUrl, method: xhr.__agenticMethod || 'GET', status: 0, ts: Date.now() });
      });
      return xhrSend.apply(this, arguments);
    };
  }

  send('overlay-ready', { url: location.href });
})();
