/*!
 * Mattccessibility Tool v1.4.0 - Audit Engine (engine.js)
 *
 * Concatenated (before overlays.js) into content/audit-runner.js and injected
 * after lib/axe.min.js in the ISOLATED world. May be injected more than once,
 * hence the load guard and no top-level const/let/class.
 *
 * Public API (CONTRACT section 2):
 *   window.__runWcagAudit(options?)                 -> Promise<AuditResult>
 *   window.__auditforgeIsExtensionElement(el)       -> boolean
 *   window.__auditforgeAnalyzeMobileLayout(win?)    -> MobileAnalysis
 *   window.__auditforgeContrast                     -> { parseColor, relativeLuminance,
 *                                                       getContrastRatio, calculateColorContrastFix }
 *   window.__auditforgeComputeTabOrder()            -> TabOrderResult (live, CONTRACT 10.2)
 *   window.__auditforgeComputeSpeechSequence(opts?) -> { sequence, barrierCount } (live, CONTRACT 10.2)
 */
(() => {
  if (window.__auditforgeEngineLoaded) return;
  window.__auditforgeEngineLoaded = true;

  /* ======================================================================
   * Constants
   * ==================================================================== */
  const TOOL_VERSION = '1.4.0';
  const WCAG_22_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
  const HOVER_ATTR = 'data-af-hover-sim';
  const HOVER_STYLE_ID = '__auditforge_hover_sim__';
  const FREEZE_STYLE_ID = '__auditforge_hover_freeze__';
  const CAPS = {
    hover: 400, overlapCandidates: 600, interactive: 600, nodesPerViolation: 50,
    srSequence: 300, tabSequence: 500, links: 500, overlaps: 50, overflows: 50,
    touchFailures: 100, crowding: 50, walk: 20000, headings: 200, landmarks: 100,
    silent: 200, ariaCandidates: 2000, hoverRules: 3000, fixedWidth: 20
  };
  const DEVICES = [
    { id: 'iphone-16-pro', name: 'Apple iPhone 16 / 15 Pro', width: 393, height: 852 },
    { id: 'iphone-se', name: 'Apple iPhone SE', width: 375, height: 667 },
    { id: 'galaxy-s24', name: 'Samsung Galaxy S24', width: 360, height: 780 },
    { id: 'pixel-8', name: 'Google Pixel 8', width: 412, height: 915 },
    { id: 'iphone-16-pro-max', name: 'Apple iPhone 16 Pro Max', width: 430, height: 932 }
  ];
  const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  /**
   * WCAG-only policy: nothing that is merely "best practice" is logged. A finding must map to a WCAG 2.x
   * Level A or AA success criterion (WCAG 2.2 set; 4.1.1 kept for 2.0/2.1 conformance claims).
   */
  const WCAG_A_AA_SC = new Set(['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5',
    '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2',
    '2.3.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.11', '2.5.1', '2.5.2', '2.5.3', '2.5.4', '2.5.7',
    '2.5.8', '3.1.1', '3.1.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6', '3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.7', '3.3.8',
    '4.1.1', '4.1.2', '4.1.3']);
  /** axe result qualifies only if it carries an A/AA level tag and is not tagged best-practice. */
  const isWcagAxeResult = (r) => {
    const tags = (r && r.tags) || [];
    return tags.indexOf('best-practice') === -1 && tags.some((t) => WCAG_22_TAGS.indexOf(t) !== -1);
  };
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);

  /* ======================================================================
   * Small utilities
   * ==================================================================== */
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const round = (n, d) => { if (typeof n !== 'number' || !isFinite(n)) return 0; const f = Math.pow(10, d || 0); return Math.round(n * f) / f; };
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const errMsg = (e) => (e && (e.message || String(e))) || 'Unknown error';
  const loose = (s) => norm(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
  const hasAlnum = (s) => /[\p{L}\p{N}]/u.test(String(s || ''));
  const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function jsonClean(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'number' && !isFinite(v) ? 0 : v)));
  }

  function outerHtml(el) {
    try { return trunc(el.outerHTML || '', 400); } catch (e) { return ''; }
  }

  /** Opening tag of an element with one attribute added or replaced (no cloning, so no network fetches). */
  function startTagWith(el, attr, value) {
    let tag = '';
    try { const h = el.outerHTML || ''; const i = h.indexOf('>'); tag = i > -1 ? h.slice(0, i + 1) : '<' + el.localName + '>'; } catch (e) { tag = '<' + el.localName + '>'; }
    if (tag.length > 300) tag = '<' + el.localName + '>';
    const esc = String(value).replace(/"/g, '&quot;');
    const re = new RegExp('\\s' + attr.replace(/[-]/g, '\\-') + '(=("[^"]*"|\'[^\']*\'|[^\\s>]*))?', 'i');
    if (attr && re.test(tag)) tag = tag.replace(re, value === null ? '' : ' ' + attr + '="' + esc + '"');
    else if (attr && value !== null) tag = tag.replace(/\s*\/?>$/, (m) => ' ' + attr + '="' + esc + '"' + (m.trim() === '/>' ? ' />' : '>'));
    const voids = /^(img|input|br|hr|meta|link|area|source|wbr|col|embed|track)$/;
    return voids.test(el.localName) ? tag : tag + '…</' + el.localName + '>';
  }

  /* ======================================================================
   * Extension-element guard
   * ==================================================================== */
  function hasExtToken(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
    const id = el.getAttribute('id');
    if (id && (id.startsWith('__auditforge_') || id.startsWith('__af_'))) return true;
    const cls = el.getAttribute('class');
    if (cls && (cls.indexOf('__auditforge_') !== -1 || cls.indexOf('__af_') !== -1)) {
      const toks = cls.split(/\s+/);
      for (let i = 0; i < toks.length; i++) if (toks[i].startsWith('__auditforge_') || toks[i].startsWith('__af_')) return true;
    }
    return false;
  }
  function isExtensionElement(el) {
    try {
      let n = el;
      while (n && n.nodeType !== 9) {
        if (n.nodeType === 1 && hasExtToken(n)) return true;
        n = n.nodeType === 11 ? n.host : n.parentNode;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function findExtensionRoots(doc) {
    const out = [];
    try {
      doc.querySelectorAll('[id^="__auditforge_"],[id^="__af_"],[class*="__auditforge_"],[class*="__af_"]').forEach((el) => {
        if (!hasExtToken(el)) return;
        let p = el.parentElement, nested = false;
        while (p) { if (hasExtToken(p)) { nested = true; break; } p = p.parentElement; }
        if (!nested) out.push(el);
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ======================================================================
   * Colour maths (__auditforgeContrast)
   * ==================================================================== */
  const NAMED_COLORS = {
    black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
    gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], yellow: [255, 255, 0],
    orange: [255, 165, 0], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128],
    maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
    cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255]
  };
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  let canvasCtx = null;

  function canvasParse(s) {
    try {
      if (typeof document === 'undefined') return null;
      if (!canvasCtx) {
        const c = document.createElement('canvas'); c.width = 1; c.height = 1;
        canvasCtx = c.getContext('2d', { willReadFrequently: true });
      }
      if (!canvasCtx) return null;
      canvasCtx.fillStyle = '#010203';
      canvasCtx.fillStyle = s;
      if (canvasCtx.fillStyle === '#010203' && s.replace(/\s/g, '') !== '#010203') return null;
      canvasCtx.clearRect(0, 0, 1, 1);
      canvasCtx.fillRect(0, 0, 1, 1);
      const d = canvasCtx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: round(d[3] / 255, 3) };
    } catch (e) { return null; }
  }
  const c255 = (v) => clampN(v, 0, 255);
  function parseChannel(tok) {
    if (tok === 'none') return 0;
    if (tok.endsWith('%')) return c255(parseFloat(tok) * 2.55);
    return c255(parseFloat(tok));
  }
  function parseAlpha(tok) {
    if (tok == null) return 1;
    const v = tok.endsWith('%') ? parseFloat(tok) / 100 : parseFloat(tok);
    return isNaN(v) ? 1 : clampN(v, 0, 1);
  }

  /** Parses CSS colour strings (hex, rgb[a], named, transparent; anything else via canvas) -> {r,g,b,a} | null. */
  function parseColor(input) {
    if (input == null) return null;
    if (typeof input === 'object') {
      if ('r' in input && 'g' in input && 'b' in input) {
        return { r: c255(+input.r || 0), g: c255(+input.g || 0), b: c255(+input.b || 0), a: input.a == null ? 1 : clampN(+input.a, 0, 1) };
      }
      return null;
    }
    const s = String(input).trim().toLowerCase();
    if (!s) return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (s[0] === '#') {
      let h = s.slice(1);
      if (!/^[0-9a-f]+$/.test(h)) return null;
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? round(parseInt(h.slice(6, 8), 16) / 255, 3) : 1
      };
    }
    const m = s.match(/^rgba?\(\s*([^)]*)\)$/);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const c = { r: parseChannel(parts[0]), g: parseChannel(parts[1]), b: parseChannel(parts[2]), a: parseAlpha(parts[3]) };
      if (isNaN(c.r) || isNaN(c.g) || isNaN(c.b)) return null;
      return c;
    }
    if (NAMED_COLORS[s]) { const v = NAMED_COLORS[s]; return { r: v[0], g: v[1], b: v[2], a: 1 }; }
    return canvasParse(s);
  }
  function blend(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function mix(c, t, k) { return { r: c.r + (t.r - c.r) * k, g: c.g + (t.g - c.g) * k, b: c.b + (t.b - c.b) * k, a: 1 }; }
  function toHex(c) {
    const h = (v) => Math.round(c255(v)).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }
  function chanLum(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  /** WCAG relative luminance (0..1). Accepts a colour string or {r,g,b}. Alpha is ignored. */
  function relativeLuminance(color) {
    const c = parseColor(color);
    if (!c) return 0;
    return 0.2126 * chanLum(c.r) + 0.7152 * chanLum(c.g) + 0.0722 * chanLum(c.b);
  }
  function ratioRaw(fgC, bgC) {
    const bg = bgC.a < 1 ? blend(bgC, WHITE) : bgC;
    const fg = fgC.a < 1 ? blend(fgC, bg) : fgC;
    const l1 = relativeLuminance(fg), l2 = relativeLuminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  /** Contrast ratio (1..21, full precision). Translucent fg is composited over bg; translucent bg over white. null if unparsable. */
  function getContrastRatio(fg, bg) {
    const f = parseColor(fg), b = parseColor(bg);
    if (!f || !b) return null;
    return ratioRaw(f, b);
  }
  /**
   * Finds the smallest change to `fg` (mixing towards black or white) that reaches `targetRatio` on `bg`.
   * Returns { color, ratio, original, originalRatio, background, target, changed, passes }.
   */
  function calculateColorContrastFix(fg, bg, targetRatio) {
    const target = typeof targetRatio === 'number' && targetRatio > 1 ? targetRatio : 4.5;
    let b = parseColor(bg) || WHITE; if (b.a < 1) b = blend(b, WHITE);
    let f = parseColor(fg) || BLACK; if (f.a < 1) f = blend(f, b);
    const current = ratioRaw(f, b);
    const base = { original: toHex(f), originalRatio: round(current, 2), background: toHex(b), target };
    if (current >= target) return Object.assign(base, { color: toHex(f), ratio: round(current, 2), changed: false, passes: true });
    const goal = target + 0.02;
    let best = null;
    [BLACK, WHITE].forEach((toward) => {
      if (ratioRaw(toward, b) < target) return;
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ratioRaw(mix(f, toward, mid), b) >= goal) hi = mid; else lo = mid; }
      let k = hi; let c = parseColor(toHex(mix(f, toward, k)));
      while (ratioRaw(c, b) < target && k < 1) { k = Math.min(1, k + 0.01); c = parseColor(toHex(mix(f, toward, k))); }
      if (ratioRaw(c, b) >= target && (!best || k < best.k)) best = { k, c };
    });
    if (!best) {
      const c = ratioRaw(BLACK, b) >= ratioRaw(WHITE, b) ? BLACK : WHITE;
      const r = ratioRaw(c, b);
      return Object.assign(base, { color: toHex(c), ratio: round(r, 2), changed: true, passes: r >= target });
    }
    const r = ratioRaw(best.c, b);
    return Object.assign(base, { color: toHex(best.c), ratio: round(r, 2), changed: true, passes: r >= target });
  }

  /** Effective (opaque) background by walking ancestors and alpha-compositing. */
  function effectiveBackground(el, win) {
    const layers = [];
    let uncertain = false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = win.getComputedStyle(cur);
      const c = parseColor(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true;
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      cur = cur.parentElement;
    }
    let out = WHITE;
    for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
    return { color: out, uncertain };
  }

  /* ======================================================================
   * Unique selector generator (per document)
   * ==================================================================== */
  function makeSelectorGen(doc) {
    const win = doc.defaultView || window;
    const escFn = (win.CSS && win.CSS.escape) ? win.CSS.escape : (s) => String(s).replace(/([^\w-])/g, '\\$1');
    const cache = new Map();
    const stableClasses = (el) => {
      const c = el.getAttribute('class');
      if (!c) return [];
      return c.split(/\s+/).filter((t) => t && /^-?[_a-zA-Z][\w-]{0,39}$/.test(t) && !t.startsWith('__af_') && !t.startsWith('__auditforge_')).slice(0, 2);
    };
    const segment = (el) => {
      const tag = escFn(el.localName);
      const parent = el.parentElement;
      if (!parent) return tag;
      const sibs = parent.children;
      let same = 0, idx = 0;
      for (let i = 0; i < sibs.length; i++) if (sibs[i].localName === el.localName) { same++; if (sibs[i] === el) idx = same; }
      const cls = stableClasses(el);
      if (cls.length) {
        const cs = tag + cls.map((c) => '.' + escFn(c)).join('');
        let n = 0;
        for (let i = 0; i < sibs.length; i++) { try { if (sibs[i].matches(cs)) n++; } catch (e) { n = 99; break; } }
        if (n === 1) return cs;
      }
      if (same === 1) return tag;
      return tag + ':nth-of-type(' + idx + ')';
    };
    const absolute = (el) => {
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
        const p = cur.parentElement;
        if (!p) break;
        let idx = 0;
        for (let i = 0; i < p.children.length; i++) { if (p.children[i].localName === cur.localName) idx++; if (p.children[i] === cur) break; }
        parts.unshift(escFn(cur.localName) + ':nth-of-type(' + idx + ')');
        cur = p;
      }
      parts.unshift('html');
      return parts.join(' > ');
    };
    // Uniqueness by construction: every segment is unique among its siblings and the chain is anchored at a
    // unique id, a document-unique tag.class, or body. One querySelector round-trip verifies the result.
    let idCounts = null;
    const idUnique = (id) => {
      if (!idCounts) {
        idCounts = new Map();
        doc.querySelectorAll('[id]').forEach((e) => { const v = e.getAttribute('id'); idCounts.set(v, (idCounts.get(v) || 0) + 1); });
      }
      return idCounts.get(id) === 1;
    };
    const classUnique = (el) => {
      const cls = stableClasses(el);
      if (!cls.length) return null;
      let n = 0;
      try {
        const list = doc.getElementsByClassName(cls.join(' '));
        for (let i = 0; i < list.length && n < 2; i++) if (list[i].localName === el.localName) n++;
      } catch (e) { return null; }
      return n === 1 ? escFn(el.localName) + cls.map((c) => '.' + escFn(c)).join('') : null;
    };
    const verify = (s, el) => { try { return doc.querySelector(s) === el; } catch (e) { return false; } };
    const gen = (el) => {
      if (!el || el.nodeType !== 1) return '';
      if (cache.has(el)) return cache.get(el);
      let result = '';
      try {
        const root = el.getRootNode ? el.getRootNode() : doc;
        if (root !== doc && root && root.host) { result = gen(root.host); cache.set(el, result); return result; }
        if (el === doc.documentElement) result = 'html';
        else if (el === doc.body) result = 'body';
        else if (el === doc.head) result = 'head';
        else {
          const id = el.getAttribute('id');
          if (id && idUnique(id)) result = '#' + escFn(id);
          else result = classUnique(el) || '';
          if (!result) {
            const parts = [];
            let cur = el;
            while (cur && cur.nodeType === 1) {
              if (cur === doc.body || cur === doc.head || cur === doc.documentElement) { parts.unshift(cur.localName); break; }
              if (cur !== el) {
                const cid = cur.getAttribute('id');
                if (cid && idUnique(cid)) { parts.unshift('#' + escFn(cid)); break; }
                const cu = classUnique(cur);
                if (cu) { parts.unshift(cu); break; }
              }
              parts.unshift(segment(cur));
              cur = cur.parentElement;
            }
            result = parts.join(' > ');
          }
        }
        if (!verify(result, el)) result = absolute(el);
      } catch (e) { result = el.localName || ''; }
      cache.set(el, result);
      return result;
    };
    return gen;
  }

  /* ======================================================================
   * DOM helpers: visibility, roles, accessible names
   * ==================================================================== */
  function isRendered(el) {
    try {
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
      return el.getClientRects().length > 0;
    } catch (e) { return true; }
  }
  function ownerWin(el) { return (el.ownerDocument && el.ownerDocument.defaultView) || window; }

  const LANDMARK_ROLES = new Set(['banner', 'main', 'navigation', 'contentinfo', 'complementary', 'region', 'form', 'search']);
  const CONTROL_ROLES = new Set(['button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton',
    'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'tab', 'checkbox', 'radio', 'switch', 'tooltip', 'treeitem', 'gridcell', 'row']);

  function hasAccessibleNameAttr(el) {
    return !!(norm(el.getAttribute('aria-label')) || norm(el.getAttribute('aria-labelledby')) || norm(el.getAttribute('title')));
  }
  function implicitRole(el) {
    const tag = el.localName;
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return '';
        if (['button', 'submit', 'reset', 'image', 'file', 'color'].includes(t)) return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        return el.hasAttribute('list') ? 'combobox' : 'textbox';
      }
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return (el.getAttribute('alt') === '' && !hasAccessibleNameAttr(el)) ? 'presentation' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'search': return 'search';
      case 'header': case 'footer': {
        let p = el.parentElement;
        while (p) {
          if (/^(article|aside|main|nav|section)$/.test(p.localName)) return 'generic';
          const r = (p.getAttribute('role') || '').trim().toLowerCase();
          if (/^(article|complementary|main|navigation|region)$/.test(r)) return 'generic';
          p = p.parentElement;
        }
        return tag === 'header' ? 'banner' : 'contentinfo';
      }
      case 'form': return hasAccessibleNameAttr(el) ? 'form' : 'generic';
      case 'section': return (norm(el.getAttribute('aria-label')) || norm(el.getAttribute('aria-labelledby'))) ? 'region' : 'generic';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'dialog': return 'dialog';
      case 'p': return 'paragraph';
      case 'details': case 'fieldset': return 'group';
      case 'figure': return 'figure';
      case 'hr': return 'separator';
      case 'progress': return 'progressbar';
      case 'option': return 'option';
      default: return '';
    }
  }
  function getRole(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit === 'none' || explicit === 'presentation') {
      // Presentational conflict resolution: focusable / globally-labelled elements keep implicit role.
      if (el.tabIndex >= 0 && /^(a|button|input|select|textarea|summary)$/.test(el.localName)) return implicitRole(el);
      return 'presentation';
    }
    if (explicit === 'image') return 'img';
    if (explicit) return explicit;
    return implicitRole(el);
  }

  function textAlt(node, win, budget) {
    if (budget.n <= 0) return '';
    if (node.nodeType === 3) { budget.n -= node.data.length; return node.data; }
    if (node.nodeType !== 1) return '';
    const el = node;
    if (hasExtToken(el) || SKIP_TAGS.has(el.localName)) return '';
    if (el.getAttribute('aria-hidden') === 'true') return '';
    let cs = null;
    try { cs = win.getComputedStyle(el); } catch (e) { cs = null; }
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return '';
    const al = norm(el.getAttribute('aria-label'));
    if (al) return ' ' + al + ' ';
    const tag = el.localName;
    if (tag === 'img' || tag === 'area') return ' ' + norm(el.getAttribute('alt') || el.getAttribute('title') || '') + ' ';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'image') return ' ' + norm(el.getAttribute('alt') || el.value || '') + ' ';
      if (['button', 'submit', 'reset'].includes(t)) return ' ' + norm(el.value || '') + ' ';
      if (t === 'checkbox' || t === 'radio' || t === 'hidden') return '';
      return ' ' + norm(el.value || '') + ' ';
    }
    if (tag === 'select') { const o = el.selectedOptions && el.selectedOptions[0]; return o ? ' ' + norm(o.textContent) + ' ' : ''; }
    if (tag === 'textarea') return ' ' + norm(el.value || '') + ' ';
    if (tag === 'br') return ' ';
    if (tag === 'svg') {
      const t = el.querySelector('title');
      return t ? ' ' + norm(t.textContent) + ' ' : '';
    }
    let out = '';
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : (tag === 'slot' && el.assignedNodes().length ? el.assignedNodes({ flatten: true }) : el.childNodes);
    for (let i = 0; i < kids.length && budget.n > 0; i++) out += textAlt(kids[i], win, budget);
    const block = cs && cs.display && cs.display !== 'inline' && cs.display !== 'contents';
    return block ? ' ' + out + ' ' : out;
  }
  function contentText(el, win) {
    const budget = { n: 1000 };
    let out = '';
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    for (let i = 0; i < kids.length && budget.n > 0; i++) out += textAlt(kids[i], win, budget);
    return norm(out);
  }
  function labelledByText(el, doc, win) {
    const ids = norm(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    const parts = [];
    ids.split(' ').forEach((id) => {
      const ref = doc.getElementById(id);
      if (!ref) return;
      const al = norm(ref.getAttribute('aria-label'));
      if (al) { parts.push(al); return; }
      const t = contentText(ref, win) || norm(ref.textContent);
      if (t) parts.push(t);
    });
    return norm(parts.join(' '));
  }

  /**
   * Approximate accname computation.
   * Returns { name, source } where source in aria-labelledby | aria-label | label | alt | value | legend | caption |
   * figcaption | svg-title | content | title | placeholder | default | null.
   */
  function computeName(el, win, roleHint) {
    win = win || ownerWin(el);
    const doc = el.ownerDocument;
    const done = (name, source) => ({ name: trunc(norm(name), 250), source: norm(name) ? source : null });
    try {
      const lb = labelledByText(el, doc, win);
      if (lb) return done(lb, 'aria-labelledby');
      const al = norm(el.getAttribute('aria-label'));
      if (al) return done(al, 'aria-label');
      const tag = el.localName;
      const role = roleHint || getRole(el);
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (tag === 'input' && ['button', 'submit', 'reset'].includes(t)) {
          const v = el.getAttribute('value');
          if (v != null && norm(v)) return done(v, 'value');
          if (t === 'submit') return done('Submit', 'default');
          if (t === 'reset') return done('Reset', 'default');
        }
        if (tag === 'input' && t === 'image') {
          const a = norm(el.getAttribute('alt')) || norm(el.getAttribute('value'));
          if (a) return done(a, 'alt');
        }
        if (el.labels && el.labels.length) {
          const parts = [];
          for (let i = 0; i < el.labels.length; i++) {
            const lab = el.labels[i];
            // Exclude the control's own value when it's nested in the label
            const budget = { n: 1000 };
            let s = '';
            lab.childNodes.forEach((k) => { if (k !== el) s += textAlt(k, win, budget); });
            if (norm(s)) parts.push(norm(s));
          }
          if (parts.length) return done(parts.join(' '), 'label');
        }
        const ti = norm(el.getAttribute('title'));
        if (ti) return done(ti, 'title');
        const ph = norm(el.getAttribute('placeholder'));
        if (ph) return done(ph, 'placeholder');
        return done('', null);
      }
      if (tag === 'img' || tag === 'area') {
        if (el.hasAttribute('alt')) {
          const a = norm(el.getAttribute('alt'));
          if (a) return done(a, 'alt');
        }
        const ti = norm(el.getAttribute('title'));
        return ti ? done(ti, 'title') : done('', null);
      }
      if (tag === 'fieldset') { const lg = el.querySelector(':scope > legend'); if (lg && norm(lg.textContent)) return done(lg.textContent, 'legend'); }
      if (tag === 'figure') { const fc = el.querySelector(':scope > figcaption'); if (fc && norm(fc.textContent)) return done(fc.textContent, 'figcaption'); }
      if (tag === 'table') { const cp = el.querySelector(':scope > caption'); if (cp && norm(cp.textContent)) return done(cp.textContent, 'caption'); }
      if (tag === 'svg') { const t = el.querySelector(':scope > title'); if (t && norm(t.textContent)) return done(t.textContent, 'svg-title'); }
      if (NAME_FROM_CONTENT.has(role) || /^(a|button|summary|h[1-6]|label|legend|caption|th|td)$/.test(tag)) {
        const c = contentText(el, win);
        if (c) return done(c, 'content');
      }
      const ti = norm(el.getAttribute('title'));
      if (ti) return done(ti, 'title');
    } catch (e) { /* fall through */ }
    return done('', null);
  }

  function isNativelyFocusable(el) {
    const tag = el.localName;
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
    if (/^(button|input|select|textarea|iframe|summary)$/.test(tag)) return !el.disabled;
    if ((tag === 'audio' || tag === 'video') && el.hasAttribute('controls')) return true;
    if (el.isContentEditable) return true;
    return false;
  }
  const KB_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox']);
  /** Interactive role (or inline onclick) but cannot receive keyboard focus at all (no tabindex attribute). */
  function isKeyboardInaccessible(el, role) {
    if (isNativelyFocusable(el)) return false;
    if (el.hasAttribute('tabindex')) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit && KB_ROLES.has(explicit)) return true;
    if (!explicit && el.hasAttribute('onclick') && /^(div|span|li|td|img|p|section|article)$/.test(el.localName)) return true;
    return false;
  }

  function getStates(el, role) {
    const s = [];
    const ac = el.getAttribute('aria-checked');
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      if (ac === 'mixed' || (el.indeterminate === true)) s.push('mixed');
      else if (ac === 'true' || (ac == null && el.checked === true)) s.push('checked');
      else s.push('not checked');
    }
    const ae = el.getAttribute('aria-expanded');
    if (ae === 'true') s.push('expanded'); else if (ae === 'false') s.push('collapsed');
    else if (el.localName === 'summary' && el.parentElement && el.parentElement.localName === 'details') s.push(el.parentElement.open ? 'expanded' : 'collapsed');
    const ap = el.getAttribute('aria-pressed');
    if (ap === 'true') s.push('pressed'); else if (ap === 'false') s.push('not pressed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.push('current');
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.required === true || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') s.push('read only');
    return s;
  }

  /* ======================================================================
   * Screen reader announcement syntax (spec 5.3)
   *   VoiceOver: [Name], [State], [Role], [Hint]
   *   TalkBack:  [Name], [Role], [State], [Hint]   ("Unlabelled" when no name)
   *   NVDA:      [Role], [Name], [State]
   *   Narrator:  [Name], [Role], [State], [Scan Position]
   * ==================================================================== */
  const ROLE_WORDS = {
    voiceover: { button: 'button', link: 'link', textbox: 'text field', searchbox: 'search field', checkbox: 'checkbox', radio: 'radio button',
      combobox: 'pop-up button', listbox: 'list box', slider: 'adjustable', spinbutton: 'stepper', switch: 'switch button', tab: 'tab',
      menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item', option: 'option', treeitem: 'tree item', img: 'image',
      banner: 'banner', main: 'main', navigation: 'navigation', contentinfo: 'content information', complementary: 'complementary',
      region: 'region', form: 'form', search: 'search' },
    talkback: { button: 'Button', link: 'Link', textbox: 'Edit box', searchbox: 'Edit box', checkbox: 'Checkbox', radio: 'Radio button',
      combobox: 'Drop-down list', listbox: 'List', slider: 'Slider', spinbutton: 'Edit box', switch: 'Switch', tab: 'Tab',
      menuitem: 'Menu item', menuitemcheckbox: 'Menu item', menuitemradio: 'Menu item', option: 'Option', treeitem: 'Tree item', img: 'Image',
      banner: 'Banner', main: 'Main', navigation: 'Navigation', contentinfo: 'Content info', complementary: 'Complementary',
      region: 'Region', form: 'Form', search: 'Search' },
    nvda: { button: 'button', link: 'link', textbox: 'edit', searchbox: 'edit', checkbox: 'check box', radio: 'radio button',
      combobox: 'combo box', listbox: 'list', slider: 'slider', spinbutton: 'spin button', switch: 'toggle button', tab: 'tab',
      menuitem: 'menu item', menuitemcheckbox: 'check menu item', menuitemradio: 'radio menu item', option: 'option', treeitem: 'tree view item',
      img: 'graphic', banner: 'banner landmark', main: 'main landmark', navigation: 'navigation landmark', contentinfo: 'content info landmark',
      complementary: 'complementary landmark', region: 'region', form: 'form landmark', search: 'search landmark' },
    narrator: { button: 'button', link: 'link', textbox: 'edit', searchbox: 'edit', checkbox: 'checkbox', radio: 'radio button',
      combobox: 'combo box', listbox: 'list', slider: 'slider', spinbutton: 'spinner', switch: 'toggle switch', tab: 'tab item',
      menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item', option: 'list item', treeitem: 'tree item', img: 'image',
      banner: 'banner landmark', main: 'main landmark', navigation: 'navigation landmark', contentinfo: 'content information landmark',
      complementary: 'complementary landmark', region: 'region landmark', form: 'form landmark', search: 'search landmark' }
  };
  const STATE_WORDS = {
    voiceover: { 'not checked': 'unchecked', disabled: 'dimmed', 'not pressed': 'not selected', current: 'current page' },
    talkback: { current: 'current page' },
    nvda: { disabled: 'unavailable', current: 'current page' },
    narrator: { 'not checked': 'unchecked', disabled: 'unavailable', current: 'current page' }
  };
  function hintFor(role) {
    if (['link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'combobox', 'listbox'].includes(role)) return 'double-tap to activate';
    if (['textbox', 'searchbox', 'spinbutton'].includes(role)) return 'double-tap to edit';
    if (['checkbox', 'radio', 'switch'].includes(role)) return 'double-tap to toggle';
    if (role === 'slider') return 'swipe up or down to adjust';
    return '';
  }
  function roleWord(persona, role, level) {
    if (role === 'heading') return persona === 'talkback' ? 'Heading ' + level : 'heading level ' + level;
    const w = ROLE_WORDS[persona][role];
    if (w) return w;
    return persona === 'talkback' ? cap1(role) : role;
  }
  function buildAnnouncements(item, scanPos) {
    const join = (arr) => arr.filter((x) => x && String(x).trim()).join(', ');
    if (item.category === 'text') {
      return { voiceover: item.name, talkback: item.name, nvda: item.name, narrator: item.name };
    }
    const states = item.states || [];
    const st = (p) => states.map((s) => STATE_WORDS[p][s] || s).join(', ');
    const lvl = item.level;
    const isLandmark = item.category === 'landmark';
    const hint = item.hint || '';
    const unl = (!item.name && !isLandmark && item.category !== 'heading') ? 'Unlabelled' : '';
    return {
      voiceover: join([item.name, st('voiceover'), roleWord('voiceover', item.role, lvl), hint]),
      talkback: join([item.name || unl, roleWord('talkback', item.role, lvl), st('talkback'), hint]),
      nvda: join([roleWord('nvda', item.role, lvl), item.name, st('nvda')]),
      narrator: join([item.name, roleWord('narrator', item.role, lvl), st('narrator'), scanPos || ''])
    };
  }
  function scanPosition(el) {
    try {
      const li = el.closest('li');
      if (!li || !li.parentElement || !/^(ul|ol|menu)$/.test(li.parentElement.localName)) return '';
      const items = Array.prototype.filter.call(li.parentElement.children, (c) => c.localName === 'li');
      const i = items.indexOf(li);
      return i > -1 ? (i + 1) + ' of ' + items.length : '';
    } catch (e) { return ''; }
  }

  /* ======================================================================
   * CSSOM rule iteration (same-origin only; cross-origin sheets skipped)
   * ==================================================================== */
  function forEachStyleRule(doc, win, cb) {
    let crossOrigin = 0;
    const seen = new Set();
    const walk = (rules, wrappers, depth) => {
      if (!rules || depth > 8) return;
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.selectorText !== undefined) { cb(r, wrappers); continue; }
        if (r.styleSheet) { // @import
          try {
            const mt = r.media && r.media.mediaText;
            if (mt && !win.matchMedia(mt).matches) continue;
            if (seen.has(r.styleSheet)) continue; seen.add(r.styleSheet);
            walk(r.styleSheet.cssRules, wrappers, depth + 1);
          } catch (e) { crossOrigin++; }
          continue;
        }
        if (r.cssRules) {
          const txt = r.cssText || '';
          const brace = txt.indexOf('{');
          const prelude = brace > 0 ? txt.slice(0, brace).trim() : '';
          if (!prelude || /^@(keyframes|-webkit-keyframes|font-feature-values|page|font-face|property|counter-style)/i.test(prelude)) continue;
          if (r.media && r.media.mediaText !== undefined && /^@media/i.test(prelude)) {
            try { if (!win.matchMedia(r.media.mediaText).matches) continue; } catch (e) { /* keep */ }
          }
          walk(r.cssRules, wrappers.concat([prelude]), depth + 1);
        }
      }
    };
    const sheets = [];
    try { for (let i = 0; i < doc.styleSheets.length; i++) sheets.push(doc.styleSheets[i]); } catch (e) { /* ignore */ }
    try { if (doc.adoptedStyleSheets) doc.adoptedStyleSheets.forEach((s) => sheets.push(s)); } catch (e) { /* ignore */ }
    sheets.forEach((sheet) => {
      try {
        if (sheet.disabled) return;
        const node = sheet.ownerNode;
        if (node && node.nodeType === 1 && hasExtToken(node)) return;
        if (seen.has(sheet)) return; seen.add(sheet);
        let rules;
        try { rules = sheet.cssRules; } catch (e) { crossOrigin++; return; }
        walk(rules, [], 0);
      } catch (e) { crossOrigin++; }
    });
    return { crossOrigin };
  }

  /* ======================================================================
   * Mobile layout analysis (works on any same-origin window)
   *
   * Mobile Health Score formula (0-100), starting at 100 (WCAG A/AA findings only):
   *   viewport zoom (1.4.4): user-scalable=no -10; maximum-scale<2 -5
   *   overflows (1.4.10): -5 each, max -20;  overlaps: -3 each, max -15
   *   touch targets (2.5.8 AA, after the spacing/inline exceptions): -2 each, max -20; spacing conflicts -1 each, max -10
   *   sticky/fixed occlusion > 30% of viewport height (2.4.11 risk): -5 each, max -10
   *   Advisory 44x44 (2.5.5 AAA / Apple HIG) items are reported but never penalised.
   * Rounded and clamped to [0, 100].
   * ==================================================================== */
  function mobileScore(a, overflowCountOverride) {
    let s = 100;
    const vm = a.viewportMeta;
    if (vm.userScalableNo) s -= 10;                       // 1.4.4
    if (vm.maxScaleRestricted) s -= 5;                    // 1.4.4
    const ov = typeof overflowCountOverride === 'number' ? overflowCountOverride : a.overflows.length;
    s -= Math.min(20, ov * 5);                            // 1.4.10
    s -= Math.min(15, a.overlaps.length * 3);             // 1.4.10 (content collisions)
    const aa = a.touchTargets.failures.filter((f) => f.level === 'AA').length;
    s -= Math.min(20, aa * 2);                            // 2.5.8 (advisory 44px items do not count)
    s -= Math.min(10, a.touchTargets.crowding.length);    // 2.5.8 spacing
    s -= Math.min(10, a.stickyOcclusions.length * 5);     // 2.4.11
    return clampN(Math.round(s), 0, 100);
  }

  const INTERACTIVE_SEL = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="slider"], [tabindex]:not([tabindex="-1"])';
  const REPLACED = /^(img|video|canvas|input|select|textarea|button|svg|iframe|object|embed|picture|meter|progress)$/;

  function parseViewportMeta(doc) {
    const meta = doc.querySelector('meta[name="viewport" i]');
    const res = { present: !!meta, content: meta ? (meta.getAttribute('content') || '') : null, widthDeviceWidth: false, userScalableNo: false, maxScaleRestricted: false, issues: [] };
    if (!meta) return { res, meta: null }; // no viewport meta: best practice only, not logged
    const kv = {};
    String(res.content).split(/[,;]/).forEach((p) => {
      const i = p.indexOf('=');
      if (i < 0) return;
      kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().toLowerCase();
    });
    res.widthDeviceWidth = kv.width === 'device-width';
    res.userScalableNo = kv['user-scalable'] === 'no' || kv['user-scalable'] === '0';
    const ms = parseFloat(kv['maximum-scale']);
    res.maxScaleRestricted = !isNaN(ms) && ms < 2;
    if (res.userScalableNo) res.issues.push('user-scalable=no blocks pinch zoom');
    if (res.maxScaleRestricted) res.issues.push('maximum-scale=' + kv['maximum-scale'] + ' restricts zoom');
    return { res, meta };
  }

  function rectGap(a, b) {
    const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
    return Math.sqrt(dx * dx + dy * dy);
  }
  function intersectArea(r1, r2) {
    const overlaps = !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
    if (!overlaps) return 0;
    const w = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
    const h = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
    return (w >= 2 && h >= 2) ? w * h : 0;
  }
  function hasDirectText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.data)) return true;
    return false;
  }

  /** Internal: returns { analysis, elements } so the engine can build violation nodes. */
  function analyzeMobileInternal(targetWindow) {
    const win = targetWindow;
    const doc = win.document;
    const sel = makeSelectorGen(doc);
    const de = doc.documentElement;
    const vw = de.clientWidth || win.innerWidth;
    const vh = win.innerHeight || de.clientHeight;
    const sx = win.scrollX || 0, sy = win.scrollY || 0;
    const vmeta = parseViewportMeta(doc);
    const vis = makeVisCtx(doc, win);
    const perceivable = (el) => { const v = vis.classify(el); return !v.excluded && v.visibility !== 'hidden-visual'; };

    const overflowEls = [], textCands = [], interactive = [], sticky = [];
    const body = doc.body || de;
    const stack = [[body, false, false, false]];
    let count = 0;
    let interactiveMatcher = (el) => { try { return el.matches(INTERACTIVE_SEL); } catch (e) { return false; } };
    while (stack.length && count < CAPS.walk) {
      const [el, clipped, inFixed, reported] = stack.pop();
      count++;
      if (el.nodeType !== 1 || SKIP_TAGS.has(el.localName) || hasExtToken(el)) continue;
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { continue; }
      if (cs.display === 'none') continue;
      const pos = cs.position;
      const isFixed = pos === 'fixed' || pos === 'sticky';
      const r = el.getBoundingClientRect();
      const boxVisible = cs.visibility !== 'hidden' && cs.display !== 'contents' && r.width > 0 && r.height > 0;
      let nowReported = false;
      if (boxVisible && isFixed && !inFixed) {
        const pct = (r.height / vh) * 100;
        if (pct > 30) sticky.push({ el, heightPct: round(pct, 0) });
      }
      if (boxVisible && !clipped && !inFixed && !isFixed && !reported && el !== body) {
        const right = r.right + sx;
        if (right > vw + 2 && r.left + sx < right) { overflowEls.push({ el, right: round(right, 0), scrollWidth: el.scrollWidth }); nowReported = true; }
      }
      if (boxVisible && !isFixed && !inFixed && el !== body && (hasDirectText(el) || REPLACED.test(el.localName)) && perceivable(el)) {
        if (r.width >= 4 && r.height >= 4) {
          const rects = cs.display === 'inline' ? Array.prototype.slice.call(el.getClientRects()).filter((x) => x.width > 0 && x.height > 0) : [r];
          textCands.push({ el, r, rects });
        }
      }
      const offscreen = r.right + sx <= 0 || r.bottom + sy <= 0; // e.g. skip links parked at left:-9999px
      if (boxVisible && !offscreen && interactive.length < CAPS.interactive && interactiveMatcher(el) && !el.disabled && perceivable(el)) {
        interactive.push({ el, r, cs });
      }
      if (el.localName === 'svg' || el.localName === 'select' || el.localName === 'iframe') continue;
      const clipsChildren = el !== body && el !== de && cs.overflowX !== 'visible' && cs.overflowX !== 'clip' ? true : (el !== body && cs.overflowX === 'clip');
      const kids = el.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], clipped || clipsChildren, inFixed || isFixed, reported || nowReported]);
    }

    // ---- Overlaps (sort-and-sweep, parent/child pairs excluded) ----
    const cands = textCands.slice(0, CAPS.overlapCandidates).sort((a, b) => a.r.top - b.r.top);
    const overlapPairs = [];
    for (let i = 0; i < cands.length; i++) {
      const A = cands[i];
      for (let j = i + 1; j < cands.length; j++) {
        const B = cands[j];
        if (B.r.top >= A.r.bottom) break;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        let area = 0;
        A.rects.forEach((ra) => B.rects.forEach((rb) => { area += intersectArea(ra, rb); }));
        if (area >= 20) overlapPairs.push({ a: A.el, b: B.el, area: Math.round(area) });
      }
    }
    overlapPairs.sort((p, q) => q.area - p.area);

    // ---- Touch targets: WCAG 2.5.8 (AA) ----
    // Undersized (<24px) targets fail only if their 24px-diameter circle (centred on the target) intersects another
    // target, or the circle of another undersized target (spacing exception). Inline links in a sentence are exempt.
    // 'advisory' = below 44x44 (2.5.5 AAA / Apple HIG) or exempt undersized targets: reported, never penalised.
    const targets = interactive.filter((it) => it.r.width > 1 && it.r.height > 1).map((it) => {
      const r = it.r;
      return { el: it.el, r, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        under: r.width < 24 || r.height < 24, inline: it.cs.display === 'inline' && !!it.el.parentElement && hasDirectText(it.el.parentElement) };
    });
    const distToRect = (x, y, r) => { const dx = Math.max(r.left - x, 0, x - r.right); const dy = Math.max(r.top - y, 0, y - r.bottom); return Math.sqrt(dx * dx + dy * dy); };
    targets.forEach((A) => {
      A.conflict = null;
      if (!A.under || A.inline) return;
      for (let j = 0; j < targets.length; j++) {
        const B = targets[j];
        if (B === A || A.el.contains(B.el) || B.el.contains(A.el)) continue;
        if (Math.abs(B.cy - A.cy) > B.h / 2 + 24) continue;
        const d = B.under ? Math.hypot(B.cx - A.cx, B.cy - A.cy) : distToRect(A.cx, A.cy, B.r);
        if (d < (B.under ? 24 : 12) && (!A.conflict || d < A.conflict.d)) A.conflict = { B, d };
      }
    });
    const fails = [], crowd = [], seenPair = new Set();
    targets.forEach((A) => {
      let level = null;
      if (A.under) level = A.conflict ? 'AA' : 'advisory';
      else if (A.w < 44 || A.h < 44) level = 'advisory';
      if (level) fails.push({ el: A.el, width: Math.round(A.w), height: Math.round(A.h), level });
      if (A.conflict && crowd.length < CAPS.crowding) {
        const B = A.conflict.B;
        const key = [targets.indexOf(A), targets.indexOf(B)].sort((x, y) => x - y).join('-');
        if (!seenPair.has(key)) { seenPair.add(key); crowd.push({ a: A.el, b: B.el, distance: round(A.conflict.d, 1) }); }
      }
    });
    fails.sort((a, b) => (a.level === b.level ? (a.width * a.height) - (b.width * b.height) : (a.level === 'AA' ? -1 : 1)));

    const analysis = {
      score: 0,
      measuredViewport: { width: Math.round(win.innerWidth || vw), height: Math.round(vh) },
      viewportMeta: vmeta.res,
      overlaps: overlapPairs.slice(0, CAPS.overlaps).map((p) => ({ selectorA: sel(p.a), selectorB: sel(p.b), area: p.area })),
      overflows: overflowEls.slice(0, CAPS.overflows).map((o) => ({ selector: sel(o.el), right: o.right, scrollWidth: Math.round(o.scrollWidth), clientWidth: Math.round(vw) })),
      touchTargets: {
        failures: fails.slice(0, CAPS.touchFailures).map((f) => ({ selector: sel(f.el), width: f.width, height: f.height, level: f.level })),
        crowding: crowd.map((c) => ({ selectorA: sel(c.a), selectorB: sel(c.b), distance: c.distance }))
      },
      stickyOcclusions: sticky.map((s) => ({ selector: sel(s.el), heightPct: s.heightPct }))
    };
    analysis.score = mobileScore(analysis);
    return { analysis, metaEl: vmeta.meta, failEls: fails, overflowEls, sel };
  }

  function analyzeMobileLayout(targetWindow) {
    const win = targetWindow || window;
    try {
      return jsonClean(analyzeMobileInternal(win).analysis);
    } catch (e) {
      let w = 0, h = 0;
      try { w = win.innerWidth; h = win.innerHeight; } catch (x) { /* cross-origin */ }
      return {
        score: 0, measuredViewport: { width: w || 0, height: h || 0 },
        viewportMeta: { present: false, content: null, widthDeviceWidth: false, userScalableNo: false, maxScaleRestricted: false, issues: ['Analysis failed: ' + errMsg(e)] },
        overlaps: [], overflows: [], touchTargets: { failures: [], crowding: [] }, stickyOcclusions: []
      };
    }
  }

  /** devices[]: heuristic from desktop DOM - elements whose fixed CSS width / min-width / intrinsic media width exceeds the device width. */
  function estimateDevices(doc, win, sel, analysis) {
    const absLen = /^(\d+(?:\.\d+)?)(px|rem|em|pt)$/;
    const toPx = (v) => { const m = absLen.exec(String(v || '').trim()); if (!m) return 0; const n = parseFloat(m[1]); return m[2] === 'px' ? n : m[2] === 'pt' ? n * 4 / 3 : n * 16; };
    const cand = new Set();
    try {
      forEachStyleRule(doc, win, (rule) => {
        const st = rule.style;
        if (!st) return;
        if (Math.max(toPx(st.width), toPx(st.minWidth)) <= 320) return;
        try { const list = doc.querySelectorAll(rule.selectorText); for (let i = 0; i < list.length && i < 200; i++) cand.add(list[i]); } catch (e) { /* bad selector */ }
      });
    } catch (e) { /* ignore */ }
    try { doc.querySelectorAll('[style*="width"]').forEach((el) => { if (Math.max(toPx(el.style.width), toPx(el.style.minWidth)) > 320) cand.add(el); }); } catch (e) { /* ignore */ }
    try { doc.querySelectorAll('img, video, canvas, iframe, embed, object, table').forEach((el) => cand.add(el)); } catch (e) { /* ignore */ }
    const measured = [];
    cand.forEach((el) => {
      if (isExtensionElement(el) || !isRendered(el)) return;
      const cs = win.getComputedStyle(el);
      if (cs.position === 'fixed') return;
      if (/%|vw|vmin|dvw|svw|lvw/.test(cs.maxWidth)) return;
      const r = el.getBoundingClientRect();
      const minW = parseFloat(cs.minWidth) || 0;
      let required = Math.max(r.width, minW);
      if (el.localName === 'table') required = Math.max(minW, el.scrollWidth > r.width ? el.scrollWidth : 0, toPx(el.getAttribute('width') + 'px'));
      if (required <= 320) return;
      // contained in a horizontal scroll/clip container?
      let p = el.parentElement, contained = false;
      while (p && p !== doc.body && p !== doc.documentElement) {
        const pcs = win.getComputedStyle(p);
        if (pcs.overflowX !== 'visible') { contained = true; break; }
        p = p.parentElement;
      }
      if (!contained) measured.push({ el, required });
    });
    return DEVICES.map((d) => {
      const over = measured.filter((m) => m.required > d.width);
      const outer = over.filter((m) => !over.some((o) => o !== m && o.el.contains(m.el)));
      return {
        id: d.id, name: d.name, width: d.width, height: d.height,
        estimatedOverflowCount: outer.length,
        fixedWidthElements: outer.slice(0, CAPS.fixedWidth).map((m) => sel(m.el)),
        // Same formula as the Mobile Health Score, with the measured overflow count replaced by this device's estimate.
        score: mobileScore(analysis, outer.length)
      };
    });
  }

  /* ======================================================================
   * Default (empty) sections, used when a stage fails
   * ==================================================================== */
  function emptyScreenReader(detail) {
    const c = (w) => ({ score: 0, weight: w, detail: detail || 'Not evaluated' });
    return {
      score: 0, categories: { headings: c(25), landmarks: c(20), labeling: c(30), focus: c(15), images: c(10) },
      headings: [], headingStatus: 'Missing H1',
      landmarks: { banner: false, main: false, navigation: false, contentinfo: false, list: [] }, landmarkStatus: 'Incomplete',
      silentControls: [], barrierCount: 0, sequence: []
    };
  }
  function emptyTabOrder() {
    return { status: 'Needs Review', total: 0, positiveTabindexCount: 0, skipLink: { present: false, functional: false, visibleOnFocus: false, selector: null }, anomalies: [], sequence: [] };
  }
  function emptyLinks() {
    return { total: 0, internal: 0, external: 0, anchors: 0, counts: { ok: 0, warning: 0, error: 0 }, issues: [], list: [] };
  }
  function emptyMobile(win) {
    return {
      score: 0, measuredViewport: { width: win.innerWidth || 0, height: win.innerHeight || 0 },
      viewportMeta: { present: false, content: null, widthDeviceWidth: false, userScalableNo: false, maxScaleRestricted: false, issues: [] },
      overlaps: [], overflows: [], touchTargets: { failures: [], crowding: [] }, stickyOcclusions: [],
      devices: DEVICES.map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height, estimatedOverflowCount: 0, fixedWidthElements: [], score: 0 }))
    };
  }

  /* ======================================================================
   * Violation helpers
   * ==================================================================== */
  function makeViolation(o) {
    return {
      id: o.id, source: o.source, impact: o.impact, title: o.title, description: o.description || '',
      wcag: o.wcag || [], tags: o.tags || [], helpUrl: o.helpUrl || null,
      nodes: (o.nodes || []).slice(0, CAPS.nodesPerViolation)
    };
  }
  function makeNode(ctx, el, failureSummary, fix, contrast) {
    const n = { selector: ctx.sel(el), html: outerHtml(el), failureSummary: failureSummary || '', fix: fix || null };
    if (contrast) n.contrast = contrast;
    return n;
  }
  function wcagFromTags(tags) {
    const out = [];
    (tags || []).forEach((t) => {
      const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
      if (m) out.push(m[1] + '.' + m[2] + '.' + m[3]);
    });
    return out;
  }
  function worstImpact(list) {
    let best = 'minor';
    list.forEach((i) => { if (IMPACT_RANK[i] < IMPACT_RANK[best]) best = i; });
    return best;
  }

  /* ======================================================================
   * Stage 2: axe-core
   * ==================================================================== */
  function axeFix(ruleId, node, el, selector) {
    const firstLine = norm(String(node.failureSummary || '').split('\n').slice(1, 2).join(' ')) || norm(node.failureSummary);
    switch (ruleId) {
      case 'image-alt': case 'input-image-alt': case 'area-alt':
        return { html: el ? startTagWith(el, 'alt', 'Describe the image') : '<img alt="Describe the image">', note: 'Add a concise text alternative, or alt="" if decorative.' };
      case 'role-img-alt': case 'svg-img-alt':
        return { html: el ? startTagWith(el, 'aria-label', 'Describe the graphic') : null, note: 'Give the graphic an accessible name.' };
      case 'button-name':
        return { html: el ? startTagWith(el, 'aria-label', 'Describe the action') : null, note: 'Give the button visible text or an aria-label.' };
      case 'link-name':
        return { html: el ? startTagWith(el, 'aria-label', 'Describe the destination') : null, note: 'Give the link text that describes its destination.' };
      case 'input-button-name':
        return { html: el ? startTagWith(el, 'value', 'Describe the action') : null };
      case 'label': case 'select-name': {
        const id = el && el.getAttribute('id');
        return { html: '<label for="' + (id || 'field-id') + '">Field label</label>', note: id ? 'Associate a visible label with the field.' : 'Give the field an id and associate a visible <label for>.' };
      }
      case 'html-has-lang': case 'html-lang-valid':
        return { html: '<html lang="en">', note: 'Declare the page language.' };
      case 'document-title':
        return { html: '<title>Descriptive page title</title>' };
      case 'meta-viewport': case 'meta-viewport-large':
        return { html: '<meta name="viewport" content="width=device-width, initial-scale=1">' };
      case 'frame-title':
        return { html: el ? startTagWith(el, 'title', 'Describe the frame content') : null };
      case 'duplicate-id': case 'duplicate-id-aria': case 'duplicate-id-active':
        return { note: 'Make every id unique.' };
      default:
        return { note: trunc(firstLine || 'See the rule help page for remediation guidance.', 300) };
    }
  }

  async function stageAxe(ctx) {
    const axe = ctx.win.axe;
    if (!axe || typeof axe.run !== 'function') throw new Error('axe-core is not loaded');
    ctx.axeVersion = axe.version || 'unknown';
    const excl = findExtensionRoots(ctx.doc).map((el) => [ctx.sel(el)]).filter((x) => x[0]);
    const context = excl.length ? { exclude: excl } : ctx.doc;
    const res = await axe.run(context, {
      runOnly: { type: 'tag', values: WCAG_22_TAGS },
      preload: false,
      resultTypes: ['violations'],
      elementRef: true,
      iframes: false,
      selectors: true,
      ancestry: false,
      xpath: false
    });
    // Defensive WCAG-only filter (runOnly already restricts to A/AA tags).
    ctx.axePasses = (res.passes || []).filter(isWcagAxeResult).length;
    ctx.axeIncomplete = (res.incomplete || []).filter(isWcagAxeResult).length;
    const axeViolations = (res.violations || []).filter(isWcagAxeResult);
    ctx.axeBypassFailed = axeViolations.some((v) => v.id === 'bypass');
    axeViolations.forEach((v) => {
      const nodes = [];
      (v.nodes || []).forEach((n) => {
        if (nodes.length >= CAPS.nodesPerViolation) return;
        const el = n.element && n.element.nodeType === 1 ? n.element : null;
        if (el && isExtensionElement(el)) return;
        const fallbackSel = Array.isArray(n.target) ? n.target.map((t) => (Array.isArray(t) ? t.join(' ') : t)).join(' ') : String(n.target || '');
        const selector = el ? ctx.sel(el) : fallbackSel;
        const node = { selector, html: trunc(n.html || (el ? el.outerHTML : ''), 400), failureSummary: norm(n.failureSummary || '').slice(0, 1000), fix: null };
        if (v.id === 'color-contrast' || v.id === 'color-contrast-enhanced') {
          const chk = (n.any || []).concat(n.all || [], n.none || []).find((c) => c && c.data && c.data.fgColor);
          if (chk) {
            const d = chk.data;
            const required = parseFloat(String(d.expectedContrastRatio || '').replace(/:1$/, '')) || 4.5;
            const fx = calculateColorContrastFix(d.fgColor, d.bgColor, required);
            node.fix = { css: selector + ' { color: ' + fx.color + '; }', note: 'Adjusted text colour reaches ' + fx.ratio + ':1 on ' + fx.background + '.' };
            node.contrast = {
              state: 'rest', fg: toHex(parseColor(d.fgColor) || BLACK), bg: toHex(parseColor(d.bgColor) || WHITE),
              ratio: round(+d.contrastRatio || fx.originalRatio, 2), required, suggestedFg: fx.color, suggestedRatio: fx.ratio
            };
          } else {
            node.fix = { note: 'Contrast could not be measured automatically (background image, gradient or overlap). Verify manually.' };
          }
        } else {
          node.fix = axeFix(v.id, n, el, selector);
        }
        nodes.push(node);
      });
      if (!nodes.length) return;
      ctx.violations.push(makeViolation({
        id: v.id, source: 'axe', impact: v.impact && IMPACT_RANK[v.impact] !== undefined ? v.impact : 'minor',
        title: v.help || v.id, description: v.description || '', wcag: wcagFromTags(v.tags), tags: v.tags || [],
        helpUrl: v.helpUrl || null, nodes
      }));
    });
  }

  /* ======================================================================
   * Stage 3: ARIA semantic accuracy (label in name, generic labels, icon contradictions)
   * ==================================================================== */
  const GENERIC_LABELS = new Set(['button', 'btn', 'link', 'click', 'click here', 'here', 'more', 'read more', 'learn more', 'icon', 'image',
    'img', 'graphic', 'untitled', 'label', 'text', 'element', 'item', 'null', 'undefined', 'tap here', 'press here', 'this', 'go', 'submit button',
    'link button', 'button button', 'menu button', 'icon button', 'clickable', 'action']);
  const ICON_CATS = [
    { key: 'close', glyphs: ['✕', '✖', '×', '⨯', '❌', '✗', '✘', '╳'], classes: ['close', 'times', 'xmark', 'x-mark', 'cross', 'dismiss', 'fa-x', 'bi-x', 'icon-x', 'x-lg'], words: ['close', 'dismiss', 'cancel', 'remove', 'delete', 'clear', 'exit', 'hide', 'quit'] },
    { key: 'search', glyphs: ['🔍', '🔎', '⌕'], classes: ['search', 'magnifying-glass', 'magnifier', 'loupe'], words: ['search', 'find', 'look up', 'lookup', 'query', 'magnify'] },
    { key: 'menu', glyphs: ['☰', '≡', '⋮', '⋯'], classes: ['bars', 'hamburger', 'menu', 'navicon', 'ellipsis', 'kebab'], words: ['menu', 'navigation', 'nav', 'more', 'options', 'toggle', 'open'] },
    { key: 'back', glyphs: ['←', '‹', '«', '◀', '⟨', '⬅', '◁'], classes: ['arrow-left', 'chevron-left', 'angle-left', 'caret-left'], words: ['back', 'previous', 'prev', 'left', 'return', 'earlier', 'before'] },
    { key: 'next', glyphs: ['→', '›', '»', '▶', '⟩', '➔', '➜', '▷'], classes: ['arrow-right', 'chevron-right', 'angle-right', 'caret-right'], words: ['next', 'forward', 'continue', 'right', 'proceed', 'play', 'later', 'go', 'after'] },
    { key: 'add', glyphs: ['+', '➕', '＋'], classes: ['plus', 'add'], words: ['add', 'plus', 'new', 'create', 'expand', 'increase', 'more', 'zoom in', 'open', 'increment'] },
    { key: 'minus', glyphs: ['−', '➖'], classes: ['minus', 'subtract'], words: ['remove', 'minus', 'decrease', 'collapse', 'less', 'zoom out', 'delete', 'reduce', 'decrement', 'close'] },
    { key: 'confirm', glyphs: ['✓', '✔', '☑'], classes: ['check', 'tick', 'checkmark'], words: ['confirm', 'ok', 'okay', 'done', 'accept', 'check', 'save', 'submit', 'apply', 'yes', 'complete', 'select', 'agree'] },
    { key: 'settings', glyphs: ['⚙'], classes: ['cog', 'gear', 'settings'], words: ['settings', 'preferences', 'options', 'configure', 'config', 'setup', 'customize', 'customise'] },
    { key: 'delete', glyphs: ['🗑'], classes: ['trash', 'bin'], words: ['delete', 'remove', 'trash', 'discard', 'bin', 'clear'] },
    { key: 'favorite', glyphs: ['♥', '❤', '♡', '★', '☆'], classes: ['heart', 'star', 'favorite', 'favourite'], words: ['like', 'favorite', 'favourite', 'love', 'star', 'rate', 'save', 'wishlist', 'bookmark'] },
    { key: 'home', glyphs: ['🏠', '⌂'], classes: ['home', 'house'], words: ['home', 'start', 'main', 'homepage'] },
    { key: 'mail', glyphs: ['✉', '📧'], classes: ['envelope', 'mail', 'email'], words: ['mail', 'email', 'e-mail', 'message', 'contact', 'inbox', 'newsletter'] },
    { key: 'cart', glyphs: ['🛒'], classes: ['cart', 'basket', 'shopping-bag'], words: ['cart', 'basket', 'bag', 'checkout', 'shopping', 'trolley'] },
    { key: 'download', glyphs: ['⬇', '↓', '⤓'], classes: ['download', 'arrow-down'], words: ['download', 'save', 'down', 'export'] },
    { key: 'upload', glyphs: ['⬆', '↑', '⤒'], classes: ['upload', 'arrow-up'], words: ['upload', 'up', 'top', 'import'] }
  ];
  const wordRe = (w) => new RegExp('(^|[^\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}])', 'iu');
  ICON_CATS.forEach((c) => { c.res = c.words.map(wordRe); });

  function iconCategory(el, visibleText) {
    const t = String(visibleText || '').replace(/[️︎\s]/g, '');
    if (t && !hasAlnum(t)) {
      for (const c of ICON_CATS) if (c.glyphs.includes(t)) return { cat: c, cue: '"' + t + '" glyph' };
    }
    if (t === 'x' || t === 'X') return { cat: ICON_CATS[0], cue: '"' + t + '" glyph' };
    if (hasAlnum(t)) return null;
    // icon classes on the element or its icon children
    const nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('i, span, svg, use, img'), 0, 10));
    for (const n of nodes) {
      const cls = (n.getAttribute('class') || '') + ' ' + (n.getAttribute('href') || n.getAttribute('xlink:href') || '') + ' ' + (n.localName === 'img' ? (n.getAttribute('src') || '').split('/').pop() : '');
      const toks = cls.toLowerCase().split(/[\s#./]+/).filter(Boolean);
      for (const c of ICON_CATS) {
        for (const k of c.classes) {
          if (toks.some((tk) => tk === k || tk.endsWith('-' + k) || tk.startsWith(k + '-') || tk.includes('-' + k + '-') || tk.endsWith('_' + k))) {
            return { cat: c, cue: 'icon "' + k + '"' };
          }
        }
      }
    }
    return null;
  }

  function stageAria(ctx) {
    const { doc, win } = ctx;
    const sel = 'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';
    const lin = [], gen = [], icon = [];
    const els = doc.querySelectorAll(sel);
    for (let i = 0; i < els.length && i < CAPS.ariaCandidates; i++) {
      const el = els[i];
      if (isExtensionElement(el) || el.closest('[aria-hidden="true"]') || !isRendered(el)) continue;
      const lbText = labelledByText(el, doc, win);
      const ariaLabel = norm(el.getAttribute('aria-label'));
      const authored = lbText || ariaLabel;
      const isInputBtn = el.localName === 'input';
      const visible = norm(isInputBtn ? el.value : (el.innerText || ''));
      // 1. Label in name (2.5.3)
      if (authored && hasAlnum(visible) && loose(visible).length >= 2) {
        if (!loose(authored).includes(loose(visible))) {
          const fixed = visible.length > 60 ? visible.slice(0, 60) : visible;
          lin.push(makeNode(ctx, el,
            'Visible text "' + trunc(visible, 80) + '" is not included in ' + (lbText ? 'aria-labelledby text' : 'aria-label') + ' "' + trunc(authored, 80) + '".',
            { html: lbText ? startTagWith(el, 'aria-labelledby', null) : startTagWith(el, 'aria-label', fixed), note: 'Start the accessible name with the visible label so speech-input users can activate it.' }));
        }
      }
      // 2. Generic labels
      if (authored && GENERIC_LABELS.has(loose(authored))) {
        gen.push(makeNode(ctx, el, (lbText ? 'aria-labelledby text' : 'aria-label') + ' "' + authored + '" is generic.',
          hasAlnum(visible) ? { html: startTagWith(el, 'aria-label', null), note: 'Remove the generic aria-label so the visible text is used.' }
            : { html: startTagWith(el, 'aria-label', 'Describe the action'), note: 'Describe the purpose, e.g. "Close dialog".' }));
      }
      // 3. Icon contradictions
      const name = authored || norm(el.getAttribute('title'));
      if (name) {
        const ic = iconCategory(el, visible);
        if (ic) {
          const own = ic.cat.res.some((re) => re.test(name));
          if (!own) {
            const other = ICON_CATS.find((c) => c !== ic.cat && c.res.some((re) => re.test(name)));
            if (other) {
              icon.push(makeNode(ctx, el, 'The ' + ic.cue + ' suggests "' + ic.cat.key + '", but the accessible name is "' + trunc(name, 80) + '" (' + other.key + ').',
                { note: 'Use an icon that matches the action, or correct the accessible name.' }));
            }
          }
        }
      }
    }
    if (lin.length) ctx.violations.push(makeViolation({ id: 'af-label-in-name', source: 'aria', impact: 'serious',
      title: 'Accessible name does not contain the visible label (WCAG 2.5.3)',
      description: 'Speech-input users say the visible text, but the aria-label differs.', wcag: ['2.5.3'], tags: ['wcag21a', 'af-aria'], nodes: lin }));
    if (gen.length) ctx.violations.push(makeViolation({ id: 'af-generic-label', source: 'aria', impact: 'moderate', title: 'Generic accessible label',
      description: 'aria-label uses a generic word that does not describe the purpose.', wcag: ['2.4.6', '4.1.2'], tags: ['wcag2a', 'wcag2aa', 'af-aria'], nodes: gen }));
    if (icon.length) ctx.violations.push(makeViolation({ id: 'af-icon-contradiction', source: 'aria', impact: 'serious', title: 'Icon contradicts its accessible name',
      description: 'The visible icon implies a different action than the name announced to assistive technology.', wcag: ['1.1.1', '4.1.2'], tags: ['wcag2a', 'af-aria'], nodes: icon }));
  }

  /* ======================================================================
   * Stage 4: :hover contrast (CSSOM :hover rules cloned onto an attribute selector)
   * ==================================================================== */
  function clearHoverSim(doc) {
    try {
      [HOVER_STYLE_ID, FREEZE_STYLE_ID].forEach((id) => { const s = doc.getElementById(id); if (s) s.remove(); });
      doc.querySelectorAll('[' + HOVER_ATTR + ']').forEach((el) => el.removeAttribute(HOVER_ATTR));
    } catch (e) { /* ignore */ }
  }
  function readVisualState(el, win) {
    const cs = win.getComputedStyle(el);
    const bgInfo = effectiveBackground(el, win);
    const outer = el.parentElement ? effectiveBackground(el.parentElement, win) : { color: WHITE, uncertain: false };
    const fgRaw = parseColor(cs.color) || BLACK;
    const fg = fgRaw.a < 1 ? blend(fgRaw, bgInfo.color) : fgRaw;
    const own = parseColor(cs.backgroundColor);
    const ownVisible = !!(own && own.a > 0.1);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = parseColor(cs.borderTopColor);
    const borderVisible = bw >= 1 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden' && bc && bc.a > 0.1;
    let boundary = null;
    if (ownVisible || borderVisible) {
      boundary = 0;
      if (ownVisible) boundary = Math.max(boundary, ratioRaw(bgInfo.color, outer.color));
      if (borderVisible) boundary = Math.max(boundary, ratioRaw(blend(bc, outer.color), outer.color));
    }
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    return {
      fg, bg: bgInfo.color, uncertain: bgInfo.uncertain, outer: outer.color, boundary,
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      key: toHex(fg) + toHex(bgInfo.color) + (borderVisible ? toHex(bc) : '') + (ownVisible ? 'o' : '')
    };
  }

  /** Splits on a separator char at nesting depth 0 (ignores (), [] and quoted strings). */
  function splitTop(s, isSep) {
    const out = []; let depth = 0, cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === q && s[i - 1] !== '\\') q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && isSep(ch)) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }
  /** For a selector list, returns the compound selectors that carry :hover with :hover stripped ('*' = any element). */
  function hoverHostsOf(selectorText) {
    const hosts = [];
    splitTop(selectorText, (c) => c === ',').forEach((complex) => {
      if (complex.indexOf(':hover') === -1) return;
      splitTop(complex, (c) => c === ' ' || c === '>' || c === '+' || c === '~' || c === '\n' || c === '\t').forEach((compound) => {
        if (compound.indexOf(':hover') === -1) return;
        let h = compound.replace(/:hover(?![\w-])/g, '').replace(/::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop)\b.*$/i, '');
        if (h.indexOf('&') !== -1) h = '*';
        hosts.push(h || '*');
      });
    });
    return hosts;
  }

  function stageHover(ctx) {
    const { doc, win } = ctx;
    clearHoverSim(doc);
    const texts = [];
    const hostSet = new Set();
    const re = /:hover(?![\w-])/g;
    const { crossOrigin } = forEachStyleRule(doc, win, (rule, wrappers) => {
      if (texts.length >= CAPS.hoverRules) return;
      const ct = rule.cssText || '';
      if (ct.indexOf(':hover') === -1) return;
      const cloned = ct.replace(re, '[' + HOVER_ATTR + ']');
      texts.push(wrappers.reduceRight((acc, p) => p + ' { ' + acc + ' }', cloned));
      const st = rule.selectorText || '';
      // Nested rules (&:hover) are hosted by the parent rule's selector.
      (st.indexOf(':hover') !== -1 ? hoverHostsOf(st) : [st]).forEach((h) => hostSet.add(h));
    });
    // Host matcher: only ancestors that can actually be in a :hover state relevant to some rule get the attribute.
    // html/body hosts are ignored (rules like `body:hover p` would otherwise restyle the entire page on every probe).
    let anyHost = hostSet.has('*');
    const validHosts = [];
    hostSet.forEach((h) => { if (h === '*') return; try { doc.querySelector(h); validHosts.push(h); } catch (e) { anyHost = true; } });
    const hostSel = validHosts.join(', ');
    const isHost = (el) => {
      if (el === doc.documentElement || el === doc.body) return false;
      if (anyHost) return true;
      try { return hostSel ? el.matches(hostSel) : false; } catch (e) { return true; }
    };
    ctx.hoverInfo = { rules: texts.length, crossOriginSheets: crossOrigin };
    if (!texts.length) return;
    const host = doc.head || doc.documentElement;
    const freeze = doc.createElement('style');
    freeze.id = FREEZE_STYLE_ID;
    freeze.textContent = '*, *::before, *::after { transition: none !important; }';
    const sim = doc.createElement('style');
    sim.id = HOVER_STYLE_ID;
    host.appendChild(freeze);
    host.appendChild(sim);
    const textNodes = [], boundaryNodes = [];
    try {
      texts.forEach((t) => { try { sim.sheet.insertRule(t, sim.sheet.cssRules.length); } catch (e) { /* unsupported clone */ } });
      if (!sim.sheet.cssRules.length) return;
      const cands = doc.querySelectorAll('a[href], button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary');
      let checked = 0;
      const hostCache = new Map();
      const hostOf = (p) => { let v = hostCache.get(p); if (v === undefined) { v = isHost(p); hostCache.set(p, v); } return v; };
      const deadline = performance.now() + 6000; // time budget for this stage
      for (let i = 0; i < cands.length && checked < CAPS.hover && performance.now() < deadline; i++) {
        const el = cands[i];
        if (isExtensionElement(el)) continue;
        const chain = [];
        for (let p = el; p && p.nodeType === 1; p = p.parentElement) if (hostOf(p)) chain.push(p);
        if (!chain.length) continue; // no :hover rule can affect this element
        if (!isRendered(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        checked++;
        const rest = readVisualState(el, win);
        chain.forEach((p) => p.setAttribute(HOVER_ATTR, ''));
        let hov;
        try { hov = readVisualState(el, win); } finally { chain.forEach((p) => p.removeAttribute(HOVER_ATTR)); }
        if (hov.key === rest.key) continue;
        const sel = ctx.sel(el);
        const text = el.localName === 'input' ? el.value : (el.innerText || '');
        if (hasAlnum(text) && !hov.uncertain) {
          const required = hov.large ? 3 : 4.5;
          const restRatio = ratioRaw(rest.fg, rest.bg);
          const hovRatio = ratioRaw(hov.fg, hov.bg);
          if (hovRatio < required && (restRatio >= required || hovRatio < restRatio - 0.05)) {
            const fx = calculateColorContrastFix(hov.fg, hov.bg, required);
            textNodes.push(makeNode(ctx, el,
              'Rest contrast ' + round(restRatio, 2) + ':1 ' + (restRatio >= required ? 'passes' : 'fails') + ', but hover contrast is ' + round(hovRatio, 2) + ':1 (required ' + required + ':1).',
              { css: sel + ':hover { color: ' + fx.color + '; }' },
              { state: 'hover', fg: toHex(hov.fg), bg: toHex(hov.bg), ratio: round(hovRatio, 2), required, suggestedFg: fx.color, suggestedRatio: fx.ratio }));
          }
        }
        if (rest.boundary !== null && hov.boundary !== null && rest.boundary >= 3 && hov.boundary < 3) {
          const fx = calculateColorContrastFix(hov.bg, hov.outer, 3);
          boundaryNodes.push(makeNode(ctx, el,
            'Component boundary contrast drops from ' + round(rest.boundary, 2) + ':1 at rest to ' + round(hov.boundary, 2) + ':1 on hover (required 3:1).',
            { css: sel + ':hover { border: 2px solid ' + fx.color + '; }', note: 'Or keep the hover background at least 3:1 against ' + toHex(hov.outer) + '.' },
            { state: 'hover', fg: toHex(hov.bg), bg: toHex(hov.outer), ratio: round(hov.boundary, 2), required: 3, suggestedFg: fx.color, suggestedRatio: fx.ratio }));
        }
      }
    } finally {
      clearHoverSim(doc);
    }
    if (textNodes.length) ctx.violations.push(makeViolation({ id: 'af-hover-contrast', source: 'hover', impact: 'serious',
      title: 'Hover state drops text contrast below the WCAG minimum',
      description: 'On :hover, the colours change and the text contrast fails WCAG 1.4.3 (4.5:1, or 3:1 for large text).',
      wcag: ['1.4.3'], tags: ['wcag2aa', 'af-hover'], nodes: textNodes }));
    if (boundaryNodes.length) ctx.violations.push(makeViolation({ id: 'af-hover-boundary', source: 'hover', impact: 'serious',
      title: 'Hover state drops component boundary contrast below 3:1',
      description: 'On :hover, the control background/border no longer contrasts 3:1 with its surroundings (WCAG 1.4.11).',
      wcag: ['1.4.11'], tags: ['wcag21aa', 'af-hover'], nodes: boundaryNodes }));
  }

  /* ======================================================================
   * Visibility model (CONTRACT 10.1)
   *   excluded       -> not rendered / inert / closed details or dialog / extension: never a tab stop, never announced
   *   'visible'      -> rendered and perceivable (below the fold still counts)
   *   'sr-only'      -> intentional visually-hidden pattern (1px clip, clip-path inset(50%), <=1px overflow-hidden box)
   *   'hidden-visual'-> reachable by Tab / read by AT but not perceivable (opacity 0, zero size, off-screen,
   *                     clipped by an overflow-hidden/clip ancestor such as a height:0 collapsed accordion)
   * ==================================================================== */
  const SR_HIDDEN_BARRIER = 'Announced by screen readers but not visible on screen';
  const HIDDEN_FOCUS_WARNING = 'Receives focus but is not visible';
  const ARIA_HIDDEN_WARNING = 'Focusable inside aria-hidden';
  const REVEAL_PROPS = ['clip', 'clip-path', 'position', 'left', 'right', 'top', 'bottom', 'inset', 'width', 'height', 'transform',
    'opacity', 'margin', 'margin-left', 'margin-top', 'overflow', 'visibility', 'display', 'translate', 'white-space'];

  function describeEl(el) {
    let s = el.localName;
    const id = el.getAttribute('id');
    if (id) return s + '#' + id;
    const c = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
    return c ? s + '.' + c : s;
  }
  function looksSrOnly(cs, getRect) {
    const pos = cs.position;
    const clip = cs.clip || 'auto';
    if ((pos === 'absolute' || pos === 'fixed') && clip !== 'auto' && clip.indexOf('rect') === 0) {
      const n = (clip.match(/-?[\d.]+/g) || []).map(Number); // rect(top, right, bottom, left)
      if (n.length === 4 && (n[1] - n[3] <= 1 || n[2] - n[0] <= 1)) return true;
    }
    const cp = cs.clipPath || 'none';
    if (/inset\(\s*(50%|100%)/.test(cp) || /circle\(\s*0(px)?\s*(at|\))/.test(cp)) return true;
    if (cs.overflowX !== 'visible' && cs.display !== 'inline') {
      const r = getRect();
      if (r.width <= 1.5 && r.height <= 1.5) return true;
    }
    return false;
  }

  /** Per-call memoised visibility context. Walks the flat tree upwards once per element. */
  function makeVisCtx(doc, win) {
    const memo = new Map();
    const de = doc.documentElement, body = doc.body;
    const sx = win.scrollX || 0, sy = win.scrollY || 0;
    const vw = de.clientWidth || win.innerWidth, vh = win.innerHeight || de.clientHeight;
    const NONE = { excluded: null, ariaHidden: false, ariaHiddenEl: null, opacityEl: null, srOnly: null, cvHidden: false, childClip: null, childClipEl: null, fixedEl: null };
    const flatParent = (el) => el.assignedSlot || el.parentElement || (el.parentNode && el.parentNode.host) || null;
    const empty = (c) => !!c && (c.r - c.l < 1 || c.b - c.t < 1);
    const ex = (reason) => ({ excluded: reason, ariaHidden: false, opacityEl: null, srOnly: null, cvHidden: false, childClip: null, childClipEl: null, fixedEl: null });

    function get(el) {
      if (!el || el.nodeType !== 1) return NONE;
      let c = memo.get(el);
      if (c) return c;
      const p = flatParent(el);
      const pc = p ? get(p) : NONE;
      c = compute(el, p, pc);
      memo.set(el, c);
      return c;
    }
    function compute(el, p, pc) {
      if (pc.excluded) return pc;
      if (hasExtToken(el)) return ex('extension element');
      if (el.hasAttribute('inert')) return ex('Inside an inert subtree (' + describeEl(el) + ')');
      if (el.localName === 'dialog' && !el.open) return ex('Inside a closed <dialog>');
      if (p && p.localName === 'details' && !p.open && !(el.localName === 'summary' && p.querySelector(':scope > summary') === el)) {
        return ex('Inside a closed <details>');
      }
      if (pc.cvHidden) return ex('content-visibility: hidden on ancestor');
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return ex('No computed style'); }
      if (cs.display === 'none') return ex(el.hidden ? 'hidden attribute on ' + describeEl(el) : 'display: none on ' + describeEl(el));
      let rect = null;
      const getRect = () => rect || (rect = el.getBoundingClientRect());
      const ariaSelf = el.getAttribute('aria-hidden') === 'true';
      const c = {
        excluded: null, cs, getRect,
        ariaHidden: pc.ariaHidden || ariaSelf, ariaHiddenEl: pc.ariaHiddenEl || (ariaSelf ? el : null),
        opacityEl: pc.opacityEl || (parseFloat(cs.opacity) <= 0.01 ? el : null),
        srOnly: pc.srOnly || (cs.display !== 'contents' && el !== de && el !== body && looksSrOnly(cs, getRect) ? el : null),
        cvHidden: cs.contentVisibility === 'hidden'
      };
      const pos = cs.position;
      let inClip, inClipEl, fixedEl;
      if (pos === 'fixed') { inClip = null; inClipEl = null; fixedEl = el; }
      else if (pos === 'absolute') {
        const op = el.offsetParent ? get(el.offsetParent) : NONE;
        inClip = op.childClip; inClipEl = op.childClipEl; fixedEl = op.fixedEl;
      } else { inClip = pc.childClip; inClipEl = pc.childClipEl; fixedEl = pc.fixedEl; }
      c.inClip = inClip; c.inClipEl = inClipEl; c.fixedEl = fixedEl;
      c.childClip = inClip; c.childClipEl = inClipEl;
      if (el !== de && el !== body && cs.display !== 'inline' && cs.display !== 'contents' && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
        const r = getRect();
        const box = { l: r.left + el.clientLeft, t: r.top + el.clientTop, r: r.left + el.clientLeft + el.clientWidth, b: r.top + el.clientTop + el.clientHeight };
        const clipX = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || box.r - box.l < 1;
        const clipY = cs.overflowY === 'hidden' || cs.overflowY === 'clip' || box.b - box.t < 1;
        if (clipX || clipY) {
          const nc = { l: clipX ? box.l : -Infinity, r: clipX ? box.r : Infinity, t: clipY ? box.t : -Infinity, b: clipY ? box.b : Infinity };
          const merged = inClip ? { l: Math.max(inClip.l, nc.l), r: Math.min(inClip.r, nc.r), t: Math.max(inClip.t, nc.t), b: Math.min(inClip.b, nc.b) } : nc;
          c.childClip = merged;
          c.childClipEl = (inClip && empty(inClip)) ? inClipEl : el; // keep the outermost collapsing container as culprit
        }
      }
      return c;
    }
    function clipReason(clipEl) {
      const cc = get(clipEl);
      const cs = cc.cs;
      if (!cs) return 'Clipped by ' + describeEl(clipEl);
      const r = cc.getRect();
      return 'Clipped by ' + describeEl(clipEl) + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + 'px, overflow: ' + (cs.overflowX === cs.overflowY ? cs.overflowX : cs.overflowX + ' ' + cs.overflowY) + ')';
    }
    /** -> { excluded } or { visibility, reason, causeEl, ariaHidden, ariaHiddenEl } */
    function classify(el) {
      const c = get(el);
      if (c.excluded) return { excluded: c.excluded };
      const cs = c.cs;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return { excluded: 'visibility: ' + cs.visibility };
      if (typeof el.checkVisibility === 'function' && cs.display !== 'contents') {
        try { if (!el.checkVisibility({ visibilityProperty: true })) return { excluded: 'Not rendered' }; } catch (e) { /* ignore */ }
      }
      const base = { excluded: null, ariaHidden: c.ariaHidden, ariaHiddenEl: c.ariaHiddenEl };
      if (c.srOnly) return Object.assign(base, { visibility: 'sr-only', reason: 'Visually hidden (sr-only pattern' + (c.srOnly !== el ? ' on ' + describeEl(c.srOnly) : '') + ')', causeEl: c.srOnly });
      if (c.opacityEl) return Object.assign(base, { visibility: 'hidden-visual', reason: 'opacity: 0' + (c.opacityEl !== el ? ' on ' + describeEl(c.opacityEl) : ''), causeEl: c.opacityEl });
      if (cs.display === 'contents') return Object.assign(base, { visibility: 'visible', reason: null, causeEl: null });
      let r = c.getRect();
      if (r.width < 1 || r.height < 1) {
        // Zero-size wrapper whose children are drawn (e.g. absolutely positioned icon): use descendants' boxes.
        let best = null;
        const kids = el.querySelectorAll('*');
        for (let i = 0; i < kids.length && i < 20; i++) { const kr = kids[i].getBoundingClientRect(); if (kr.width >= 1 && kr.height >= 1) { best = kr; break; } }
        if (!best) return Object.assign(base, { visibility: 'hidden-visual', reason: 'Zero size (' + Math.round(r.width) + '×' + Math.round(r.height) + 'px)', causeEl: el });
        r = best;
      }
      if (r.right + sx <= 0 || r.bottom + sy <= 0) {
        return Object.assign(base, { visibility: 'hidden-visual', reason: 'Positioned off-screen (left: ' + Math.round(r.left + sx) + 'px, top: ' + Math.round(r.top + sy) + 'px)', causeEl: el });
      }
      if (c.fixedEl && (r.left >= vw || r.top >= vh)) {
        return Object.assign(base, { visibility: 'hidden-visual', reason: 'Outside the viewport inside fixed container ' + describeEl(c.fixedEl), causeEl: c.fixedEl });
      }
      const clip = c.inClip;
      if (clip) {
        const w = Math.min(r.right, clip.r) - Math.max(r.left, clip.l);
        const h = Math.min(r.bottom, clip.b) - Math.max(r.top, clip.t);
        if (w < 1 || h < 1) return Object.assign(base, { visibility: 'hidden-visual', reason: clipReason(c.inClipEl), causeEl: c.inClipEl });
      }
      return Object.assign(base, { visibility: 'visible', reason: null, causeEl: null });
    }
    return { get, classify };
  }

  /** Selectors of rules that reveal an element on focus (:focus / :focus-visible / :focus-within / :not(:focus) hiding rules). */
  function makeFocusRevealTest(doc, win) {
    let hosts = null;
    return (el) => {
      if (!hosts) {
        hosts = [];
        try {
          forEachStyleRule(doc, win, (rule) => {
            const st = rule.selectorText || '';
            if (st.indexOf(':focus') === -1 || !rule.style) return;
            if (!REVEAL_PROPS.some((p) => rule.style.getPropertyValue(p) !== '')) return;
            splitTop(st, (ch) => ch === ',').forEach((cx) => {
              if (cx.indexOf(':focus') === -1) return;
              const h = cx.replace(/:not\((?:[^()]|\([^()]*\))*?:focus[^)]*\)/g, '').replace(/:focus(-visible|-within)?(?![\w-])/g, '').replace(/::?(before|after)\b.*$/i, '').trim();
              if (!h || h.indexOf('&') !== -1) return;
              try { doc.querySelector(h); hosts.push(h); } catch (e) { /* invalid */ }
            });
          });
        } catch (e) { /* ignore */ }
      }
      return hosts.some((h) => { try { return el.matches(h) || !!el.closest(h); } catch (e) { return false; } });
    };
  }

  /* ======================================================================
   * Screen-reader sequence (CONTRACT 10.1 / 10.2) - shared by the audit and the live function
   * ==================================================================== */
  function computeSpeechInternal(doc, win, sel, opts) {
    const includeHidden = !(opts && opts.includeHiddenVisual === false);
    const vis = (opts && opts.vis) || makeVisCtx(doc, win);
    const raw = [], headings = [], landmarks = [], silent = [], placeholderOnly = [];
    let lastText = null, prevLevel = 0, h1Count = 0, skipCount = 0, emptyHeadings = 0, visited = 0;
    let interactiveTotal = 0, interactiveNamed = 0, imgTotal = 0, imgNamed = 0;
    const push = (it) => { raw.push(it); lastText = null; };
    const displayOf = (el) => { const c = vis.get(el); return c.cs ? c.cs.display : 'block'; };
    const blockAncestor = (el, root) => {
      let g = el;
      while (g && g !== root && g.localName !== 'label' && displayOf(g) === 'inline' && g.parentElement) g = g.parentElement;
      return g;
    };
    const roleLabel = (role) => (role === 'link' ? 'Link' : role === 'button' ? 'Button' : ['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider'].includes(role) ? 'Form field' : cap1(role));
    const visOf = (el) => { const v = vis.classify(el); return v.excluded ? { visibility: 'visible', reason: null, causeEl: null } : v; };
    const controlItem = (el, role, category, v) => {
      const nm = computeName(el, win, role);
      interactiveTotal++;
      let barrier = null;
      if (!nm.name) barrier = roleLabel(role) + ' has no accessible name';
      else if (nm.source === 'placeholder') barrier = 'Form field is labelled only by its placeholder';
      if (!barrier && isKeyboardInaccessible(el, role)) barrier = 'Interactive role but not keyboard focusable';
      if (!nm.name) silent.push({ el, role }); else interactiveNamed++; // a placeholder is a valid accessible name (4.1.2); 3.3.2 is reported separately
      if (nm.source === 'placeholder') placeholderOnly.push(el);
      push({ el, category, role, name: nm.name, states: getStates(el, role), hint: hintFor(role), level: null, barrier, vis: v });
    };
    const kidsOf = (el) => {
      if (el.shadowRoot) return el.shadowRoot.childNodes;
      if (el.localName === 'slot') { const a = el.assignedNodes({ flatten: true }); if (a.length) return a; }
      return el.childNodes;
    };
    const visit = (parent) => {
      const kids = kidsOf(parent);
      for (let i = 0; i < kids.length; i++) {
        if (visited++ > CAPS.walk) return;
        const node = kids[i];
        if (node.nodeType === 3) {
          const t = norm(node.data);
          if (!t) continue;
          const pe = node.parentElement || parent;
          const pv = vis.classify(pe);
          if (pv.excluded) continue; // e.g. visibility:hidden parent
          const group = blockAncestor(pe, doc.body);
          if (lastText && lastText.el === group && lastText.vis.visibility === pv.visibility) { lastText.name = trunc(lastText.name + ' ' + t, 300); continue; }
          lastText = { el: group, category: 'text', role: 'text', name: trunc(t, 300), states: [], hint: '', level: null, barrier: null, vis: pv };
          raw.push(lastText);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node;
        if (SKIP_TAGS.has(el.localName)) continue;
        const c = vis.get(el);
        if (c.excluded) continue;                                  // not rendered / inert / closed details|dialog / extension
        if (el.getAttribute('aria-hidden') === 'true') continue;   // removed from the accessibility tree
        if (el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
        const selfHidden = c.cs.visibility === 'hidden' || c.cs.visibility === 'collapse';
        if (selfHidden) { visit(el); continue; }                  // children may override with visibility:visible
        const role = getRole(el);
        if (role === 'heading') {
          const lv = parseInt(el.getAttribute('aria-level'), 10);
          const level = lv >= 1 && lv <= 6 ? lv : (/^h[1-6]$/.test(el.localName) ? +el.localName[1] : 2);
          const name = computeName(el, win, 'heading').name;
          let issue = null, barrier = null;
          if (!name) { issue = 'Empty heading'; barrier = 'Empty heading'; emptyHeadings++; }
          // Heading order / single-H1 are best practice (axe heading-order, page-has-heading-one), not A/AA SCs:
          // they are counted for headingStatus (structure descriptor) but never logged as an issue or barrier.
          if (level === 1) h1Count++;
          if (prevLevel && level > prevLevel + 1) skipCount++;
          prevLevel = level;
          headings.push({ el, level, text: name, issue });
          push({ el, category: 'heading', role: 'heading', name, states: [], hint: '', level, barrier, vis: visOf(el) });
          continue;
        }
        if (LANDMARK_ROLES.has(role)) {
          const label = labelledByText(el, doc, win) || norm(el.getAttribute('aria-label'));
          landmarks.push({ el, role, label });
          push({ el, category: 'landmark', role, name: trunc(label, 250), states: [], hint: '', level: null, barrier: null, vis: visOf(el) });
          visit(el);
          continue;
        }
        if (role === 'link') { controlItem(el, role, 'link', visOf(el)); continue; }
        if (CONTROL_ROLES.has(role)) { controlItem(el, role, 'control', visOf(el)); continue; }
        if (role === 'img') {
          imgTotal++;
          const name = computeName(el, win, 'img').name;
          let barrier = null;
          if (name) imgNamed++;
          else barrier = (el.localName === 'img' && !el.hasAttribute('alt')) ? 'Image has no alt text' : 'Image has no text alternative';
          push({ el, category: 'image', role: 'img', name, states: [], hint: '', level: null, barrier, vis: visOf(el) });
          continue;
        }
        // role=presentation/none: the element contributes no item of its own; leaf/replaced elements are dropped entirely.
        if (role === 'presentation' && /^(img|svg|hr|canvas|picture|video|audio|iframe|object|embed)$/.test(el.localName)) continue;
        if (/^(svg|canvas|video|audio|iframe|object|embed|math)$/.test(el.localName)) continue;
        visit(el);
      }
    };
    if (doc.body) visit(doc.body);
    // Visibility barrier (contract string takes precedence so the UI can match on it)
    raw.forEach((it) => {
      if (it.vis.visibility === 'hidden-visual') { it.ownBarrier = it.barrier; it.barrier = SR_HIDDEN_BARRIER; }
    });
    const items = includeHidden ? raw : raw.filter((it) => it.vis.visibility !== 'hidden-visual');
    const sequence = items.slice(0, CAPS.srSequence).map((it, index) => {
      const sp = it.category !== 'text' ? scanPosition(it.el) : '';
      return {
        index, selector: sel(it.el), category: it.category, role: it.role, name: it.name || '',
        state: (it.states || []).join(', '), hint: it.hint || '', headingLevel: it.category === 'heading' ? it.level : null,
        announcements: buildAnnouncements(it, sp), isBarrier: !!it.barrier, barrierReason: it.barrier || null,
        visibility: it.vis.visibility, visibilityReason: it.vis.reason || null
      };
    });
    return {
      sequence, barrierCount: items.filter((r) => r.barrier).length, raw, headings, landmarks, silent, placeholderOnly,
      stats: { h1Count, skipCount, emptyHeadings, interactiveTotal, interactiveNamed, imgTotal, imgNamed }
    };
  }

  /* ======================================================================
   * Tab order (CONTRACT 10.1 / 10.2) - shared by the audit and the live function
   * ==================================================================== */
  const FOCUSABLE_SEL = 'a[href], area[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
  const SKIP_RE = /\b(skip|jump|bypass)\b|main content|go to content|to content/i;

  function computeTabOrderInternal(doc, win, sel, vis) {
    vis = vis || makeVisCtx(doc, win);
    const reveals = makeFocusRevealTest(doc, win);
    const nodes = doc.querySelectorAll(FOCUSABLE_SEL);
    let stops = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.tabIndex < 0) continue;
      if (el.disabled === true) continue;
      try { if (el.matches(':disabled')) continue; } catch (e) { /* ignore */ }
      if (el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
      if (el.localName === 'summary' && !(el.parentElement && el.parentElement.localName === 'details' && el.parentElement.querySelector(':scope > summary') === el)) continue;
      const v = vis.classify(el);
      if (v.excluded) continue;
      if (v.visibility === 'sr-only') {
        // Focusable visually-hidden element: fine if a :focus rule reveals it (skip-link pattern), otherwise focus is invisible.
        if (reveals(el)) v.reason = 'Visually hidden until focused (revealed by a :focus style)';
        else { v.visibility = 'hidden-visual'; v.reason = 'Visually hidden (sr-only pattern) and not revealed on focus'; }
      }
      const a = el.getAttribute('tabindex');
      const attr = a !== null && /^\s*-?\d+\s*$/.test(a) ? parseInt(a, 10) : null;
      stops.push({ el, dom: i, ti: el.tabIndex, attr, v });
    }
    // Radio groups contribute only the checked radio, or the first one if none is checked.
    const groups = new Map();
    stops.forEach((s) => {
      if (s.el.localName !== 'input' || (s.el.type || '').toLowerCase() !== 'radio' || !s.el.name) return;
      const key = (s.el.form ? 'f' + Array.prototype.indexOf.call(doc.forms, s.el.form) : 'd') + '|' + s.el.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    if (groups.size) {
      const drop = new Set();
      groups.forEach((members) => {
        const keep = members.find((m) => m.el.checked) || members[0];
        members.forEach((m) => { if (m !== keep) drop.add(m); });
      });
      stops = stops.filter((s) => !drop.has(s));
    }
    const positive = stops.filter((s) => s.ti > 0).sort((a, b) => a.ti - b.ti || a.dom - b.dom);
    const ordered = positive.concat(stops.filter((s) => s.ti === 0));
    const sx = win.scrollX, sy = win.scrollY;
    ordered.forEach((s) => {
      const r = s.el.getBoundingClientRect();
      s.rect = { x: Math.round(r.left + sx), y: Math.round(r.top + sy), width: Math.round(r.width), height: Math.round(r.height) };
      s.anomaly = false; s.warning = null;
      if (s.v.visibility === 'hidden-visual') { s.anomaly = true; s.warning = HIDDEN_FOCUS_WARNING; }
      else if (s.v.ariaHidden) { s.anomaly = true; s.warning = ARIA_HIDDEN_WARNING; }
    });
    const anomalies = [];
    const leap = Math.max(150, Math.round(0.25 * (win.innerHeight || 800)));
    let upward = 0, backward = 0;
    // tabindex > 0 on its own is best practice (axe 'tabindex'). It is logged only when it fails WCAG 2.4.3
    // (technique F44): the stop is pulled ahead of natural stops that sit visually above it.
    const f44 = new Set(positive.filter((p) => ordered.some((n) => n.ti === 0 && n.v.visibility === 'visible' && n.rect.height > 0 && n.rect.y + n.rect.height <= p.rect.y)));
    ordered.forEach((s, i) => {
      if (s.ti > 0 && f44.has(s)) {
        s.anomaly = true; if (!s.warning) s.warning = 'Positive tabindex';
        anomalies.push({ fromIndex: i - 1, toIndex: i, type: 'positive-tabindex', message: 'tabindex="' + s.ti + '" jumps ahead of natural order' });
      }
    });
    // Leaps are measured between visible stops only (hidden stops have no meaningful position).
    const shown = ordered.map((s, i) => ({ s, i })).filter((x) => x.s.v.visibility === 'visible' && (x.s.rect.width || x.s.rect.height));
    for (let k = 1; k < shown.length; k++) {
      const a = shown[k - 1].s, b = shown[k].s, ia = shown[k - 1].i, ib = shown[k].i;
      if (a.ti > 0 || b.ti > 0) continue;
      const dy = b.rect.y - a.rect.y;
      if (dy < -leap) {
        upward++;
        b.anomaly = true; if (!b.warning) b.warning = 'Upward focus leap';
        anomalies.push({ fromIndex: ia, toIndex: ib, type: 'upward-leap', message: 'Focus jumps up ' + (-dy) + 'px' + (b.rect.y < 200 ? ' to the top of the page' : '') });
        continue;
      }
      const ov = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - Math.max(a.rect.y, b.rect.y);
      const sameRow = ov > 0.5 * Math.min(a.rect.height || 1, b.rect.height || 1);
      let rtl = false;
      try { rtl = vis.get(b.el).cs.direction === 'rtl'; } catch (e) { /* ignore */ }
      const dx = rtl ? a.rect.x - b.rect.x : b.rect.x - a.rect.x;
      if (sameRow && dx < -40) {
        backward++;
        b.anomaly = true; if (!b.warning) b.warning = 'Backward focus leap';
        anomalies.push({ fromIndex: ia, toIndex: ib, type: 'backward-leap', message: 'Focus moves backward ' + (-dx) + 'px along the same row' });
      }
    }
    anomalies.sort((p, q) => p.toIndex - q.toIndex);
    // Skip link (static, side-effect free: visible-on-focus comes from the visibility model + :focus rules)
    const skip = { present: false, functional: false, visibleOnFocus: false, selector: null };
    for (let i = 0; i < Math.min(3, ordered.length); i++) {
      const el = ordered[i].el;
      const href = (el.getAttribute('href') || '').trim();
      if (el.localName !== 'a' || href.length < 2 || href[0] !== '#') continue;
      let target = null;
      try { const id = decodeURIComponent(href.slice(1)); target = doc.getElementById(id) || doc.getElementsByName(id)[0] || null; } catch (e) { target = null; }
      const text = computeName(el, win, 'link').name;
      const targetIsMain = !!(target && (target.localName === 'main' || target.getAttribute('role') === 'main'));
      if (SKIP_RE.test(text) || targetIsMain) {
        const v = ordered[i].v;
        skip.present = true; skip.selector = sel(el); skip.functional = !!target;
        skip.visibleOnFocus = v.visibility === 'visible' || v.visibility === 'sr-only';
        break;
      }
    }
    // Disrupted: any positive tabindex, 2+ upward leaps, or 3+ anomalies. Needs Review: any other anomaly or hidden stop.
    const hiddenStops = ordered.filter((s) => s.v.visibility === 'hidden-visual' || s.v.ariaHidden).length;
    let status = 'Sequential';
    if (f44.size > 0 || upward >= 2 || anomalies.length >= 3) status = 'Disrupted';
    else if (anomalies.length || hiddenStops) status = 'Needs Review';
    const result = {
      status, total: ordered.length, positiveTabindexCount: positive.length, skipLink: skip,
      anomalies: anomalies.slice(0, 200),
      sequence: ordered.slice(0, CAPS.tabSequence).map((s, index) => ({
        index, selector: sel(s.el), role: getRole(s.el) || s.el.localName, name: computeName(s.el, win).name,
        tabindex: s.attr, rect: s.rect, isAnomaly: s.anomaly, warning: s.warning,
        visibility: s.v.visibility, visibilityReason: s.v.reason || null
      }))
    };
    return { result, ordered, positive: positive.filter((p) => f44.has(p)), upward, backward };
  }

  /* ======================================================================
   * Stage 5: Screen reader assessment
   * ==================================================================== */
  function stageScreenReader(ctx) {
    const { doc, win } = ctx;
    if (!ctx.vis) ctx.vis = makeVisCtx(doc, win);
    const sp = computeSpeechInternal(doc, win, ctx.sel, { includeHiddenVisual: true, vis: ctx.vis });
    const { headings, landmarks, silent, placeholderOnly } = sp;
    const { h1Count, skipCount, emptyHeadings, interactiveTotal, interactiveNamed, imgTotal, imgNamed } = sp.stats;
    const has = (r) => landmarks.some((l) => l.role === r);
    const lm = { banner: has('banner'), main: has('main'), navigation: has('navigation'), contentinfo: has('contentinfo') };
    let headingStatus = 'Sequential';
    if (h1Count === 0) headingStatus = 'Missing H1';
    else if (skipCount > 0) headingStatus = 'Skipped Levels';
    else if (h1Count > 1) headingStatus = 'Multiple H1';

    // Category scores (focus is filled in after stage 6)
    // WCAG-only scoring: only A/AA failures lower a category. Heading order, single H1 and landmark coverage
    // are best practice, so they are described (headingStatus / landmarkStatus / inventory) but not penalised.
    let hScore, hDetail;
    if (!headings.length) { hScore = 100; hDetail = 'No headings found.'; }
    else {
      hScore = 100 - Math.min(60, emptyHeadings * 20);
      hDetail = emptyHeadings ? emptyHeadings + ' of ' + headings.length + ' headings are empty (WCAG 1.3.1 / 2.4.6).' : headings.length + ' headings, none empty.';
    }
    const missing = Object.keys(lm).filter((k) => !lm[k]);
    const presentRoles = Object.keys(lm).filter((k) => lm[k]);
    const lScore = ctx.axeBypassFailed ? 0 : 100;
    const lDetail = ctx.axeBypassFailed ? 'No mechanism to bypass repeated blocks (WCAG 2.4.1).'
      : (presentRoles.length ? 'Landmarks present: ' + presentRoles.join(', ') + '.' : 'No landmarks present.');
    const silentCount = interactiveTotal - interactiveNamed;
    const labScore = interactiveTotal ? Math.round(100 * interactiveNamed / interactiveTotal) : 100;
    const labDetail = interactiveTotal ? silentCount + ' of ' + interactiveTotal + ' interactive controls have no accessible name.' : 'No interactive controls found.';
    const imgScore = imgTotal ? Math.round(100 * imgNamed / imgTotal) : 100;
    const imgDetail = imgTotal ? (imgTotal - imgNamed) + ' of ' + imgTotal + ' images missing alt text.' : 'No informative images found.';

    ctx.sr = {
      score: 0,
      categories: {
        headings: { score: clampN(hScore, 0, 100), weight: 25, detail: hDetail },
        landmarks: { score: lScore, weight: 20, detail: lDetail },
        labeling: { score: labScore, weight: 30, detail: labDetail },
        focus: { score: 100, weight: 15, detail: 'Tab order not evaluated.' },
        images: { score: imgScore, weight: 10, detail: imgDetail }
      },
      headings: headings.slice(0, CAPS.headings).map((h) => ({ level: h.level, text: h.text, selector: ctx.sel(h.el), issue: h.issue })),
      headingStatus,
      landmarks: Object.assign(lm, { list: landmarks.slice(0, CAPS.landmarks).map((l) => ({ role: l.role, label: l.label, selector: ctx.sel(l.el) })) }),
      landmarkStatus: missing.length ? 'Incomplete' : 'Verified',
      silentControls: silent.slice(0, CAPS.silent).map((s) => ({ selector: ctx.sel(s.el), role: s.role, html: outerHtml(s.el) })),
      barrierCount: sp.barrierCount,
      sequence: sp.sequence
    };
    if (placeholderOnly.length) {
      ctx.violations.push(makeViolation({ id: 'af-placeholder-label', source: 'aria', impact: 'serious',
        title: 'Form field is labelled only by its placeholder',
        description: 'Placeholder text disappears on input and is not a reliable label; give the field a visible <label>.',
        wcag: ['3.3.2'], tags: ['wcag2a', 'af-aria'],
        nodes: placeholderOnly.map((el) => makeNode(ctx, el, 'Only placeholder "' + trunc(norm(el.getAttribute('placeholder')), 80) + '" names this field.',
          { html: '<label for="' + (el.getAttribute('id') || 'field-id') + '">' + trunc(norm(el.getAttribute('placeholder')), 60) + '</label>', note: 'Add a visible label associated with the field.' })) }));
    }
    // af-hidden-announced: non-focusable content read by AT but not visible, grouped per hiding container.
    const groups = new Map();
    sp.raw.forEach((it) => {
      if (it.vis.visibility !== 'hidden-visual') return;
      const focusable = it.el.tabIndex >= 0 && !it.el.disabled && (it.category === 'link' || it.category === 'control' || it.el.hasAttribute('tabindex'));
      if (focusable) return; // reported as af-hidden-focusable by the tab stage
      const key = it.vis.causeEl || it.el;
      if (!groups.has(key)) groups.set(key, { reason: it.vis.reason, items: [] });
      groups.get(key).items.push(it);
    });
    if (groups.size) {
      const nodes = [];
      groups.forEach((g, el) => {
        const sample = g.items.slice(0, 4).map((it) => '"' + trunc(it.name || it.role, 50) + '"').join(', ');
        nodes.push(makeNode(ctx, el, g.items.length + ' item' + (g.items.length > 1 ? 's' : '') + ' announced but not visible (' + g.reason + '): ' + sample + (g.items.length > 4 ? ', …' : '') + '.',
          { note: 'Hide collapsed content with display:none, the hidden attribute or visibility:hidden so screen readers skip it too, or make it visible.' }));
      });
      ctx.violations.push(makeViolation({ id: 'af-hidden-announced', source: 'aria', impact: 'moderate',
        title: 'Content is announced by screen readers but not visible',
        description: 'Visually collapsed or transparent content stays in the accessibility tree, so screen-reader users hear content sighted users cannot see.',
        wcag: ['1.3.2'], tags: ['wcag2a', 'af-aria', 'af-visibility'], nodes }));
    }
  }

  /* ======================================================================
   * Stage 6: Tab order
   * ==================================================================== */
  function stageTabOrder(ctx) {
    const { doc, win } = ctx;
    if (!ctx.vis) ctx.vis = makeVisCtx(doc, win);
    const t = computeTabOrderInternal(doc, win, ctx.sel, ctx.vis);
    const { ordered, positive } = t;
    // Keyboard-inaccessible interactive elements
    const inacc = [];
    doc.querySelectorAll('[role], [onclick]').forEach((el) => {
      if (inacc.length >= CAPS.nodesPerViolation) return;
      const v = ctx.vis.classify(el);
      if (v.excluded || v.ariaHidden) return;
      if (isKeyboardInaccessible(el, getRole(el))) inacc.push(el);
    });
    ctx.notFocusableCount = inacc.length;
    ctx.tab = t.result;
    ctx.tabStats = { upward: t.upward, backward: t.backward, f44: positive.length, hidden: ordered.filter((s) => s.v.visibility === 'hidden-visual' || s.v.ariaHidden).length };
    if (positive.length) {
      ctx.violations.push(makeViolation({ id: 'af-positive-tabindex', source: 'tab', impact: 'moderate', title: 'Positive tabindex disrupts focus order',
        description: 'A tabindex greater than 0 moves focus ahead of content that comes earlier in the visual order (WCAG 2.4.3, failure F44).', wcag: ['2.4.3'], tags: ['wcag2a', 'af-tab'],
        nodes: positive.map((s) => makeNode(ctx, s.el, 'tabindex="' + s.ti + '"', { html: startTagWith(s.el, 'tabindex', null), note: 'Remove the tabindex or use 0.' })) }));
    }
    if (inacc.length) {
      ctx.violations.push(makeViolation({ id: 'af-not-focusable', source: 'tab', impact: 'serious', title: 'Interactive element is not keyboard focusable',
        description: 'Elements with an interactive role or click handler must be reachable and operable by keyboard.', wcag: ['2.1.1'], tags: ['wcag2a', 'af-tab'],
        nodes: inacc.map((el) => makeNode(ctx, el, 'role="' + (el.getAttribute('role') || 'none') + '" with no tabindex; keyboard users cannot reach it.',
          { html: startTagWith(el, 'tabindex', '0'), note: 'Prefer a native <button>/<a href>; otherwise add tabindex="0" and Enter/Space key handlers.' })) }));
    }
    const hidden = ordered.filter((s) => s.v.visibility === 'hidden-visual' || s.v.ariaHidden);
    if (hidden.length) {
      ctx.violations.push(makeViolation({ id: 'af-hidden-focusable', source: 'tab', impact: 'serious', title: 'Keyboard focus lands on content that is not visible',
        description: 'These elements receive keyboard focus while hidden from view (collapsed, transparent, off-screen or clipped) or while inside aria-hidden="true".',
        wcag: ['2.4.7', '2.4.11'], tags: ['wcag2aa', 'wcag22aa', 'af-tab', 'af-visibility'],
        nodes: hidden.map((s) => {
          const aria = s.v.visibility !== 'hidden-visual';
          return makeNode(ctx, s.el,
            aria ? ARIA_HIDDEN_WARNING + ' (aria-hidden="true" on ' + describeEl(s.v.ariaHiddenEl || s.el) + '): keyboard users reach it but screen readers announce nothing.'
              : HIDDEN_FOCUS_WARNING + ': ' + s.v.reason + '.',
            { note: aria ? 'Remove aria-hidden, or make the hidden subtree unfocusable (inert, display:none or tabindex="-1").'
              : 'While hidden, remove it from the tab order (display:none, the hidden attribute, visibility:hidden or inert); otherwise make it visible when focused.' });
        }) }));
    }
  }

  /** Focus category: only WCAG A/AA failures count (2.4.3 order, 2.1.1 keyboard, 2.4.7/2.4.11 hidden focus, 2.4.1 broken skip link).
   *  A missing skip link is not penalised: 2.4.1 can be met by headings/landmarks, and axe 'bypass' covers the A-level failure. */
  function finalizeFocusCategory(ctx) {
    if (!ctx.sr || !ctx.tab) return;
    const t = ctx.tab, st = ctx.tabStats || { upward: 0, backward: 0, f44: 0, hidden: 0 };
    const nf = ctx.notFocusableCount || 0;
    let s = 100 - Math.min(40, 10 * (st.f44 || 0));
    if (t.skipLink.present) { if (!t.skipLink.functional) s -= 5; if (!t.skipLink.visibleOnFocus) s -= 5; }
    s -= Math.min(30, 10 * st.upward) + Math.min(15, 5 * st.backward) + Math.min(20, 10 * nf) + Math.min(20, 5 * (st.hidden || 0));
    const parts = [];
    if (st.f44) parts.push(st.f44 + ' positive tabindex breaking the visual order (2.4.3)');
    if (t.skipLink.present) { if (!t.skipLink.functional) parts.push('skip link target missing (2.4.1)'); if (!t.skipLink.visibleOnFocus) parts.push('skip link not visible on focus (2.4.7)'); }
    if (st.upward) parts.push(st.upward + ' upward focus leap' + (st.upward > 1 ? 's' : '') + ' (2.4.3)');
    if (st.backward) parts.push(st.backward + ' backward focus leap' + (st.backward > 1 ? 's' : '') + ' (2.4.3)');
    if (nf) parts.push(nf + ' interactive element' + (nf > 1 ? 's' : '') + ' not keyboard focusable (2.1.1)');
    if (st.hidden) parts.push(st.hidden + ' focus stop' + (st.hidden > 1 ? 's' : '') + ' not visible (2.4.7)');
    ctx.sr.categories.focus = { score: clampN(s, 0, 100), weight: 15, detail: parts.length ? cap1(parts.join('; ')) + '.' : 'No keyboard focus failures found.' };
  }
  function finalizeSrScore(ctx) {
    if (!ctx.sr) return;
    const c = ctx.sr.categories;
    ctx.sr.score = Math.round(Object.keys(c).reduce((acc, k) => acc + c[k].score * c[k].weight, 0) / 100);
  }

  /* ======================================================================
   * Stage 7: Links
   * ==================================================================== */
  const GENERIC_LINK_TEXT = new Set(['click here', 'here', 'click', 'read more', 'more', 'learn more', 'link', 'this', 'go', 'details', 'more info',
    'more information', 'continue', 'see more', 'view more', 'tap here', 'this link', 'click this', 'find out more', 'info', 'view', 'see details']);
  // WCAG-only: empty href, javascript:void / "#" placeholders, target=_blank without rel=noopener and broken
  // in-page anchors (other than skip links) are functional/security best practice with no A/AA SC, so they are not logged.
  const LINK_META = {
    'generic-text': { title: 'Link purpose cannot be determined', description: 'Link text such as "click here" has no surrounding context (sentence, list item, cell or aria-describedby) that explains the destination.', wcag: ['2.4.4'] },
    'broken-anchor': { title: 'Skip link points to a missing target', description: 'The bypass link fragment does not match any element, so it cannot skip repeated content.', wcag: ['2.4.1'] },
    'no-text': { title: 'Link has no accessible name', description: 'The link has no text, alt text or aria-label, so its purpose cannot be determined.', wcag: ['2.4.4', '4.1.2'] }
  };

  /** 2.4.4 allows purpose from programmatically determined context: enclosing sentence/paragraph, list item, cell, or aria-describedby/title. */
  function linkHasContext(el) {
    if (norm(el.getAttribute('title')) || norm(el.getAttribute('aria-describedby'))) return true;
    const block = el.closest('p, li, td, th, dd, dt, figcaption, caption, blockquote');
    if (!block) return false;
    const rest = loose(block.textContent).replace(loose(el.textContent), ' ');
    return hasAlnum(rest);
  }

  function stageLinks(ctx) {
    const { doc, win } = ctx;
    const anchors = doc.querySelectorAll('a[href], area[href]');
    const out = emptyLinks();
    const byType = {};
    const pageBase = String(win.location.href).split('#')[0];
    const linkVis = ctx.vis || makeVisCtx(doc, win);
    for (let i = 0; i < anchors.length; i++) {
      const el = anchors[i];
      if (isExtensionElement(el)) continue;
      const raw = (el.getAttribute('href') || '').trim();
      let url = null;
      try { url = new URL(raw, doc.baseURI); } catch (e) { url = null; }
      const isAnchor = raw.startsWith('#');
      const isJs = /^javascript:/i.test(raw);
      const protocol = raw === '' ? '' : (url ? url.protocol : '');
      const isExternal = !!url && !isAnchor && /^https?:$/.test(url.protocol) && url.origin !== win.location.origin;
      const href = (raw === '' || isAnchor || isJs) ? raw : (url ? url.href : raw);
      let text = norm(el.innerText || '');
      if (!text && linkVis.classify(el).excluded) text = norm(el.textContent); // not rendered (closed details etc.): innerText is empty
      if (!text) text = norm(Array.prototype.map.call(el.querySelectorAll('img[alt]'), (im) => im.getAttribute('alt')).join(' '));
      if (el.localName === 'area') text = norm(el.getAttribute('alt'));
      const name = computeName(el, win, 'link').name;
      const iss = [];
      if (raw !== '' && !isJs && raw !== '#') {
        let frag = null;
        if (isAnchor && !/^#[!/]/.test(raw)) frag = raw.slice(1);
        else if (url && url.hash && url.hash.length > 1 && url.href.split('#')[0] === pageBase && !/^#[!/]/.test(url.hash)) frag = url.hash.slice(1);
        if (frag) {
          let id = frag;
          try { id = decodeURIComponent(frag); } catch (e) { /* keep raw */ }
          if (id.toLowerCase() !== 'top' && !doc.getElementById(id) && !doc.getElementsByName(id).length && SKIP_RE.test(name || text)) {
            iss.push({ type: 'broken-anchor', severity: 'serious', message: 'Skip link target "' + trunc(id, 80) + '" does not exist.' });
          }
        }
      }
      const target = el.getAttribute('target');
      const rel = el.getAttribute('rel');
      if (!text && !name) {
        iss.push({ type: 'no-text', severity: 'serious', message: 'Link has no text or accessible name.' });
      } else if (GENERIC_LINK_TEXT.has(loose(name || text)) && !linkHasContext(el)) {
        iss.push({ type: 'generic-text', severity: 'moderate', message: 'Generic link text with no programmatic context.' });
      }
      out.total++;
      if (isAnchor) out.anchors++; else if (isExternal) out.external++; else out.internal++;
      const status = iss.some((x) => x.severity === 'serious' || x.severity === 'critical') ? 'error' : iss.length ? 'warning' : 'ok';
      out.counts[status]++;
      if (out.list.length < CAPS.links || (iss.length && out.issues.length < CAPS.links)) {
        const selector = ctx.sel(el);
        if (out.list.length < CAPS.links) {
          out.list.push({ selector, href: trunc(href, 500), text: trunc(text, 200), protocol, isExternal, target: target, rel: rel, status, issueTypes: iss.map((x) => x.type) });
        }
        iss.forEach((x) => {
          if (out.issues.length < CAPS.links) out.issues.push({ selector, href: trunc(href, 500), text: trunc(text, 200), type: x.type, severity: x.severity, message: x.message });
          (byType[x.type] = byType[x.type] || []).push({ el, x, text });
        });
      }
    }
    ctx.links = out;
    Object.keys(byType).forEach((type) => {
      const meta = LINK_META[type];
      const items = byType[type];
      const nodes = items.slice(0, CAPS.nodesPerViolation).map(({ el, x, text }) => {
        let fix;
        if (type === 'generic-text') fix = { note: 'Describe the destination, e.g. "View delivery options", or place the link in a sentence that explains it.' };
        else if (type === 'broken-anchor') fix = { note: 'Point the skip link at the main content id (e.g. <main id="main">).' };
        else fix = { note: 'Add visible link text that describes the destination.' };
        return makeNode(ctx, el, x.message + (text ? ' Text: "' + trunc(text, 80) + '"' : ''), fix);
      });
      ctx.violations.push(makeViolation({ id: 'af-link-' + type, source: 'link', impact: worstImpact(items.map((i) => i.x.severity)), title: meta.title,
        description: meta.description, wcag: meta.wcag, tags: ['wcag2a', 'af-link'], nodes }));
    });
  }

  /* ======================================================================
   * Stage 8: Mobile
   * ==================================================================== */
  function stageMobile(ctx) {
    const { doc, win } = ctx;
    const res = analyzeMobileInternal(win);
    const a = res.analysis;
    const devices = estimateDevices(doc, win, ctx.sel, a);
    ctx.mobile = Object.assign({}, a, { devices });
    const aa = res.failEls.filter((f) => f.level === 'AA');
    if (aa.length) {
      ctx.violations.push(makeViolation({ id: 'af-target-size', source: 'mobile', impact: 'moderate', title: 'Touch target smaller than 24×24px (WCAG 2.5.8)',
        description: 'Interactive targets must be at least 24 by 24 CSS pixels.', wcag: ['2.5.8'], tags: ['wcag22aa', 'af-mobile'],
        nodes: aa.slice(0, CAPS.nodesPerViolation).map((f) => makeNode(ctx, f.el, f.width + '×' + f.height + 'px',
          { css: ctx.sel(f.el) + ' { min-width: 24px; min-height: 24px; }' })) }));
    }
    const vm = a.viewportMeta;
    if (res.metaEl && (vm.userScalableNo || vm.maxScaleRestricted)) {
      const parts = [];
      if (vm.userScalableNo) parts.push('user-scalable=no');
      if (vm.maxScaleRestricted) parts.push((/maximum-scale\s*=\s*[^,;]*/i.exec(vm.content || '') || ['maximum-scale'])[0].replace(/\s/g, ''));
      const cleaned = String(vm.content || '').split(/[,;]/).map((p) => p.trim()).filter((p) => p && !/^(user-scalable|maximum-scale)\s*=/i.test(p)).join(', ');
      ctx.violations.push(makeViolation({ id: 'af-viewport-zoom', source: 'mobile', impact: 'minor', title: 'Viewport disables zoom',
        description: 'user-scalable=no / maximum-scale below 2 prevents pinch zoom (WCAG 1.4.4).', wcag: ['1.4.4'], tags: ['wcag2aa', 'af-mobile'],
        nodes: [makeNode(ctx, res.metaEl, parts.join(', '), { html: '<meta name="viewport" content="' + (cleaned || 'width=device-width, initial-scale=1') + '">' })] }));
    }
  }

  /* ======================================================================
   * Scoring (spec 5.2)
   * ==================================================================== */
  function scoreFrom(counts) {
    const penalty = (counts.critical * 12) + (counts.serious * 6) + (counts.moderate * 3) + (counts.minor * 1);
    return Math.max(12, Math.min(100, Math.round(100 - penalty)));
  }
  function gradeFor(score) {
    if (score >= 95) return { grade: 'A+', risk: 'Low' };
    if (score >= 88) return { grade: 'A', risk: 'Low' };
    if (score >= 75) return { grade: 'B', risk: 'Moderate' };
    if (score >= 60) return { grade: 'C', risk: 'High' };
    return { grade: 'F', risk: 'Severe' };
  }

  /* ======================================================================
   * Orchestration
   * ==================================================================== */
  async function runAudit(options) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const doc = document, win = window;
    const ctx = {
      doc, win, options: options || {}, sel: makeSelectorGen(doc), stageErrors: [], violations: [],
      axeVersion: (win.axe && win.axe.version) || 'unknown', axePasses: 0, axeIncomplete: 0,
      sr: null, tab: null, links: null, mobile: null
    };
    const stage = async (name, fn) => {
      try { await fn(); } catch (e) { ctx.stageErrors.push(name + ': ' + errMsg(e)); }
    };
    await stage('reset', () => {
      try { if (typeof win.__auditforgeClearAll === 'function') win.__auditforgeClearAll(); } catch (e) { ctx.stageErrors.push('reset: __auditforgeClearAll threw: ' + errMsg(e)); }
      clearHoverSim(doc);
    });
    await stage('axe', () => stageAxe(ctx));
    await stage('aria', () => stageAria(ctx));
    await stage('hover', () => stageHover(ctx));
    await stage('screenReader', () => stageScreenReader(ctx));
    await stage('tabOrder', () => stageTabOrder(ctx));
    await stage('links', () => stageLinks(ctx));
    await stage('mobile', () => stageMobile(ctx));

    const sr = ctx.sr || emptyScreenReader(ctx.stageErrors.some((e) => e.startsWith('screenReader')) ? 'Stage failed' : 'Not evaluated');
    ctx.sr = sr;
    try {
      if (ctx.tab) finalizeFocusCategory(ctx);
      else if (ctx.sr.sequence.length) ctx.sr.categories.focus = { score: 0, weight: 15, detail: 'Tab order analysis failed.' };
      finalizeSrScore(ctx);
    } catch (e) { ctx.stageErrors.push('finalize: ' + errMsg(e)); }

    // WCAG-only safety net: keep A/AA SCs only; drop anything best-practice or without an A/AA SC.
    const violations = ctx.violations
      .map((v) => Object.assign(v, { wcag: (v.wcag || []).filter((sc) => WCAG_A_AA_SC.has(sc)) }))
      .filter((v) => v.wcag.length > 0 && (v.tags || []).indexOf('best-practice') === -1 && v.nodes.length > 0)
      .sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]);
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    violations.forEach((v) => { counts[v.impact]++; });
    const score = scoreFrom(counts);
    const gr = gradeFor(score);
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const result = {
      meta: {
        url: String(win.location.href), title: doc.title || '', timestamp: new Date().toISOString(), durationMs: Math.round(t1 - t0),
        toolVersion: TOOL_VERSION, viewport: { width: win.innerWidth, height: win.innerHeight }, axeVersion: ctx.axeVersion,
        stageErrors: ctx.stageErrors
      },
      summary: {
        score, grade: gr.grade, risk: gr.risk, counts, totalViolations: violations.length,
        totalNodes: violations.reduce((n, v) => n + v.nodes.length, 0), passes: ctx.axePasses, incomplete: ctx.axeIncomplete
      },
      violations,
      screenReader: sr,
      tabOrder: ctx.tab || emptyTabOrder(),
      links: ctx.links || emptyLinks(),
      mobile: ctx.mobile || emptyMobile(win)
    };
    return jsonClean(result);
  }

  let inflight = null;
  window.__runWcagAudit = function (options) {
    if (inflight) return inflight;
    inflight = runAudit(options).catch((e) => jsonClean({
      meta: { url: String(location.href), title: document.title || '', timestamp: new Date().toISOString(), durationMs: 0, toolVersion: TOOL_VERSION,
        viewport: { width: innerWidth, height: innerHeight }, axeVersion: (window.axe && window.axe.version) || 'unknown', stageErrors: ['fatal: ' + errMsg(e)] },
      summary: { score: 0, grade: 'F', risk: 'Severe', counts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, totalViolations: 0, totalNodes: 0, passes: 0, incomplete: 0 },
      violations: [], screenReader: emptyScreenReader('Stage failed'), tabOrder: emptyTabOrder(), links: emptyLinks(), mobile: emptyMobile(window)
    })).finally(() => { inflight = null; });
    return inflight;
  };
  /** Live: tab order of the CURRENT DOM state (CONTRACT 10.2). Side-effect free, JSON-clean. */
  window.__auditforgeComputeTabOrder = function () {
    try { return jsonClean(computeTabOrderInternal(document, window, makeSelectorGen(document)).result); }
    catch (e) { return emptyTabOrder(); }
  };
  /** Live: screen-reader sequence of the CURRENT DOM state (CONTRACT 10.2). options = { includeHiddenVisual?: boolean = true } */
  window.__auditforgeComputeSpeechSequence = function (options) {
    try {
      const r = computeSpeechInternal(document, window, makeSelectorGen(document), { includeHiddenVisual: !(options && options.includeHiddenVisual === false) });
      return jsonClean({ sequence: r.sequence, barrierCount: r.barrierCount });
    } catch (e) { return { sequence: [], barrierCount: 0 }; }
  };
  window.__auditforgeIsExtensionElement = isExtensionElement;
  window.__auditforgeAnalyzeMobileLayout = analyzeMobileLayout;
  window.__auditforgeContrast = { parseColor, relativeLuminance, getContrastRatio, calculateColorContrastFix };
})();


/*!
 * Mattccessibility Tool v1.4.0 - in-page overlays (parts/overlays.js)
 *
 * Spec coverage: §5.3 (screen-reader HUD + earcons), §5.4.3 (mobile simulator),
 * §5.5 (tab trail), §5.6 (vision suite), §5.7 (highlighter + CSS fix preview).
 * Interface: CONTRACT §3. Concatenated AFTER engine.js into content/audit-runner.js
 * and injected into the ISOLATED world, possibly more than once (guarded below).
 *
 * Design notes
 *  - Interactive overlay UI lives in shadow roots on prefixed host elements and is
 *    promoted to the browser top layer (popover="manual") when supported. Top-layer
 *    content is painted outside <html>, so vision filters applied to
 *    document.documentElement do not distort the extension's own UI, and
 *    position:fixed keeps working while <html> carries a filter.
 *  - Only two global <style> elements are ever created (vision filter, fix preview);
 *    both are removed on reset. No attributes or inline styles are written to page
 *    elements. __auditforgeClearAll() returns the page to pristine.
 *  - Engine helpers (__auditforgeAnalyzeMobileLayout) are feature-detected.
 */
(() => {
  if (window.__auditforgeOverlaysLoaded) return;
  window.__auditforgeOverlaysLoaded = true;

  const W = window;
  const D = document;
  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */
  const PAL = {
    bg: '#0D0D11', card: '#16161F', border: '#222230',
    cyan: '#00D1FF', magenta: '#EC5D87', amber: '#FFB800', green: '#00E676',
    text: '#F4F4F8', muted: '#B4B4C6', red: '#FF3B30'
  };
  const IMPACT_COLORS = { critical: '#FF3B30', serious: '#FF9500', moderate: '#FFCC00', minor: '#00D1FF' };

  const IDS = {
    highlight: '__auditforge_highlighter_root__',
    tabTrail: '__auditforge_tab_trail_svg__',
    tabTrailBar: '__auditforge_tab_trail_bar__',
    hud: '__auditforge_voiceover_hud__',
    mobile: '__auditforge_mobile_sim_root__',
    visionRoot: '__auditforge_vision_root__',
    visionStyle: '__auditforge_vision_style__',
    visionDefs: '__auditforge_vision_defs__',
    fixStyle: '__auditforge_fix_preview_style__',
    fixPill: '__auditforge_fix_preview_pill__'
  };

  const DEVICES = [
    { id: 'iphone-16-pro', name: 'Apple iPhone 16 / 15 Pro', w: 393, h: 852, kind: 'island' },
    { id: 'iphone-se', name: 'Apple iPhone SE', w: 375, h: 667, kind: 'classic' },
    { id: 'galaxy-s24', name: 'Samsung Galaxy S24', w: 360, h: 780, kind: 'punch' },
    { id: 'pixel-8', name: 'Google Pixel 8', w: 412, h: 915, kind: 'punch' },
    { id: 'iphone-16-pro-max', name: 'Apple iPhone 16 Pro Max', w: 430, h: 932, kind: 'island' }
  ];

  // CVD matrices: exact values from spec §5.6.
  const LENSES = {
    protanopia: { label: 'Protanopia', desc: 'Red-blind colour vision', kind: 'matrix',
      m: '0.567, 0.433, 0.000, 0, 0  0.558, 0.442, 0.000, 0, 0  0.000, 0.242, 0.758, 0, 0  0.000, 0.000, 0.000, 1, 0' },
    deuteranopia: { label: 'Deuteranopia', desc: 'Green-blind colour vision', kind: 'matrix',
      m: '0.625, 0.375, 0.000, 0, 0  0.700, 0.300, 0.000, 0, 0  0.000, 0.300, 0.700, 0, 0  0.000, 0.000, 0.000, 1, 0' },
    tritanopia: { label: 'Tritanopia', desc: 'Blue-blind colour vision', kind: 'matrix',
      m: '0.950, 0.050, 0.000, 0, 0  0.000, 0.433, 0.567, 0, 0  0.000, 0.475, 0.525, 0, 0  0.000, 0.000, 0.000, 1, 0' },
    achromatopsia: { label: 'Achromatopsia', desc: 'Total colour blindness (monochromacy)', kind: 'matrix',
      m: '0.299, 0.587, 0.114, 0, 0  0.299, 0.587, 0.114, 0, 0  0.299, 0.587, 0.114, 0, 0  0.000, 0.000, 0.000, 1, 0' },
    cataracts: { label: 'Cataracts', desc: 'Clouded, low-contrast, glare-prone lens', kind: 'css', css: 'blur(4px) contrast(0.7) brightness(1.15)' },
    glaucoma: { label: 'Glaucoma', desc: 'Peripheral tunnel vision (follows cursor)', kind: 'mask' },
    macular: { label: 'Macular Degeneration', desc: 'Central scotoma (follows cursor)', kind: 'mask' },
    'diabetic-retinopathy': { label: 'Diabetic Retinopathy', desc: 'Drifting patchy retinal scotomas', kind: 'patches' },
    'low-contrast': { label: 'Reduced Contrast Sensitivity', desc: 'Washed-out contrast', kind: 'css', css: 'contrast(0.4) brightness(0.95)' },
    myopia: { label: 'Severe Myopia', desc: 'Severe short-sightedness blur', kind: 'css', css: 'blur(8px)' },
    photophobia: { label: 'Photophobia', desc: 'High-contrast dark inverted rendering', kind: 'css', css: 'invert(1) hue-rotate(180deg)' },
    astigmatism: { label: 'Astigmatism / Diplopia', desc: 'Directional distortion with double-vision ghosting', kind: 'svg' },
    'visual-snow': { label: 'Visual Snow Syndrome', desc: 'Persistent dynamic TV-static grain', kind: 'snow' }
  };

  const PERSONAS = {
    voiceover: { name: 'Apple iOS VoiceOver', short: 'VoiceOver', mode: 'touch', rotor: 'Rotor 🔄', rotorName: 'Rotor', rate: 1.05, pitch: 1.0 },
    talkback: { name: 'Android TalkBack', short: 'TalkBack', mode: 'touch', rotor: 'Granularity 🔠', rotorName: 'Granularity', rate: 1.1, pitch: 1.0 },
    nvda: { name: 'NVDA', short: 'NVDA', mode: 'keys', rotor: 'Elements List 🔄', rotorName: 'Elements list', rate: 1.15, pitch: 0.95 },
    narrator: { name: 'Windows Narrator', short: 'Narrator', mode: 'keys', rotor: 'Scan Category 🔄', rotorName: 'Scan category', rate: 1.0, pitch: 1.0 }
  };

  const ROTOR = [
    { id: 'all', label: 'All items' },
    { id: 'heading', label: 'Headings' },
    { id: 'link', label: 'Links' },
    { id: 'control', label: 'Form controls' },
    { id: 'landmark', label: 'Landmarks' }
  ];
  const QUICK_KEYS = { h: 'heading', k: 'link', f: 'control', d: 'landmark' };

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */
  const reducedMotion = () => { try { return W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const errOut = (e) => ({ ok: false, error: String((e && e.message) || e || 'Unknown error') });
  const safe = (fn) => function () { try { return fn.apply(this, arguments); } catch (e) { return errOut(e); } };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const truncate = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => { try { W.requestAnimationFrame(() => r()); } catch (e) { setTimeout(r, 16); } });

  function qs(sel, root) {
    if (!sel || typeof sel !== 'string') return null;
    try { return (root || D).querySelector(sel); } catch (e) { return null; }
  }

  // Fire-and-forget message to the popup; silently ignored when the popup is closed or runtime is absent.
  function sendMsg(msg) {
    try {
      const c = (typeof chrome !== 'undefined' && chrome) || W.chrome; // eslint-disable-line no-undef
      const rt = c && c.runtime;
      if (rt && rt.id && typeof rt.sendMessage === 'function') {
        rt.sendMessage(msg, () => { try { void rt.lastError; } catch (e) { /* popup closed */ } });
      }
    } catch (e) { /* popup closed or runtime unavailable */ }
  }
  function notify(overlay) { sendMsg({ type: 'AF_OVERLAY_CLOSED', overlay }); }

  /* Live DOM watching (CONTRACT §10.3). Mutations caused by our own nodes are ignored. */
  const WATCH_ATTRS = ['class', 'style', 'hidden', 'disabled', 'tabindex', 'aria-hidden', 'aria-expanded', 'open', 'inert'];
  function isOwnNode(n) {
    try {
      let el = n && n.nodeType === 1 ? n : (n && n.parentNode);
      for (; el && el.nodeType === 1; el = el.parentNode) {
        const id = el.id || '';
        const cls = typeof el.className === 'string' ? el.className : ((el.className && el.className.baseVal) || '');
        if (/^__(af|auditforge)_/.test(id) || /(^|\s)__af_/.test(cls)) return true;
      }
    } catch (e) {}
    return false;
  }
  function relevantMutation(r) {
    if (isOwnNode(r.target)) return false;
    if (r.type === 'childList') {
      const nodes = Array.from(r.addedNodes).concat(Array.from(r.removedNodes));
      if (nodes.length && nodes.every(isOwnNode)) return false;
    }
    return true;
  }
  // Debounced (trailing 250ms, max wait 1s so continuous animation can't starve updates).
  function makeLiveWatcher(onChange, delay) {
    delay = delay || 250;
    const bucket = [];
    let timer = 0, first = 0, mo = null;
    const fire = () => { timer = 0; first = 0; try { onChange(); } catch (e) {} };
    const schedule = () => {
      const now = Date.now();
      if (!first) first = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, now - first > 1000 ? 0 : delay);
    };
    try {
      mo = new MutationObserver((recs) => { for (let i = 0; i < recs.length; i++) if (relevantMutation(recs[i])) { schedule(); return; } });
      mo.observe(D, { childList: true, subtree: true, attributes: true, attributeFilter: WATCH_ATTRS });
    } catch (e) { mo = null; }
    const ev = (e) => { if (eventInOwnUi(e) || isOwnNode(e.target)) return; schedule(); };
    ['transitionend', 'animationend', 'input', 'change'].forEach((t) => listen(bucket, D, t, ev, true));
    listen(bucket, W, 'resize', schedule, { passive: true });
    return { stop() { if (mo) mo.disconnect(); mo = null; drain(bucket); if (timer) clearTimeout(timer); timer = 0; }, schedule };
  }

  // Tiny element factory. Text is always assigned via textContent (never innerHTML).
  function h(tag, props) {
    const el = D.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => append(el, x)); return; }
    el.appendChild(typeof c === 'string' ? D.createTextNode(c) : c);
  }
  function svg(tag, attrs) {
    const el = D.createElementNS(SVGNS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  function btn(label, onClick, opts) {
    opts = opts || {};
    return h('button', {
      type: 'button', class: '__af_btn ' + (opts.cls || ''), 'aria-label': opts.aria, title: opts.title,
      'aria-pressed': opts.pressed, 'aria-expanded': opts.expanded, 'aria-controls': opts.controls,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); }
    }, label);
  }
  function listen(bucket, target, type, fn, opts) {
    try { target.addEventListener(type, fn, opts); bucket.push(() => { try { target.removeEventListener(type, fn, opts); } catch (e) {} }); } catch (e) {}
  }
  function drain(bucket) { while (bucket && bucket.length) { try { bucket.pop()(); } catch (e) {} } }
  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(t.type || '');
    return false;
  }
  function vw() { return W.innerWidth || D.documentElement.clientWidth || 0; }
  function vh() { return W.innerHeight || D.documentElement.clientHeight || 0; }

  /* ------------------------------------------------------------------ */
  /* Shadow host + top-layer mounting                                    */
  /* ------------------------------------------------------------------ */
  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const MONO = 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
  const BASE_CSS = `
    *, *::before, *::after { box-sizing: border-box; }
    .__af_glass { background: rgba(22,22,31,.86); -webkit-backdrop-filter: blur(16px) saturate(150%); backdrop-filter: blur(16px) saturate(150%);
      border: 1px solid rgba(255,255,255,.10); box-shadow: 0 12px 40px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      color: ${PAL.text}; font: 13px/1.45 ${FONT}; border-radius: 14px; pointer-events: auto; }
    .__af_btn { appearance: none; -webkit-appearance: none; font: 600 13px/1.2 ${FONT}; color: ${PAL.text}; background: ${PAL.border};
      border: 1px solid #3a3a52; border-radius: 10px; padding: 7px 12px; min-height: 32px; cursor: pointer; white-space: nowrap;
      transition: background .15s, border-color .15s, transform .1s; }
    .__af_btn:hover { background: #2d2d42; border-color: ${PAL.cyan}; }
    .__af_btn:active { transform: translateY(1px); }
    .__af_btn:focus-visible { outline: 2px solid ${PAL.cyan}; outline-offset: 2px; }
    .__af_btn_primary { background: ${PAL.cyan}; color: ${PAL.bg}; border-color: ${PAL.cyan}; }
    .__af_btn_primary:hover { background: #5fe3ff; }
    .__af_btn_icon { min-width: 32px; padding: 0 8px; }
    .__af_mono { font-family: ${MONO}; font-size: 12px; }
    .__af_muted { color: ${PAL.muted}; }
    .__af_chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font: 700 11px/1.5 ${FONT};
      letter-spacing: .03em; background: ${PAL.border}; color: ${PAL.text}; border: 1px solid #3a3a52; white-space: nowrap; }
    .__af_sr { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `;

  function hostStyle(host) {
    const s = host.style;
    const set = (p, v) => s.setProperty(p, v, 'important');
    set('position', 'fixed'); set('inset', '0'); set('top', '0'); set('left', '0'); set('right', '0'); set('bottom', '0');
    set('width', '100%'); set('height', '100%'); set('max-width', 'none'); set('max-height', 'none');
    set('margin', '0'); set('padding', '0'); set('border', '0'); set('background', 'transparent'); set('overflow', 'visible');
    set('pointer-events', 'none'); set('z-index', '2147483647'); set('display', 'block'); set('color-scheme', 'dark');
    set('filter', 'none'); set('transform', 'none'); set('opacity', '1'); set('visibility', 'visible');
  }

  function mountHost(id, css) {
    const old = D.getElementById(id);
    if (old) old.remove();
    const host = D.createElement('div');
    host.id = id;
    hostStyle(host);
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: BASE_CSS + (css || '') }));
    (D.body || D.documentElement).appendChild(host);
    if (typeof host.showPopover === 'function') {
      try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch (e) { /* fallback: plain fixed layer */ }
    }
    return { host, root };
  }
  function unmount(host) { if (!host) return; try { if (host.hidePopover && host.matches(':popover-open')) host.hidePopover(); } catch (e) {} try { host.remove(); } catch (e) {} }

  /* ------------------------------------------------------------------ */
  /* Escape stack + global key routing                                   */
  /* ------------------------------------------------------------------ */
  const STACK = [];
  const CLOSERS = {}; // overlay name -> programmatic close fn
  let keysBound = false;

  function pushOverlay(name) { popOverlay(name, true); STACK.push(name); bindKeys(); }
  function popOverlay(name, keepKeys) {
    const i = STACK.indexOf(name);
    if (i >= 0) STACK.splice(i, 1);
    if (!keepKeys && !STACK.length) unbindKeys();
  }
  function userClose(name) { try { if (CLOSERS[name]) CLOSERS[name](); } catch (e) {} notify(name); }

  function ownHosts() { return [IDS.highlight, IDS.hud, IDS.mobile, IDS.visionRoot, IDS.tabTrailBar, IDS.fixPill].map((id) => D.getElementById(id)).filter(Boolean); }
  function eventInOwnUi(e) {
    try { const path = e.composedPath ? e.composedPath() : []; const hosts = ownHosts(); return path.some((n) => hosts.indexOf(n) >= 0); } catch (e2) { return false; }
  }

  function onKeyDown(e) {
    try {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (!STACK.length) return;
        e.preventDefault(); e.stopPropagation();
        userClose(STACK[STACK.length - 1]);
        return;
      }
      if (HUD.open) hudKey(e);
    } catch (err) { /* never break the page */ }
  }
  function bindKeys() { if (keysBound) return; W.addEventListener('keydown', onKeyDown, true); keysBound = true; }
  function unbindKeys() { if (!keysBound) return; W.removeEventListener('keydown', onKeyDown, true); keysBound = false; }

  // Shared rect follower: re-runs `update` on scroll/resize and continuously for `kick(ms)`.
  function makeFollower(update) {
    const bucket = [];
    let raf = 0, until = 0, scheduled = false;
    const run = () => { scheduled = false; raf = 0; try { update(); } catch (e) {} if (performance.now() < until) schedule(); };
    const schedule = () => { if (scheduled) return; scheduled = true; raf = W.requestAnimationFrame(run); };
    listen(bucket, W, 'scroll', schedule, { capture: true, passive: true });
    listen(bucket, W, 'resize', schedule, { passive: true });
    return {
      kick(ms) { until = Math.max(until, performance.now() + (ms || 0)); schedule(); },
      stop() { drain(bucket); if (raf) W.cancelAnimationFrame(raf); until = 0; scheduled = false; }
    };
  }

  /* ================================================================== */
  /* §5.7 Highlighter                                                    */
  /* ================================================================== */
  const HL = { host: null, el: null, ring: null, badge: null, follower: null };
  const HL_CSS = `
    .__af_hl_ring { position: fixed; border: 3px solid var(--af-c); border-radius: 8px; pointer-events: none;
      box-shadow: 0 0 0 2px rgba(0,0,0,.65), 0 0 14px 3px var(--af-c), inset 0 0 10px var(--af-cg);
      animation: __af_hl_pulse 1.4s ease-in-out infinite; }
    .__af_hl_ring::after { content: ""; position: absolute; inset: -3px; border-radius: 10px; border: 2px solid var(--af-c);
      animation: __af_hl_ripple 1.4s ease-out infinite; }
    @keyframes __af_hl_pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(0,0,0,.65), 0 0 8px 2px var(--af-c), inset 0 0 6px var(--af-cg); }
                               50% { box-shadow: 0 0 0 2px rgba(0,0,0,.65), 0 0 26px 9px var(--af-c), inset 0 0 14px var(--af-cg); } }
    @keyframes __af_hl_ripple { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.12); } }
    .__af_hl_badge { position: fixed; max-width: min(380px, calc(100vw - 16px)); padding: 10px 12px 10px; border-left: 4px solid var(--af-c); }
    .__af_hl_head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-right: 36px; }
    .__af_hl_impact { background: var(--af-c); color: #0D0D11; border-color: var(--af-c); text-transform: uppercase; }
    .__af_hl_title { font: 700 14px/1.35 ${FONT}; margin: 6px 0 2px; color: #fff; }
    .__af_hl_msg { margin: 4px 0 0; color: ${PAL.muted}; font-size: 12px; }
    .__af_hl_sel { margin-top: 6px; color: ${PAL.cyan}; word-break: break-all; background: rgba(0,0,0,.35); border-radius: 6px; padding: 4px 6px; }
    .__af_hl_close { position: absolute; top: 8px; right: 8px; }
    .__af_hl_hint { margin-top: 6px; font-size: 11px; }
    .__af_hl_hidden { display: none; }
  `;

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(0,209,255,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function highlight(selector, meta) {
    clearHighlight();
    meta = meta || {};
    const el = qs(selector);
    if (!el) return { ok: true, found: false };
    const impact = String(meta.impact || 'moderate').toLowerCase();
    const color = IMPACT_COLORS[impact] || IMPACT_COLORS.moderate;
    const { host, root } = mountHost(IDS.highlight, HL_CSS);
    host.style.setProperty('--af-c', color);
    host.style.setProperty('--af-cg', hexToRgba(color, 0.35));

    const ring = h('div', { class: '__af_hl_ring', 'aria-hidden': 'true' });
    const wcag = Array.isArray(meta.wcag) ? meta.wcag : (meta.wcag ? [meta.wcag] : []);
    const badge = h('div', { class: '__af_hl_badge __af_glass', role: 'region', 'aria-label': 'Mattccessibility issue highlight' },
      h('div', { class: '__af_hl_head' },
        h('span', { class: '__af_chip __af_hl_impact', text: impact }),
        wcag.slice(0, 3).map((t) => h('span', { class: '__af_chip', text: 'WCAG ' + String(t).replace(/^wcag\s*/i, '') })),
        meta.ruleId ? h('span', { class: '__af_chip __af_mono', text: truncate(meta.ruleId, 40) }) : null),
      h('div', { class: '__af_hl_title', text: truncate(meta.title || meta.ruleId || 'Accessibility issue', 140) }),
      meta.message ? h('p', { class: '__af_hl_msg', text: truncate(meta.message, 240) }) : null,
      h('div', { class: '__af_hl_sel __af_mono', title: selector, text: truncate(selector, 180) }),
      h('div', { class: '__af_hl_hint __af_muted', text: 'Press Esc or ✕ to dismiss' }),
      btn('✕', () => userClose('highlight'), { cls: '__af_btn_icon __af_hl_close', aria: 'Dismiss highlight' }));
    root.appendChild(ring);
    root.appendChild(badge);

    HL.host = host; HL.el = el; HL.ring = ring; HL.badge = badge;
    HL.follower = makeFollower(positionHighlight);
    try { el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    positionHighlight();
    HL.follower.kick(1600); // keep in sync through the smooth scroll
    pushOverlay('highlight');
    return { ok: true, found: true };
  }

  function positionHighlight() {
    if (!HL.el || !HL.ring) return;
    if (!HL.el.isConnected) { HL.ring.classList.add('__af_hl_hidden'); return; }
    const r = HL.el.getBoundingClientRect();
    const pad = 5;
    const w = Math.max(r.width, 10) + pad * 2, hgt = Math.max(r.height, 10) + pad * 2;
    const x = r.left - pad - (r.width < 10 ? (10 - r.width) / 2 : 0);
    const y = r.top - pad - (r.height < 10 ? (10 - r.height) / 2 : 0);
    const st = HL.ring.style;
    st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = hgt + 'px';
    HL.ring.classList.remove('__af_hl_hidden');
    const b = HL.badge; if (!b) return;
    const bw = b.offsetWidth || 300, bh = b.offsetHeight || 100;
    const VW = vw(), VH = vh();
    let top = y - bh - 10;
    if (top < 8) top = y + hgt + 10;
    if (top + bh > VH - 8) top = clamp(y - bh - 10, 8, Math.max(8, VH - bh - 8));
    top = clamp(top, 8, Math.max(8, VH - bh - 8));
    const left = clamp(x, 8, Math.max(8, VW - bw - 8));
    b.style.left = left + 'px'; b.style.top = top + 'px';
  }

  function clearHighlight() {
    if (HL.follower) HL.follower.stop();
    unmount(HL.host);
    const stray = D.getElementById(IDS.highlight); if (stray) stray.remove();
    HL.host = HL.el = HL.ring = HL.badge = HL.follower = null;
    popOverlay('highlight');
    return { ok: true };
  }
  CLOSERS.highlight = clearHighlight;

  /* ------------------------------------------------------------------ */
  /* §5.7 Live CSS fix preview                                            */
  /* ------------------------------------------------------------------ */
  const FIX = { rules: new Map(), host: null, countEl: null };

  function parseDecls(cssRule) {
    let body = String(cssRule == null ? '' : cssRule);
    const open = body.indexOf('{');
    if (open >= 0) { const close = body.indexOf('}', open); body = body.slice(open + 1, close >= 0 ? close : undefined); }
    body = body.replace(/[{}<>]/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    body.split(';').forEach((d) => {
      const i = d.indexOf(':');
      if (i < 1) return;
      const p = d.slice(0, i).trim().toLowerCase();
      const v = d.slice(i + 1).trim().replace(/!\s*important\s*$/i, '').trim();
      if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(p) || !v) return;
      out.push(p + ': ' + v + ' !important');
    });
    return out;
  }
  function renderFixStyle() {
    let st = D.getElementById(IDS.fixStyle);
    if (!FIX.rules.size) { if (st) st.remove(); return; }
    if (!st) { st = D.createElement('style'); st.id = IDS.fixStyle; (D.head || D.documentElement).appendChild(st); }
    let css = '/* Mattccessibility Tool: live fix preview */\n';
    FIX.rules.forEach((decls, sel) => { css += sel + ' { ' + decls.join('; ') + '; }\n'; });
    st.textContent = css;
  }
  const FIX_CSS = `
    .__af_fix_pill { position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 999px; border-color: rgba(0,230,118,.45); }
    .__af_fix_dot { width: 9px; height: 9px; border-radius: 50%; background: ${PAL.green}; box-shadow: 0 0 10px ${PAL.green}; }
  `;
  function showFixPill() {
    if (FIX.host && FIX.host.isConnected) { FIX.countEl.textContent = 'Fix preview active (' + FIX.rules.size + ')'; return; }
    const { host, root } = mountHost(IDS.fixPill, FIX_CSS);
    FIX.countEl = h('span', { text: 'Fix preview active (' + FIX.rules.size + ')' });
    root.appendChild(h('div', { class: '__af_fix_pill __af_glass', role: 'region', 'aria-label': 'CSS fix preview' },
      h('span', { class: '__af_fix_dot', 'aria-hidden': 'true' }), FIX.countEl,
      btn('Revert all', () => userClose('fixPreview'), { cls: '__af_btn_primary', aria: 'Revert all previewed fixes' })));
    FIX.host = host;
  }

  function previewFix(selector, cssRule) {
    if (!selector || typeof selector !== 'string') return { ok: false, error: 'selector is required' };
    try { D.querySelectorAll(selector); } catch (e) { return { ok: false, error: 'Invalid selector' }; }
    if (/[{}]/.test(selector)) return { ok: false, error: 'Invalid selector' };
    const decls = parseDecls(cssRule);
    if (!decls.length) return { ok: false, error: 'No valid CSS declarations' };
    FIX.rules.set(selector, decls);
    renderFixStyle();
    showFixPill();
    pushOverlay('fixPreview');
    if (HL.follower) HL.follower.kick(300);
    let matched = 0; try { matched = D.querySelectorAll(selector).length; } catch (e) {}
    return { ok: true, matched, active: FIX.rules.size };
  }
  function revertAllFixes() {
    FIX.rules.clear();
    renderFixStyle();
    unmount(FIX.host);
    const stray = D.getElementById(IDS.fixPill); if (stray) stray.remove();
    FIX.host = null; FIX.countEl = null;
    popOverlay('fixPreview');
    if (HL.follower) HL.follower.kick(300);
    return { ok: true };
  }
  CLOSERS.fixPreview = revertAllFixes;

  /* ================================================================== */
  /* §5.5 Tab-Trail (+ CONTRACT §10.3: line style, live, real tabbing)  */
  /* ================================================================== */
  const TT = { svg: null, bar: null, seq: [], bucket: [], timer: 0, drawn: 0, stats: null, statEl: null, focusEl: null,
    lineStyle: 'straight', live: true, watch: null, sig: '', geoSig: '', pts: [], focusIdx: -1, toggles: null, liveEl: null, open: false };
  const TT_COLORS = { seq: PAL.cyan, up: '#FF3B30', back: PAL.amber };

  const stopSig = (seq) => (seq || []).map((s) => (s && s.selector) + '|' + ((s && s.visibility) || '') + '|' + ((s && s.tabindex) == null ? '' : s.tabindex)).join('\n');
  const engineTabOrder = () => typeof W.__auditforgeComputeTabOrder === 'function';

  function showTabTrail(sequence, opts) {
    opts = opts || {};
    hideTabTrail();
    if (opts.lineStyle === 'curved' || opts.lineStyle === 'straight') TT.lineStyle = opts.lineStyle;
    TT.live = opts.live !== false;
    TT.seq = Array.isArray(sequence) ? sequence.slice(0, 500) : [];
    TT.sig = stopSig(TT.seq);
    const s = svg('svg', { id: IDS.tabTrail, 'aria-hidden': 'true', focusable: 'false', xmlns: SVGNS });
    s.setAttribute('style', 'position:absolute !important;left:0;top:0;width:0;height:0;margin:0 !important;padding:0 !important;border:0 !important;' +
      'pointer-events:none !important;z-index:2147483646 !important;overflow:visible !important;display:block !important;background:transparent !important;max-width:none !important;max-height:none !important;');
    (D.body || D.documentElement).appendChild(s);
    TT.svg = s; TT.open = true;
    TT.focusIdx = indexOfStop(D.activeElement);
    TT.focusEl = TT.focusIdx >= 0 ? D.activeElement : null;
    drawTabTrail();
    buildTabTrailBar();
    const schedule = () => { if (TT.timer) return; TT.timer = setTimeout(() => { TT.timer = 0; try { drawTabTrail(); } catch (e) {} }, 140); };
    listen(TT.bucket, W, 'resize', schedule, { passive: true });
    listen(TT.bucket, W, 'scroll', schedule, { passive: true, capture: true });
    listen(TT.bucket, D, 'focusin', onTrailFocusIn, true);
    listen(TT.bucket, D, 'focusout', onTrailFocusOut, true);
    if (TT.live) {
      TT.watch = makeLiveWatcher(liveRefreshTrail);
      // The popup's sequence may be stale (page changed since the audit): reconcile right away.
      if (engineTabOrder()) setTimeout(() => { if (TT.open) liveRefreshTrail(); }, 0);
    }
    pushOverlay('tabTrail');
    return { ok: true, drawn: TT.drawn, total: TT.seq.length, missing: TT.stats.missing, upward: TT.stats.up, backward: TT.stats.back,
      hidden: TT.stats.hidden, lineStyle: TT.lineStyle, live: !!(TT.live && engineTabOrder()) };
  }

  function setTabTrailLineStyle(style) {
    if (style !== 'straight' && style !== 'curved') return { ok: false, error: 'lineStyle must be "straight" or "curved"' };
    TT.lineStyle = style;
    if (TT.open) { drawTabTrail(); syncLineToggle(); }
    return { ok: true, lineStyle: style };
  }

  // Live: recompute from the CURRENT DOM via the engine; redraw on sequence or geometry change.
  function liveRefreshTrail() {
    if (!TT.open) return;
    if (engineTabOrder()) {
      let to = null;
      try { to = W.__auditforgeComputeTabOrder(); } catch (e) { to = null; }
      if (to && Array.isArray(to.sequence)) {
        const sig = stopSig(to.sequence);
        if (sig !== TT.sig) {
          TT.sig = sig;
          TT.seq = to.sequence.slice(0, 500);
          TT.focusIdx = indexOfStop(TT.focusEl || D.activeElement);
          drawTabTrail();
          let clean = null; try { clean = JSON.parse(JSON.stringify(to)); } catch (e) {}
          if (clean) sendMsg({ type: 'AF_TAB_ORDER_UPDATED', tabOrder: clean });
          return;
        }
      }
    }
    // Same stops: redraw only if the layout moved.
    if (geometrySig() !== TT.geoSig) drawTabTrail();
  }

  function geometrySig() {
    return TT.seq.map((s) => { const b = resolveStop(s); return b ? Math.round(b.x) + ',' + Math.round(b.y) + ',' + Math.round(b.w) + ',' + Math.round(b.h) : '-'; }).join(';');
  }

  function indexOfStop(el) {
    if (!el || el === D.body || el === D.documentElement) return -1;
    for (let i = 0; i < TT.seq.length; i++) { if (qs(TT.seq[i] && TT.seq[i].selector) === el) return i; }
    return -1;
  }

  function onTrailFocusIn(e) {
    if (eventInOwnUi(e)) return; // our own bar buttons
    const el = e.target;
    const idx = indexOfStop(el);
    TT.focusEl = idx >= 0 ? el : null;
    if (idx === TT.focusIdx && idx >= 0) return;
    TT.focusIdx = idx;
    drawHereRing(); updateFocusLabel();
    sendMsg({ type: 'AF_TAB_FOCUS_CHANGED', index: idx, selector: idx >= 0 ? (TT.seq[idx].selector || null) : null });
  }

  // Focus left the page content (blur / click on empty space): no current stop, like real Tab restarting.
  // Moving focus into our own bar is NOT a reset (activeElement is then our host, not body).
  function onTrailFocusOut() {
    setTimeout(() => {
      if (!TT.open) return;
      const a = D.activeElement;
      if ((a && a !== D.body && a !== D.documentElement) || TT.focusIdx < 0) return;
      TT.focusIdx = -1; TT.focusEl = null;
      drawHereRing(); updateFocusLabel();
      sendMsg({ type: 'AF_TAB_FOCUS_CHANGED', index: -1, selector: null });
    }, 0);
  }

  // Real tabbing: call .focus() so the page's own focus styles and handlers run.
  function focusStep(dir) {
    const n = TT.seq.length;
    if (!n) return;
    let i = TT.focusIdx;
    if (i < 0) { const cur = indexOfStop(D.activeElement); i = cur >= 0 ? cur : (dir > 0 ? -1 : n); }
    for (let tries = 0; tries < n; tries++) {
      i += dir;
      if (i < 0 || i >= n) { setTrailStatus(dir > 0 ? 'End of tab order: real Tab would leave the page' : 'Start of tab order'); return; }
      const el = qs(TT.seq[i].selector);
      if (!el) continue;
      try { el.focus({ focusVisible: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
      if (D.activeElement === el || (el.contains && el.contains(D.activeElement))) {
        // focusin normally updates state; enforce in case the page stopped propagation.
        if (TT.focusIdx !== i) { TT.focusIdx = i; TT.focusEl = el; drawHereRing(); updateFocusLabel(); sendMsg({ type: 'AF_TAB_FOCUS_CHANGED', index: i, selector: TT.seq[i].selector || null }); }
        setTrailStatus('');
        return;
      }
    }
    setTrailStatus('No focusable stop found in that direction');
  }

  function resolveStop(stop) {
    const el = qs(stop && stop.selector);
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0 || r.left || r.top) return { x: r.left + W.scrollX, y: r.top + W.scrollY, w: r.width, h: r.height, live: true };
    }
    const rc = stop && stop.rect;
    if (rc && isFinite(rc.x) && isFinite(rc.y)) return { x: +rc.x, y: +rc.y, w: +rc.width || 0, h: +rc.height || 0, live: false };
    return null;
  }

  function drawTabTrail() {
    const s = TT.svg;
    if (!s || !s.isConnected) return;
    // Measure the document without our own SVG contributing to its size.
    s.style.width = '0px'; s.style.height = '0px'; s.style.left = '0px'; s.style.top = '0px';
    const de = D.documentElement, b = D.body;
    const docW = Math.max(de.scrollWidth, b ? b.scrollWidth : 0, de.clientWidth);
    const docH = Math.max(de.scrollHeight, b ? b.scrollHeight : 0, de.clientHeight);
    const sr = s.getBoundingClientRect();
    const offX = sr.left + W.scrollX, offY = sr.top + W.scrollY; // where left:0/top:0 lands in document coordinates
    s.style.left = (-offX) + 'px'; s.style.top = (-offY) + 'px';
    s.style.width = docW + 'px'; s.style.height = docH + 'px';
    s.setAttribute('width', docW); s.setAttribute('height', docH);
    s.setAttribute('viewBox', `0 0 ${docW} ${docH}`);
    while (s.firstChild) s.removeChild(s.firstChild);

    const anim = !reducedMotion();
    const curved = TT.lineStyle === 'curved';
    const defs = svg('defs');
    Object.keys(TT_COLORS).forEach((k) => {
      const m = svg('marker', { id: '__af_tt_arrow_' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
      m.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: TT_COLORS[k] }));
      defs.appendChild(m);
    });
    s.appendChild(defs);
    const gOutline = svg('g', { 'data-layer': 'outlines' });
    const gPaths = svg('g', { 'data-layer': 'paths', fill: 'none', 'stroke-linecap': 'round', 'data-style': TT.lineStyle });
    const gWarn = svg('g', { 'data-layer': 'warnings' });
    const gBadges = svg('g', { 'data-layer': 'badges' });
    const gHere = svg('g', { 'data-layer': 'here' });
    s.appendChild(gOutline); s.appendChild(gPaths); s.appendChild(gWarn); s.appendChild(gBadges); s.appendChild(gHere);

    const pts = [];
    let missing = 0, hidden = 0;
    const geo = [];
    TT.seq.forEach((stop, i) => {
      const box = resolveStop(stop);
      geo.push(box ? Math.round(box.x) + ',' + Math.round(box.y) + ',' + Math.round(box.w) + ',' + Math.round(box.h) : '-');
      if (!box) { missing++; return; }
      const label = String((stop && Number.isFinite(stop.index) ? stop.index : i) + 1);
      const r = label.length > 2 ? 15 : 12;
      const isHidden = stop && stop.visibility === 'hidden-visual';
      if (isHidden) hidden++;
      const offscreen = box.x + box.w <= 0 || box.y + box.h <= 0 || box.x >= docW || box.y >= docH;
      const cx = clamp(box.x, r + 2, docW - r - 2), cy = clamp(box.y, r + 2, docH - r - 2);
      pts.push({ stop, box, cx, cy, r, label, flag: null, isHidden, offscreen, seqIndex: i });
    });
    TT.geoSig = geo.join(';');

    let up = 0, back = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], z = pts[i + 1];
      const ay = a.box.y + a.box.h / 2, zy = z.box.y + z.box.h / 2;
      const rowTol = Math.max(24, Math.min(a.box.h, 80));
      let kind = 'seq';
      if (zy < ay - rowTol) { kind = 'up'; up++; }
      else if (Math.abs(zy - ay) <= rowTol && z.box.x + z.box.w / 2 < a.box.x + a.box.w / 2 - 24) { kind = 'back'; back++; }
      if (kind !== 'seq') z.flag = kind;
      const col = TT_COLORS[kind];
      const dx = z.cx - a.cx, dy = z.cy - a.cy;
      const dist = Math.hypot(dx, dy);
      if (dist < a.r + z.r + 6) continue; // badges touch: no room for a line
      const nx = -dy / dist, ny = dx / dist;
      // Curved: gentle quadratic, control point offset ~15% of segment length. Straight: plain line.
      const off = curved ? dist * 0.15 : 0;
      const c = { x: (a.cx + z.cx) / 2 + nx * off, y: (a.cy + z.cy) / 2 + ny * off };
      const toward = (p, q, rr) => { const vx = q.x - p.cx, vy = q.y - p.cy, l = Math.hypot(vx, vy) || 1; return { x: p.cx + vx / l * rr, y: p.cy + vy / l * rr }; };
      const p0 = toward(a, curved ? c : { x: z.cx, y: z.cy }, a.r + 3);
      const p3 = toward(z, curved ? c : { x: a.cx, y: a.cy }, z.r + 4);
      const f = (n) => n.toFixed(1);
      const d = curved ? `M${f(p0.x)},${f(p0.y)} Q${f(c.x)},${f(c.y)} ${f(p3.x)},${f(p3.y)}` : `M${f(p0.x)},${f(p0.y)} L${f(p3.x)},${f(p3.y)}`;
      gPaths.appendChild(svg('path', { d, stroke: col, 'stroke-width': 6, 'stroke-opacity': 0.2 }));
      const core = svg('path', { d, stroke: col, 'stroke-width': kind === 'seq' ? 2 : 2.5, 'marker-end': `url(#__af_tt_arrow_${kind})`,
        'stroke-dasharray': kind === 'seq' ? null : '8 5', 'data-kind': kind });
      if (anim && kind !== 'seq') core.appendChild(svg('animate', { attributeName: 'stroke-dashoffset', from: 26, to: 0, dur: '1.1s', repeatCount: 'indefinite' }));
      gPaths.appendChild(core);
      if (kind !== 'seq') {
        // Place the warning 38% along the segment (not the midpoint) so two crossing leaps don't stack their labels.
        const q = 0.38, u = 1 - q;
        const mx = curved ? u * u * p0.x + 2 * u * q * c.x + q * q * p3.x : p0.x + (p3.x - p0.x) * q;
        const my = curved ? u * u * p0.y + 2 * u * q * c.y + q * q * p3.y : p0.y + (p3.y - p0.y) * q;
        const g = svg('g', { transform: `translate(${f(mx)},${f(my)})` });
        g.appendChild(svg('path', { d: 'M0,-9 L9,7 L-9,7 Z', fill: col, stroke: '#0D0D11', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
        const t = svg('text', { x: 0, y: 5, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': 10, 'font-weight': 800, fill: '#0D0D11' });
        t.textContent = '!';
        g.appendChild(t);
        const lab = svg('text', { x: 13, y: -6, 'font-family': FONT, 'font-size': 11, 'font-weight': 700, fill: col, stroke: '#0D0D11', 'stroke-width': 3, 'paint-order': 'stroke' });
        lab.textContent = (kind === 'up' ? 'Upward leap ' : 'Backward leap ') + `#${a.label}→#${z.label}`;
        g.appendChild(lab);
        gWarn.appendChild(g);
      }
    }

    pts.forEach((p) => {
      const stop = p.stop || {};
      const positive = Number(stop.tabindex) > 0;
      const warn = !!(stop.isAnomaly || stop.warning || positive);
      const col = p.isHidden ? TT_COLORS.back : (p.flag ? TT_COLORS[p.flag] : (warn ? TT_COLORS.back : TT_COLORS.seq));
      if (p.box.w > 0 && p.box.h > 0 && !p.offscreen) {
        gOutline.appendChild(svg('rect', { x: p.box.x - 2, y: p.box.y - 2, width: p.box.w + 4, height: p.box.h + 4, rx: 4,
          fill: 'none', stroke: col, 'stroke-width': 1.5, 'stroke-opacity': 0.75, 'stroke-dasharray': (p.box.live && !p.isHidden) ? null : '4 3' }));
      }
      const g = svg('g', { transform: `translate(${p.cx.toFixed(1)},${p.cy.toFixed(1)})`, 'data-index': p.seqIndex, 'data-visibility': stop.visibility || 'visible' });
      g.appendChild(svg('circle', { r: p.r + 4, fill: col, 'fill-opacity': p.isHidden ? 0.12 : 0.22 }));
      g.appendChild(svg('circle', { r: p.r, fill: '#0D0D11', stroke: col, 'stroke-width': 2.5, 'stroke-dasharray': p.isHidden ? '4 3' : null }));
      const t = svg('text', { x: 0, y: 4, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': p.label.length > 2 ? 10 : 11.5, 'font-weight': 800, fill: '#FFFFFF' });
      t.textContent = p.label;
      g.appendChild(t);
      if (p.isHidden) {
        const txt = p.offscreen ? 'hidden · off-screen' : 'hidden';
        const w = txt.length * 6.2 + 12;
        const pill = svg('g', { transform: `translate(${p.r + 5},-8)`, 'data-hidden-badge': '1' });
        pill.appendChild(svg('rect', { x: 0, y: 0, width: w.toFixed(0), height: 16, rx: 8, fill: '#0D0D11', stroke: TT_COLORS.back, 'stroke-width': 1.5, 'stroke-dasharray': '3 2' }));
        const pt = svg('text', { x: 6, y: 11.5, 'font-family': FONT, 'font-size': 10.5, 'font-weight': 700, fill: TT_COLORS.back });
        pt.textContent = txt;
        pill.appendChild(pt);
        g.appendChild(pill);
      } else if (warn) {
        const wg = svg('g', { transform: `translate(${p.r - 1},${-p.r + 1})` });
        wg.appendChild(svg('circle', { r: 6.5, fill: TT_COLORS.back, stroke: '#0D0D11', 'stroke-width': 1.5 }));
        const wt = svg('text', { x: 0, y: 3.5, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': 9.5, 'font-weight': 900, fill: '#0D0D11' });
        wt.textContent = '!';
        wg.appendChild(wt);
        g.appendChild(wg);
      }
      gBadges.appendChild(g);
    });

    TT.pts = pts;
    TT.drawn = pts.length;
    TT.stats = { missing, up, back, hidden, positive: TT.seq.filter((x) => x && Number(x.tabindex) > 0).length };
    drawHereRing();
    if (TT.statEl) TT.statEl.textContent = tabTrailSummary();
    updateFocusLabel();
  }

  function drawHereRing() {
    const s = TT.svg; if (!s) return;
    const g = s.querySelector('[data-layer=here]'); if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    const p = TT.pts.find((x) => x.seqIndex === TT.focusIdx);
    if (!p) return;
    const ring = svg('g', { transform: `translate(${p.cx.toFixed(1)},${p.cy.toFixed(1)})`, 'data-here': String(TT.focusIdx) });
    const c = svg('circle', { r: p.r + 7, fill: 'none', stroke: PAL.green, 'stroke-width': 3 });
    if (!reducedMotion()) {
      c.appendChild(svg('animate', { attributeName: 'r', values: `${p.r + 6};${p.r + 11};${p.r + 6}`, dur: '1.3s', repeatCount: 'indefinite' }));
      c.appendChild(svg('animate', { attributeName: 'stroke-opacity', values: '1;0.35;1', dur: '1.3s', repeatCount: 'indefinite' }));
    }
    ring.appendChild(c);
    // Keep the ~76px-wide label inside the document's left edge.
    const lab = svg('text', { x: Math.max(0, 42 - p.cx).toFixed(1), y: -(p.r + 15), 'text-anchor': 'middle', 'font-family': FONT, 'font-size': 11, 'font-weight': 800,
      fill: PAL.green, stroke: '#0D0D11', 'stroke-width': 3.5, 'paint-order': 'stroke' });
    lab.textContent = 'You are here';
    ring.appendChild(lab);
    g.appendChild(ring);
  }

  function tabTrailSummary() {
    const st = TT.stats || { up: 0, back: 0, missing: 0, positive: 0, hidden: 0 };
    let t = `${TT.drawn} stop${TT.drawn === 1 ? '' : 's'}`;
    t += ` · ${st.up} upward · ${st.back} backward`;
    if (st.hidden) t += ` · ${st.hidden} hidden`;
    if (st.positive) t += ` · ${st.positive} tabindex>0`;
    if (st.missing) t += ` · ${st.missing} not found`;
    return t;
  }
  function updateFocusLabel() {
    if (!TT.focusLabel) return;
    TT.focusLabel.textContent = TT.focusIdx >= 0 ? `Focused: #${TT.focusIdx + 1} of ${TT.seq.length}` : `Focused: none of ${TT.seq.length}`;
  }
  function setTrailStatus(t) { if (TT.statusEl) TT.statusEl.textContent = t || ''; }
  function syncLineToggle() {
    if (!TT.toggles) return;
    TT.toggles.straight.setAttribute('aria-pressed', String(TT.lineStyle === 'straight'));
    TT.toggles.curved.setAttribute('aria-pressed', String(TT.lineStyle === 'curved'));
  }

  const TT_CSS = `
    .__af_tt_bar { position: fixed; bottom: 14px; right: 14px; display: flex; align-items: center; gap: 8px 10px; padding: 8px 8px 8px 14px; flex-wrap: wrap;
      max-width: min(760px, calc(100vw - 28px)); justify-content: flex-end; }
    .__af_tt_title { font-weight: 800; color: #fff; }
    .__af_tt_live { color: ${PAL.green}; font: 800 11px/1 ${FONT}; }
    .__af_tt_focus { font-weight: 700; color: ${PAL.green}; }
    .__af_tt_status { flex-basis: 100%; text-align: right; font-size: 11px; color: ${PAL.amber}; min-height: 0; }
    .__af_tt_status:empty { display: none; }
    .__af_tt_legend { display: flex; gap: 10px; font-size: 11px; color: ${PAL.muted}; }
    .__af_tt_legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
    .__af_tt_seg { display: inline-flex; border: 1px solid #3a3a52; border-radius: 10px; overflow: hidden; }
    .__af_tt_seg .__af_btn { border: 0; border-radius: 0; min-height: 30px; padding: 5px 10px; background: transparent; }
    .__af_tt_seg .__af_btn[aria-pressed="true"] { background: ${PAL.cyan}; color: ${PAL.bg}; }
  `;
  function buildTabTrailBar() {
    const { host, root } = mountHost(IDS.tabTrailBar, TT_CSS);
    TT.statEl = h('span', { class: '__af_muted', text: tabTrailSummary() });
    TT.focusLabel = h('span', { class: '__af_tt_focus', role: 'status', 'aria-live': 'polite' });
    TT.statusEl = h('span', { class: '__af_tt_status', role: 'status' });
    TT.toggles = {
      straight: btn('Straight', () => setTabTrailLineStyle('straight'), { pressed: String(TT.lineStyle === 'straight'), aria: 'Straight lines' }),
      curved: btn('Curved', () => setTabTrailLineStyle('curved'), { pressed: String(TT.lineStyle === 'curved'), aria: 'Curved lines' })
    };
    const isLive = TT.live && engineTabOrder();
    root.appendChild(h('div', { class: '__af_tt_bar __af_glass', role: 'region', 'aria-label': 'Tab trail overlay controls' },
      h('span', { class: '__af_tt_title', text: '⌨ Tab Trail' }),
      isLive ? h('span', { class: '__af_tt_live', title: 'Updates automatically as the page changes', text: '● Live' }) : null,
      TT.statEl, TT.focusLabel,
      btn('◀ Prev', () => focusStep(-1), { aria: 'Focus previous tab stop (like Shift+Tab)' }),
      btn('Next ▶', () => focusStep(1), { cls: '__af_btn_primary', aria: 'Focus next tab stop (like Tab)' }),
      h('span', { class: '__af_tt_seg', role: 'group', 'aria-label': 'Line style' }, TT.toggles.straight, TT.toggles.curved),
      h('span', { class: '__af_tt_legend', 'aria-hidden': 'true' },
        h('span', null, h('i', { style: `background:${TT_COLORS.seq}` }), 'Sequential'),
        h('span', null, h('i', { style: `background:${TT_COLORS.up}` }), 'Upward'),
        h('span', null, h('i', { style: `background:${TT_COLORS.back}` }), 'Backward / hidden')),
      btn('Close', () => userClose('tabTrail'), { aria: 'Close tab trail' }),
      TT.statusEl));
    TT.bar = host;
    updateFocusLabel();
  }

  function hideTabTrail() {
    if (TT.watch) { TT.watch.stop(); TT.watch = null; }
    drain(TT.bucket);
    if (TT.timer) { clearTimeout(TT.timer); TT.timer = 0; }
    if (TT.svg) TT.svg.remove();
    unmount(TT.bar);
    [IDS.tabTrail, IDS.tabTrailBar].forEach((id) => { const n = D.getElementById(id); if (n) n.remove(); });
    TT.svg = TT.bar = TT.statEl = TT.focusLabel = TT.statusEl = TT.toggles = TT.focusEl = null;
    TT.seq = []; TT.pts = []; TT.drawn = 0; TT.sig = ''; TT.geoSig = ''; TT.focusIdx = -1; TT.open = false;
    popOverlay('tabTrail');
    return { ok: true };
  }
  CLOSERS.tabTrail = hideTabTrail;

  /* ================================================================== */
  /* §5.6 Vision suite                                                   */
  /* ================================================================== */
  const VIS = { lensId: 'none', host: null, root: null, bucket: [], raf: 0, snow: null };
  const VIS_CSS = `
    .__af_vis_pill { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 7px 7px 7px 14px; border-radius: 999px; border-color: rgba(0,209,255,.45); max-width: calc(100vw - 24px); }
    .__af_vis_eye { font-size: 15px; }
    .__af_vis_label { font-weight: 800; color: #fff; }
    .__af_vis_desc { font-size: 12px; }
    .__af_vis_layer { position: fixed; inset: 0; pointer-events: none; }
    .__af_vis_glaucoma { background: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), rgba(0,0,0,0) 0, rgba(0,0,0,0) 90px, rgba(0,0,0,.72) 210px, rgba(0,0,0,.96) 340px, #000 520px); }
    .__af_vis_glaucoma_blur { -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      -webkit-mask-image: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), transparent 0, transparent 100px, #000 230px);
      mask-image: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), transparent 0, transparent 100px, #000 230px); }
    .__af_vis_macular { background: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), rgba(0,0,0,.97) 0, rgba(8,8,8,.92) 55px, rgba(20,20,20,.55) 105px, rgba(0,0,0,.18) 150px, rgba(0,0,0,0) 190px); }
    .__af_vis_macular_blur { -webkit-backdrop-filter: blur(2.5px); backdrop-filter: blur(2.5px);
      -webkit-mask-image: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), #000 0, #000 140px, transparent 230px);
      mask-image: radial-gradient(circle at var(--af-x,50%) var(--af-y,50%), #000 0, #000 140px, transparent 230px); }
    .__af_vis_blob { position: absolute; border-radius: 42% 58% 55% 45% / 50% 40% 60% 50%; filter: blur(7px);
      background: radial-gradient(circle at 50% 50%, rgba(0,0,0,.92) 0, rgba(10,4,4,.8) 45%, rgba(30,0,0,.35) 65%, rgba(0,0,0,0) 72%);
      animation: __af_vis_drift var(--af-d, 18s) ease-in-out infinite alternate; }
    .__af_vis_haze { background: radial-gradient(ellipse at 50% 50%, rgba(80,40,0,0) 40%, rgba(40,20,0,.18) 100%); }
    @keyframes __af_vis_drift { 0% { transform: translate(0,0) scale(1) rotate(0deg); } 50% { transform: translate(var(--af-dx,30px), var(--af-dy,-20px)) scale(1.12) rotate(14deg); }
      100% { transform: translate(calc(var(--af-dx,30px) * -0.6), calc(var(--af-dy,-20px) * -0.8)) scale(.92) rotate(-10deg); } }
    .__af_vis_snow { width: 100%; height: 100%; image-rendering: pixelated; opacity: .42; mix-blend-mode: normal; }
  `;

  function ensureDefs() {
    let defs = D.getElementById(IDS.visionDefs);
    if (defs) return defs;
    defs = svg('svg', { id: IDS.visionDefs, 'aria-hidden': 'true', focusable: 'false', width: 0, height: 0 });
    defs.setAttribute('style', 'position:absolute !important;width:0 !important;height:0 !important;overflow:hidden !important;pointer-events:none !important;left:-9999px;top:-9999px;');
    (D.body || D.documentElement).appendChild(defs);
    return defs;
  }
  function setRootFilter(filterValue) {
    let st = D.getElementById(IDS.visionStyle);
    if (!st) { st = D.createElement('style'); st.id = IDS.visionStyle; (D.head || D.documentElement).appendChild(st); }
    st.textContent = `html { filter: ${filterValue} !important; }`;
  }

  function applyVision(lensId) {
    if (!lensId || lensId === 'none') { resetVision(); return { ok: true, lensId: 'none' }; }
    const lens = LENSES[lensId];
    if (!lens) return { ok: false, error: 'Unknown lens id: ' + lensId, lensId };
    resetVision();
    VIS.lensId = lensId;
    const { host, root } = mountHost(IDS.visionRoot, VIS_CSS);
    VIS.host = host; VIS.root = root;

    if (lens.kind === 'matrix') {
      const defs = ensureDefs();
      const f = svg('filter', { id: '__af_lens_' + lensId, 'color-interpolation-filters': 'sRGB', x: 0, y: 0, width: '100%', height: '100%' });
      f.appendChild(svg('feColorMatrix', { type: 'matrix', values: lens.m }));
      defs.appendChild(f);
      setRootFilter(`url("#__af_lens_${lensId}")`);
    } else if (lens.kind === 'css') {
      setRootFilter(lens.css);
    } else if (lens.kind === 'svg') {
      const defs = ensureDefs();
      const f = svg('filter', { id: '__af_lens_astigmatism', 'color-interpolation-filters': 'sRGB', x: '-2%', y: '-2%', width: '104%', height: '104%' });
      // Directional (horizontal-stretched) noise drives a subtle displacement smear, then an offset ghost gives diplopia.
      f.appendChild(svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.004 0.06', numOctaves: 1, seed: 7, result: 'af_noise' }));
      f.appendChild(svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'af_noise', scale: 7, xChannelSelector: 'R', yChannelSelector: 'G', result: 'af_disp' }));
      f.appendChild(svg('feOffset', { in: 'af_disp', dx: 7, dy: 3, result: 'af_ghost' }));
      f.appendChild(svg('feColorMatrix', { in: 'af_ghost', type: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.45 0', result: 'af_ghost_a' }));
      const merge = svg('feMerge');
      merge.appendChild(svg('feMergeNode', { in: 'af_disp' }));
      merge.appendChild(svg('feMergeNode', { in: 'af_ghost_a' }));
      f.appendChild(merge);
      defs.appendChild(f);
      setRootFilter('url("#__af_lens_astigmatism")');
    } else if (lens.kind === 'mask') {
      const cls = lensId === 'glaucoma' ? 'glaucoma' : 'macular';
      const blur = h('div', { class: `__af_vis_layer __af_vis_${cls}_blur`, 'aria-hidden': 'true' });
      const mask = h('div', { class: `__af_vis_layer __af_vis_${cls}`, 'aria-hidden': 'true' });
      root.appendChild(blur); root.appendChild(mask);
      const setPos = (x, y) => { host.style.setProperty('--af-x', x + 'px'); host.style.setProperty('--af-y', y + 'px'); };
      setPos(vw() / 2, vh() / 2);
      let pend = null, raf = 0;
      const move = (e) => { pend = [e.clientX, e.clientY]; if (!raf) raf = W.requestAnimationFrame(() => { raf = 0; if (pend) setPos(pend[0], pend[1]); }); };
      listen(VIS.bucket, W, 'mousemove', move, { passive: true, capture: true });
      listen(VIS.bucket, W, 'pointermove', move, { passive: true, capture: true });
      VIS.bucket.push(() => { if (raf) W.cancelAnimationFrame(raf); });
    } else if (lens.kind === 'patches') {
      const layer = h('div', { class: '__af_vis_layer', 'aria-hidden': 'true' });
      layer.appendChild(h('div', { class: '__af_vis_layer __af_vis_haze' }));
      // Deterministic pseudo-random layout so screenshots and reruns are stable.
      let seed = 1337;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      for (let i = 0; i < 11; i++) {
        const size = 50 + Math.round(rnd() * 150);
        const b = h('div', { class: '__af_vis_blob' });
        b.style.left = (rnd() * 92) + '%'; b.style.top = (rnd() * 88) + '%';
        b.style.width = size + 'px'; b.style.height = Math.round(size * (0.7 + rnd() * 0.6)) + 'px';
        b.style.setProperty('--af-d', (14 + rnd() * 14).toFixed(1) + 's');
        b.style.setProperty('--af-dx', Math.round((rnd() - 0.5) * 120) + 'px');
        b.style.setProperty('--af-dy', Math.round((rnd() - 0.5) * 90) + 'px');
        b.style.animationDelay = (-rnd() * 10).toFixed(1) + 's';
        layer.appendChild(b);
      }
      root.appendChild(layer);
    } else if (lens.kind === 'snow') {
      startSnow(root);
    }

    root.appendChild(h('div', { class: '__af_vis_pill __af_glass', role: 'region', 'aria-label': 'Vision simulation' },
      h('span', { class: '__af_vis_eye', 'aria-hidden': 'true', text: '👁' }),
      h('span', null, h('span', { class: '__af_muted', text: 'Lens: ' }), h('span', { class: '__af_vis_label', text: lens.label })),
      h('span', { class: '__af_vis_desc __af_muted', text: '· ' + lens.desc }),
      btn('Reset Normal', () => userClose('vision'), { cls: '__af_btn_primary' })));
    pushOverlay('vision');
    return { ok: true, lensId };
  }

  function startSnow(root) {
    const canvas = h('canvas', { class: '__af_vis_layer __af_vis_snow', 'aria-hidden': 'true' });
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: true });
    const SCALE = 3; // render at 1/3 resolution for performance, upscale with pixelated grain
    let img = null, buf = null, last = 0;
    const size = () => {
      canvas.width = Math.max(1, Math.ceil(vw() / SCALE)); canvas.height = Math.max(1, Math.ceil(vh() / SCALE));
      img = ctx.createImageData(canvas.width, canvas.height); buf = new Uint32Array(img.data.buffer);
    };
    const frame = () => {
      if (!buf) return;
      for (let i = 0; i < buf.length; i++) {
        const r = Math.random();
        const v = (r * 255) | 0;
        const a = r > 0.55 ? ((r - 0.55) * 300) | 0 : ((0.55 - r) * 150) | 0; // bright and dark specks
        buf[i] = (a << 24) | (v << 16) | (v << 8) | v; // little-endian ABGR
      }
      ctx.putImageData(img, 0, 0);
    };
    const reduce = reducedMotion();
    const loop = (t) => {
      VIS.raf = 0;
      if (D.hidden) return; // paused; visibilitychange restarts
      if (t - last >= 1000 / 24) { last = t; frame(); }
      VIS.raf = W.requestAnimationFrame(loop);
    };
    const start = () => { if (!reduce && !VIS.raf && !D.hidden) VIS.raf = W.requestAnimationFrame(loop); };
    size(); frame(); start();
    listen(VIS.bucket, W, 'resize', () => { size(); frame(); }, { passive: true });
    listen(VIS.bucket, D, 'visibilitychange', () => { if (D.hidden) { if (VIS.raf) { W.cancelAnimationFrame(VIS.raf); VIS.raf = 0; } } else start(); });
    VIS.snow = canvas;
  }

  function resetVision() {
    drain(VIS.bucket);
    if (VIS.raf) { W.cancelAnimationFrame(VIS.raf); VIS.raf = 0; }
    unmount(VIS.host);
    [IDS.visionRoot, IDS.visionStyle, IDS.visionDefs].forEach((id) => { const n = D.getElementById(id); if (n) n.remove(); });
    VIS.host = VIS.root = VIS.snow = null;
    VIS.lensId = 'none';
    popOverlay('vision');
    return { ok: true, lensId: 'none' };
  }
  CLOSERS.vision = resetVision;

  /* ================================================================== */
  /* §5.3 Screen-reader HUD                                              */
  /* ================================================================== */
  const HUD = { open: false, host: null, root: null, persona: 'voiceover', seq: [], idx: -1, filter: 0,
    cursor: null, cursorTag: null, caption: null, sub: null, pos: null, rotorChip: null, audio: null,
    bucket: [], follower: null, curEl: null,
    baseSeq: [], includeHidden: true, watch: null, sig: '', hiddenTag: null, skipBtn: null, liveEl: null };

  const HUD_CSS = `
    .__af_hud { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); width: min(880px, calc(100vw - 24px));
      padding: 12px 14px; border-radius: 18px; display: grid; gap: 10px; }
    .__af_hud_top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .__af_hud_persona { font-weight: 800; color: #fff; }
    .__af_hud_dot { width: 9px; height: 9px; border-radius: 50%; background: ${PAL.magenta}; box-shadow: 0 0 10px ${PAL.magenta}; animation: __af_hud_blink 1.6s ease-in-out infinite; }
    @keyframes __af_hud_blink { 50% { opacity: .35; } }
    .__af_hud_spacer { flex: 1; }
    .__af_hud_caption { font: 600 17px/1.4 ${FONT}; color: #fff; min-height: 24px; padding: 8px 12px; border-radius: 12px;
      background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.07); word-break: break-word; }
    .__af_hud_sub { font-size: 12px; color: ${PAL.muted}; min-height: 16px; }
    .__af_hud_sub.__af_barrier { color: #FF8FB0; font-weight: 700; }
    .__af_hud_btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .__af_hud_btns .__af_btn { flex: 1 1 auto; }
    .__af_hud_hint { font-size: 11px; }
    .__af_hud_hint kbd { font: 700 10px/1 ${MONO}; padding: 2px 5px; border-radius: 4px; background: ${PAL.border}; border: 1px solid #3a3a52; color: #fff; }
    .__af_cur { position: fixed; pointer-events: none; display: none; transition: left .14s ease, top .14s ease, width .14s ease, height .14s ease; }
    .__af_cur.__af_on { display: block; }
    .__af_cur_tag { position: absolute; left: -3px; top: -24px; font: 700 11px/1 ${FONT}; padding: 5px 7px; border-radius: 6px 6px 6px 0; white-space: nowrap; }
    .__af_cur_voiceover { border: 4px solid #111; border-radius: 12px; box-shadow: 0 0 0 2px #fff, 0 0 0 6px rgba(0,0,0,.25); }
    .__af_cur_voiceover .__af_cur_tag { background: #111; color: #fff; }
    .__af_cur_talkback { border: 4px solid ${PAL.green}; border-radius: 4px; box-shadow: 0 0 0 1px #0D0D11, 0 0 16px rgba(0,230,118,.7); }
    .__af_cur_talkback .__af_cur_tag { background: ${PAL.green}; color: #0D0D11; }
    .__af_cur_nvda { border: 3px dashed #1E5EFF; border-radius: 3px; box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(30,94,255,.35); }
    .__af_cur_nvda .__af_cur_tag { background: #1E5EFF; color: #fff; }
    .__af_cur_narrator { border: 3px solid #0078D4; border-radius: 2px; box-shadow: 0 0 0 2px #fff, 0 0 18px rgba(0,120,212,.75); }
    .__af_cur_narrator .__af_cur_tag { background: #0078D4; color: #fff; }
    .__af_cur.__af_cur_barrier { border-color: ${PAL.magenta} !important; }
    .__af_cur.__af_cur_hidden { border-style: dashed !important; border-color: ${PAL.amber} !important; }
    .__af_cur.__af_cur_hidden .__af_cur_tag { background: ${PAL.amber} !important; color: #0D0D11 !important; }
    .__af_hud_caprow { display: flex; align-items: stretch; gap: 8px; }
    .__af_hud_caprow .__af_hud_caption { flex: 1 1 auto; min-width: 0; }
    .__af_hud_hidden { align-self: center; background: rgba(255,184,0,.16); color: ${PAL.amber}; border: 1px dashed ${PAL.amber}; }
    .__af_hud_hidden[hidden] { display: none; }
    .__af_hud_live { color: ${PAL.green}; font: 800 11px/1 ${FONT}; }
    .__af_switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px; padding: 5px 10px; min-height: 30px; }
    .__af_switch::before { content: ""; width: 30px; height: 16px; border-radius: 8px; flex: none; box-shadow: inset 0 0 0 1px #6a6a86;
      background: radial-gradient(circle at 8px 50%, ${PAL.muted} 5px, transparent 5.5px), #2a2a3c; }
    .__af_switch[aria-pressed="true"]::before { box-shadow: none; background: radial-gradient(circle at 22px 50%, #0D0D11 5px, transparent 5.5px), ${PAL.cyan}; }
  `;

  const engineSpeech = () => typeof W.__auditforgeComputeSpeechSequence === 'function';
  const localFilter = (seq) => (HUD.includeHidden ? seq : seq.filter((it) => !(it && it.visibility === 'hidden-visual'))).slice(0, 300);
  const speechSig = (seq) => seq.map((it) => [it && it.selector, it && it.visibility, it && it.isBarrier ? 1 : 0, announcementFor(it, 0)].join('|')).join('\n');

  function startHud(persona, sequence, opts) {
    persona = PERSONAS[persona] ? persona : 'voiceover';
    stopHud();
    const P = PERSONAS[persona];
    HUD.persona = persona;
    // User decision (round 3): "Skip content hidden from view" is ON by default, so hidden-visual items are
    // excluded unless the caller explicitly passes includeHiddenVisual: true.
    HUD.includeHidden = !!(opts && opts.includeHiddenVisual === true);
    HUD.baseSeq = Array.isArray(sequence) ? sequence.slice(0, 300) : [];
    HUD.seq = localFilter(HUD.baseSeq);
    HUD.sig = speechSig(HUD.seq);
    HUD.idx = -1; HUD.filter = 0;
    const { host, root } = mountHost(IDS.hud, HUD_CSS);
    HUD.host = host; HUD.root = root;

    HUD.cursorTag = h('span', { class: '__af_cur_tag' });
    HUD.cursor = h('div', { class: '__af_cur __af_cur_' + persona, 'aria-hidden': 'true' }, HUD.cursorTag);
    root.appendChild(HUD.cursor);

    HUD.pos = h('span', { class: '__af_chip', text: `0 / ${HUD.seq.length}` });
    HUD.rotorChip = h('span', { class: '__af_chip', text: `${P.rotorName}: ${ROTOR[0].label}` });
    HUD.caption = h('div', { class: '__af_hud_caption', role: 'status', 'aria-live': 'polite',
      text: HUD.seq.length ? (P.mode === 'touch' ? 'Press Swipe ➔ (or →) to start reading.' : 'Press Next ➔ (or →) to start reading.') : 'No readable items in this audit.' });
    HUD.sub = h('div', { class: '__af_hud_sub', text: '' });

    const g = (fn) => () => { ensureAudio(); fn(); };
    const buttons = [];
    if (P.mode === 'touch') {
      buttons.push(btn('Swipe ⬅', g(() => hudMove(-1)), { aria: 'Swipe ⬅ previous item' }));
      buttons.push(btn('Swipe ➔', g(() => hudMove(1)), { cls: '__af_btn_primary', aria: 'Swipe ➔ next item' }));
      buttons.push(btn('Double-Tap 👆', g(hudActivate), { aria: 'Double-Tap 👆 activate' }));
      buttons.push(btn(P.rotor, g(() => hudRotor(1)), { aria: P.rotor + ' change navigation category' }));
    } else {
      buttons.push(btn('⬅ Previous', g(() => hudMove(-1)), { aria: 'Previous item (Left arrow)' }));
      buttons.push(btn('Next ➔', g(() => hudMove(1)), { cls: '__af_btn_primary', aria: 'Next item (Right arrow)' }));
      buttons.push(btn('⏎ Activate', g(hudActivate), { aria: 'Activate (Enter)' }));
      buttons.push(btn('H Heading', g(() => hudMove(1, 'heading')), { aria: 'H next heading' }));
      buttons.push(btn('K Link', g(() => hudMove(1, 'link')), { aria: 'K next link' }));
      buttons.push(btn('F Control', g(() => hudMove(1, 'control')), { aria: 'F next form control' }));
      buttons.push(btn('D Landmark', g(() => hudMove(1, 'landmark')), { aria: 'D next landmark' }));
      buttons.push(btn(P.rotor, g(() => hudRotor(1)), { aria: P.rotor + ' (R)' }));
    }
    buttons.push(btn('✕', () => userClose('voiceover'), { cls: '__af_btn_icon', aria: 'Close screen reader simulator', title: 'Close (Esc)' }));

    const hint = P.mode === 'touch'
      ? ['Hotkeys: ', h('kbd', { text: '←' }), ' ', h('kbd', { text: '→' }), ' swipe · ', h('kbd', { text: 'Enter' }), ' double-tap · ', h('kbd', { text: 'R' }), ' rotor · ', h('kbd', { text: 'G' }), ' granularity · ', h('kbd', { text: 'Esc' }), ' close']
      : ['Hotkeys: ', h('kbd', { text: '←' }), ' ', h('kbd', { text: '→' }), ' read · ', h('kbd', { text: 'Enter' }), ' activate · ', h('kbd', { text: 'H' }), h('kbd', { text: 'K' }), h('kbd', { text: 'F' }), h('kbd', { text: 'D' }), ' quick-nav (Shift = back) · ', h('kbd', { text: 'R' }), '/', h('kbd', { text: 'G' }), ' category · ', h('kbd', { text: 'Esc' }), ' close'];

    HUD.hiddenTag = h('span', { class: '__af_chip __af_hud_hidden', hidden: true, text: '⚠ Not visible on screen' });
    HUD.skipBtn = btn('Skip content hidden from view', () => { HUD.includeHidden = !HUD.includeHidden; HUD.skipBtn.setAttribute('aria-pressed', String(!HUD.includeHidden)); hudLiveRefresh(true); },
      { cls: '__af_switch', pressed: String(!HUD.includeHidden), title: 'Real screen readers still announce visually hidden content; turn on to skip it' });
    HUD.liveEl = engineSpeech() ? h('span', { class: '__af_hud_live', title: 'Sequence updates as the page changes', text: '● Live' }) : null;

    root.appendChild(h('div', { class: '__af_hud __af_glass', role: 'region', 'aria-label': P.name + ' simulator' },
      h('div', { class: '__af_hud_top' },
        h('span', { class: '__af_hud_dot', 'aria-hidden': 'true' }),
        h('span', { class: '__af_hud_persona', text: P.name }),
        h('span', { class: '__af_chip __af_muted', text: 'Simulation' }), HUD.liveEl,
        h('span', { class: '__af_hud_spacer' }), HUD.skipBtn, HUD.rotorChip, HUD.pos),
      h('div', { class: '__af_hud_caprow' }, HUD.caption, HUD.hiddenTag), HUD.sub,
      h('div', { class: '__af_hud_btns' }, buttons),
      h('div', { class: '__af_hud_hint __af_muted' }, hint)));

    HUD.follower = makeFollower(positionCursor);
    HUD.open = true;
    HUD.watch = makeLiveWatcher(() => hudLiveRefresh(false));
    if (engineSpeech()) setTimeout(() => { if (HUD.open) hudLiveRefresh(false); }, 0); // reconcile a stale popup sequence
    pushOverlay('voiceover');
    return { ok: true, persona, count: HUD.seq.length, includeHiddenVisual: HUD.includeHidden, live: engineSpeech() };
  }

  // Live: recompute from the CURRENT DOM, keep the reading position by selector (or nearest following item).
  function hudLiveRefresh(force) {
    if (!HUD.open) return;
    let seq = null, barrierCount = null;
    if (engineSpeech()) {
      try {
        const res = W.__auditforgeComputeSpeechSequence({ includeHiddenVisual: HUD.includeHidden });
        if (res && Array.isArray(res.sequence)) { seq = res.sequence.slice(0, 300); barrierCount = res.barrierCount; }
      } catch (e) { seq = null; }
    }
    if (!seq) seq = localFilter(HUD.baseSeq); // no engine: the toggle still filters the supplied sequence
    if (barrierCount == null) barrierCount = seq.filter((it) => it && it.isBarrier).length;
    const sig = speechSig(seq);
    if (sig === HUD.sig && !force) { positionCursor(); return; }
    const changed = sig !== HUD.sig;
    const old = HUD.seq, oldIdx = HUD.idx;
    HUD.seq = seq; HUD.sig = sig;
    if (oldIdx >= 0) {
      const sel = old[oldIdx] && old[oldIdx].selector;
      let ni = seq.findIndex((it) => it && it.selector === sel);
      for (let k = oldIdx + 1; ni < 0 && k < old.length; k++) { const s2 = old[k] && old[k].selector; ni = seq.findIndex((it) => it && it.selector === s2); }
      if (ni < 0) ni = seq.length ? Math.min(oldIdx, seq.length - 1) : -1;
      HUD.idx = ni;
      if (ni >= 0) present(seq[ni], true);
      else { HUD.cursor.classList.remove('__af_on'); HUD.caption.textContent = 'No readable items.'; HUD.hiddenTag.hidden = true; }
    }
    HUD.pos.textContent = `${HUD.idx + 1} / ${HUD.seq.length}`;
    if (changed || force) {
      let clean = null; try { clean = JSON.parse(JSON.stringify(seq)); } catch (e) {}
      if (clean) sendMsg({ type: 'AF_SR_SEQUENCE_UPDATED', sequence: clean, barrierCount });
    }
  }

  function announcementFor(item, idx) {
    const a = item && item.announcements && item.announcements[HUD.persona];
    if (a) return String(a);
    const it = item || {};
    const role = it.role || '', name = it.name || '', state = it.state || '', hint = it.hint || '';
    const parts = {
      voiceover: [name, state, role, hint],
      talkback: [name, role, state, hint],
      nvda: [role, name, state],
      narrator: [name, role, state, `${idx + 1} of ${HUD.seq.length}`]
    }[HUD.persona] || [name, role];
    return parts.filter(Boolean).join(', ') || '(empty)';
  }

  function hudMove(dir, cat) {
    const n = HUD.seq.length;
    if (!n) { say('No readable items.'); return; }
    const f = cat || ROTOR[HUD.filter].id;
    let i = HUD.idx;
    if (i < 0 && dir < 0) i = n;
    for (let step = 0; step < n + 1; step++) {
      i += dir;
      if (i < 0 || i >= n) break;
      const it = HUD.seq[i];
      if (f === 'all' || (it && it.category === f)) { HUD.idx = i; present(it); return; }
    }
    const what = f === 'all' ? '' : ' ' + (ROTOR.find((r) => r.id === f) || ROTOR[0]).label.toLowerCase().replace(/s$/, '');
    say(dir > 0 ? `No next${what}. End of content.` : `No previous${what}. Start of content.`, true);
  }

  // silent=true: live refresh (no scroll, no speech/earcon; those need a user gesture).
  function present(item, silent) {
    const text = announcementFor(item, HUD.idx);
    HUD.caption.textContent = text;
    HUD.pos.textContent = `${HUD.idx + 1} / ${HUD.seq.length}`;
    const barrier = item && item.isBarrier;
    const hiddenVisual = !!(item && item.visibility === 'hidden-visual');
    HUD.hiddenTag.hidden = !hiddenVisual;
    HUD.sub.className = '__af_hud_sub' + (barrier ? ' __af_barrier' : '');
    HUD.sub.textContent = barrier ? '⚠ Barrier: ' + (item.barrierReason || 'Accessibility barrier') : (item && item.selector ? item.selector : '');
    const el = qs(item && item.selector);
    HUD.curEl = el;
    if (el) {
      if (!silent) { try { el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' }); } catch (e) {} }
      const tag = [item.role || item.category || '', item.headingLevel ? String(item.headingLevel) : ''].filter(Boolean).join(' ');
      HUD.cursorTag.textContent = (tag || 'item') + (hiddenVisual ? ' · not visible' : '');
      HUD.cursor.classList.toggle('__af_cur_barrier', !!barrier);
      HUD.cursor.classList.toggle('__af_cur_hidden', hiddenVisual);
      HUD.cursor.classList.add('__af_on');
      positionCursor();
      HUD.follower.kick(silent ? 0 : 1200);
    } else {
      HUD.cursor.classList.remove('__af_on');
      HUD.sub.textContent += (HUD.sub.textContent ? ' · ' : '') + '(element not found on page)';
    }
    if (silent) return;
    earcon();
    speak(text);
  }

  function positionCursor() {
    const el = HUD.curEl, c = HUD.cursor;
    if (!el || !c) return;
    if (!el.isConnected) { c.classList.remove('__af_on'); return; }
    const r = el.getBoundingClientRect();
    const pad = 4, edge = 3;
    // Clamp to the viewport so full-width/tall elements (landmarks) still show all four edges.
    const x1 = Math.max(r.left - pad, edge), y1 = Math.max(r.top - pad, edge);
    const x2 = Math.min(r.left + Math.max(r.width, 8) + pad, vw() - edge), y2 = Math.min(r.top + Math.max(r.height, 8) + pad, vh() - edge);
    c.style.left = x1 + 'px'; c.style.top = y1 + 'px';
    c.style.width = Math.max(12, x2 - x1) + 'px'; c.style.height = Math.max(12, y2 - y1) + 'px';
    if (HUD.cursorTag) { const s = HUD.cursorTag.style; if (y1 < 28) { s.top = '3px'; s.left = '3px'; s.borderRadius = '0 0 6px 0'; } else { s.top = ''; s.left = ''; s.borderRadius = ''; } }
  }

  function hudActivate() {
    if (HUD.idx < 0 || !HUD.seq[HUD.idx]) { say('Nothing in focus. Move to an item first.', true); return; }
    const it = HUD.seq[HUD.idx];
    const el = qs(it.selector);
    if (el) { try { el.focus({ preventScroll: true }); } catch (e) {} }
    const nm = it.name || it.role || 'item';
    const msg = (PERSONAS[HUD.persona].mode === 'touch' ? 'Double-tap: ' : 'Activate: ') + nm + ' (simulated; page action not triggered)';
    HUD.sub.className = '__af_hud_sub';
    HUD.sub.textContent = msg;
    earcon();
    speak(nm + ', activated');
  }

  function hudRotor(dir) {
    HUD.filter = (HUD.filter + (dir < 0 ? ROTOR.length - 1 : 1)) % ROTOR.length;
    const P = PERSONAS[HUD.persona];
    const label = ROTOR[HUD.filter].label;
    HUD.rotorChip.textContent = `${P.rotorName}: ${label}`;
    HUD.caption.textContent = `${P.rotorName}: ${label}`;
    earcon();
    speak(label);
  }

  function say(text, speakIt) {
    if (HUD.caption) HUD.caption.textContent = text;
    if (speakIt) speak(text);
  }

  function hudKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (eventInOwnUi(e)) return;       // focus is on our own buttons/select: let them work natively
    if (isEditable(e.target)) return;
    const k = e.key;
    let handled = true;
    ensureAudio(); // keydown is a user gesture
    if (k === 'ArrowRight') hudMove(1);
    else if (k === 'ArrowLeft') hudMove(-1);
    else if (k === 'Enter') hudActivate();
    else if (k === 'r' || k === 'R' || k === 'g' || k === 'G') hudRotor(e.shiftKey ? -1 : 1);
    else if (QUICK_KEYS[String(k).toLowerCase()] && PERSONAS[HUD.persona].mode === 'keys') hudMove(e.shiftKey ? -1 : 1, QUICK_KEYS[String(k).toLowerCase()]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  /* Speech + earcons (§5.3). Only invoked from user gestures (buttons/hotkeys). */
  function speak(text) {
    try {
      const ss = W.speechSynthesis;
      if (!ss || typeof W.SpeechSynthesisUtterance !== 'function' || !text) return;
      ss.cancel();
      const u = new W.SpeechSynthesisUtterance(String(text));
      const P = PERSONAS[HUD.persona] || PERSONAS.voiceover;
      u.rate = P.rate; u.pitch = P.pitch;
      u.lang = (D.documentElement.getAttribute('lang') || 'en-US');
      ss.speak(u);
    } catch (e) { /* speech unavailable */ }
  }
  function ensureAudio() {
    try {
      if (!HUD.audio) { const AC = W.AudioContext || W.webkitAudioContext; if (!AC) return null; HUD.audio = new AC(); }
      if (HUD.audio.state === 'suspended') HUD.audio.resume().catch(() => {});
      return HUD.audio;
    } catch (e) { return null; }
  }
  function tone(ctx, o) {
    const now = ctx.currentTime + (o.start || 0);
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, now);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(o.f1, now + o.dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(o.gain, now + (o.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0008, now + o.dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now + o.dur + 0.02);
  }
  const EARCONS = {
    // Harmonic crystalline dual-sine bell chime (E5 & C6)
    voiceover: (ctx) => { tone(ctx, { f0: 659.25, dur: 0.34, gain: 0.045, attack: 0.003 }); tone(ctx, { f0: 1046.5, dur: 0.4, gain: 0.032, attack: 0.003, start: 0.012 }); },
    // Resonant fluid bubble bloop 460Hz -> 280Hz (spec sample, verbatim envelope)
    talkback: (ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(460, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.09);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.09);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.09);
    },
    // Crisp square-wave chirp 440Hz -> 660Hz
    nvda: (ctx) => tone(ctx, { type: 'square', f0: 440, f1: 660, dur: 0.07, gain: 0.022, attack: 0.002 }),
    // Fluent two-tone soft sine chord D5 & A5
    narrator: (ctx) => { tone(ctx, { f0: 587.33, dur: 0.26, gain: 0.038, attack: 0.025 }); tone(ctx, { f0: 880, dur: 0.26, gain: 0.028, attack: 0.025 }); }
  };
  function earcon() {
    try { const ctx = HUD.audio; if (!ctx || ctx.state === 'closed') return; (EARCONS[HUD.persona] || EARCONS.voiceover)(ctx); } catch (e) {}
  }

  function stopHud() {
    try { if (W.speechSynthesis && HUD.open) W.speechSynthesis.cancel(); } catch (e) {}
    try { if (HUD.audio && HUD.audio.state !== 'closed') HUD.audio.close(); } catch (e) {}
    if (HUD.follower) HUD.follower.stop();
    if (HUD.watch) { HUD.watch.stop(); HUD.watch = null; }
    drain(HUD.bucket);
    unmount(HUD.host);
    const stray = D.getElementById(IDS.hud); if (stray) stray.remove();
    HUD.open = false; HUD.host = HUD.root = HUD.cursor = HUD.cursorTag = HUD.caption = HUD.sub = HUD.pos = HUD.rotorChip = null;
    HUD.audio = null; HUD.follower = null; HUD.curEl = null; HUD.seq = []; HUD.baseSeq = []; HUD.idx = -1; HUD.sig = '';
    HUD.hiddenTag = HUD.skipBtn = HUD.liveEl = null;
    popOverlay('voiceover');
    return { ok: true };
  }
  CLOSERS.voiceover = stopHud;

  /* ================================================================== */
  /* §5.4.3 Mobile simulator                                             */
  /* ================================================================== */
  const SIM = { open: false, host: null, root: null, iframe: null, mode: null, device: DEVICES[0], orientation: 'portrait',
    analysis: null, bucket: [], frameBucket: [], token: 0, inertia: 0, els: {}, drawerOpen: false, scale: 1, rubber: 0, resetRubber: null };

  const SIM_CSS = `
    /* Layout: grid rows [toolbar | stage]. The stage is a flex box that centres the phone with "safe" alignment,
       so it can never overflow off the top/left. The phone is scaled in JS to fit the stage's content box. No
       full-screen backdrop-filter: it would re-blur behind the scrolling frame every frame. */
    .__af_sim_backdrop { position: fixed; inset: 0; pointer-events: auto; background: rgba(5,5,8,.9);
      display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 10px; /* gap == padding: symmetric margins */
      font: 13px/1.4 ${FONT}; color: ${PAL.text}; overflow: hidden; }
    .__af_sim_toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex-wrap: wrap; justify-content: center; max-width: 100%; justify-self: center; }
    .__af_sim_title { font-weight: 800; color: #fff; margin-right: 4px; }
    .__af_sim_select { appearance: auto; font: 600 13px/1.2 ${FONT}; color: ${PAL.text}; background: ${PAL.bg}; border: 1px solid #3a3a52; border-radius: 10px; padding: 6px 8px; min-height: 32px; }
    .__af_sim_select:focus-visible { outline: 2px solid ${PAL.cyan}; outline-offset: 2px; }
    .__af_sim_mode { font-weight: 800; }
    .__af_sim_mode_live { background: rgba(0,230,118,.15); color: ${PAL.green}; border-color: rgba(0,230,118,.5); }
    .__af_sim_mode_snapshot { background: rgba(255,184,0,.15); color: ${PAL.amber}; border-color: rgba(255,184,0,.5); }
    .__af_sim_stage { min-height: 0; min-width: 0; display: flex; align-items: safe center; justify-content: safe center; overflow: hidden; padding: 8px; }
    .__af_sim_scaler { position: relative; flex: none; }
    .__af_sim_chassis { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; border-radius: 60px; padding: 14px;
      background: linear-gradient(145deg, #3a3a44 0%, #1a1a20 40%, #0b0b0e 100%);
      box-shadow: 0 0 0 2px #4a4a56, 0 0 0 4px #121216, 0 30px 80px rgba(0,0,0,.7), inset 0 0 6px rgba(255,255,255,.12); }
    .__af_sim_chassis.__af_kind_classic { border-radius: 52px; padding: 86px 18px; }
    .__af_sim_chassis.__af_kind_classic.__af_land { padding: 18px 86px; }
    .__af_sim_chassis.__af_kind_punch { border-radius: 44px; padding: 12px; }
    .__af_sim_screen { position: relative; overflow: hidden; border-radius: 46px; background: #fff; }
    .__af_kind_classic .__af_sim_screen { border-radius: 4px; }
    .__af_kind_punch .__af_sim_screen { border-radius: 34px; }
    .__af_sim_frame { position: absolute; left: 0; top: 0; border: 0; display: block; background: #fff; }
    .__af_sim_screen { background: #e9e9ee; } /* shows through during rubber-band overscroll */
    .__af_sim_island { position: absolute; z-index: 2; background: #000; border-radius: 20px; pointer-events: none; box-shadow: 0 0 0 1px rgba(255,255,255,.04); }
    .__af_sim_island::after { content: ""; position: absolute; width: 11px; height: 11px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #2b3a66, #05070d 70%); }
    .__af_kind_island .__af_sim_island { width: 122px; height: 35px; left: 50%; top: 11px; transform: translateX(-50%); }
    .__af_kind_island .__af_sim_island::after { right: 14px; top: 12px; }
    .__af_kind_island.__af_land .__af_sim_island { width: 35px; height: 122px; left: 11px; top: 50%; transform: translateY(-50%); }
    .__af_kind_island.__af_land .__af_sim_island::after { right: 12px; top: auto; bottom: 14px; }
    .__af_kind_punch .__af_sim_island { width: 13px; height: 13px; border-radius: 50%; left: 50%; top: 12px; transform: translateX(-50%); }
    .__af_kind_punch.__af_land .__af_sim_island { left: 12px; top: 50%; transform: translateY(-50%); }
    .__af_kind_classic .__af_sim_island { display: none; }
    .__af_sim_home { display: none; position: absolute; width: 56px; height: 56px; border-radius: 50%; border: 3px solid #2c2c34; background: #0e0e12; }
    .__af_kind_classic .__af_sim_home { display: block; left: 50%; bottom: 15px; transform: translateX(-50%); }
    .__af_kind_classic.__af_land .__af_sim_home { left: auto; right: 15px; bottom: auto; top: 50%; transform: translateY(-50%); }
    .__af_sim_speaker { display: none; position: absolute; width: 60px; height: 6px; border-radius: 3px; background: #050507; }
    .__af_kind_classic .__af_sim_speaker { display: block; left: 50%; top: 40px; transform: translateX(-50%); }
    .__af_kind_classic.__af_land .__af_sim_speaker { width: 6px; height: 60px; left: 40px; top: 50%; transform: translateY(-50%); }
    .__af_sim_loading { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center;
      background: ${PAL.bg}; color: ${PAL.text}; font-weight: 600; }
    .__af_sim_spin { width: 34px; height: 34px; border-radius: 50%; border: 3px solid rgba(0,209,255,.2); border-top-color: ${PAL.cyan}; animation: __af_sim_spin 0.9s linear infinite; }
    @keyframes __af_sim_spin { to { transform: rotate(360deg); } }
    .__af_sim_drawer { position: absolute; left: 50%; bottom: 0; width: min(600px, calc(100% - 20px)); max-height: 42vh; display: flex; flex-direction: column;
      transform: translate(-50%, 105%); visibility: hidden; transition: transform .32s cubic-bezier(.2,.8,.2,1), visibility 0s linear .32s;
      border-radius: 18px 18px 0 0; border-bottom: 0; }
    .__af_sim_drawer.__af_open { transform: translate(-50%, 0); visibility: visible; transition: transform .32s cubic-bezier(.2,.8,.2,1); }
    /* Wide viewports: dock the drawer to the right (full height) so the phone keeps its size. */
    .__af_sim_drawer.__af_side { left: auto; right: 0; bottom: 10px; top: var(--af-drawer-top, 70px); width: min(420px, 40vw); max-height: none;
      transform: translateX(105%); border-radius: 18px 0 0 18px; border-right: 0; border-bottom: 1px solid rgba(255,255,255,.10); }
    .__af_sim_drawer.__af_side.__af_open { transform: none; }
    .__af_sim_drawer.__af_side .__af_sim_grip { display: none; }
    .__af_sim_drawer.__af_side .__af_sim_list { flex: 1 1 auto; min-height: 0; }
    .__af_sim_grip { width: 44px; height: 5px; border-radius: 3px; background: #4a4a60; margin: 8px auto 0; }
    .__af_sim_dhead { display: flex; align-items: center; gap: 8px; padding: 8px 12px 8px 16px; border-bottom: 1px solid ${PAL.border}; }
    .__af_sim_dtitle { font-weight: 800; color: #fff; flex: 1; }
    .__af_sim_score { font-weight: 800; }
    .__af_sim_list { overflow: auto; padding: 6px 12px 14px; }
    .__af_sim_group { margin: 10px 0 4px; font: 800 11px/1.3 ${FONT}; letter-spacing: .06em; text-transform: uppercase; color: ${PAL.cyan}; }
    .__af_sim_item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; background: rgba(13,13,17,.6); border: 1px solid ${PAL.border}; margin: 4px 0; }
    .__af_sim_item_txt { flex: 1; min-width: 0; }
    .__af_sim_item_sel { color: ${PAL.cyan}; word-break: break-all; }
    .__af_sim_item_meta { font-size: 12px; color: ${PAL.muted}; }
    .__af_sim_toast { min-height: 18px; padding: 0 16px 8px; font-size: 12px; color: ${PAL.amber}; }
    .__af_sim_empty { padding: 14px 4px; color: ${PAL.muted}; }
  `;

  function deviceDims() {
    const d = SIM.device;
    return SIM.orientation === 'landscape' ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
  }

  function buildSim(dev, orientation) {
    SIM.device = dev; SIM.orientation = orientation;
    const { host, root } = mountHost(IDS.mobile, SIM_CSS);
    SIM.host = host; SIM.root = root; SIM.open = true; SIM.drawerOpen = false;
    const E = SIM.els = {};

    E.select = h('select', { class: '__af_sim_select', id: '__af_sim_device', 'aria-label': 'Device' },
      DEVICES.map((d) => h('option', { value: d.id, text: `${d.name} (${d.w}×${d.h})` })));
    E.select.value = dev.id;
    E.select.addEventListener('change', () => { const nd = DEVICES.find((x) => x.id === E.select.value); if (nd) { SIM.device = nd; reconfigureSim(); } });
    E.rotate = btn('⟳ Rotate', () => { SIM.orientation = SIM.orientation === 'portrait' ? 'landscape' : 'portrait'; reconfigureSim(); }, { aria: 'Rotate to landscape' });
    E.issuesBtn = btn('Issues', () => toggleDrawer(), { aria: 'Show layout issues', expanded: 'false', controls: '__af_sim_drawer' });
    E.mode = h('span', { class: '__af_chip __af_sim_mode', text: 'Loading…' });
    const close = btn('✕ Close', () => userClose('mobile'), { aria: 'Close mobile simulator' });

    const toolbar = h('div', { class: '__af_sim_toolbar __af_glass', role: 'toolbar', 'aria-label': 'Mobile simulator controls' },
      h('span', { class: '__af_sim_title', text: '📱 Mobile Simulator' }),
      h('label', { class: '__af_sr', for: '__af_sim_device', text: 'Device' }), E.select, E.rotate, E.issuesBtn, E.mode, close);

    E.loading = h('div', { class: '__af_sim_loading', role: 'status' }, h('div', { class: '__af_sim_spin', 'aria-hidden': 'true' }), h('span', { text: 'Loading live page…' }));
    E.screen = h('div', { class: '__af_sim_screen' }, h('div', { class: '__af_sim_island', 'aria-hidden': 'true' }), E.loading);
    E.chassis = h('div', { class: '__af_sim_chassis' }, E.screen,
      h('div', { class: '__af_sim_home', 'aria-hidden': 'true' }), h('div', { class: '__af_sim_speaker', 'aria-hidden': 'true' }));
    E.scaler = h('div', { class: '__af_sim_scaler' }, E.chassis);
    E.stage = h('div', { class: '__af_sim_stage' }, E.scaler);

    E.score = h('span', { class: '__af_chip __af_sim_score', text: '–' });
    E.list = h('div', { class: '__af_sim_list' });
    E.toast = h('div', { class: '__af_sim_toast', role: 'status', 'aria-live': 'polite' });
    E.drawer = h('div', { class: '__af_sim_drawer __af_glass', id: '__af_sim_drawer', role: 'region', 'aria-label': 'Mobile layout issues', inert: true },
      h('div', { class: '__af_sim_grip', 'aria-hidden': 'true' }),
      h('div', { class: '__af_sim_dhead' }, h('span', { class: '__af_sim_dtitle', text: 'Mobile layout issues' }), E.score,
        btn('Hide', () => toggleDrawer(false), { aria: 'Hide layout issues' })),
      E.toast, E.list);

    E.toolbar = toolbar;
    E.backdrop = h('div', { class: '__af_sim_backdrop', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Mobile device simulator' }, toolbar, E.stage, E.drawer);
    root.appendChild(E.backdrop);
    syncDrawerSpace();
    applySimSize();
    // Refit on window resize AND whenever the stage/drawer box changes (toolbar wrapping, fonts, drawer content).
    let fitRaf = 0;
    const refit = () => { if (fitRaf) return; fitRaf = W.requestAnimationFrame(() => { fitRaf = 0; syncDrawerSpace(); applySimSize(); }); };
    listen(SIM.bucket, W, 'resize', refit, { passive: true });
    try {
      const ro = new ResizeObserver(refit);
      ro.observe(E.stage); ro.observe(E.drawer);
      SIM.bucket.push(() => ro.disconnect());
    } catch (e) {}
    SIM.bucket.push(() => { if (fitRaf) W.cancelAnimationFrame(fitRaf); });
  }

  // Reserve room for the open drawer via stage padding, so the phone centres in what's left:
  // below the phone (slide-up drawer) on narrow viewports, beside it (docked right) when >= 960px wide.
  const SIDE_DRAWER_MIN_WIDTH = 960;
  function syncDrawerSpace() {
    const E = SIM.els; if (!E.stage || !E.drawer || !E.backdrop) return;
    const side = E.backdrop.clientWidth >= SIDE_DRAWER_MIN_WIDTH;
    if (E.drawer.classList.contains('__af_side') !== side) E.drawer.classList.toggle('__af_side', side);
    if (side && E.toolbar) E.drawer.style.setProperty('--af-drawer-top', (E.toolbar.offsetTop + E.toolbar.offsetHeight + 10) + 'px');
    const padB = SIM.drawerOpen && !side ? (Math.ceil(E.drawer.offsetHeight) + 8) + 'px' : '';
    const padR = SIM.drawerOpen && side ? (Math.ceil(E.drawer.offsetWidth) + 8) + 'px' : '';
    if (E.stage.style.paddingBottom !== padB) E.stage.style.paddingBottom = padB;
    if (E.stage.style.paddingRight !== padR) E.stage.style.paddingRight = padR;
  }

  function applySimSize() {
    const E = SIM.els;
    if (!E.chassis) return;
    const { w, h: hh } = deviceDims();
    const land = SIM.orientation === 'landscape';
    E.chassis.className = '__af_sim_chassis __af_kind_' + SIM.device.kind + (land ? ' __af_land' : '');
    E.screen.style.width = w + 'px'; E.screen.style.height = hh + 'px';
    if (SIM.iframe) { SIM.iframe.style.width = w + 'px'; SIM.iframe.style.height = hh + 'px'; SIM.iframe.width = w; SIM.iframe.height = hh; }
    // Natural (unscaled) chassis size; offsetWidth/Height ignore transforms.
    const cw = E.chassis.offsetWidth, ch = E.chassis.offsetHeight;
    // Available = stage content box (clientWidth/Height include padding, so subtract it).
    const cs = W.getComputedStyle(E.stage);
    const aw = E.stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const ah = E.stage.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    let s = Math.min(1, aw / cw, ah / ch);
    if (!(s > 0) || !isFinite(s)) s = 0.1; // stage not laid out yet; the ResizeObserver refits shortly
    s = Math.floor(s * 1000) / 1000;       // round DOWN so the scaled box never exceeds the space
    E.chassis.style.transform = s === 1 ? 'none' : `scale(${s})`;
    E.scaler.style.width = Math.floor(cw * s) + 'px'; E.scaler.style.height = Math.floor(ch * s) + 'px';
    SIM.scale = s;
    if (E.rotate) {
      const lbl = land ? 'Rotate to portrait' : 'Rotate to landscape';
      E.rotate.setAttribute('aria-label', lbl); E.rotate.title = lbl;
    }
    if (E.select && E.select.value !== SIM.device.id) E.select.value = SIM.device.id;
  }

  function clearFrameRings() {
    try { const fd = SIM.iframe && SIM.iframe.contentDocument; if (fd) fd.querySelectorAll('.__af_sim_ring').forEach((n) => n.remove()); } catch (e) {}
  }

  async function reconfigureSim() {
    clearFrameRings();
    if (SIM.resetRubber) SIM.resetRubber();
    applySimSize();
    if (SIM.mode) { const a = await analyseSim(); renderDrawer(a); }
  }

  function toggleDrawer(force) {
    const E = SIM.els;
    if (!E.drawer) return;
    SIM.drawerOpen = typeof force === 'boolean' ? force : !SIM.drawerOpen;
    E.drawer.classList.toggle('__af_open', SIM.drawerOpen);
    if (SIM.drawerOpen) E.drawer.removeAttribute('inert'); else E.drawer.setAttribute('inert', '');
    E.issuesBtn.setAttribute('aria-expanded', String(SIM.drawerOpen));
    // Shrink/re-centre the phone in the space above the drawer.
    syncDrawerSpace();
    applySimSize();
  }

  function frameAccessible(f, kind) {
    try {
      const d = f.contentDocument;
      if (!d || !d.documentElement) return false;
      if (kind === 'live' && d.URL === 'about:blank') return false;
      return true;
    } catch (e) { return false; }
  }

  function buildSnapshot() {
    const clone = D.documentElement.cloneNode(true);
    // Carry CSSOM-only rules (CSS-in-JS insertRule) across before pruning.
    try {
      const src = D.querySelectorAll('style'), dst = clone.querySelectorAll('style');
      if (src.length === dst.length) {
        src.forEach((s, i) => { try { if (!s.textContent.trim() && s.sheet && s.sheet.cssRules.length) dst[i].textContent = Array.from(s.sheet.cssRules).map((r) => r.cssText).join('\n'); } catch (e) {} });
      }
    } catch (e) {}
    clone.querySelectorAll('script, noscript, template, [id^="__auditforge_"], [id^="__af_"], [class*="__af_"], link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], meta[http-equiv]').forEach((n) => n.remove());
    clone.querySelectorAll('*').forEach((n) => {
      Array.from(n.attributes).forEach((a) => {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        else if ((a.name === 'href' || a.name === 'src' || a.name === 'action') && /^\s*javascript:/i.test(a.value)) n.setAttribute(a.name, '#');
      });
      if (n.removeAttribute) n.removeAttribute('popover');
    });
    let head = clone.querySelector('head');
    if (!head) { head = D.createElement('head'); clone.insertBefore(head, clone.firstChild); }
    head.querySelectorAll('base').forEach((b) => b.remove());
    head.insertBefore(h('base', { href: D.baseURI || location.href }), head.firstChild);
    try {
      const extra = (D.adoptedStyleSheets || []).map((s) => Array.from(s.cssRules).map((r) => r.cssText).join('\n')).join('\n');
      if (extra) head.appendChild(h('style', { text: extra }));
    } catch (e) {}
    // Sync live form state into attributes so the snapshot mirrors what the user sees.
    try {
      const sIn = D.querySelectorAll('input, textarea, select'), cIn = clone.querySelectorAll('input, textarea, select');
      if (sIn.length === cIn.length) sIn.forEach((el, i) => {
        const c = cIn[i];
        if (el.tagName === 'TEXTAREA') c.textContent = el.value;
        else if (el.tagName === 'SELECT') Array.from(c.options || []).forEach((o, j) => { if (el.options[j] && el.options[j].selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
        else if (/^(checkbox|radio)$/i.test(el.type)) { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
        else if (el.type !== 'password' && el.type !== 'file') c.setAttribute('value', el.value);
      });
    } catch (e) {}
    const dt = D.doctype ? '<!DOCTYPE ' + D.doctype.name + '>' : '<!DOCTYPE html>';
    return dt + '\n' + clone.outerHTML;
  }

  function loadFrame(kind, token) {
    return new Promise((resolve) => {
      const E = SIM.els;
      if (SIM.iframe) { try { SIM.iframe.remove(); } catch (e) {} SIM.iframe = null; }
      drain(SIM.frameBucket);
      const { w, h: hh } = deviceDims();
      const f = D.createElement('iframe');
      f.className = '__af_sim_frame';
      f.title = kind === 'live' ? 'Live mobile preview of this page' : 'Snapshot mobile preview of this page';
      f.setAttribute('sandbox', kind === 'live' ? 'allow-scripts allow-same-origin allow-forms' : 'allow-same-origin');
      f.setAttribute('referrerpolicy', 'same-origin');
      f.width = w; f.height = hh; f.style.width = w + 'px'; f.style.height = hh + 'px';
      let done = false, timer = 0;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); resolve(!!ok && token === SIM.token); };
      timer = setTimeout(() => {
        // Slow pages: accept if the DOM is already parsed and reachable.
        let ok = false; try { ok = frameAccessible(f, kind) && f.contentDocument.readyState !== 'loading'; } catch (e) {}
        finish(ok);
      }, kind === 'live' ? 9000 : 5000);
      f.addEventListener('load', () => finish(frameAccessible(f, kind)), { once: true });
      if (kind === 'live') f.src = location.href;
      else {
        if (E.loading) E.loading.lastChild.textContent = 'Building DOM snapshot…';
        f.srcdoc = buildSnapshot();
      }
      SIM.iframe = f;
      E.screen.insertBefore(f, E.screen.firstChild);
    });
  }

  function setModeBadge() {
    const E = SIM.els; if (!E.mode) return;
    if (SIM.mode === 'live') { E.mode.textContent = '● Live'; E.mode.className = '__af_chip __af_sim_mode __af_sim_mode_live'; E.mode.title = 'Live page loaded in device frame'; }
    else if (SIM.mode === 'snapshot') { E.mode.textContent = '◐ Snapshot'; E.mode.className = '__af_chip __af_sim_mode __af_sim_mode_snapshot'; E.mode.title = 'Live frame blocked; showing a script-free DOM snapshot'; }
    else { E.mode.textContent = '✕ Unavailable'; E.mode.className = '__af_chip __af_sim_mode'; }
  }

  function attachFrame() {
    const f = SIM.iframe;
    let fw, fd;
    try { fw = f.contentWindow; fd = f.contentDocument; } catch (e) { return; }
    if (!fw || !fd) return;
    const B = SIM.frameBucket;
    try {
      const st = fd.createElement('style');
      st.id = '__af_sim_frame_style';
      // Mobile browsers use overlay scrollbars: hide desktop gutters so the layout viewport equals the device width.
      st.textContent = `html { cursor: grab; scrollbar-width: none; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none; } html.__af_dragging, html.__af_dragging * { cursor: grabbing !important; user-select: none !important; }
        .__af_sim_ring { position: absolute; pointer-events: none; z-index: 2147483647; border: 3px solid #FF3B30; border-radius: 8px;
          box-shadow: 0 0 0 2px rgba(0,0,0,.6), 0 0 18px 4px rgba(255,59,48,.8); animation: __af_sim_ring_pulse 1.2s ease-in-out infinite; }
        .__af_sim_ring.__af_b { border-color: #FFB800; box-shadow: 0 0 0 2px rgba(0,0,0,.6), 0 0 18px 4px rgba(255,184,0,.8); }
        @keyframes __af_sim_ring_pulse { 50% { box-shadow: 0 0 0 2px rgba(0,0,0,.6), 0 0 30px 10px rgba(255,59,48,.55); } }
        @media (prefers-reduced-motion: reduce) { .__af_sim_ring { animation: none; } }`;
      (fd.head || fd.documentElement).appendChild(st);
    } catch (e) {}
    // Escape (and HUD hotkeys) from inside the frame route through the same handler.
    listen(B, fd, 'keydown', onKeyDown, true);
    attachTouchEmulation(fw, fd, B);
  }

  /* iOS-like drag-to-scroll inside the same-origin frame (mouse -> Touch events).
   *  - Wheel/trackpad is NOT intercepted: the frame scrolls natively.
   *  - Drag tracks the pointer 1:1 (frame CSS px == what the user sees, since events arrive in frame coordinates).
   *  - Release velocity = displacement over the last ~100ms of pointer samples.
   *  - Momentum: exponential decay x(t) = x0 + v*TAU*(1 - e^(-t/TAU)), TAU = 325ms.
   *  - Rubber band at the document edges (UIScrollView formula), spring back when released.
   *  - Moves under 6px are taps: no scroll, and the click goes through.
   *  - All scroll writes use behavior:'instant' so a page's `scroll-behavior: smooth` can't make dragging lag. */
  const TAP_SLOP = 6, VEL_WINDOW = 100, MOMENTUM_TAU = 325, BOUNCE_K = 90, SPRING_K = 70;
  function attachTouchEmulation(fw, fd, B) {
    const frameEl = SIM.iframe;
    let drag = null, suppressClick = false, raf = 0;
    const reduce = reducedMotion();
    const docEl = () => fd.scrollingElement || fd.documentElement;
    const scrollerFor = (el) => {
      for (let n = el; n && n.nodeType === 1 && n !== fd.body && n !== fd.documentElement; n = n.parentElement) {
        try {
          const cs = fw.getComputedStyle(n);
          if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return n;
        } catch (e) {}
      }
      return null; // null = the frame's document viewport
    };
    const getPos = (sc) => (sc ? { x: sc.scrollLeft, y: sc.scrollTop } : { x: fw.scrollX, y: fw.scrollY });
    const maxPos = (sc) => {
      const el = sc || docEl();
      return { x: Math.max(0, el.scrollWidth - (sc ? sc.clientWidth : fw.innerWidth)), y: Math.max(0, el.scrollHeight - (sc ? sc.clientHeight : fw.innerHeight)) };
    };
    const setPos = (sc, x, y) => {
      const t = sc || fw;
      try { t.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch (e) { try { t.scrollTo(x, y); } catch (e2) {} }
    };
    const setRubber = (oy) => {
      SIM.rubber = oy;
      try { frameEl.style.transform = Math.abs(oy) >= 0.25 ? `translate3d(0, ${oy.toFixed(2)}px, 0)` : ''; } catch (e) {}
    };
    SIM.resetRubber = () => setRubber(0);
    // UIScrollView rubber band: f(x) = (1 - 1 / (x * c / d + 1)) * d
    const rubberBand = (o, dim) => Math.sign(o) * (1 - 1 / (Math.abs(o) * 0.55 / dim + 1)) * dim;
    const touch = (type, e, target) => {
      try {
        const T = fw.Touch, TE = fw.TouchEvent;
        if (typeof T !== 'function' || typeof TE !== 'function') return;
        const t = new T({ identifier: 1, target, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX || 0, screenY: e.screenY || 0,
          pageX: e.pageX || 0, pageY: e.pageY || 0, radiusX: 11.5, radiusY: 11.5, rotationAngle: 0, force: 1 });
        const list = type === 'touchend' ? [] : [t];
        target.dispatchEvent(new TE(type, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t] }));
      } catch (err) { /* Touch constructors unavailable */ }
    };
    const stopAnim = () => { if (SIM.inertia) { W.cancelAnimationFrame(SIM.inertia); SIM.inertia = 0; } };
    const run = (step) => { stopAnim(); SIM.inertia = W.requestAnimationFrame(step); };

    const applyDrag = (d) => {
      if (!d || !d.moved) return;
      const tx = d.startPos.x - (d.x - d.ax), ty = d.startPos.y - (d.y - d.ay);
      const cx = clamp(tx, 0, d.max.x), cy = clamp(ty, 0, d.max.y);
      setPos(d.sc, cx, cy);
      if (!d.sc) setRubber(ty !== cy ? -rubberBand(ty - cy, fw.innerHeight) : 0);
    };
    const frameTick = () => { raf = 0; applyDrag(drag); };

    const down = (e) => {
      if (e.button !== 0) return;
      stopAnim();
      if (SIM.rubber) setRubber(0);
      const target = e.target && e.target.nodeType === 1 ? e.target : (fd.body || fd.documentElement);
      const sc = scrollerFor(target);
      const now = performance.now();
      drag = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, ax: e.clientX, ay: e.clientY, moved: false, target, sc,
        startPos: getPos(sc), max: maxPos(sc), samples: [{ t: now, x: e.clientX, y: e.clientY }] };
      touch('touchstart', e, target);
    };
    const move = (e) => {
      if (!drag) return;
      if (e.buttons === 0) { up(e); return; }
      const now = performance.now();
      drag.x = e.clientX; drag.y = e.clientY;
      drag.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (drag.samples.length > 2 && now - drag.samples[0].t > VEL_WINDOW) drag.samples.shift();
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= TAP_SLOP) {
        // Re-anchor at the slop boundary (like iOS) so content doesn't jump by the slop distance.
        drag.moved = true; drag.ax = e.clientX; drag.ay = e.clientY; drag.startPos = getPos(drag.sc);
        try { fd.documentElement.classList.add('__af_dragging'); const sel = fw.getSelection(); if (sel) sel.removeAllRanges(); } catch (er) {}
      }
      if (drag.moved) { e.preventDefault(); if (!raf) raf = W.requestAnimationFrame(frameTick); }
      touch('touchmove', e, drag.target);
    };
    const up = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (raf) { W.cancelAnimationFrame(raf); raf = 0; }
      applyDrag(d); // flush the last pointer position
      touch('touchend', e, d.target);
      try { fd.documentElement.classList.remove('__af_dragging'); } catch (er) {}
      if (!d.moved) return; // tap: let the click through
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      const now = performance.now();
      const s = d.samples.filter((p) => now - p.t <= VEL_WINDOW);
      let vx = 0, vy = 0; // content velocity, px/ms (opposite to pointer motion)
      if (s.length >= 2) {
        const a = s[0], b = s[s.length - 1], dt = Math.max(8, b.t - a.t);
        vx = -(b.x - a.x) / dt; vy = -(b.y - a.y) / dt;
      }
      SIM.lastFling = { vx, vy }; // exposed for diagnostics/tests
      if (SIM.rubber) { springBack(SIM.rubber); return; } // released while overscrolled
      if (reduce || (Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05)) return;
      momentum(d.sc, vx, vy);
    };
    const momentum = (sc, vx, vy) => {
      const p0 = getPos(sc), mx = maxPos(sc), t0 = performance.now();
      const ax = vx * MOMENTUM_TAU, ay = vy * MOMENTUM_TAU; // total remaining travel
      const step = () => {
        SIM.inertia = 0;
        const t = performance.now() - t0, k = Math.exp(-t / MOMENTUM_TAU);
        const tx = p0.x + ax * (1 - k), ty = p0.y + ay * (1 - k);
        const cx = clamp(tx, 0, mx.x), cy = clamp(ty, 0, mx.y);
        setPos(sc, cx, cy);
        if (!sc && cy !== ty && Math.abs(vy * k) > 0.05) { bounce(vy * k); return; } // hit an edge with speed: rubber-band
        if (Math.abs(ax * k) < 0.5 && Math.abs(ay * k) < 0.5) return;
        SIM.inertia = W.requestAnimationFrame(step);
      };
      run(step);
    };
    // Edge impact: critically damped impulse o(t) = -v * t * e^(-t/K) (peaks at t=K, returns to 0).
    const bounce = (v) => {
      const vv = clamp(v, -4, 4), t0 = performance.now();
      const step = () => {
        SIM.inertia = 0;
        const t = performance.now() - t0;
        if (t > BOUNCE_K * 8) { setRubber(0); return; }
        setRubber(-vv * t * Math.exp(-t / BOUNCE_K));
        SIM.inertia = W.requestAnimationFrame(step);
      };
      run(step);
    };
    // Release while stretched: critically damped spring back to 0.
    const springBack = (o0) => {
      if (reduce) { setRubber(0); return; }
      const t0 = performance.now();
      const step = () => {
        SIM.inertia = 0;
        const t = performance.now() - t0, o = o0 * (1 + t / SPRING_K) * Math.exp(-t / SPRING_K);
        if (Math.abs(o) < 0.25) { setRubber(0); return; }
        setRubber(o);
        SIM.inertia = W.requestAnimationFrame(step);
      };
      run(step);
    };
    const click = (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } };
    const dragstart = (e) => { if (drag) e.preventDefault(); };
    const release = () => { if (drag) up({ clientX: drag.x, clientY: drag.y }); };
    listen(B, fd, 'mousedown', down, true);
    listen(B, fd, 'mousemove', move, { capture: true, passive: false });
    listen(B, fd, 'mouseup', up, true);
    listen(B, W, 'mouseup', release, true);   // released outside the frame
    listen(B, fd, 'click', click, true);
    listen(B, fd, 'dragstart', dragstart, true);
    listen(B, fw, 'blur', release);
    B.push(stopAnim);
    B.push(() => { if (raf) W.cancelAnimationFrame(raf); SIM.resetRubber = null; SIM.rubber = 0; });
  }

  async function analyseSim() {
    const f = SIM.iframe;
    if (!f || !frameAccessible(f, SIM.mode)) { SIM.analysis = null; return null; }
    await nextFrame(); await nextFrame(); await sleep(150);
    let a = null;
    try {
      if (typeof W.__auditforgeAnalyzeMobileLayout === 'function') {
        a = W.__auditforgeAnalyzeMobileLayout(f.contentWindow);
        if (a && typeof a.then === 'function') a = await a;
        a = a ? JSON.parse(JSON.stringify(a)) : null;
      }
    } catch (e) { a = null; }
    SIM.analysis = a;
    renderDrawer(a);
    return a;
  }

  function renderDrawer(a) {
    const E = SIM.els; if (!E.list) return;
    while (E.list.firstChild) E.list.removeChild(E.list.firstChild);
    E.toast.textContent = '';
    if (!a) {
      E.score.textContent = 'n/a';
      E.issuesBtn.textContent = 'Issues';
      E.list.appendChild(h('div', { class: '__af_sim_empty', text: typeof W.__auditforgeAnalyzeMobileLayout === 'function'
        ? 'Layout analysis is unavailable because the frame content is not accessible.'
        : 'Layout analysis is unavailable because the audit engine is not loaded.' }));
      return;
    }
    const groups = [];
    const vm = (a.viewportMeta && a.viewportMeta.issues) || [];
    if (vm.length) groups.push(['Viewport meta', vm.map((t) => ({ text: t }))]);
    const of = a.overflows || [];
    if (of.length) groups.push(['Horizontal overflow', of.map((o) => ({ sels: [o.selector], text: o.selector, meta: `right edge ${Math.round(o.right)}px · scrollWidth ${o.scrollWidth} / clientWidth ${o.clientWidth}` }))]);
    const ov = a.overlaps || [];
    if (ov.length) groups.push(['Overlapping elements', ov.map((o) => ({ sels: [o.selectorA, o.selectorB], text: `${o.selectorA}  ↔  ${o.selectorB}`, meta: `overlap area ${Math.round(o.area)}px²` }))]);
    const tt = (a.touchTargets && a.touchTargets.failures) || [];
    if (tt.length) groups.push(['Touch target size', tt.map((o) => ({ sels: [o.selector], text: o.selector, meta: `${Math.round(o.width)}×${Math.round(o.height)}px · ${o.level === 'AA' ? 'Fails WCAG 2.5.8 (24×24 AA)' : 'Below 44×44 advisory'}` }))]);
    const cr = (a.touchTargets && a.touchTargets.crowding) || [];
    if (cr.length) groups.push(['Crowded targets', cr.map((o) => ({ sels: [o.selectorA, o.selectorB], text: `${o.selectorA}  ↔  ${o.selectorB}`, meta: `${Math.round(o.distance)}px apart (< 8px)` }))]);
    const so = a.stickyOcclusions || [];
    if (so.length) groups.push(['Sticky / fixed occlusion', so.map((o) => ({ sels: [o.selector], text: o.selector, meta: `covers ${Math.round(o.heightPct)}% of screen height` }))]);

    const total = groups.reduce((n, g) => n + g[1].length, 0);
    const score = Number.isFinite(a.score) ? Math.round(a.score) : null;
    E.score.textContent = score == null ? 'Score n/a' : `Score ${score}`;
    E.score.style.color = score == null ? '' : (score >= 85 ? PAL.green : score >= 60 ? PAL.amber : '#FF6B8B');
    E.issuesBtn.textContent = `Issues (${total})`;
    E.issuesBtn.setAttribute('aria-label', `Show layout issues, ${total} found`);
    if (!total) { E.list.appendChild(h('div', { class: '__af_sim_empty', text: '✓ No mobile layout issues detected at this viewport.' })); return; }
    groups.forEach(([title, items]) => {
      E.list.appendChild(h('div', { class: '__af_sim_group', text: `${title} (${items.length})` }));
      items.slice(0, 40).forEach((it) => {
        E.list.appendChild(h('div', { class: '__af_sim_item' },
          h('div', { class: '__af_sim_item_txt' },
            h('div', { class: it.sels ? '__af_sim_item_sel __af_mono' : '', text: truncate(it.text, 200) }),
            it.meta ? h('div', { class: '__af_sim_item_meta', text: it.meta }) : null),
          it.sels ? btn('🎯 Locate', () => locateInFrame(it.sels), { aria: 'Locate ' + truncate(it.sels[0], 80) }) : null));
      });
      if (items.length > 40) E.list.appendChild(h('div', { class: '__af_sim_item_meta', text: `+ ${items.length - 40} more` }));
    });
  }

  function locateInFrame(sels) {
    const E = SIM.els;
    let fd, fw;
    try { fd = SIM.iframe.contentDocument; fw = SIM.iframe.contentWindow; } catch (e) {}
    if (!fd || !fw) { E.toast.textContent = 'Frame is not accessible; cannot locate.'; return; }
    fd.querySelectorAll('.__af_sim_ring').forEach((n) => n.remove());
    let found = 0;
    sels.filter(Boolean).forEach((s, i) => {
      const el = qs(s, fd);
      if (!el) return;
      found++;
      if (found === 1) { try { el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); } catch (e) {} }
      const r = el.getBoundingClientRect();
      const ring = fd.createElement('div');
      ring.className = '__af_sim_ring' + (i > 0 ? ' __af_b' : '');
      ring.setAttribute('aria-hidden', 'true');
      ring.style.left = (r.left + fw.scrollX - 4) + 'px'; ring.style.top = (r.top + fw.scrollY - 4) + 'px';
      ring.style.width = (Math.max(r.width, 6) + 8) + 'px'; ring.style.height = (Math.max(r.height, 6) + 8) + 'px';
      (fd.body || fd.documentElement).appendChild(ring);
    });
    E.toast.textContent = found ? '' : 'Element not found in this viewport\'s DOM.';
    if (found) setTimeout(() => { try { fd.querySelectorAll('.__af_sim_ring').forEach((n) => n.remove()); } catch (e) {} }, 4000);
  }

  async function startMobile(opts) {
    opts = opts || {};
    const dev = DEVICES.find((d) => d.id === opts.deviceId) || DEVICES[0];
    const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
    if (SIM.open && SIM.iframe && SIM.mode) {
      SIM.device = dev; SIM.orientation = orientation;
      clearFrameRings();
      if (SIM.resetRubber) SIM.resetRubber();
      applySimSize();
      const analysis = await analyseSim();
      return { ok: true, mode: SIM.mode, analysis, deviceId: dev.id, orientation };
    }
    stopMobile();
    const token = ++SIM.token;
    buildSim(dev, orientation);
    pushOverlay('mobile');
    const closed = { ok: false, error: 'Simulator closed before it finished loading', mode: null, analysis: null };
    let mode = 'live';
    let ok = await loadFrame('live', token);
    if (token !== SIM.token) return closed;
    if (!ok) { mode = 'snapshot'; ok = await loadFrame('snapshot', token); if (token !== SIM.token) return closed; }
    SIM.mode = ok ? mode : null;
    setModeBadge();
    if (SIM.els.loading) { SIM.els.loading.remove(); SIM.els.loading = null; }
    if (!ok) return { ok: false, error: 'Device frame failed to load', mode, analysis: null };
    attachFrame();
    const analysis = await analyseSim();
    if (token !== SIM.token) return closed;
    return { ok: true, mode, analysis, deviceId: dev.id, orientation };
  }

  function stopMobile() {
    SIM.token++;
    if (SIM.inertia) { W.cancelAnimationFrame(SIM.inertia); SIM.inertia = 0; }
    drain(SIM.frameBucket);
    drain(SIM.bucket);
    if (SIM.iframe) { try { SIM.iframe.remove(); } catch (e) {} }
    unmount(SIM.host);
    const stray = D.getElementById(IDS.mobile); if (stray) stray.remove();
    SIM.open = false; SIM.host = SIM.root = SIM.iframe = null; SIM.mode = null; SIM.analysis = null; SIM.els = {};
    popOverlay('mobile');
    return { ok: true };
  }
  CLOSERS.mobile = stopMobile;

  /* ================================================================== */
  /* Clear all                                                           */
  /* ================================================================== */
  function clearAll() {
    const steps = [clearHighlight, revertAllFixes, hideTabTrail, resetVision, stopHud, stopMobile];
    steps.forEach((fn) => { try { fn(); } catch (e) {} });
    Object.keys(IDS).forEach((k) => { const n = D.getElementById(IDS[k]); if (n) { try { n.remove(); } catch (e) {} } });
    STACK.length = 0;
    unbindKeys();
    return { ok: true };
  }

  /* ================================================================== */
  /* Public API (CONTRACT §3)                                            */
  /* ================================================================== */
  W.__auditforgeHighlight = safe(highlight);
  W.__auditforgeClearHighlight = safe(clearHighlight);
  W.__auditforgePreviewFix = safe(previewFix);
  W.__auditforgeRevertAllFixes = safe(revertAllFixes);
  W.__auditforgeShowTabTrail = safe(showTabTrail);
  W.__auditforgeHideTabTrail = safe(hideTabTrail);
  W.__auditforgeSetTabTrailLineStyle = safe(setTabTrailLineStyle);
  W.__auditforgeApplyVisionFilter = safe(applyVision);
  W.__auditforgeResetVision = safe(resetVision);
  W.__auditforgeStartVoiceOverSimulator = safe(startHud);
  W.__auditforgeStopVoiceOverSimulator = safe(stopHud);
  W.__auditforgeStartMobileSimulator = function (opts) {
    try {
      return startMobile(opts).catch((e) => { try { stopMobile(); } catch (e2) {} return Object.assign(errOut(e), { mode: null, analysis: null }); });
    } catch (e) { return Promise.resolve(Object.assign(errOut(e), { mode: null, analysis: null })); }
  };
  W.__auditforgeStopMobileSimulator = safe(stopMobile);
  W.__auditforgeClearAll = safe(clearAll);
})();
