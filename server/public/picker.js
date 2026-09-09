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
    if (data.type === 'ping') send('pong', {});
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
