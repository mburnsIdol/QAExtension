/* ==========================================================================
   Mattccessibility Tool v1.4.0 — Side panel controller (popup.js)
   - View state machine: welcome → progress → results | error
   - Scan coordinator (NAVIGATE_AND_WAIT → inject → __runWcagAudit → render)
   - Six result drawers, overlay toggles, speech/earcon player
   - Live Tab / Screen Reader updates from the page (CONTRACT §10.4)
   Contracts: CONTRACT.md §2–§7, §10 (window.__auditforge* APIs, AuditResult,
   service worker messages, window.generateWcagPdfReport).
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     Constants (CONTRACT §5)
     ------------------------------------------------------------------------ */
  const INJECT_FILES = ['lib/axe.min.js', 'content/audit-runner.js'];
  const AUDIT_TIMEOUT_MS = 120000;
  const INJECT_TIMEOUT_MS = 30000;

  const DEVICES = [
    { id: 'iphone-16-pro', name: 'Apple iPhone 16 / 15 Pro', width: 393, height: 852 },
    { id: 'iphone-se', name: 'Apple iPhone SE', width: 375, height: 667 },
    { id: 'galaxy-s24', name: 'Samsung Galaxy S24', width: 360, height: 780 },
    { id: 'pixel-8', name: 'Google Pixel 8', width: 412, height: 915 },
    { id: 'iphone-16-pro-max', name: 'Apple iPhone 16 Pro Max', width: 430, height: 932 }
  ];

  const LENS_GROUPS = [
    { title: 'Color vision deficiency', lenses: [
      { id: 'protanopia', label: 'Protanopia', desc: 'Red-blind' },
      { id: 'deuteranopia', label: 'Deuteranopia', desc: 'Green-blind' },
      { id: 'tritanopia', label: 'Tritanopia', desc: 'Blue-blind' },
      { id: 'achromatopsia', label: 'Achromatopsia', desc: 'Monochromacy' }
    ] },
    { title: 'Low vision', lenses: [
      { id: 'cataracts', label: 'Cataracts', desc: 'Blur, haze and glare' },
      { id: 'glaucoma', label: 'Glaucoma', desc: 'Peripheral tunnel vision' },
      { id: 'macular', label: 'Macular Degeneration', desc: 'Central scotoma' },
      { id: 'diabetic-retinopathy', label: 'Diabetic Retinopathy', desc: 'Patchy dark spots' },
      { id: 'low-contrast', label: 'Reduced Contrast Sensitivity', desc: 'Washed-out contrast' },
      { id: 'myopia', label: 'Severe Myopia', desc: 'Heavy distance blur' }
    ] },
    { title: 'Neurological & refractive', lenses: [
      { id: 'photophobia', label: 'Photophobia', desc: 'Light-sensitive inverted view' },
      { id: 'astigmatism', label: 'Astigmatism / Diplopia', desc: 'Double-vision ghosting' },
      { id: 'visual-snow', label: 'Visual Snow Syndrome', desc: 'Animated static grain' }
    ] }
  ];
  const LENS_LABEL = {};
  LENS_GROUPS.forEach((g) => g.lenses.forEach((l) => { LENS_LABEL[l.id] = l.label; }));

  const PERSONAS = [
    { id: 'voiceover', name: 'Apple iOS VoiceOver', syntax: 'Name, State, Role, Hint' },
    { id: 'talkback', name: 'Android TalkBack', syntax: 'Name, Role, State, Hint' },
    { id: 'nvda', name: 'NVDA', syntax: 'Role, Name, State' },
    { id: 'narrator', name: 'Windows Narrator', syntax: 'Name, Role, State, Position' }
  ];

  const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
  const IMPACT_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };

  /* ------------------------------------------------------------------------
     State
     ------------------------------------------------------------------------ */
  const state = {
    view: 'welcome',
    tabId: null,
    tabUrl: '',
    windowId: null,
    runId: 0,
    lastUrl: '',
    result: null,
    fileAccess: null,
    // WCAG drawer
    search: '',
    sevFilter: new Set(IMPACTS),
    openIssues: new Set(),
    openNodes: new Set(),
    nodeLimit: {},
    previews: new Set(),
    openSections: new Set(),
    // Mobile drawer
    deviceId: DEVICES[0].id,
    orientation: 'portrait',
    mobileAnalysisByDevice: {},
    simMeta: {},
    mobileSimActive: false,
    deviceWindowId: null,
    // Screen reader drawer
    persona: 'voiceover',
    hudActive: false,
    skipHidden: true,
    // Tab drawer
    tabTrail: false,
    lineStyle: 'straight',
    focusedTab: null,
    // Live page updates (CONTRACT §10.4); null = use the audit snapshot
    live: { tabOrder: null, sequence: null, barrierCount: 0, tabAt: null, srAt: null },
    // Vision
    lens: 'none',
    // Links
    linkFilter: 'all'
  };

  /* ------------------------------------------------------------------------
     DOM helpers
     ------------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendKids(el, kids);
    return el;
  }
  function appendKids(el, kids) {
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) appendKids(el, kid);
      else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function svg(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errMsg = (e) => (e && e.message ? e.message : String(e == null ? 'Unknown error' : e));

  /* ------------------------------------------------------------------------
     Announcements (polite live region) + visual toast
     ------------------------------------------------------------------------ */
  let liveTimer = null;
  function announce(msg) {
    const live = $('af-live');
    if (!live) return;
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = msg; }, 60);
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2600);
    announce(msg);
  }

  /* ------------------------------------------------------------------------
     Chrome API wrappers
     ------------------------------------------------------------------------ */
  const hasChrome = typeof chrome !== 'undefined' && chrome;

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (e) {
      return null;
    }
  }

  function fileSchemeAllowed() {
    return new Promise((resolve) => {
      try {
        if (!hasChrome || !chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) return resolve(true);
        const maybe = chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(!!allowed));
        if (maybe && typeof maybe.then === 'function') maybe.then((a) => resolve(!!a), () => resolve(true));
      } catch (e) {
        resolve(true);
      }
    });
  }

  async function sendMessage(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res || { ok: false, error: 'No response from the background service worker.' };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => {
        const e = new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`);
        e.code = 'timeout';
        reject(e);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function injectEngine(tabId) {
    return chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
  }

  /* Runs window[name](...args) in the page. Self-contained: serialised by
     chrome.scripting, so it must not reference anything outside itself. */
  async function afPageCall(name, args) {
    const fn = window[name];
    if (typeof fn !== 'function') return { __afMissing: true };
    try {
      const r = await fn.apply(window, args || []);
      if (r === undefined || r === null) return { ok: true };
      if (typeof r !== 'object') return { ok: true, value: r };
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * Safe wrapper for every overlay/engine call in the target tab.
   * Never throws. If the API is missing (page navigated, fresh document),
   * re-injects the engine files and retries once.
   */
  async function callPage(name, args = [], opts = {}) {
    const tabId = state.tabId;
    if (tabId == null) return { ok: false, error: 'No audited tab.' };
    const run = async () => {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: afPageCall, args: [name, args] });
      return res && res[0] ? res[0].result : undefined;
    };
    try {
      let out = await run();
      if (out && out.__afMissing && opts.reinject !== false) {
        await injectEngine(tabId);
        out = await run();
      }
      if (out && out.__afMissing) return { ok: false, missing: true, error: `${name} is not available on this page.` };
      if (out == null) return { ok: true };
      return out;
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /* ------------------------------------------------------------------------
     URL classification
     ------------------------------------------------------------------------ */
  function normalizeUrl(raw) {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    try { return new URL(v).href; } catch (e) { return ''; }
  }
  function sameUrl(a, b) {
    if (!a || !b) return false;
    try { return new URL(a).href === new URL(b).href; } catch (e) { return a === b; }
  }
  function classifyUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return 'empty';
    if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|edge-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted|chrome-error):/.test(u)) return 'restricted';
    if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/.test(u)) return 'restricted';
    if (u.startsWith('file:')) return 'file';
    if (/^https?:/.test(u)) return 'web';
    return 'unsupported';
  }

  /* ------------------------------------------------------------------------
     Views
     ------------------------------------------------------------------------ */
  const VIEWS = ['welcome', 'progress', 'results', 'error'];
  function showView(name, { focus = true } = {}) {
    state.view = name;
    VIEWS.forEach((v) => { $(`${v}-view`).hidden = v !== name; });
    window.scrollTo(0, 0);
    if (focus) {
      const title = { welcome: 'welcome-title', progress: 'progress-title', results: 'results-title', error: 'error-title' }[name];
      const t = $(title);
      if (t) t.focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------------------
     Welcome
     ------------------------------------------------------------------------ */
  async function refreshTargetFromTab() {
    const tab = await getActiveTab();
    if (!tab) return;
    state.tabId = tab.id;
    state.tabUrl = tab.url || '';
    state.windowId = tab.windowId != null ? tab.windowId : null;
    const input = $('target-url');
    if (document.activeElement !== input || !input.value) input.value = tab.url || '';
    updateFileBanner();
  }

  async function updateFileBanner() {
    const url = normalizeUrl($('target-url').value);
    if (classifyUrl(url) !== 'file') { $('file-banner').hidden = true; return; }
    if (state.fileAccess == null) state.fileAccess = await fileSchemeAllowed();
    $('file-banner').hidden = !!state.fileAccess;
  }

  function setUrlError(msg) {
    const input = $('target-url');
    const err = $('target-url-error');
    if (msg) {
      err.textContent = msg;
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    } else {
      err.hidden = true;
      err.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  }

  function openExtensionSettings() {
    const id = hasChrome && chrome.runtime ? chrome.runtime.id : '';
    try {
      chrome.tabs.create({ url: `chrome://extensions/?id=${id}` });
    } catch (e) {
      toast('Open chrome://extensions, find Mattccessibility Tool and choose Details.');
    }
  }

  /* ------------------------------------------------------------------------
     Progress
     ------------------------------------------------------------------------ */
  const STEP_PCT = [8, 30, 60, 90];
  function setStep(index, status, detail) {
    const steps = document.querySelectorAll('#progress-steps .step');
    steps.forEach((li, i) => {
      const s = li.querySelector('.step-state');
      if (i < index) {
        if (!li.classList.contains('is-skipped')) li.className = 'step is-done';
        s.textContent = li.classList.contains('is-skipped') ? ' (skipped)' : ' (done)';
        li.removeAttribute('aria-current');
      } else if (i === index) {
        li.className = `step ${status === 'error' ? 'is-error' : status === 'skipped' ? 'is-skipped' : 'is-active'}`;
        s.textContent = status === 'error' ? ' (failed)' : status === 'skipped' ? ' (skipped)' : ' (in progress)';
        if (status === 'active') li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      } else {
        li.className = 'step';
        s.textContent = ' (pending)';
        li.removeAttribute('aria-current');
      }
    });
    const pct = status === 'complete' ? 100 : STEP_PCT[index] || 0;
    $('progress-fill').style.width = `${pct}%`;
    $('progress-bar').setAttribute('aria-valuenow', String(pct));
    if (detail) {
      $('progress-detail').textContent = detail;
      announce(detail);
    }
  }
  function completeSteps() {
    document.querySelectorAll('#progress-steps .step').forEach((li) => {
      if (!li.classList.contains('is-skipped')) li.className = 'step is-done';
      li.removeAttribute('aria-current');
    });
    $('progress-fill').style.width = '100%';
    $('progress-bar').setAttribute('aria-valuenow', '100');
  }

  /* ------------------------------------------------------------------------
     Audit flow
     ------------------------------------------------------------------------ */
  function classifyError(e) {
    const m = errMsg(e);
    if (e && e.code) return e.code;
    if (/cannot access a chrome|chrome:\/\/|edge:\/\/|extensions gallery|cannot be scripted|cannot access contents of the page|about:|webstore/i.test(m)) return 'restricted';
    if (/file:\/\/|file url|cannot access contents of url "file/i.test(m)) return 'file';
    if (/timed out|timeout|took longer/i.test(m)) return 'timeout';
    if (/no tab with id|tab was closed|tab.*closed/i.test(m)) return 'tab-closed';
    if (/__runWcagAudit|is not a function|could not load file/i.test(m)) return 'engine';
    if (/frame was removed|navigat/i.test(m)) return 'navigated';
    return 'generic';
  }

  function makeError(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    Object.assign(e, extra || {});
    return e;
  }

  async function runAudit() {
    setUrlError('');
    const url = normalizeUrl($('target-url').value);
    if (!url) { setUrlError('Enter a valid URL, for example https://example.com.'); return; }
    state.lastUrl = url;

    const kind = classifyUrl(url);
    if (kind === 'restricted') return showError('restricted', null, { url });
    if (kind === 'unsupported') return showError('unsupported', null, { url });
    if (kind === 'file') {
      state.fileAccess = await fileSchemeAllowed();
      if (!state.fileAccess) return showError('file', null, { url });
    }

    const tab = await getActiveTab();
    if (!tab || tab.id == null) return showError('generic', 'Could not find the active tab. Click into the page you want to audit and try again.');

    // Reset per-run state.
    await resetForNewRun();
    state.tabId = tab.id;
    state.tabUrl = tab.url || '';
    state.windowId = tab.windowId != null ? tab.windowId : null;

    const runId = ++state.runId;
    const live = () => runId === state.runId;

    $('progress-url').textContent = url;
    $('progress-detail').textContent = '';
    document.querySelectorAll('#progress-steps .step').forEach((li) => { li.className = 'step'; });
    showView('progress');

    let stage = 0;
    try {
      // Step 1 — navigation
      if (!sameUrl(url, tab.url)) {
        setStep(0, 'active', `Navigating to ${url}…`);
        const nav = await sendMessage({ type: 'NAVIGATE_AND_WAIT', tabId: tab.id, url });
        if (!live()) return;
        if (!nav || !nav.ok) {
          const msg = (nav && nav.error) || 'Navigation failed.';
          throw makeError(/longer|timeout/i.test(msg) ? 'timeout' : classifyError(new Error(msg)), msg);
        }
        state.tabUrl = url;
      } else {
        setStep(0, 'skipped', 'Already on the target URL.');
      }

      // Step 2 — injection
      stage = 1;
      setStep(1, 'active', 'Injecting WCAG 2.2 ruleset and axe-core…');
      await withTimeout(injectEngine(tab.id), INJECT_TIMEOUT_MS, 'Script injection');
      if (!live()) return;

      // Step 3 — audit
      stage = 2;
      setStep(2, 'active', 'Auditing DOM, :hover contrast and ARIA labels. This can take a few seconds…');
      const opts = { deviceId: state.deviceId };
      const res = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (o) => window.__runWcagAudit(o), args: [opts] }),
        AUDIT_TIMEOUT_MS, 'The audit'
      );
      if (!live()) return;
      const raw = res && res[0] ? res[0].result : null;
      if (!raw || typeof raw !== 'object') throw makeError('engine', 'The audit engine returned no result. The page may have navigated or blocked script execution.');
      if (raw.ok === false && !raw.summary) throw makeError('engine', raw.error || 'The audit engine reported an error.', { stageErrors: (raw.meta && raw.meta.stageErrors) || raw.stageErrors });
      if (!raw.summary && !raw.violations) {
        throw makeError('engine', 'The audit result was incomplete.', { stageErrors: raw.meta && raw.meta.stageErrors });
      }

      // Step 4 — compile
      stage = 3;
      setStep(3, 'active', 'Compiling compliance scorecard…');
      const result = normalizeResult(raw);
      state.result = result;
      renderResults(result);
      completeSteps();
      await sleep(250);
      if (!live()) return;
      showView('results');
      const s = result.summary;
      announce(`Audit complete. Score ${s.score} out of 100, grade ${s.grade}, ${s.risk} risk, ${plural(s.totalViolations, 'violation')}.`);
    } catch (e) {
      if (!live()) return;
      setStep(stage, 'error');
      showError(classifyError(e), errMsg(e), { url, stageErrors: e.stageErrors });
    }
  }

  async function resetForNewRun() {
    stopSpeech();
    state.result = null;
    state.mobileAnalysisByDevice = {};
    state.simMeta = {};
    state.openIssues = new Set();
    state.openNodes = new Set();
    state.nodeLimit = {};
    state.openSections = new Set();
    state.previews = new Set();
    state.search = '';
    state.sevFilter = new Set(IMPACTS);
    state.linkFilter = 'all';
    resetOverlayFlags();
    resetLive();
    $('wcag-search').value = '';
  }

  function resetOverlayFlags() {
    state.mobileSimActive = false;
    state.hudActive = false;
    state.tabTrail = false;
    state.lens = 'none';
    state.previews = new Set();
    syncToggleButtons();
  }

  /* ------------------------------------------------------------------------
     Result normalisation (defensive: partial engine output must still render)
     ------------------------------------------------------------------------ */
  function gradeFor(score) {
    if (score >= 95) return ['A+', 'Low'];
    if (score >= 88) return ['A', 'Low'];
    if (score >= 75) return ['B', 'Moderate'];
    if (score >= 60) return ['C', 'High'];
    return ['F', 'Severe'];
  }

  function normalizeStageErrors(se) {
    if (!se) return [];
    if (Array.isArray(se)) {
      return se.map((x) => (typeof x === 'string' ? { stage: '', message: x }
        : { stage: String(x.stage || x.name || x.id || ''), message: String(x.message || x.error || JSON.stringify(x)) }));
    }
    if (typeof se === 'object') return Object.entries(se).map(([k, v]) => ({ stage: k, message: typeof v === 'string' ? v : (v && (v.message || v.error)) || JSON.stringify(v) }));
    return [{ stage: '', message: String(se) }];
  }

  function normalizeResult(raw) {
    const r = raw;
    r.meta = r.meta || {};
    r.violations = arr(r.violations).map((v) => Object.assign({ impact: 'minor', title: v.id || 'Rule', description: '', wcag: [], tags: [], helpUrl: null }, v, {
      wcag: arr(v.wcag), tags: arr(v.tags), nodes: arr(v.nodes),
      impact: IMPACTS.includes(v.impact) ? v.impact : 'minor'
    }));
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    r.violations.forEach((v) => { counts[v.impact] += 1; });
    r.summary = r.summary || {};
    r.summary.counts = Object.assign({}, counts, r.summary.counts || {});
    if (typeof r.summary.score !== 'number') {
      const c = r.summary.counts;
      const penalty = c.critical * 12 + c.serious * 6 + c.moderate * 3 + c.minor;
      r.summary.score = Math.max(12, Math.min(100, Math.round(100 - penalty)));
    }
    const [g, risk] = gradeFor(r.summary.score);
    r.summary.grade = r.summary.grade || g;
    r.summary.risk = r.summary.risk || risk;
    r.summary.totalViolations = num(r.summary.totalViolations, r.violations.length);
    r.summary.totalNodes = num(r.summary.totalNodes, r.violations.reduce((a, v) => a + v.nodes.length, 0));
    r.summary.passes = num(r.summary.passes);
    r.summary.incomplete = num(r.summary.incomplete);

    const sr = r.screenReader = r.screenReader || {};
    sr.score = num(sr.score);
    sr.categories = sr.categories || {};
    sr.headings = arr(sr.headings);
    sr.landmarks = sr.landmarks || {};
    sr.landmarks.list = arr(sr.landmarks.list);
    sr.silentControls = arr(sr.silentControls);
    sr.sequence = arr(sr.sequence);
    sr.barrierCount = num(sr.barrierCount, sr.sequence.filter((s) => s.isBarrier).length);

    const t = r.tabOrder = r.tabOrder || {};
    t.sequence = arr(t.sequence);
    t.anomalies = arr(t.anomalies);
    t.total = num(t.total, t.sequence.length);
    t.positiveTabindexCount = num(t.positiveTabindexCount);
    t.skipLink = t.skipLink || { present: false, functional: false, visibleOnFocus: false, selector: null };
    t.status = t.status || 'Needs Review';

    const l = r.links = r.links || {};
    l.list = arr(l.list);
    l.issues = arr(l.issues);
    l.counts = Object.assign({ ok: 0, warning: 0, error: 0 }, l.counts || {});
    l.total = num(l.total, l.list.length);
    l.internal = num(l.internal); l.external = num(l.external); l.anchors = num(l.anchors);

    r.mobile = normalizeMobile(r.mobile || {});
    r.mobile.devices = arr(r.mobile.devices);
    r.__stageErrors = normalizeStageErrors(r.meta.stageErrors);
    return r;
  }

  function normalizeMobile(m) {
    m = m || {};
    m.score = num(m.score);
    m.viewportMeta = Object.assign({ present: false, content: null, widthDeviceWidth: false, userScalableNo: false, maxScaleRestricted: false, issues: [] }, m.viewportMeta || {});
    m.viewportMeta.issues = arr(m.viewportMeta.issues);
    m.overlaps = arr(m.overlaps);
    m.overflows = arr(m.overflows);
    m.touchTargets = m.touchTargets || {};
    m.touchTargets.failures = arr(m.touchTargets.failures);
    m.touchTargets.crowding = arr(m.touchTargets.crowding);
    m.stickyOcclusions = arr(m.stickyOcclusions);
    return m;
  }

  /* ------------------------------------------------------------------------
     Error view
     ------------------------------------------------------------------------ */
  function showError(code, message, extra = {}) {
    stopSpeech();
    const title = $('error-title');
    const msg = $('error-message');
    const help = clear($('error-help'));
    const details = clear($('error-details'));
    $('error-settings').hidden = true;
    const url = extra.url || state.lastUrl;

    switch (code) {
      case 'restricted':
        title.textContent = 'This page can’t be audited';
        msg.textContent = 'Chrome does not allow extensions to run scripts on browser-internal pages.';
        help.append(
          h('p', null, 'Blocked pages include ', h('code', null, 'chrome://'), ', ', h('code', null, 'edge://'), ', ', h('code', null, 'about:'), ', ', h('code', null, 'view-source:'), ' and the Chrome Web Store.'),
          h('p', null, 'Open a normal website (http or https) in this tab, then choose Back.')
        );
        break;
      case 'unsupported':
        title.textContent = 'Unsupported address';
        msg.textContent = 'Only http, https and file pages can be audited.';
        break;
      case 'file':
        title.textContent = 'File access is needed';
        msg.textContent = 'To audit local file:// pages, Chrome needs permission for this extension to read file URLs.';
        help.append(h('ol', null,
          h('li', null, 'Choose “Open extension settings” below.'),
          h('li', null, 'Turn on “Allow access to file URLs”.'),
          h('li', null, 'Reload the page, then run the audit again.')));
        $('error-settings').hidden = false;
        break;
      case 'timeout':
        title.textContent = 'The page took too long';
        msg.textContent = message || 'The page did not finish loading or the audit did not finish in time.';
        help.append(h('p', null, 'Check your connection, wait for the page to finish loading, then try again. Very large pages can take longer to audit.'));
        break;
      case 'tab-closed':
        title.textContent = 'The tab was closed';
        msg.textContent = 'The tab being audited is no longer available.';
        break;
      case 'navigated':
        title.textContent = 'The page changed during the audit';
        msg.textContent = message || 'The page navigated away while the audit was running.';
        help.append(h('p', null, 'Wait for the page to settle, then try again.'));
        break;
      case 'engine':
        title.textContent = 'The audit engine failed';
        msg.textContent = message || 'The audit engine could not complete.';
        help.append(h('p', null, 'Reload the page and try again. Some pages block injected scripts with strict security policies.'));
        break;
      default:
        title.textContent = 'Something went wrong';
        msg.textContent = message || 'The audit could not be completed.';
        help.append(h('p', null, 'Reload the page and try again.'));
    }
    if (message && code !== 'timeout' && code !== 'engine' && code !== 'navigated' && code !== 'generic') {
      details.append(h('li', null, message));
    }
    if (url) details.append(h('li', null, `URL: ${url}`));
    normalizeStageErrors(extra.stageErrors).forEach((s) => details.append(h('li', null, s.stage ? `${s.stage}: ${s.message}` : s.message)));
    details.hidden = !details.firstChild;
    showView('error');
    announce(`${title.textContent}. ${msg.textContent}`);
  }

  /* ------------------------------------------------------------------------
     Results: scorecard
     ------------------------------------------------------------------------ */
  function toneForScore(s) {
    if (s >= 88) return 'green';
    if (s >= 75) return 'cyan';
    if (s >= 60) return 'amber';
    return 'red';
  }
  const TONE_HEX = { green: '#00E676', cyan: '#00D1FF', amber: '#FFB800', red: '#FF6B66', orange: '#FF9F43', magenta: '#EC5D87' };
  const RISK_TONE = { Low: 'green', Moderate: 'cyan', High: 'amber', Severe: 'red' };
  const SEV_TONE = { critical: 'red', serious: 'orange', moderate: 'amber', minor: 'cyan' };

  /* Score ring. No CSS filters: the soft glow is an inner radial fill drawn
     inside the ring, so nothing can ever be clipped by the container. */
  function scoreRing(score, label, size = 120, stroke = 10) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const tone = toneForScore(score);
    const uid = Math.random().toString(36).slice(2, 8);
    const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `${label}: ${score} out of 100` });
    const defs = svg('defs');
    const grad = svg('linearGradient', { id: `g${uid}`, x1: '0', y1: '0', x2: '1', y2: '1' });
    grad.append(svg('stop', { offset: '0%', 'stop-color': TONE_HEX[tone] }), svg('stop', { offset: '100%', 'stop-color': tone === 'red' ? '#EC5D87' : '#00D1FF' }));
    const glow = svg('radialGradient', { id: `r${uid}`, cx: '50%', cy: '50%', r: '50%' });
    glow.append(svg('stop', { offset: '60%', 'stop-color': TONE_HEX[tone], 'stop-opacity': '0' }), svg('stop', { offset: '100%', 'stop-color': TONE_HEX[tone], 'stop-opacity': '0.16' }));
    defs.append(grad, glow);
    s.append(defs);
    s.append(svg('circle', { cx: size / 2, cy: size / 2, r: r - stroke / 2, fill: `url(#r${uid})` }));
    s.append(svg('circle', { class: 'ring-track', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke }));
    const val = svg('circle', {
      class: 'ring-value', cx: size / 2, cy: size / 2, r, fill: 'none', stroke: `url(#g${uid})`, 'stroke-width': stroke,
      'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': c, transform: `rotate(-90 ${size / 2} ${size / 2})`
    });
    s.append(val);
    const t1 = svg('text', { class: 'ring-num', x: '50%', y: '50%', 'text-anchor': 'middle', 'dominant-baseline': 'central', dy: '-4' });
    t1.textContent = String(score);
    const t2 = svg('text', { class: 'ring-sub', x: '50%', y: '50%', 'text-anchor': 'middle', dy: size * 0.22 });
    t2.textContent = '/ 100';
    s.append(t1, t2);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      val.setAttribute('stroke-dashoffset', String(c * (1 - Math.max(0, Math.min(100, score)) / 100)));
    }));
    return s;
  }

  function renderScorecard(r) {
    const s = r.summary;
    clear($('score-ring')).append(scoreRing(s.score, 'Compliance score'));
    const grade = $('grade-badge');
    grade.textContent = s.grade;
    grade.className = `grade-badge tone-${toneForScore(s.score)}`;
    grade.setAttribute('aria-label', `Grade ${s.grade}`);
    const risk = $('risk-pill');
    risk.textContent = `${s.risk} risk`;
    risk.className = `chip tone-${RISK_TONE[s.risk] || 'muted'}`;
    $('result-title').textContent = r.meta.title || 'Untitled page';
    const url = r.meta.url || state.tabUrl;
    $('result-url').textContent = url;
    $('result-url').title = url;
    const when = r.meta.timestamp ? new Date(r.meta.timestamp) : null;
    const parts = [];
    if (when && !isNaN(when)) parts.push(when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    if (r.meta.durationMs) parts.push(`${(r.meta.durationMs / 1000).toFixed(1)}s`);
    if (r.meta.axeVersion) parts.push(`axe ${r.meta.axeVersion}`);
    $('result-stamp').textContent = parts.join(' · ');

    const stats = clear($('count-chips'));
    IMPACTS.forEach((k) => stats.append(h('li', { class: 'sev-stat' },
      h('span', { class: `sev-stat-n tone-${SEV_TONE[k]}` }, s.counts[k]),
      h('span', { class: 'sev-stat-l' }, h('span', { class: `dot sev-${k}`, 'aria-hidden': 'true' }), IMPACT_LABEL[k]))));
    $('score-foot').textContent = `${plural(s.totalNodes, 'affected element')} · ${plural(s.passes, 'passed check')}${s.incomplete ? ` · ${s.incomplete} to review` : ''}`;

    const warn = clear($('stage-warnings'));
    if (r.__stageErrors.length) {
      warn.append(h('p', { class: 'banner-title' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), 'Some audit stages did not complete. Results may be partial.'),
        h('ul', null, r.__stageErrors.map((e) => h('li', null, e.stage ? `${e.stage}: ${e.message}` : e.message))));
      warn.hidden = false;
    } else warn.hidden = true;
  }

  function renderResults(r) {
    renderScorecard(r);
    renderWcag();
    renderMobile();
    renderScreenReader();
    renderTabOrder();
    renderVision();
    renderLinks();
    $('badge-wcag').textContent = plural(r.violations.length, 'rule');
    $('badge-sr').textContent = `${r.screenReader.score}/100`;
    $('badge-links').textContent = plural(r.links.total, 'link');
  }

  /* ------------------------------------------------------------------------
     Shared building blocks: Locate button, rows, chips, copy, UI preservation
     ------------------------------------------------------------------------ */
  async function locate(selector, meta) {
    if (!selector) return;
    const res = await callPage('__auditforgeHighlight', [selector, Object.assign({ impact: 'minor', ruleId: '', title: '', wcag: [], message: '' }, meta || {})]);
    if (res.ok === false) toast(`Could not highlight: ${res.error || 'unknown error'}`);
    else if (res.found === false) toast('Element not found. The page may have changed since the audit.');
    else toast('Highlighted on the page.');
  }

  /** The primary per-row action: filled cyan "🎯 Locate". */
  function locateBtn(selector, meta, labelCtx, key) {
    return h('button', {
      type: 'button', class: 'btn btn-locate', 'aria-label': `Locate ${labelCtx || selector}`, title: `Locate ${selector} on the page`,
      dataset: key ? { key } : null, disabled: selector ? null : true,
      onclick: () => locate(selector, meta)
    }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '🎯'), 'Locate');
  }

  function chip(text, tone, title) {
    return h('span', { class: `chip tone-${tone || 'muted'}`, title: title || null }, text);
  }

  /** CONTRACT §10.1 visibility chip: amber for hidden-visual, neutral for sr-only. */
  function visChip(item) {
    if (!item) return null;
    if (item.visibility === 'hidden-visual') return chip('Hidden from view', 'amber', item.visibilityReason || 'Not perceivable on screen');
    if (item.visibility === 'sr-only') return chip('Screen-reader only', 'muted', item.visibilityReason || 'Visually hidden on purpose');
    return null;
  }

  function selText(selector) {
    return h('code', { class: 'sel', title: selector || '' }, selector || '(no selector)');
  }

  /** Generic compact row. */
  function row({ lead, title, sub, sel, chips, actions, cls, data, extra }) {
    const chipEls = arr(chips).filter(Boolean);
    return h('li', { class: `row${cls ? ' ' + cls : ''}`, dataset: data || null },
      lead || null,
      h('div', { class: 'row-main' },
        title != null ? h('span', { class: 'row-title' }, title) : null,
        sel ? selText(sel) : null,
        arr(sub).filter(Boolean).map((s) => (s instanceof Node ? s : h('span', { class: 'row-sub' }, s))),
        chipEls.length ? h('div', { class: 'row-chips' }, chipEls) : null,
        extra || null),
      actions ? h('div', { class: 'row-actions' }, actions) : null);
  }

  function stat(n, label, tone) {
    return h('div', { class: 'stat' }, h('span', { class: `stat-n tone-${tone || 'muted'}` }, n), h('span', { class: 'stat-l' }, label));
  }

  function sectionH(text, extra) {
    return h('div', { class: 'section-head' }, h('h3', { class: 'h3' }, text), extra || null);
  }

  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      try {
        const ta = h('textarea', { 'aria-hidden': 'true', style: { position: 'fixed', opacity: '0' } });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }
    announce(ok ? 'Copied to clipboard.' : 'Copy failed.');
  }

  /** Re-render without jumps: keeps window/list scroll and keyboard focus. */
  function preserveUi(fn) {
    const y = window.scrollY;
    const lists = [...document.querySelectorAll('.scroll-list[id]')].map((el) => [el.id, el.scrollTop]);
    const ae = document.activeElement;
    const key = ae && ae.dataset ? ae.dataset.key : null;
    fn();
    lists.forEach(([id, top]) => { const el = $(id); if (el) el.scrollTop = top; });
    if (key) {
      const el = [...document.querySelectorAll('[data-key]')].find((x) => x.dataset.key === key);
      if (el) el.focus({ preventScroll: true });
    }
    window.scrollTo(0, y);
  }

  /** Scrolls `child` into view inside a scroll container only (never the window). */
  function scrollWithin(container, child) {
    if (!container || !child) return;
    const c = container.getBoundingClientRect();
    const r = child.getBoundingClientRect();
    if (r.top < c.top) container.scrollTop -= (c.top - r.top) + 8;
    else if (r.bottom > c.bottom) container.scrollTop += (r.bottom - c.bottom) + 8;
  }

  function disclosure(id, title, count, content, tone) {
    const open = state.openSections.has(id);
    const bodyId = `disc-${id}`;
    const body = h('div', { class: 'disclosure-body', id: bodyId, hidden: !open }, content);
    const btn = h('button', {
      type: 'button', class: 'disclosure-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId,
      onclick: () => {
        const now = !state.openSections.has(id);
        if (now) state.openSections.add(id); else state.openSections.delete(id);
        btn.setAttribute('aria-expanded', now ? 'true' : 'false');
        body.hidden = !now;
      }
    }, h('span', { class: 'grow' }, title), h('span', { class: `count${count && tone ? ` tone-${tone}` : ''}` }, count), h('span', { class: 'chev', 'aria-hidden': 'true' }));
    return h('div', { class: 'disclosure' }, btn, body);
  }

  const LIST_PAGE = 12;
  /** Compact row list; long lists show the first 12 with a "Show more" button. */
  function listOrEmpty(items, render, emptyText) {
    if (!items.length) return h('p', { class: 'note' }, emptyText);
    const ul = h('ul', { class: 'rows' });
    const wrap = h('div', null, ul);
    let shown = 0;
    const more = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' });
    const page = () => {
      const next = items.slice(shown, shown + (shown ? 25 : LIST_PAGE));
      next.forEach((x, k) => ul.append(render(x, shown + k)));
      shown += next.length;
      const left = items.length - shown;
      more.hidden = left <= 0;
      more.textContent = left > 25 ? `Show 25 more (${left} remaining)` : `Show ${left} more`;
    };
    more.addEventListener('click', page);
    page();
    wrap.append(more);
    return wrap;
  }

  /* ------------------------------------------------------------------------
     Drawer 1 — WCAG issues (collapsed one-line rule cards)
     ------------------------------------------------------------------------ */
  const NODE_PAGE = 10;

  function renderWcagFilters() {
    const r = state.result;
    const wrap = clear($('wcag-filters'));
    IMPACTS.forEach((k) => {
      const n = r.violations.filter((v) => v.impact === k).length;
      wrap.append(h('button', {
        type: 'button', class: 'seg-btn', dataset: { sev: k }, 'aria-pressed': state.sevFilter.has(k) ? 'true' : 'false',
        onclick: (e) => {
          if (state.sevFilter.has(k)) state.sevFilter.delete(k); else state.sevFilter.add(k);
          e.currentTarget.setAttribute('aria-pressed', state.sevFilter.has(k) ? 'true' : 'false');
          renderWcagList();
        }
      }, h('span', { class: `dot sev-${k}`, 'aria-hidden': 'true' }), IMPACT_LABEL[k], h('span', { class: 'n' }, n)));
    });
  }

  function matchesSearch(v, q) {
    if (!q) return true;
    const hay = [v.id, v.title, v.description, v.source, v.wcag.join(' '), v.tags.join(' '),
      ...v.nodes.map((n) => `${n.selector} ${n.html} ${n.failureSummary}`)].join(' ').toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  function renderWcag() {
    renderWcagFilters();
    renderWcagList();
  }

  function renderWcagList() {
    const r = state.result;
    const list = clear($('wcag-list'));
    const q = state.search.trim().toLowerCase();
    if (!r.violations.length) {
      list.append(h('p', { class: 'empty' }, 'No WCAG 2.2 AA violations were detected. Manual review is still recommended.'));
      $('wcag-count').textContent = '';
      return;
    }
    let shown = 0;
    IMPACTS.forEach((impact) => {
      if (!state.sevFilter.has(impact)) return;
      const items = r.violations.map((v, i) => [v, i]).filter(([v]) => v.impact === impact && matchesSearch(v, q));
      if (!items.length) return;
      shown += items.length;
      list.append(h('div', { class: 'sev-group' },
        h('h3', { class: `sev-group-h sev-${impact}` }, IMPACT_LABEL[impact], h('span', { class: 'n' }, items.length)),
        items.map(([v, i]) => ruleCard(v, i))));
    });
    if (!shown) list.append(h('p', { class: 'empty' }, 'No issues match the current search and filters.'));
    $('wcag-count').textContent = shown === r.violations.length ? `${plural(shown, 'rule')}. Select a rule to see affected elements.` : `Showing ${shown} of ${plural(r.violations.length, 'rule')}.`;
  }

  function ruleCard(v, i) {
    const key = String(i);
    const open = state.openIssues.has(key);
    const bodyId = `rule-body-${i}`;
    const body = h('div', { class: 'rule-body', id: bodyId, hidden: !open });
    const card = h('article', { class: `rule sev-${v.impact}${open ? ' is-open' : ''}` });
    const sc = v.wcag.length ? `WCAG ${v.wcag.join(', ')}` : 'Best practice';
    const toggle = h('button', {
      type: 'button', class: 'rule-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId,
      onclick: () => {
        const now = !state.openIssues.has(key);
        if (now) state.openIssues.add(key); else state.openIssues.delete(key);
        toggle.setAttribute('aria-expanded', now ? 'true' : 'false');
        card.classList.toggle('is-open', now);
        body.hidden = !now;
        if (now && !body.firstChild) fillRuleBody(body, v, i);
      }
    },
    h('span', { class: 'rule-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'rule-text' },
      h('span', { class: 'sr-only' }, `${IMPACT_LABEL[v.impact]}: `),
      h('span', { class: 'rule-title' }, v.title),
      h('span', { class: 'rule-sc' }, sc)),
    h('span', { class: 'count', title: plural(v.nodes.length, 'affected element') }, v.nodes.length, h('span', { class: 'sr-only' }, v.nodes.length === 1 ? ' element' : ' elements')),
    h('span', { class: 'chev', 'aria-hidden': 'true' }));
    if (open) fillRuleBody(body, v, i);
    card.append(toggle, body);
    return card;
  }

  function fillRuleBody(body, v, i) {
    clear(body);
    body.append(h('p', { class: 'rule-desc' }, v.description || v.title,
      v.helpUrl ? h('a', { href: v.helpUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Learn more', h('span', { class: 'sr-only' }, ` about ${v.id} (opens in a new tab)`)) : null));
    if (!v.nodes.length) { body.append(h('p', { class: 'note' }, 'No element details were recorded for this rule.')); return; }
    const limit = state.nodeLimit[i] || NODE_PAGE;
    const ul = h('ul', { class: 'nodes', 'aria-label': `Affected elements for ${v.title}` });
    v.nodes.slice(0, limit).forEach((n, j) => ul.append(nodeRow(v, n, i, j)));
    body.append(ul);
    if (v.nodes.length > limit) {
      body.append(h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { state.nodeLimit[i] = limit + 25; fillRuleBody(body, v, i); }
      }, (v.nodes.length - limit > 25 ? `Show 25 more (${v.nodes.length - limit} remaining)` : `Show ${v.nodes.length - limit} more`)));
    }
  }

  function nodeRow(v, n, i, j) {
    const key = `${i}:${j}`;
    const open = state.openNodes.has(key);
    const detailsId = `node-details-${i}-${j}`;
    const meta = { impact: v.impact, ruleId: v.id, title: v.title, wcag: v.wcag, message: n.failureSummary || v.description };
    const details = h('div', { class: 'node-details', id: detailsId, hidden: !open });
    if (open) fillNodeDetails(details, n);
    const dbtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-details', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailsId,
      'aria-label': `Details for ${n.selector || 'element'}`,
      onclick: () => {
        const now = !state.openNodes.has(key);
        if (now) state.openNodes.add(key); else state.openNodes.delete(key);
        dbtn.setAttribute('aria-expanded', now ? 'true' : 'false');
        details.hidden = !now;
        if (now && !details.firstChild) fillNodeDetails(details, n);
      }
    }, 'Details', h('span', { class: 'chev', 'aria-hidden': 'true' }));
    const actions = h('div', { class: 'node-actions' }, dbtn);
    if (n.fix && n.fix.css) {
      const pbtn = h('button', { type: 'button', class: 'btn btn-preview', dataset: { previewKey: key } });
      pbtn.addEventListener('click', () => togglePreview(key, n.selector, n.fix.css));
      updatePreviewButton(pbtn);
      actions.append(pbtn);
    }
    actions.append(locateBtn(n.selector, meta, n.selector));
    return h('li', { class: 'node' }, h('div', { class: 'node-row' }, selText(n.selector), actions), details);
  }

  function fillNodeDetails(wrap, n) {
    // Full selector only when the row's one-line version is likely truncated.
    if ((n.selector || '').length > 34) wrap.append(h('div', null, h('div', { class: 'detail-label' }, 'Element'), h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Selector' }, n.selector || '(no selector)')));
    if (n.failureSummary) wrap.append(h('div', null, h('div', { class: 'detail-label' }, 'Why it fails'), h('p', { class: 'rule-desc' }, n.failureSummary)));
    if (n.contrast) {
      const c = n.contrast;
      // Non-text colour samples (fg bar on bg), so the panel never contains failing text.
      const swatch = (fg, bg) => h('span', { class: 'swatch', style: { background: bg }, 'aria-hidden': 'true' }, h('span', { class: 'swatch-fg', style: { background: fg } }));
      wrap.append(h('div', { class: 'contrast' },
        swatch(c.fg, c.bg),
        h('span', null, `${c.state === 'hover' ? 'Hover' : 'Rest'} `, h('code', null, c.fg), ' on ', h('code', null, c.bg), ' ', h('strong', { class: 'tone-red' }, `${num(c.ratio).toFixed(2)}:1`), ` / ${c.required}:1`),
        c.suggestedFg ? swatch(c.suggestedFg, c.bg) : null,
        c.suggestedFg ? h('span', null, 'Use ', h('code', null, c.suggestedFg), ' ', h('strong', { class: 'tone-green' }, `${num(c.suggestedRatio).toFixed(2)}:1`)) : null));
    }
    if (n.html) wrap.append(h('div', null, h('div', { class: 'detail-label' }, 'HTML'), h('pre', { class: 'code', tabindex: '0', 'aria-label': 'HTML snippet' }, n.html)));
    const fix = n.fix || null;
    if (fix) {
      [['css', 'CSS fix'], ['html', 'HTML fix']].forEach(([k, label]) => {
        if (!fix[k]) return;
        const copy = h('button', { type: 'button', class: 'btn btn-ghost btn-copy', 'aria-label': `Copy ${label}`, onclick: (e) => copyText(fix[k], e.currentTarget) }, 'Copy');
        wrap.append(h('div', null, h('div', { class: 'detail-label' }, h('span', { class: 'tone-green' }, label), copy), h('pre', { class: 'code is-fix', tabindex: '0', 'aria-label': `${label} code` }, fix[k])));
      });
      if (fix.note) wrap.append(h('p', { class: 'rule-desc' }, h('strong', { class: 'tone-green' }, 'How to fix: '), fix.note));
    }
  }

  function extractDeclarations(css) {
    const s = String(css || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) return s.slice(a + 1, b).trim();
    return s.trim();
  }

  function updatePreviewButton(btn) {
    const active = state.previews.has(btn.dataset.previewKey);
    clear(btn);
    if (active) btn.append(h('span', { 'aria-hidden': 'true' }, '●'), 'Previewing · Revert');
    else btn.append(h('span', { 'aria-hidden': 'true' }, '✦'), 'Preview Fix');
    btn.classList.toggle('is-previewing', active);
    btn.setAttribute('aria-label', active ? 'Previewing fix. Revert all previewed fixes' : 'Preview this CSS fix on the page');
  }
  function syncPreviewButtons() {
    document.querySelectorAll('[data-preview-key]').forEach(updatePreviewButton);
  }

  async function togglePreview(key, selector, css) {
    if (state.previews.has(key)) {
      const res = await callPage('__auditforgeRevertAllFixes', [], { reinject: false });
      state.previews.clear();
      syncPreviewButtons();
      toast(res.ok === false && !res.missing ? `Revert failed: ${res.error}` : 'All previewed fixes reverted.');
      return;
    }
    const res = await callPage('__auditforgePreviewFix', [selector, extractDeclarations(css)]);
    if (res.ok === false) { toast(`Preview failed: ${res.error || 'unknown error'}`); return; }
    state.previews.add(key);
    syncPreviewButtons();
    toast('Fix previewed on the page. Choose Revert to undo.');
  }

  /* ------------------------------------------------------------------------
     Drawer 2 — Mobile
     ------------------------------------------------------------------------ */
  function currentDevice() { return DEVICES.find((d) => d.id === state.deviceId) || DEVICES[0]; }
  function deviceDims() {
    const d = currentDevice();
    return state.orientation === 'landscape' ? { width: d.height, height: d.width } : { width: d.width, height: d.height };
  }

  function initDeviceControls() {
    const sel = $('device-select');
    DEVICES.forEach((d) => sel.append(h('option', { value: d.id }, d.name)));
    sel.value = state.deviceId;
    sel.addEventListener('change', () => { state.deviceId = sel.value; renderMobile(); });
    document.querySelectorAll('#orientation-group [data-orientation]').forEach((b) => {
      b.addEventListener('click', () => {
        state.orientation = b.dataset.orientation;
        document.querySelectorAll('#orientation-group [data-orientation]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        renderMobile();
      });
    });
  }

  function renderMobile() {
    const r = state.result;
    if (!r) return;
    const body = clear($('mobile-body'));
    const dev = currentDevice();
    const dims = deviceDims();
    const sim = state.mobileAnalysisByDevice[dev.id];
    const simMeta = state.simMeta[dev.id];
    const est = r.mobile.devices.find((d) => d.id === dev.id) || null;
    const a = sim ? normalizeMobile(sim) : r.mobile;
    const score = sim ? a.score : (est ? num(est.score, r.mobile.score) : r.mobile.score);
    $('badge-mobile').textContent = `${r.mobile.score}/100`;

    body.append(h('div', { class: 'device-head' },
      h('span', { class: `device-score tone-${toneForScore(score)}`, 'aria-label': `Mobile health score ${score} out of 100` }, score),
      h('div', { class: 'row-main' },
        h('span', { class: 'device-name' }, dev.name),
        h('span', { class: 'row-sub' }, `${dims.width} × ${dims.height} · ${state.orientation}`)),
      sim
        ? chip(`Device-accurate · ${simMeta ? simMeta.mode : 'simulated'}`, 'green')
        : chip('Estimate', 'amber', 'Estimated from the desktop DOM')));

    const vp = r.mobile.measuredViewport || {};
    if (!sim) body.append(h('p', { class: 'note' }, `Measured at the desktop viewport (${num(vp.width)}×${num(vp.height)}). Launch the simulator for device-accurate results.`));
    else if (simMeta && simMeta.mode === 'snapshot') body.append(h('p', { class: 'note' }, 'Simulator ran in snapshot mode (cross-origin frame).'));

    const aa = a.touchTargets.failures.filter((f) => f.level === 'AA');
    const adv = a.touchTargets.failures.filter((f) => f.level !== 'AA');
    body.append(h('div', { class: 'stats stats-3' },
      stat(a.overlaps.length, 'Overlaps', a.overlaps.length ? 'red' : 'green'),
      stat(a.overflows.length, 'Overflows', a.overflows.length ? 'red' : 'green'),
      stat(aa.length, 'Targets < 24px', aa.length ? 'red' : 'green'),
      stat(adv.length, 'Targets < 44px', adv.length ? 'amber' : 'green'),
      stat(a.touchTargets.crowding.length, 'Crowded', a.touchTargets.crowding.length ? 'amber' : 'green'),
      stat(a.stickyOcclusions.length, 'Sticky > 30%', a.stickyOcclusions.length ? 'amber' : 'green')));

    const vm = a.viewportMeta;
    const vmOk = vm.present && vm.widthDeviceWidth && !vm.userScalableNo && !vm.maxScaleRestricted;
    const meta = (title, wcag, impact) => ({ impact: impact || 'serious', ruleId: 'mobile-layout', title, wcag, message: title });
    const rows = h('div', { class: 'section' });
    rows.append(h('ul', { class: 'rows' }, row({
      title: 'Viewport meta tag',
      sub: [vm.content ? h('code', { class: 'sel', title: vm.content }, vm.content) : 'No <meta name="viewport"> tag', ...vm.issues],
      actions: [chip(vmOk ? 'OK' : vm.present ? 'Issues' : 'Missing', vmOk ? 'green' : vm.present ? 'amber' : 'red')]
    })));
    if (!sim && est && arr(est.fixedWidthElements).length) {
      rows.append(disclosure('m-fixed', 'Wider than this device', est.fixedWidthElements.length, listOrEmpty(est.fixedWidthElements, (s) => row({
        sel: s, actions: [locateBtn(s, meta('Wider than device', ['1.4.10'], 'moderate'), s)] }), ''), 'amber'));
    }
    rows.append(
      disclosure('m-overlap', 'Overlapping elements', a.overlaps.length, listOrEmpty(a.overlaps, (o) => row({
        sel: o.selectorA, sub: [`overlaps ${o.selectorB} · ${num(o.area)}px²`], actions: [locateBtn(o.selectorA, meta('Overlapping element', ['1.4.10']), o.selectorA)] }), 'No overlaps detected.'), 'red'),
      disclosure('m-overflow', 'Horizontal overflows', a.overflows.length, listOrEmpty(a.overflows, (o) => row({
        sel: o.selector, sub: [`right edge ${num(o.right)}px · scroll ${num(o.scrollWidth)} / ${num(o.clientWidth)}`], actions: [locateBtn(o.selector, meta('Horizontal overflow', ['1.4.10']), o.selector)] }), 'No horizontal overflow.'), 'red'),
      disclosure('m-targets', 'Small touch targets', a.touchTargets.failures.length, listOrEmpty(a.touchTargets.failures, (f) => row({
        sel: f.selector,
        sub: [h('span', { class: 'row-sub' }, `${num(f.width)} × ${num(f.height)}px · `, f.level === 'AA' ? h('span', { class: 'tone-red' }, 'Fails 2.5.8 (AA)') : h('span', { class: 'tone-amber' }, 'Below 44px (advisory)'))],
        actions: [locateBtn(f.selector, { impact: f.level === 'AA' ? 'serious' : 'minor', ruleId: 'af-target-size', title: 'Small touch target', wcag: ['2.5.8'], message: `${f.width}×${f.height}px` }, f.selector)] }), 'All targets meet size guidance.'), 'red'),
      disclosure('m-crowd', 'Crowded targets', a.touchTargets.crowding.length, listOrEmpty(a.touchTargets.crowding, (c) => row({
        sel: c.selectorA, sub: [`${num(c.distance)}px from ${c.selectorB}`], actions: [locateBtn(c.selectorA, meta('Crowded target', ['2.5.8']), c.selectorA)] }), 'No crowding detected.'), 'amber'),
      disclosure('m-sticky', 'Sticky / fixed occlusion', a.stickyOcclusions.length, listOrEmpty(a.stickyOcclusions, (s) => row({
        sel: s.selector, sub: [`${num(s.heightPct)}% of screen height`], actions: [locateBtn(s.selector, meta('Sticky element occludes content', ['2.4.11']), s.selector)] }), 'No large sticky elements.'), 'amber'));
    body.append(rows);

    const others = Object.keys(state.mobileAnalysisByDevice).filter((id) => id !== dev.id);
    if (others.length) body.append(h('p', { class: 'note' }, `Also simulated: ${others.map((id) => (DEVICES.find((d) => d.id === id) || { name: id }).name).join(', ')}. Included in the PDF report.`));
    syncToggleButtons();
  }

  async function launchSimulator() {
    const btn = $('mobile-launch');
    btn.disabled = true;
    const deviceId = state.deviceId;
    const orientation = state.orientation;
    announce('Launching mobile simulator…');
    const res = await callPage('__auditforgeStartMobileSimulator', [{ deviceId, orientation }]);
    btn.disabled = false;
    if (res.ok === false) { toast(`Simulator failed: ${res.error || 'unknown error'}`); return; }
    state.mobileSimActive = true;
    state.simMeta[deviceId] = { mode: res.mode || 'live', orientation };
    if (res.analysis && typeof res.analysis === 'object') {
      state.mobileAnalysisByDevice[deviceId] = res.analysis;
      toast(`Simulator running (${res.mode || 'live'}). Device-accurate results loaded.`);
    } else {
      toast(`Simulator running (${res.mode || 'live'}). Device-accurate analysis is not available for this page.`);
    }
    renderMobile();
  }

  async function closeSimulator() {
    await callPage('__auditforgeStopMobileSimulator', [], { reinject: false });
    state.mobileSimActive = false;
    syncToggleButtons();
    toast('Simulator closed.');
  }

  async function openDeviceWindow() {
    const url = (state.result && state.result.meta.url) || state.tabUrl;
    const d = deviceDims();
    const res = await sendMessage({ type: 'OPEN_DEVICE_WINDOW', url, width: d.width, height: d.height });
    if (res.ok) { state.deviceWindowId = res.windowId != null ? res.windowId : null; toast(`Opened a ${d.width}×${d.height} device window.`); }
    else toast(`Could not open window: ${res.error || 'unknown error'}`);
  }

  async function resizeWindow() {
    const d = deviceDims();
    const res = await sendMessage({ type: 'RESIZE_WINDOW_TO_DEVICE', width: d.width, height: d.height });
    toast(res.ok ? `Window resized to ${d.width}×${d.height}.` : `Could not resize window: ${res.error || 'unknown error'}`);
  }

  /* ------------------------------------------------------------------------
     Drawer 3 — Screen reader
     ------------------------------------------------------------------------ */
  function srSequence() {
    return state.live.sequence || (state.result ? state.result.screenReader.sequence : []);
  }
  function srBarrierCount() {
    if (state.live.sequence) return num(state.live.barrierCount, state.live.sequence.filter((s) => s.isBarrier).length);
    return state.result ? state.result.screenReader.barrierCount : 0;
  }
  const isSkipped = (item) => state.skipHidden && item.visibility === 'hidden-visual';

  function initPersonas() {
    const g = $('persona-group');
    PERSONAS.forEach((p) => g.append(h('button', {
      type: 'button', class: 'seg-card', dataset: { persona: p.id }, 'aria-pressed': p.id === state.persona ? 'true' : 'false',
      onclick: () => setPersona(p.id)
    }, h('strong', null, p.name), h('span', null, p.syntax))));
  }

  async function setPersona(id) {
    if (id === state.persona) return;
    state.persona = id;
    document.querySelectorAll('#persona-group [data-persona]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.persona === id ? 'true' : 'false'));
    stopSpeech();
    preserveUi(renderTimeline);
    const p = PERSONAS.find((x) => x.id === id);
    announce(`${p.name} selected.`);
    if (state.hudActive && state.result) await startHud();
  }

  const CAT_LABEL = { headings: 'Heading hierarchy', landmarks: 'Landmark coverage', labeling: 'Control labelling', focus: 'Focus & tab flow', images: 'Image alternatives' };
  const CAT_WEIGHT = { headings: 25, landmarks: 20, labeling: 30, focus: 15, images: 10 };

  function renderScreenReader() {
    const sr = state.result.screenReader;
    const box = clear($('sr-score'));
    const ring = h('div', { class: 'mini-ring' });
    ring.append(scoreRing(sr.score, 'Screen reader score', 80, 8));
    box.append(sectionH('Compatibility'),
      h('div', { class: 'sr-scorebox' }, ring,
        h('div', { class: 'row-chips' },
          chip(`Headings: ${sr.headingStatus || 'Unknown'}`, sr.headingStatus === 'Sequential' ? 'green' : 'amber'),
          chip(`Landmarks: ${sr.landmarkStatus || 'Unknown'}`, sr.landmarkStatus === 'Verified' ? 'green' : 'amber'),
          h('span', { id: 'sr-barriers' }))),
      h('ul', { class: 'cats' }, Object.keys(CAT_LABEL).filter((k) => sr.categories[k]).map((k) => {
        const c = sr.categories[k];
        const sc = num(c.score);
        return h('li', null,
          h('div', { class: 'cat-top' }, h('span', null, CAT_LABEL[k]), h('span', { class: 'num' }, `${sc} · ${num(c.weight, CAT_WEIGHT[k])}%`)),
          h('div', { class: `bar tone-${toneForScore(sc)}`, 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(0, Math.min(100, sc))}%` } })),
          c.detail ? h('div', { class: 'cat-detail' }, c.detail) : null);
      })));
    updateBarrierChip();

    renderTimeline();

    const st = clear($('sr-structure'));
    st.append(h('div', { class: 'section' }, sectionH('Heading tree'),
      sr.headings.length ? h('ul', { class: 'rows htree' }, sr.headings.map((hd) => row({
        lead: h('span', { class: 'hlvl', style: { marginLeft: `${(Math.max(1, num(hd.level, 1)) - 1) * 12}px` } }, `H${hd.level}`),
        title: hd.text || '(empty heading)', sub: hd.issue ? [h('span', { class: 'row-sub tone-amber' }, hd.issue)] : null,
        actions: [locateBtn(hd.selector, { impact: hd.issue ? 'moderate' : 'minor', ruleId: 'heading-order', title: `Heading level ${hd.level}`, wcag: ['1.3.1'], message: hd.issue || hd.text }, `heading ${hd.text || hd.selector}`)]
      }))) : h('p', { class: 'note' }, 'No headings found.')));

    const lm = sr.landmarks;
    st.append(h('div', { class: 'section' }, sectionH('Landmarks'),
      h('div', { class: 'lm-grid' }, ['banner', 'main', 'navigation', 'contentinfo'].map((k) => chip(`${lm[k] ? '✓' : '✕'} ${k}`, lm[k] ? 'green' : 'red', lm[k] ? 'Present' : 'Missing'))),
      lm.list.length ? h('ul', { class: 'rows' }, lm.list.map((l) => row({
        title: l.label ? `${l.role} · ${l.label}` : l.role, sel: l.selector,
        actions: [locateBtn(l.selector, { impact: 'minor', ruleId: 'landmark', title: `${l.role} landmark`, wcag: ['1.3.1'], message: l.label || l.role }, `${l.role} landmark`)]
      }))) : null));

    st.append(h('div', { class: 'section' }, sectionH(`Silent controls (${sr.silentControls.length})`),
      listOrEmpty(sr.silentControls, (c) => row({
        title: c.role || 'control', sel: c.selector,
        actions: [locateBtn(c.selector, { impact: 'critical', ruleId: 'silent-control', title: 'Control has no accessible name', wcag: ['4.1.2'], message: c.html }, c.selector)]
      }), 'Every interactive control has an accessible name.')));
  }

  function updateBarrierChip() {
    const el = $('sr-barriers');
    if (!el) return;
    const n = srBarrierCount();
    clear(el).append(chip(plural(n, 'barrier'), n ? 'red' : 'green'));
  }

  function announcementFor(item, persona) {
    const a = item.announcements || {};
    if (a[persona]) return a[persona];
    return [item.name, item.role, item.state, item.hint].filter(Boolean).join(', ') || item.role || 'unlabelled';
  }
  const itemKey = (item, i) => `sr|${item.index != null ? item.index : i}|${item.selector}`;

  function renderTimeline() {
    const ol = clear($('sr-timeline'));
    if (!state.result) return;
    const seq = srSequence();
    if (!seq.length) { ol.append(h('li', { class: 'empty' }, 'No reading sequence was recorded.')); return; }
    const pname = PERSONAS.find((p) => p.id === state.persona).name;
    ol.setAttribute('aria-label', `${pname} announcements`);
    seq.forEach((item, i) => {
      const text = announcementFor(item, state.persona);
      const k = itemKey(item, i);
      const skipped = isSkipped(item);
      const cat = item.category === 'heading' && item.headingLevel ? `heading ${item.headingLevel}` : item.category;
      ol.append(row({
        cls: `${skipped ? 'is-skipped' : ''}`,
        data: { k },
        lead: h('span', { class: `idx${item.isBarrier ? ' is-warn' : ''}` }, i + 1),
        title: null,
        extra: null,
        sub: [h('span', { class: 'sr-cat' }, cat), h('span', { class: 'sr-say' }, `“${text}”`),
          item.isBarrier && item.barrierReason ? h('span', { class: 'row-sub tone-red' }, item.barrierReason) : null,
          skipped ? h('span', { class: 'row-sub' }, 'Skipped by Read All') : null],
        chips: [item.isBarrier ? chip('Barrier', 'red') : null, visChip(item)],
        actions: [
          h('button', { type: 'button', class: 'btn btn-sm btn-icon', 'aria-label': `Listen to item ${i + 1}`, title: 'Listen', dataset: { key: `listen|${k}` }, onclick: () => listenItem(item) }, h('span', { 'aria-hidden': 'true' }, '▶')),
          locateBtn(item.selector, { impact: item.isBarrier ? 'serious' : 'minor', ruleId: 'sr-sequence', title: text, wcag: item.isBarrier ? ['4.1.2'] : [], message: item.barrierReason || text }, `item ${i + 1}`, `loc|${k}`)
        ]
      }));
    });
    if (speech.current) markSpeaking(speech.current);
  }

  async function startHud() {
    return callPage('__auditforgeStartVoiceOverSimulator', [state.persona, srSequence(), { includeHiddenVisual: !state.skipHidden }]);
  }

  async function toggleHud() {
    if (!state.result) return;
    if (state.hudActive) {
      await callPage('__auditforgeStopVoiceOverSimulator', [], { reinject: false });
      state.hudActive = false;
      syncToggleButtons();
      toast('On-page HUD stopped.');
      return;
    }
    stopSpeech();
    const res = await startHud();
    if (res.ok === false) { toast(`HUD failed: ${res.error || 'unknown error'}`); return; }
    state.hudActive = true;
    syncToggleButtons();
    toast('On-page HUD launched. Use the arrow keys on the page to move.');
  }

  async function setSkipHidden(skip) {
    state.skipHidden = skip;
    preserveUi(renderTimeline);
    announce(skip ? 'Content hidden from view will be skipped.' : 'Content hidden from view will be read.');
    if (state.hudActive) await startHud();
  }

  /* ---------- Earcons (Web Audio, spec §5.3 tone profiles) ---------- */
  let audioCtx = null;
  function getAudioCtx() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    } catch (e) { return null; }
  }

  /** Must first be called from a click handler (audio policy, spec §9.3). Returns duration in ms. */
  function playEarcon(persona) {
    const ctx = getAudioCtx();
    if (!ctx) return 0;
    const now = ctx.currentTime + 0.01;
    const tone = (type, f0, f1, start, dur, vol) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, now + start);
      if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, now + start + dur);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.linearRampToValueAtTime(vol, now + start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    try {
      switch (persona) {
        case 'voiceover': // harmonic crystalline dual-sine bell chime (E5 & C6)
          tone('sine', 659.25, 0, 0, 0.32, 0.05);
          tone('sine', 1046.5, 0, 0.05, 0.36, 0.035);
          return 420;
        case 'talkback': { // resonant fluid bubble bloop 460Hz → 280Hz
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(460, now);
          osc.frequency.exponentialRampToValueAtTime(280, now + 0.09);
          gain.gain.setValueAtTime(0.06, now);
          gain.gain.linearRampToValueAtTime(0.001, now + 0.09);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.09);
          return 120;
        }
        case 'nvda': // crisp square-wave chirp 440Hz → 660Hz
          tone('square', 440, 660, 0, 0.07, 0.022);
          return 100;
        case 'narrator': // fluent two-tone soft sine chord (D5 & A5)
          tone('sine', 587.33, 0, 0, 0.28, 0.04);
          tone('sine', 880, 0, 0, 0.28, 0.03);
          return 320;
        default:
          return 0;
      }
    } catch (e) { return 0; }
  }

  /* ---------- Speech (Web Speech, falling back to chrome.tts) ---------- */
  const speech = { token: 0, useTts: !('speechSynthesis' in window), voices: [], speaking: false, current: null };

  function speechRate() { return parseFloat($('sr-rate').value) || 1; }

  function loadVoices() {
    const sel = $('sr-voice');
    const prev = sel.value;
    const fill = (voices) => {
      clear(sel);
      sel.append(h('option', { value: '' }, 'Default voice'));
      voices.forEach((v) => sel.append(h('option', { value: v.value }, v.label)));
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    };
    if (!speech.useTts && window.speechSynthesis) {
      const vs = window.speechSynthesis.getVoices() || [];
      speech.voices = vs;
      if (vs.length) { fill(vs.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))); return; }
    }
    try {
      if (hasChrome && chrome.tts && chrome.tts.getVoices) {
        chrome.tts.getVoices((vs) => {
          if (!speech.useTts && speech.voices.length) return;
          fill((vs || []).filter((v) => v.voiceName).map((v) => ({ value: `tts:${v.voiceName}`, label: `${v.voiceName}${v.lang ? ` (${v.lang})` : ''}` })));
        });
      }
    } catch (e) { /* no voices */ }
  }

  function speakTts(text, token) {
    return new Promise((resolve) => {
      if (!hasChrome || !chrome.tts) return resolve();
      const v = $('sr-voice').value;
      const opts = { rate: speechRate(), enqueue: false };
      if (v.startsWith('tts:')) opts.voiceName = v.slice(4);
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(finish, 3000 + text.length * 110 / speechRate());
      opts.onEvent = (e) => { if (['end', 'interrupted', 'cancelled', 'error'].includes(e.type)) finish(); };
      try { chrome.tts.speak(text, opts, () => { if (chrome.runtime && chrome.runtime.lastError) finish(); }); } catch (e) { finish(); }
      if (token !== speech.token) finish();
    });
  }

  function speak(text, token) {
    if (speech.useTts || !window.speechSynthesis) return speakTts(text, token);
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = speechRate();
      const vv = $('sr-voice').value;
      const voice = speech.voices.find((v) => v.voiceURI === vv);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(finish, 2500 + text.length * 100 / speechRate());
      u.onend = finish;
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return finish();
        // Web Speech unavailable/blocked: fall back to chrome.tts for this and later items.
        if (hasChrome && chrome.tts) {
          speech.useTts = true;
          clearTimeout(t);
          done = true;
          speakTts(text, token).then(resolve);
        } else finish();
      };
      try { window.speechSynthesis.speak(u); } catch (e) { finish(); }
    });
  }

  function markSpeaking(item) {
    speech.current = item;
    const list = $('sr-timeline');
    const target = item ? `|${item.index}|${item.selector}` : null;
    list.querySelectorAll('.row').forEach((li) => {
      const on = !!target && (li.dataset.k || '').endsWith(target);
      li.classList.toggle('is-speaking', on);
      if (on) { li.setAttribute('aria-current', 'true'); scrollWithin(list, li); } else li.removeAttribute('aria-current');
    });
  }

  function setSpeaking(on) {
    speech.speaking = on;
    $('sr-stop').disabled = !on;
  }

  function stopSpeech() {
    speech.token += 1;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    try { if (hasChrome && chrome.tts && chrome.tts.stop) chrome.tts.stop(); } catch (e) { /* ignore */ }
    if ($('sr-stop')) setSpeaking(false);
    if ($('sr-timeline')) markSpeaking(null);
  }

  async function speakItem(item, token) {
    markSpeaking(item);
    if ($('sr-earcons').checked) {
      const ms = playEarcon(state.persona);
      if (ms) await sleep(Math.min(ms, 250));
    }
    if (token !== speech.token) return;
    await speak(announcementFor(item, state.persona), token);
  }

  async function listenItem(item) {
    stopSpeech();
    getAudioCtx(); // unlock audio inside the click gesture
    const token = speech.token;
    setSpeaking(true);
    await speakItem(item, token);
    if (token === speech.token) { setSpeaking(false); markSpeaking(null); }
  }

  async function readAll() {
    if (!state.result) return;
    stopSpeech();
    getAudioCtx();
    const token = speech.token;
    setSpeaking(true);
    // Snapshot: live updates during reading don't disturb the current pass.
    const seq = srSequence().filter((item) => !isSkipped(item));
    announce(`Reading ${plural(seq.length, 'item')}${state.skipHidden ? ', skipping content hidden from view' : ''}.`);
    for (const item of seq) {
      if (token !== speech.token) return;
      await speakItem(item, token);
      if (token !== speech.token) return;
      await sleep(220);
    }
    if (token === speech.token) { setSpeaking(false); markSpeaking(null); announce('Finished reading.'); }
  }

  /* ------------------------------------------------------------------------
     Drawer 4 — Tab order
     ------------------------------------------------------------------------ */
  function tabOrderView() {
    return state.live.tabOrder || (state.result ? state.result.tabOrder : null);
  }
  const tabKey = (s, i) => `tab|${s.index != null ? s.index : i}|${s.selector}`;

  function renderTabOrder() {
    const t = tabOrderView();
    if (!t) return;
    $('badge-tab').textContent = plural(t.total, 'stop');
    const body = clear($('tab-body'));
    const statusTone = { Sequential: 'green', 'Needs Review': 'amber', Disrupted: 'red' }[t.status] || 'muted';
    const sl = t.skipLink;
    const hiddenCount = t.sequence.filter((s) => s.visibility === 'hidden-visual').length;
    body.append(h('div', { class: 'row-chips' }, chip(`Focus flow: ${t.status}`, statusTone)), h('div', { class: 'stats' },
      stat(t.total, 'Tab stops', 'cyan'),
      stat(t.anomalies.length, 'Anomalies', t.anomalies.length ? 'red' : 'green'),
      stat(t.positiveTabindexCount, 'tabindex > 0', t.positiveTabindexCount ? 'amber' : 'green'),
      stat(hiddenCount, 'Hidden stops', hiddenCount ? 'amber' : 'green')));

    body.append(h('ul', { class: 'rows' }, row({
      title: 'Skip-to-content link',
      sub: [`Present ${sl.present ? 'yes' : 'no'} · Works ${sl.functional ? 'yes' : 'no'} · Visible on focus ${sl.visibleOnFocus ? 'yes' : 'no'}`],
      actions: [sl.present && sl.selector
        ? locateBtn(sl.selector, { impact: 'minor', ruleId: 'skip-link', title: 'Skip link', wcag: ['2.4.1'], message: '' }, 'skip link')
        : chip('Missing', 'red')]
    })));

    if (t.anomalies.length) {
      body.append(h('div', { class: 'section' }, sectionH(`Flow anomalies (${t.anomalies.length})`),
        h('ul', { class: 'rows' }, t.anomalies.map((a) => row({
          title: [chip('Anomaly', 'amber'), ' ', a.type.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())],
          sub: [`${a.fromIndex >= 0 ? `#${a.fromIndex + 1} → ` : ''}#${a.toIndex + 1} · ${a.message}`]
        })))));
    }

    const live = state.live.tabAt;
    const focusNote = h('span', { class: 'meta-line', id: 'tab-focus-note' }, '');
    const sec = h('div', { class: 'section' }, sectionH('Focus sequence', focusNote));
    if (live) sec.append(h('p', { class: 'note' }, `Live from the page · updated ${live.toLocaleTimeString()}`));
    if (!t.sequence.length) sec.append(h('p', { class: 'note' }, 'No focusable elements found.'));
    else {
      sec.append(h('ol', { class: 'rows scroll-list', id: 'tab-seq', 'aria-label': 'Tab stops in focus order' }, t.sequence.map((s, i) => row({
        data: { k: tabKey(s, i), sel: s.selector, i: String(i) },
        lead: h('span', { class: `idx${s.isAnomaly ? ' is-warn' : ''}`, 'aria-hidden': 'true' }, i + 1),
        title: s.name || h('span', { class: 'tone-red' }, '(no accessible name)'),
        sub: [[s.role, s.tabindex != null ? `tabindex=${s.tabindex}` : null].filter((x) => x != null).join(' · '),
          s.warning ? h('span', { class: 'row-sub tone-amber' }, s.warning) : null,
          s.keys ? h('span', { class: 'row-sub tone-cyan' }, `⌨ ${s.keys}`) : null],
        chips: [visChip(s)],
        actions: [locateBtn(s.selector, { impact: s.isAnomaly ? 'serious' : 'minor', ruleId: 'tab-order', title: `Tab stop #${i + 1}`, wcag: ['2.4.3'], message: s.warning || `${s.role} ${s.name}` }, `tab stop ${i + 1}`, `loc|${tabKey(s, i)}`)]
      }))));
    }
    body.append(sec);
    applyTabFocus(false);
  }

  /** Highlights the stop the page reported as focused (AF_TAB_FOCUS_CHANGED). */
  function applyTabFocus(scroll) {
    const list = $('tab-seq');
    const note = $('tab-focus-note');
    const f = state.focusedTab;
    if (!list) return;
    const rows = [...list.querySelectorAll('.row')];
    let hit = null;
    if (f) {
      hit = rows.find((r) => r.dataset.sel === f.selector && (f.index == null || r.dataset.i === String(f.index)))
        || rows.find((r) => r.dataset.sel === f.selector)
        || (f.index != null ? rows[f.index] : null);
    }
    rows.forEach((r) => {
      const on = r === hit;
      r.classList.toggle('is-focused', on);
      if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    });
    if (note) note.textContent = hit ? `Focused: #${Number(hit.dataset.i) + 1} of ${rows.length}` : '';
    if (hit && scroll) scrollWithin(list, hit);
  }

  async function toggleTabTrail() {
    if (!state.result) return;
    if (state.tabTrail) {
      await callPage('__auditforgeHideTabTrail', [], { reinject: false });
      state.tabTrail = false;
      state.focusedTab = null;
      $('live-tab').hidden = true;
      syncToggleButtons();
      applyTabFocus(false);
      toast('Tab-Trail hidden.');
      return;
    }
    const res = await callPage('__auditforgeShowTabTrail', [tabOrderView().sequence, { lineStyle: state.lineStyle, live: true }]);
    if (res.ok === false) { toast(`Tab-Trail failed: ${res.error || 'unknown error'}`); return; }
    state.tabTrail = true;
    syncToggleButtons();
    toast(`Tab-Trail shown${typeof res.drawn === 'number' ? ` (${res.drawn} stops drawn)` : ''}.`);
  }

  async function setLineStyle(style) {
    state.lineStyle = style;
    document.querySelectorAll('#line-style-group [data-line-style]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lineStyle === style ? 'true' : 'false'));
    if (state.tabTrail) {
      let res = await callPage('__auditforgeSetTabTrailLineStyle', [style], { reinject: false });
      // Older overlay builds: redraw the trail with the new style instead.
      if (res.missing) res = await callPage('__auditforgeShowTabTrail', [tabOrderView().sequence, { lineStyle: style, live: true }]);
      if (res.ok === false) { toast(`Could not change line style: ${res.error || 'unknown error'}`); return; }
    }
    announce(`${style === 'curved' ? 'Curved' : 'Straight'} Tab-Trail lines.`);
  }

  /* ------------------------------------------------------------------------
     Live updates from the page (CONTRACT §10.3 / §10.4)
     ------------------------------------------------------------------------ */
  function normalizeTabOrder(t) {
    t = Object.assign({}, t || {});
    t.sequence = arr(t.sequence);
    t.anomalies = arr(t.anomalies);
    t.total = num(t.total, t.sequence.length);
    t.positiveTabindexCount = num(t.positiveTabindexCount);
    t.skipLink = t.skipLink || { present: false, functional: false, visibleOnFocus: false, selector: null };
    t.status = t.status || 'Needs Review';
    return t;
  }

  function showLive(which, at) {
    const pill = $(`live-${which}`);
    pill.hidden = false;
    pill.title = `Updated live from the page at ${at.toLocaleTimeString()}`;
  }

  function onTabOrderUpdated(tabOrder) {
    if (!state.result || !tabOrder) return;
    state.live.tabOrder = normalizeTabOrder(tabOrder);
    state.live.tabAt = new Date();
    showLive('tab', state.live.tabAt);
    preserveUi(renderTabOrder);
  }

  function onSrSequenceUpdated(sequence, barrierCount) {
    if (!state.result || !Array.isArray(sequence)) return;
    state.live.sequence = sequence;
    state.live.barrierCount = barrierCount;
    state.live.srAt = new Date();
    showLive('sr', state.live.srAt);
    $('sr-live-note').textContent = `Live · updated ${state.live.srAt.toLocaleTimeString()}`;
    preserveUi(() => { renderTimeline(); updateBarrierChip(); });
  }

  function onTabFocusChanged(index, selector) {
    if (!state.result) return;
    state.focusedTab = { index: typeof index === 'number' ? index : null, selector: selector || null };
    applyTabFocus(true);
  }

  function resetLive() {
    state.live = { tabOrder: null, sequence: null, barrierCount: 0, tabAt: null, srAt: null };
    state.focusedTab = null;
    ['live-tab', 'live-sr'].forEach((id) => { const el = $(id); if (el) el.hidden = true; });
    const n = $('sr-live-note');
    if (n) n.textContent = '';
  }

  /* ------------------------------------------------------------------------
     Drawer 5 — Vision
     ------------------------------------------------------------------------ */
  function renderVision() {
    const body = clear($('vision-body'));
    LENS_GROUPS.forEach((g) => {
      body.append(h('div', { class: 'section' }, sectionH(g.title),
        h('div', { class: 'lens-grid', role: 'group', 'aria-label': g.title }, g.lenses.map((l) => h('button', {
          type: 'button', class: 'lens', dataset: { lens: l.id }, 'aria-pressed': state.lens === l.id ? 'true' : 'false',
          onclick: () => applyLens(state.lens === l.id ? 'none' : l.id)
        }, h('strong', null, l.label), h('span', null, l.desc))))));
    });
    syncToggleButtons();
  }

  async function applyLens(id) {
    const res = id === 'none'
      ? await callPage('__auditforgeResetVision', [], { reinject: false })
      : await callPage('__auditforgeApplyVisionFilter', [id]);
    if (res.ok === false && !(id === 'none' && res.missing)) { toast(`Lens failed: ${res.error || 'unknown error'}`); return; }
    state.lens = id;
    syncToggleButtons();
    toast(id === 'none' ? 'Vision reset to normal.' : `${LENS_LABEL[id]} lens applied.`);
  }

  /* ------------------------------------------------------------------------
     Drawer 6 — Links
     ------------------------------------------------------------------------ */
  const SECURITY_TYPES = ['missing-noopener', 'javascript-void'];
  const STATUS_TONE = { ok: 'green', warning: 'amber', error: 'red' };
  const STATUS_LABEL = { ok: 'OK', warning: 'Warning', error: 'Error' };

  function renderLinks() {
    const l = state.result.links;
    const body = clear($('links-body'));
    body.append(h('div', { class: 'stats' },
      stat(l.total, 'Links', 'cyan'), stat(l.internal, 'Internal', 'muted'), stat(l.external, 'External', 'muted'), stat(l.anchors, 'Anchors', 'muted')),
      h('div', { class: 'stats stats-tight' }, stat(l.counts.ok, 'OK', 'green'), stat(l.counts.warning, 'Warnings', 'amber'), stat(l.counts.error, 'Errors', 'red')));

    const protos = {};
    l.list.forEach((x) => { const p = x.protocol || '(none)'; protos[p] = (protos[p] || 0) + 1; });
    const entries = Object.entries(protos).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    body.append(h('div', { class: 'section' }, sectionH('Protocols'),
      entries.length ? h('div', null, entries.map(([p, n]) => h('div', { class: 'proto' },
        h('span', { class: 'proto-name' }, p), h('div', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${(n / max) * 100}%` } })), h('span', { class: 'num' }, n))))
        : h('p', { class: 'note' }, 'No links found.')));

    const issueRow = (x) => row({
      title: [chip(IMPACT_LABEL[x.severity] || x.severity, SEV_TONE[x.severity] || 'muted'), ' ', x.text || '(no text)'], sel: x.href || '(empty href)', sub: [x.message],
      actions: [locateBtn(x.selector, { impact: x.severity, ruleId: `af-link-${x.type}`, title: x.message, wcag: x.type === 'generic-text' || x.type === 'no-text' ? ['2.4.4'] : [], message: x.href }, x.text || x.selector)]
    });
    const sec = l.issues.filter((x) => SECURITY_TYPES.includes(x.type));
    const other = l.issues.filter((x) => !SECURITY_TYPES.includes(x.type));
    body.append(h('div', { class: 'section' }, sectionH(`Security issues (${sec.length})`), listOrEmpty(sec, issueRow, 'No link security issues.')));
    body.append(h('div', { class: 'section' }, sectionH(`Integrity issues (${other.length})`), listOrEmpty(other, issueRow, 'No broken or empty links.')));

    const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter links by status' });
    [['all', 'All', l.list.length], ['ok', 'OK', l.list.filter((x) => x.status === 'ok').length], ['warning', 'Warnings', l.list.filter((x) => x.status === 'warning').length], ['error', 'Errors', l.list.filter((x) => x.status === 'error').length]]
      .forEach(([k, label, n]) => filters.append(h('button', {
        type: 'button', class: 'seg-btn', dataset: { linkFilter: k }, 'aria-pressed': state.linkFilter === k ? 'true' : 'false',
        onclick: () => {
          state.linkFilter = k;
          filters.querySelectorAll('[data-link-filter]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.linkFilter === k ? 'true' : 'false'));
          renderLinkList();
        }
      }, label, h('span', { class: 'n' }, n))));
    body.append(h('div', { class: 'section' }, sectionH('All links'), filters, h('ul', { class: 'rows scroll-list', id: 'links-list', 'aria-label': 'Links' })));
    renderLinkList();
  }

  function renderLinkList() {
    const ul = clear($('links-list'));
    const items = state.result.links.list.filter((x) => state.linkFilter === 'all' || x.status === state.linkFilter);
    if (!items.length) { ul.append(h('li', { class: 'empty' }, 'No links match this filter.')); return; }
    items.forEach((x) => ul.append(row({
      lead: h('span', { class: `dot tone-${STATUS_TONE[x.status] || 'muted'}`, title: STATUS_LABEL[x.status] || x.status }, h('span', { class: 'sr-only' }, STATUS_LABEL[x.status] || x.status)),
      title: x.text || '(no text)', sel: x.href || '(empty href)',
      sub: [x.issueTypes && x.issueTypes.length ? h('span', { class: 'row-sub tone-amber' }, x.issueTypes.join(', ').replace(/-/g, ' ')) : null],
      chips: [x.isExternal ? chip('External', 'magenta') : null, x.target === '_blank' ? chip('New tab', 'muted') : null],
      actions: [locateBtn(x.selector, { impact: x.status === 'error' ? 'serious' : x.status === 'warning' ? 'moderate' : 'minor', ruleId: 'link', title: x.text || 'Link', wcag: [], message: x.href }, `link ${x.text || x.href || x.selector}`)]
    })));
  }

  /* ------------------------------------------------------------------------
     Toggle button sync (also used by AF_OVERLAY_CLOSED)
     ------------------------------------------------------------------------ */
  function syncToggleButtons() {
    const tt = $('tab-trail');
    tt.textContent = state.tabTrail ? 'Hide Tab-Trail' : 'Show Tab-Trail';
    tt.classList.toggle('is-active', state.tabTrail);
    const hud = $('sr-hud');
    hud.textContent = state.hudActive ? 'Stop On-Page HUD' : 'Launch On-Page HUD';
    hud.classList.toggle('is-active', state.hudActive);
    $('mobile-close').hidden = !state.mobileSimActive;
    const ml = $('mobile-launch');
    clear(ml).append(h('span', { 'aria-hidden': 'true' }, '📱'), state.mobileSimActive ? ' Relaunch Simulator' : ' Launch Simulator');
    ml.classList.toggle('is-active', state.mobileSimActive);
    document.querySelectorAll('[data-lens]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lens === state.lens ? 'true' : 'false'));
    $('vision-status').textContent = state.lens === 'none' ? 'No lens active.' : `Active lens: ${LENS_LABEL[state.lens] || state.lens}`;
    syncPreviewButtons();
  }

  function onOverlayClosed(overlay) {
    switch (overlay) {
      case 'tabTrail': state.tabTrail = false; state.focusedTab = null; $('live-tab').hidden = true; applyTabFocus(false); break;
      case 'vision': state.lens = 'none'; break;
      case 'voiceover': state.hudActive = false; $('live-sr').hidden = true; break;
      case 'mobile': state.mobileSimActive = false; break;
      case 'fixPreview': state.previews.clear(); break;
      case 'highlight': default: break;
    }
    syncToggleButtons();
  }

  function onRuntimeMessage(msg, sender) {
    if (!msg || typeof msg.type !== 'string') return;
    // Only accept page events from the audited tab.
    if (sender && sender.tab && state.tabId != null && sender.tab.id !== state.tabId) return;
    switch (msg.type) {
      case 'AF_OVERLAY_CLOSED': onOverlayClosed(msg.overlay); break;
      case 'AF_TAB_ORDER_UPDATED': onTabOrderUpdated(msg.tabOrder); break;
      case 'AF_SR_SEQUENCE_UPDATED': onSrSequenceUpdated(msg.sequence, msg.barrierCount); break;
      case 'AF_TAB_FOCUS_CHANGED': onTabFocusChanged(msg.index, msg.selector); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------------
     Drawers (accordion)
     ------------------------------------------------------------------------ */
  function initDrawers() {
    document.querySelectorAll('.drawer-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        $(btn.getAttribute('aria-controls')).hidden = !open;
        btn.closest('.drawer').classList.toggle('is-open', open);
        if (open && btn.id === 'drawer-sr-btn') loadVoices();
      });
    });
  }

  /* ------------------------------------------------------------------------
     PDF
     ------------------------------------------------------------------------ */
  async function downloadPdf() {
    if (!state.result) return;
    const btn = $('download-pdf');
    if (typeof window.generateWcagPdfReport !== 'function') { toast('PDF compiler is not available.'); return; }
    btn.disabled = true;
    announce('Generating PDF report…');
    try {
      const res = await window.generateWcagPdfReport(state.result, { mobileAnalysisByDevice: state.mobileAnalysisByDevice });
      if (res && res.ok === false) toast(`PDF failed: ${res.error || 'unknown error'}`);
      else toast(`PDF report saved${res && res.pages ? ` (${res.pages} pages)` : ''}.`);
    } catch (e) {
      toast(`PDF failed: ${errMsg(e)}`);
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
     New audit
     ------------------------------------------------------------------------ */
  async function newAudit() {
    stopSpeech();
    state.runId += 1;
    if (state.tabId != null) await callPage('__auditforgeClearAll', [], { reinject: false });
    resetOverlayFlags();
    resetLive();
    showView('welcome');
    refreshTargetFromTab();
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    initDrawers();
    initDeviceControls();
    initPersonas();
    syncToggleButtons();

    $('audit-form').addEventListener('submit', (e) => { e.preventDefault(); runAudit(); });
    $('target-url').addEventListener('input', () => { setUrlError(''); updateFileBanner(); });
    $('file-banner-settings').addEventListener('click', openExtensionSettings);
    $('progress-cancel').addEventListener('click', () => { state.runId += 1; showView('welcome'); announce('Audit cancelled.'); });
    $('new-audit').addEventListener('click', newAudit);
    $('download-pdf').addEventListener('click', downloadPdf);

    $('wcag-search').addEventListener('input', (e) => { state.search = e.target.value; renderWcagList(); });

    $('mobile-launch').addEventListener('click', launchSimulator);
    $('mobile-close').addEventListener('click', closeSimulator);
    $('mobile-window').addEventListener('click', openDeviceWindow);
    $('mobile-resize').addEventListener('click', resizeWindow);

    $('sr-hud').addEventListener('click', toggleHud);
    $('sr-skip-hidden').addEventListener('change', (e) => setSkipHidden(e.target.checked));
    $('sr-earcon-preview').addEventListener('click', () => { if (!playEarcon(state.persona)) toast('Audio is not available.'); });
    $('sr-readall').addEventListener('click', readAll);
    $('sr-stop').addEventListener('click', () => { stopSpeech(); announce('Speech stopped.'); });
    $('sr-rate').addEventListener('input', (e) => { $('sr-rate-out').textContent = `${parseFloat(e.target.value).toFixed(1)}×`; });
    $('sr-voice').addEventListener('change', (e) => { if (e.target.value.startsWith('tts:')) speech.useTts = true; });

    $('tab-trail').addEventListener('click', toggleTabTrail);
    document.querySelectorAll('#line-style-group [data-line-style]').forEach((b) => b.addEventListener('click', () => setLineStyle(b.dataset.lineStyle)));
    $('vision-reset').addEventListener('click', () => applyLens('none'));

    $('error-retry').addEventListener('click', () => { if (state.lastUrl) $('target-url').value = state.lastUrl; runAudit(); });
    $('error-back').addEventListener('click', () => { showView('welcome'); refreshTargetFromTab(); });
    $('error-settings').addEventListener('click', openExtensionSettings);

    if (window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    }

    if (hasChrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender) => { onRuntimeMessage(msg, sender); return false; });
    }
    if (hasChrome && chrome.tabs) {
      // The audited page reloaded/navigated: every overlay is gone.
      if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, info) => {
          if (tabId === state.tabId && info.status === 'loading' && state.view === 'results') { resetOverlayFlags(); $('live-tab').hidden = true; $('live-sr').hidden = true; }
          if (tabId === state.tabId && info.url && state.view === 'welcome') refreshTargetFromTab();
        });
      }
      if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(() => { if (state.view === 'welcome') refreshTargetFromTab(); });
      }
    }

    showView('welcome', { focus: false });
    refreshTargetFromTab();
    loadVoices();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
