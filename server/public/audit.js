/**
 * The visual audit.
 *
 * Evaluated inside a rendered page and returns findings as JSON. This is the
 * check that exists because every other gate passed a calculator whose grid had
 * a hole in it: the `=` key had been pushed into the wrong cell, the `.` was
 * orphaned on a row of its own, and the syntax parser, the secret scan and the
 * project's own test suite all said the work was fine. It rendered. It was
 * wrong. Nothing in the system could tell the difference.
 *
 * What this can and cannot do is worth being honest about. It cannot judge
 * whether a design is good — that is taste, and a machine asserting taste would
 * produce noise that people learn to ignore. It checks only things that are
 * objectively broken: content that does not fit, elements on top of each other,
 * controls with no area to click, text clipped mid-word, holes in a grid.
 *
 * Every finding therefore has to survive one question: could a competent person
 * look at this and say "yes, that is deliberate"? Where the answer is ever
 * plausibly yes, it is a warning. Where it is no, it is an error and the task
 * gets sent back with it.
 *
 * Plain ES5-compatible JavaScript with no build step, because it is evaluated
 * as a string in a page whose toolchain we do not control.
 */
(function () {
  'use strict';

  var MAX_PER_CHECK = 8;
  var findings = [];

  function add(check, severity, selector, message, detail) {
    findings.push({
      check: check,
      severity: severity,
      selector: selector,
      message: message,
      detail: detail || undefined,
    });
  }

  function countFor(check) {
    var n = 0;
    for (var i = 0; i < findings.length; i++) if (findings[i].check === check) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Element helpers
  // -------------------------------------------------------------------------

  /** A short, readable path to an element, for the repair prompt. */
  function describe(el) {
    if (!el || el === document.documentElement) return 'html';
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      var cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
      if (cls) part += '.' + cls;
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /** Text of an element, trimmed, for identifying which one it is. */
  function label(el) {
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
  }

  function isOurs(el) {
    return Boolean(el && el.getAttribute && el.getAttribute('data-agentic-ui') !== null);
  }

  function styleOf(el) {
    try {
      return window.getComputedStyle(el);
    } catch (err) {
      return null;
    }
  }

  /**
   * Is this element actually on the page right now?
   *
   * The ANCESTOR walk is the part that matters, and its absence failed real
   * work: the close and add buttons of a popover that was closed were reported
   * as "0x0px, no clickable area". They were nothing of the sort — they were
   * inside a container that was not open yet. `getComputedStyle` on a child of
   * a hidden parent still reports the child's own `display`, so asking only
   * about the element says "visible" about something nobody can see.
   *
   * `offsetParent` is null for anything inside a `display:none` subtree, which
   * settles it in one property for the common case; `position: fixed` has a
   * null `offsetParent` legitimately, so that is checked separately.
   */
  function isRendered(el) {
    var style = styleOf(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;

    if (el.offsetParent === null && style.position !== 'fixed') {
      // Either inside a hidden subtree, or detached. Both mean "not on screen".
      if (el !== document.body && el !== document.documentElement) return false;
    }

    // The explicit ways a container says "not yet": the hidden attribute, an
    // aria-hidden region, a closed dialog or details element.
    var node = el;
    var depth = 0;
    while (node && node !== document.documentElement && depth < 12) {
      if (node.hasAttribute && node.hasAttribute('hidden')) return false;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if ((tag === 'dialog' || tag === 'details') && !node.open) return false;
      var s2 = styleOf(node);
      if (s2 && (s2.display === 'none' || s2.visibility === 'hidden')) return false;
      node = node.parentElement;
      depth++;
    }

    return true;
  }

  /**
   * Is this element hidden on purpose, in one of the standard ways?
   *
   * A visually-hidden label is 1px, clipped and off-screen — which is exactly
   * what several of these checks look for. Flagging the accessibility
   * technique as a layout bug would be a bad joke.
   */
  function isDeliberatelyHidden(el) {
    var style = styleOf(el);
    if (!style) return false;
    // The two ways the visually-hidden pattern is actually written.
    if (style.clipPath && style.clipPath !== 'none') return true;
    if (style.clip && style.clip !== 'auto') return true;
    if (el.classList) {
      for (var i = 0; i < el.classList.length; i++) {
        if (/^(sr-only|visually-hidden|screen-reader|a11y-hidden)/i.test(el.classList[i])) return true;
      }
    }
    return false;
  }

  function isVisuallyHidden(el) {
    if (isDeliberatelyHidden(el)) return true;
    var rect = el.getBoundingClientRect();
    // Note: SIZE alone only counts here. The unclickable check deliberately
    // does not use this function, because "it is tiny" is the thing it is
    // looking for — treating tiny as intentional would make it find nothing.
    return rect.width <= 1 && rect.height <= 1;
  }

  function visibleElements() {
    var all = document.body ? document.body.querySelectorAll('*') : [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (isOurs(el)) continue;
      if (!isRendered(el)) continue;
      out.push(el);
    }
    return out;
  }

  var INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]';

  // -------------------------------------------------------------------------
  // 1. Horizontal overflow
  // -------------------------------------------------------------------------

  /**
   * The page is wider than the window.
   *
   * The single most common visible defect in generated pages, and the one users
   * describe as "it's broken on my phone". Reported with the widest offenders,
   * because "something overflows" is not actionable and "this element is 412px
   * wide in a 320px viewport" is.
   */
  function checkHorizontalOverflow() {
    var docWidth = document.documentElement.clientWidth;
    var scrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
    );

    if (scrollWidth <= docWidth + 1) return;

    var culprits = [];
    var els = visibleElements();
    for (var i = 0; i < els.length; i++) {
      var rect = els[i].getBoundingClientRect();
      if (rect.width === 0) continue;
      var overhang = rect.right - docWidth;
      if (overhang > 2) culprits.push({ el: els[i], overhang: overhang, rect: rect });
    }

    culprits.sort(function (a, b) {
      return b.overhang - a.overhang;
    });

    add(
      'horizontal-overflow',
      'error',
      'html',
      'The page scrolls sideways: its content is ' +
        Math.round(scrollWidth) +
        'px wide in a ' +
        docWidth +
        'px viewport.',
      culprits.length
        ? 'Widest offenders: ' +
          culprits
            .slice(0, 3)
            .map(function (c) {
              return describe(c.el) + ' (' + Math.round(c.rect.width) + 'px, ' + Math.round(c.overhang) + 'px past the edge)';
            })
            .join('; ')
        : undefined,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Grid holes
  // -------------------------------------------------------------------------

  function trackSizes(value) {
    if (!value || value === 'none') return [];
    var sizes = [];
    var parts = value.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var n = parseFloat(parts[i]);
      if (!isNaN(n)) sizes.push(n);
    }
    return sizes;
  }

  /**
   * An empty cell in the middle of a grid.
   *
   * This is the check that would have caught the calculator. One key given
   * `grid-column: span 2` silently reflows every key after it, leaving a hole
   * and pushing the last item onto a row of its own. Nothing errors. The page
   * renders. It is visibly wrong and no other gate can see it.
   *
   * Only INTERIOR holes are reported. A trailing empty cell is what every
   * partially-filled last row looks like and is completely normal.
   */
  function checkGridHoles() {
    var els = document.body ? document.body.querySelectorAll('*') : [];

    for (var i = 0; i < els.length; i++) {
      if (countFor('grid-hole') >= MAX_PER_CHECK) return;

      var container = els[i];
      if (isOurs(container) || !isRendered(container)) continue;

      var style = styleOf(container);
      if (!style || (style.display !== 'grid' && style.display !== 'inline-grid')) continue;

      var cols = trackSizes(style.gridTemplateColumns);
      var rows = trackSizes(style.gridTemplateRows);
      if (cols.length < 2 || rows.length < 2) continue;

      // Children that participate in grid placement. Absolutely positioned
      // children are out of flow and occupy no cell.
      var children = [];
      for (var c = 0; c < container.children.length; c++) {
        var child = container.children[c];
        if (isOurs(child) || !isRendered(child)) continue;
        var childStyle = styleOf(child);
        if (!childStyle || childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
        children.push(child);
      }
      if (children.length < 4) continue;

      var box = container.getBoundingClientRect();
      var colGap = parseFloat(style.columnGap) || 0;
      var rowGap = parseFloat(style.rowGap) || 0;
      var padLeft = parseFloat(style.paddingLeft) || 0;
      var padTop = parseFloat(style.paddingTop) || 0;
      var borderLeft = parseFloat(style.borderLeftWidth) || 0;
      var borderTop = parseFloat(style.borderTopWidth) || 0;

      // Cell centres, in viewport coordinates.
      var xs = [];
      var x = box.left + borderLeft + padLeft;
      for (var cx = 0; cx < cols.length; cx++) {
        xs.push(x + cols[cx] / 2);
        x += cols[cx] + colGap;
      }
      var ys = [];
      var y = box.top + borderTop + padTop;
      for (var cy = 0; cy < rows.length; cy++) {
        ys.push(y + rows[cy] / 2);
        y += rows[cy] + rowGap;
      }

      // Occupancy by geometry rather than by computed placement: an
      // auto-placed item keeps `grid-row-start: auto` in its computed style, so
      // the placement properties cannot be read back. Where the item actually
      // IS can be.
      var occupied = [];
      for (var r = 0; r < ys.length; r++) {
        occupied.push([]);
        for (var q = 0; q < xs.length; q++) occupied[r].push(false);
      }

      for (var k = 0; k < children.length; k++) {
        var rect = children[k].getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        for (var rr = 0; rr < ys.length; rr++) {
          for (var qq = 0; qq < xs.length; qq++) {
            if (
              xs[qq] >= rect.left - 1 &&
              xs[qq] <= rect.right + 1 &&
              ys[rr] >= rect.top - 1 &&
              ys[rr] <= rect.bottom + 1
            ) {
              occupied[rr][qq] = true;
            }
          }
        }
      }

      // Flatten row-major, then look for a gap with something after it.
      var flat = [];
      for (var fr = 0; fr < occupied.length; fr++) {
        for (var fq = 0; fq < occupied[fr].length; fq++) {
          flat.push({ filled: occupied[fr][fq], row: fr + 1, col: fq + 1 });
        }
      }
      var lastFilled = -1;
      for (var f = flat.length - 1; f >= 0; f--) {
        if (flat[f].filled) {
          lastFilled = f;
          break;
        }
      }
      var holes = [];
      for (var h = 0; h < lastFilled; h++) if (!flat[h].filled) holes.push(flat[h]);

      if (holes.length) {
        add(
          'grid-hole',
          'error',
          describe(container),
          'This grid has ' +
            holes.length +
            ' empty cell' +
            (holes.length === 1 ? '' : 's') +
            ' in the middle of it, so the items after the gap are in the wrong place.',
          'Empty: ' +
            holes
              .slice(0, 6)
              .map(function (p) {
                return 'row ' + p.row + ' column ' + p.col;
              })
              .join(', ') +
            '. The grid is ' +
            cols.length +
            ' columns by ' +
            rows.length +
            ' rows with ' +
            children.length +
            ' items. Check every `span` — one spanning item reflows everything after it.',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Overlapping content
  // -------------------------------------------------------------------------

  /**
   * Two siblings sitting on top of each other.
   *
   * Restricted to siblings that are both in normal flow, because overlap is the
   * entire point of absolute and fixed positioning, and of a deliberate
   * negative margin. What is left is the case where a layout has collapsed.
   */
  function checkOverlap() {
    var containers = document.body ? document.body.querySelectorAll('*') : [];

    for (var i = 0; i < containers.length; i++) {
      if (countFor('overlap') >= MAX_PER_CHECK) return;

      var kids = [];
      for (var c = 0; c < containers[i].children.length; c++) {
        var child = containers[i].children[c];
        if (isOurs(child) || !isRendered(child) || isVisuallyHidden(child)) continue;
        var style = styleOf(child);
        if (!style) continue;
        if (style.position !== 'static' && style.position !== 'relative') continue;
        if (style.float !== 'none') continue;
        // A negative margin is a deliberate overlap.
        if (
          parseFloat(style.marginTop) < 0 ||
          parseFloat(style.marginLeft) < 0 ||
          parseFloat(style.marginBottom) < 0 ||
          parseFloat(style.marginRight) < 0
        ) {
          continue;
        }
        var rect = child.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        kids.push({ el: child, rect: rect });
      }

      for (var a = 0; a < kids.length; a++) {
        for (var b = a + 1; b < kids.length; b++) {
          var r1 = kids[a].rect;
          var r2 = kids[b].rect;
          var overlapW = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
          var overlapH = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
          if (overlapW <= 2 || overlapH <= 2) continue;

          // Ignore a token overlap from rounding or a shared border.
          var area = overlapW * overlapH;
          var smaller = Math.min(r1.width * r1.height, r2.width * r2.height);
          if (area / smaller < 0.25) continue;

          add(
            'overlap',
            'error',
            describe(kids[a].el),
            'Two elements are drawn on top of each other: ' +
              describe(kids[a].el) +
              ' and ' +
              describe(kids[b].el) +
              '.',
            'They overlap by ' +
              Math.round(overlapW) +
              '×' +
              Math.round(overlapH) +
              'px. Both are in normal flow, so this is a collapsed layout rather than deliberate stacking.',
          );
          if (countFor('overlap') >= MAX_PER_CHECK) return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Controls with no area
  // -------------------------------------------------------------------------

  /** A button nobody can press, because it has no size. */
  function checkUnclickable() {
    var controls = document.body ? document.body.querySelectorAll(INTERACTIVE) : [];

    for (var i = 0; i < controls.length; i++) {
      if (countFor('unclickable') >= MAX_PER_CHECK) return;

      var el = controls[i];
      if (isOurs(el) || isDeliberatelyHidden(el)) continue;
      if (el.disabled) continue;
      if (el.type === 'hidden') continue;
      if (!isRendered(el)) continue;

      var rect = el.getBoundingClientRect();
      if (rect.width >= 4 && rect.height >= 4) continue;

      add(
        'unclickable',
        'error',
        describe(el),
        'This control has no clickable area (' +
          Math.round(rect.width) +
          '×' +
          Math.round(rect.height) +
          'px).' +
          (label(el) ? ' Its text is "' + label(el) + '".' : ''),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. Clipped text
  // -------------------------------------------------------------------------

  /**
   * Text cut off mid-word with no ellipsis.
   *
   * A deliberate truncation uses `text-overflow: ellipsis`, so the presence of
   * one is taken as the author having thought about it. What is left is text
   * silently disappearing.
   */
  function checkClippedText() {
    var els = visibleElements();

    for (var i = 0; i < els.length; i++) {
      if (countFor('clipped-text') >= MAX_PER_CHECK) return;

      var el = els[i];
      if (!el.textContent || !el.textContent.trim()) continue;
      // Only leaf-ish elements: a container's scrollWidth reflects its children.
      if (el.children.length > 0) continue;
      // A visually-hidden label is clipped BY DESIGN. Flagging the standard
      // screen-reader technique as a layout bug would be a bad joke, and it is
      // the false positive this check is most likely to produce.
      if (isVisuallyHidden(el)) continue;

      var style = styleOf(el);
      if (!style) continue;
      if (style.overflow === 'visible' && style.overflowX === 'visible') continue;
      if (style.textOverflow === 'ellipsis') continue;
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;

      if (el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0) {
        add(
          'clipped-text',
          'warning',
          describe(el),
          'Text is cut off here with no ellipsis: needs ' +
            el.scrollWidth +
            'px, has ' +
            el.clientWidth +
            'px.',
          label(el) ? 'The text is "' + label(el) + '".' : undefined,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. Invisible text
  // -------------------------------------------------------------------------

  function parseColour(value) {
    var m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    var parts = m[1].split(',').map(function (p) {
      return parseFloat(p);
    });
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function luminance(c) {
    var channel = function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  function contrastRatio(fg, bg) {
    var l1 = luminance(fg);
    var l2 = luminance(bg);
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Did we find a real background, or fall back to assuming white?
   *
   * The fallback exists so the check can say something about a plain page, but
   * on a themed one it is a guess — and a guess about the background is a guess
   * about whether the text is readable, which is the entire finding.
   */
  function hasResolvedBackground(el) {
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 20) {
      var style = styleOf(node);
      if (style) {
        if (style.backgroundImage && style.backgroundImage !== 'none') return false;
        var bg = parseColour(style.backgroundColor);
        if (bg && bg.a > 0.9) return true;
      }
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  /** The first ancestor with a background you can actually see. */
  function effectiveBackground(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var style = styleOf(node);
      if (style) {
        var bg = parseColour(style.backgroundColor);
        if (bg && bg.a > 0.9) return bg;
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      }
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  /**
   * Text you cannot read against its own background.
   *
   * The threshold is 2.0, well below the WCAG minimum of 4.5, and that is
   * deliberate. This is not an accessibility audit — it is a check for text
   * that has effectively vanished, usually because a colour was set without its
   * background being considered, or a dark theme was half-applied. Auditing to
   * 4.5 here would bury the black-on-black case in a hundred style opinions.
   */
  function checkInvisibleText() {
    var els = visibleElements();

    for (var i = 0; i < els.length; i++) {
      if (countFor('invisible-text') >= MAX_PER_CHECK) return;

      var el = els[i];
      if (el.children.length > 0) continue;
      var text = (el.textContent || '').trim();
      if (!text) continue;
      if (isVisuallyHidden(el)) continue;

      var style = styleOf(el);
      if (!style) continue;
      var fg = parseColour(style.color);
      var bg = effectiveBackground(el);
      if (!fg || !bg || fg.a < 0.1) continue;

      var ratio = contrastRatio(fg, bg);

      /**
       * Only when the background is genuinely known.
       *
       * `effectiveBackground` walks up for the first opaque colour and gives up
       * on a gradient or an image, and a wrong answer here reads as
       * "unreadable" about text a person can see perfectly well. Every day
       * number in a calendar was reported as black-on-black because of it.
       *
       * So: skip anything whose own colours are inherited through a background
       * this cannot resolve, and skip the element if it is smaller than real
       * text — a 0-size node has no colours worth judging.
       */
      var box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      if (!hasResolvedBackground(el)) continue;

      if (ratio < 2.0) {
        add(
          'invisible-text',
          'error',
          describe(el),
          'This text is unreadable against its background (contrast ' + ratio.toFixed(2) + ':1).',
          'Text "' + label(el) + '" in ' + style.color + ' on ' + 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. An empty page
  // -------------------------------------------------------------------------

  /**
   * Nothing rendered at all.
   *
   * A blank page is the loudest possible failure and the easiest one to miss in
   * a pipeline: the file parses, the server serves it, and there is nothing on
   * it — a script threw before it built the DOM, or the markup went in the
   * wrong file.
   */
  function checkNotEmpty() {
    if (!document.body) {
      add('empty-page', 'error', 'html', 'The page has no body element.');
      return;
    }
    var text = (document.body.innerText || '').trim();
    var visual = document.body.querySelectorAll('img, svg, canvas, video, input, button, iframe');
    if (text.length < 2 && visual.length === 0) {
      add(
        'empty-page',
        'error',
        'body',
        'The page rendered blank: no text and no visual elements.',
        'Either a script failed before building the DOM, or the markup is not in the file being served.',
      );
    }
  }

  // -------------------------------------------------------------------------

  try {
    checkNotEmpty();
    // Everything below assumes there is a page to look at.
    if (!findings.length || findings[0].check !== 'empty-page') {
      checkHorizontalOverflow();
      checkGridHoles();
      checkOverlap();
      checkUnclickable();
      checkClippedText();
      checkInvisibleText();
    }
  } catch (err) {
    findings.push({
      check: 'audit-failed',
      severity: 'warning',
      selector: 'html',
      message: 'The visual audit could not complete: ' + (err && err.message ? err.message : String(err)),
    });
  }

  return {
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    title: document.title,
    findings: findings,
  };
})();
