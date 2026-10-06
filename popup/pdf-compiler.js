/*
 * Mattccessibility Tool v1.4.0 - Vector PDF Compliance Compiler (spec \u00A77, contract \u00A77)
 *
 * Exposes: window.generateWcagPdfReport(auditData, options?) -> Promise<{ ok, filename, pages, error? }>
 *   auditData : AuditResult (contract \u00A74)
 *   options   : { mobileAnalysisByDevice?: Record<deviceId, MobileAnalysis> }
 *
 * Requires (loaded before this file): lib/jspdf.umd.min.js (jsPDF 4.x) and
 * lib/jspdf.plugin.autotable.js (AutoTable 5.x, registers doc.autoTable()).
 *
 * Everything is drawn as vector primitives / text. No canvas or raster images.
 * The promise never rejects: failures resolve to { ok: false, error }.
 */
(function () {
  'use strict';

  var FILENAME = 'WCAG_2.2_Compliance_Report.pdf';
  var TOOL_NAME = 'Mattccessibility Tool';
  var TOOL_VERSION = '1.4.0';

  // ---- Layout (mm, portrait A4) -------------------------------------------
  var PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
  var TOP = 22;          // content starts below the header band
  var BOTTOM = PH - 16;  // content stops above the footer

  // ---- Palette -------------------------------------------------------------
  var C = {
    page: [15, 17, 23],
    surface: [24, 27, 36],
    surfaceAlt: [30, 33, 44],
    border: [48, 52, 66],
    band: [21, 24, 33],
    code: [9, 10, 14],
    text: [255, 255, 255],
    body: [222, 226, 235],
    muted: [160, 166, 182],
    cyan: [0, 209, 255],
    critical: [255, 59, 48],
    serious: [255, 149, 0],
    moderate: [255, 204, 0],
    minor: [0, 209, 255],
    pass: [0, 230, 118]
  };
  var IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
  var PERSONAS = [
    ['voiceover', 'VoiceOver (iOS)'],
    ['talkback', 'TalkBack'],
    ['nvda', 'NVDA'],
    ['narrator', 'Narrator']
  ];
  var SPEECH_ROW_CAP = 40;
  var TAB_ROW_CAP = 40;
  var SNIPPETS_PER_RULE = 3;

  // ---- Text sanitising -----------------------------------------------------
  // The 14 standard PDF fonts only cover WinAnsi / Latin-1. Map common
  // typographic characters to ASCII and drop anything else (emoji etc.).
  var CHAR_MAP = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'", '\u00B4': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"', '\u00AB': '"', '\u00BB': '"',
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
    '\u2026': '...', '\u2022': '*', '\u25CF': '*', '\u25E6': '-', '\u2023': '>',
    '\u2192': '->', '\u2794': '->', '\u279C': '->', '\u279D': '->', '\u279E': '->', '\u27A1': '->',
    '\u27F6': '->', '\u21D2': '=>', '\u2190': '<-', '\u2B05': '<-', '\u27F5': '<-', '\u21D0': '<=',
    '\u2191': '^', '\u2193': 'v', '\u2194': '<->', '\u21C4': '<->', '\u21BA': '(rotate)', '\u21BB': '(rotate)',
    '\u00D7': 'x', '\u2715': 'x', '\u2716': 'x', '\u2717': 'x', '\u2718': 'x', '\u274C': 'x',
    '\u2713': 'OK', '\u2714': 'OK', '\u2705': 'OK', '\u26A0': '!', '\u2757': '!',
    '\u2265': '>=', '\u2264': '<=', '\u2260': '!=', '\u2248': '~', '\u00B1': '+/-',
    '\u2122': '(TM)', '\u20AC': 'EUR', '\u00A0': ' ', '\u2007': ' ', '\u2009': ' ', '\u202F': ' ',
    '\t': '  '
  };
  var CHAR_RE = new RegExp('[' + Object.keys(CHAR_MAP).join('') + ']', 'g');

  function sanitize(v) {
    if (v === null || v === undefined) return '';
    var str = typeof v === 'string' ? v : String(v);
    str = str.replace(/\r\n?/g, '\n')
      .replace(CHAR_RE, function (ch) { return CHAR_MAP[ch]; })
      .replace(/[\u200B-\u200F\u2060\uFEFF\uFE00-\uFE0F]/g, '')   // zero-width & variation selectors
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')               // astral plane (emoji)
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ')   // control chars (keep \n)
      .replace(/[^\n -~\u00A1-\u00FF]/g, '');              // anything outside Latin-1
    return str;
  }
  function clip(v, max) {
    var t = sanitize(v);
    return t.length > max ? t.slice(0, max - 3) + '...' : t;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function yesNo(b) { return b ? 'Yes' : 'No'; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function impactColor(impact) { return C[impact] || C.muted; }
  function scoreColor(score) {
    if (score >= 88) return C.pass;
    if (score >= 75) return C.moderate;
    if (score >= 60) return C.serious;
    return C.critical;
  }
  function gradeFromScore(s) {
    if (s >= 95) return ['A+', 'Low'];
    if (s >= 88) return ['A', 'Low'];
    if (s >= 75) return ['B', 'Moderate'];
    if (s >= 60) return ['C', 'High'];
    return ['F', 'Severe'];
  }
  function riskColor(risk) {
    return { Low: C.pass, Moderate: C.moderate, High: C.serious, Severe: C.critical }[risk] || C.muted;
  }
  function formatDate(ts) {
    var d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }

  // ---- Report builder ------------------------------------------------------
  function build(JsPDF, data, options) {
    var meta = obj(data.meta);
    var summary = obj(data.summary);
    var counts = obj(summary.counts);
    var violations = arr(data.violations);
    var url = sanitize(meta.url || 'Unknown URL');
    var dateStr = formatDate(meta.timestamp);

    var doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

    // Dark fill on every page, including pages AutoTable adds on overflow.
    function paintPage() {
      var prev = doc.getFillColor();
      doc.setFillColor(C.page[0], C.page[1], C.page[2]);
      doc.rect(0, 0, PW, PH, 'F');
      doc.setFillColor(prev);
    }
    var origAddPage = doc.addPage;
    doc.addPage = function () {
      var r = origAddPage.apply(doc, arguments);
      paintPage();
      return r;
    };
    paintPage();

    var y = TOP;

    // -- primitives --
    function fill(c) { doc.setFillColor(c[0], c[1], c[2]); }
    function stroke(c) { doc.setDrawColor(c[0], c[1], c[2]); }
    function ink(c) { doc.setTextColor(c[0], c[1], c[2]); }
    function font(style, size, family) { doc.setFont(family || 'helvetica', style || 'normal'); doc.setFontSize(size); }
    function newPage() { doc.addPage(); y = TOP; }
    function ensure(h) { if (y + h > BOTTOM) newPage(); }
    function lineH(size) { return size * 0.3528 * 1.35; } // pt -> mm with leading

    function text(str, x, yy, opts) { doc.text(sanitize(str), x, yy, opts || {}); }

    function paragraph(str, opts) {
      opts = opts || {};
      var size = opts.size || 10;
      font(opts.style || 'normal', size, opts.family);
      ink(opts.color || C.body);
      var x = opts.x || M;
      var lines = doc.splitTextToSize(sanitize(str), opts.width || CW);
      var lh = lineH(size);
      for (var i = 0; i < lines.length; i++) {
        ensure(lh);
        doc.text(lines[i], x, y + lh * 0.75);
        y += lh;
      }
      y += opts.after === undefined ? 2 : opts.after;
    }

    function sectionTitle(n, title, intro) {
      newPage();
      fill(C.cyan);
      doc.rect(M, y, 2.4, 10, 'F');
      font('bold', 9);
      ink(C.cyan);
      text('SECTION ' + n, M + 6, y + 3.2);
      font('bold', 16);
      ink(C.text);
      text(title, M + 6, y + 9.4);
      y += 13;
      stroke(C.border);
      doc.setLineWidth(0.3);
      doc.line(M, y, PW - M, y);
      y += 5;
      if (intro) paragraph(intro, { size: 9.5, color: C.muted, after: 3 });
    }

    var lastSub = null; // { page, startY, endY, args } so a following block can pull its heading along
    function subTitle(title, color, right) {
      ensure(24);
      lastSub = { page: doc.getCurrentPageInfo().pageNumber, startY: y, endY: y + 9, args: [title, color, right] };
      fill(color || C.cyan);
      doc.rect(M, y, 1.4, 6, 'F');
      font('bold', 12);
      ink(C.text);
      text(title, M + 4, y + 4.6);
      if (right) {
        font('normal', 9);
        ink(C.muted);
        text(right, PW - M, y + 4.6, { align: 'right' });
      }
      y += 9;
    }

    function noData(msg) {
      ensure(12);
      fill(C.surface);
      stroke(C.border);
      doc.setLineWidth(0.2);
      doc.roundedRect(M, y, CW, 9, 1.5, 1.5, 'FD');
      font('italic', 9.5);
      ink(C.muted);
      text(msg || 'No data available for this section.', M + 4, y + 5.8);
      y += 13;
    }

    function note(msg) { paragraph(msg, { size: 8.5, style: 'italic', color: C.muted, after: 4 }); }

    // Row of metric tiles: items = [{ label, value, color, sub }]
    function tiles(items, h) {
      h = h || 22;
      ensure(h + 4);
      var gap = 4, n = items.length, w = (CW - gap * (n - 1)) / n;
      for (var i = 0; i < n; i++) {
        var it = items[i], x = M + i * (w + gap), col = it.color || C.cyan;
        fill(C.surface);
        stroke(C.border);
        doc.setLineWidth(0.2);
        doc.roundedRect(x, y, w, h, 2, 2, 'FD');
        fill(col);
        doc.rect(x, y + 2, 1.2, h - 4, 'F');
        font('normal', 7.5);
        ink(C.muted);
        text(String(it.label).toUpperCase(), x + 4, y + 5.5);
        var val = sanitize(it.value);
        var vs = val.length > 14 ? 10 : (val.length > 8 ? 12 : 17);
        font('bold', vs);
        ink(col);
        var fitted = doc.splitTextToSize(val, w - 6)[0] || '';
        doc.text(fitted, x + 4, y + h * 0.62);
        if (it.sub) {
          font('normal', 7);
          ink(C.muted);
          doc.text(doc.splitTextToSize(sanitize(it.sub), w - 6)[0] || '', x + 4, y + h - 3);
        }
      }
      y += h + 5;
    }

    function codeBlock(code, label) {
      var size = 8;
      font('normal', size, 'courier');
      var lines = [];
      String(sanitize(code)).split('\n').forEach(function (ln) {
        var wrapped = doc.splitTextToSize(ln === '' ? ' ' : ln, CW - 8);
        lines = lines.concat(wrapped);
      });
      if (lines.length > 30) lines = lines.slice(0, 30).concat(['/* ... truncated ... */']);
      var lh = lineH(size);
      if (label) {
        ensure(4 + lh * 2);
        font('bold', 7);
        ink(C.cyan);
        text(label, M + 1, y + 2.5);
        y += 4;
      }
      ensure(lh + 3);
      fill(C.code);
      doc.rect(M, y, CW, 1.5, 'F');
      y += 1.5;
      for (var i = 0; i < lines.length; i++) {
        if (y + lh > BOTTOM) { newPage(); }
        fill(C.code);
        doc.rect(M, y, CW, lh, 'F');
        fill(C.cyan);
        doc.rect(M, y, 0.8, lh, 'F');
        font('normal', size, 'courier');
        ink([180, 235, 255]);
        doc.text(lines[i], M + 4, y + lh * 0.75);
        y += lh;
      }
      fill(C.code);
      doc.rect(M, y, CW, 1.5, 'F');
      y += 4;
    }

    function runAutoTable(opts) {
      if (typeof doc.autoTable === 'function') return doc.autoTable(opts);
      if (typeof window.autoTable === 'function') return window.autoTable(doc, opts);
      if (window.jspdf_autotable && typeof window.jspdf_autotable.autoTable === 'function') {
        return window.jspdf_autotable.autoTable(doc, opts);
      }
      throw new Error('jsPDF AutoTable plugin is not loaded');
    }

    // Generic dark-themed table. head: string[]; body: (string|cellObj)[][]
    function table(head, body, extra) {
      extra = extra || {};
      if (!body || !body.length) { noData(extra.emptyMessage); return; }
      // Keep short tables on one page (and keep the heading above them).
      var need = body.length <= 8 ? Math.min(90, 10 + body.length * 9) : 24;
      if (y + need > BOTTOM) {
        var s = lastSub;
        if (s && s.endY === y && s.page === doc.getCurrentPageInfo().pageNumber && s.startY > TOP + 1) {
          fill(C.page);
          doc.rect(0, s.startY - 0.5, PW, s.endY - s.startY + 0.5, 'F');
          newPage();
          subTitle.apply(null, s.args);
        } else if (y > TOP + 1) {
          newPage();
        }
      }
      var cleanBody = body.map(function (row) {
        return row.map(function (cell) {
          if (cell && typeof cell === 'object') {
            var c = {};
            for (var k in cell) c[k] = cell[k];
            c.content = sanitize(cell.content);
            return c;
          }
          return sanitize(cell);
        });
      });
      var opts = {
        startY: y,
        head: [head.map(sanitize)],
        body: cleanBody,
        theme: 'grid',
        margin: { top: TOP, bottom: PH - BOTTOM, left: M, right: M },
        tableWidth: CW,
        rowPageBreak: 'avoid',
        showHead: 'everyPage',
        styles: {
          font: 'helvetica', fontSize: 8, cellPadding: 1.8, overflow: 'linebreak',
          textColor: C.body, fillColor: C.surface, lineColor: C.border, lineWidth: 0.15, valign: 'top'
        },
        headStyles: { fillColor: C.cyan, textColor: C.page, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: C.surfaceAlt },
        columnStyles: extra.columnStyles || {},
        didParseCell: extra.didParseCell
      };
      runAutoTable(opts);
      var fy = doc.lastAutoTable && doc.lastAutoTable.finalY;
      y = (typeof fy === 'number' ? fy : y) + 6;
      if (y > BOTTOM) newPage();
    }

    // Colour the text of an "impact"/"status" column by keyword.
    function colourColumn(colIndex) {
      return function (d) {
        if (d.section !== 'body' || d.column.index !== colIndex) return;
        var raw = String(d.cell.raw && d.cell.raw.content !== undefined ? d.cell.raw.content : d.cell.raw).toLowerCase();
        var col = C[raw] || ({ pass: C.pass, yes: C.pass, ok: C.pass, verified: C.pass, aa: C.serious,
          advisory: C.moderate, no: C.critical, missing: C.critical, fail: C.critical }[raw]);
        if (col) { d.cell.styles.textColor = col; d.cell.styles.fontStyle = 'bold'; }
      };
    }

    function arc(cx, cy, r, startDeg, sweepDeg) {
      if (sweepDeg <= 0) return;
      var steps = Math.max(2, Math.ceil(sweepDeg / 3));
      var toRad = Math.PI / 180;
      var x0 = cx + r * Math.cos(startDeg * toRad), y0 = cy + r * Math.sin(startDeg * toRad);
      var segs = [], px = x0, py = y0;
      for (var i = 1; i <= steps; i++) {
        var a = (startDeg + sweepDeg * i / steps) * toRad;
        var nx = cx + r * Math.cos(a), ny = cy + r * Math.sin(a);
        segs.push([nx - px, ny - py]);
        px = nx; py = ny;
      }
      doc.lines(segs, x0, y0, [1, 1], 'S', false);
    }

    function scoreRing(cx, cy, r, score, color, label) {
      doc.setLineCap('butt');
      doc.setLineWidth(4.2);
      stroke(C.surfaceAlt);
      doc.circle(cx, cy, r, 'S');
      doc.setLineCap('round');
      stroke(color);
      arc(cx, cy, r, -90, 360 * Math.max(0, Math.min(100, score)) / 100);
      doc.setLineCap('butt');
      doc.setLineWidth(0.2);
      font('bold', 30);
      ink(C.text);
      text(String(score), cx, cy + 3, { align: 'center' });
      font('normal', 8);
      ink(C.muted);
      text(label || 'OUT OF 100', cx, cy + 9, { align: 'center' });
    }

    // =========================================================================
    // PAGE 1: Cover & scorecard
    // =========================================================================
    var score = Math.round(num(summary.score, 0));
    var gr = gradeFromScore(score);
    var grade = sanitize(summary.grade || gr[0]);
    var risk = sanitize(summary.risk || gr[1]);
    var cnt = {
      critical: num(counts.critical), serious: num(counts.serious),
      moderate: num(counts.moderate), minor: num(counts.minor)
    };
    var totalRules = num(summary.totalViolations, violations.length);
    var totalNodes = num(summary.totalNodes, violations.reduce(function (a, v) { return a + arr(v.nodes).length; }, 0));

    fill(C.cyan);
    doc.rect(M, y + 2, 2.4, 20, 'F');
    font('bold', 9);
    ink(C.cyan);
    text('EXECUTIVE COMPLIANCE DELIVERABLE', M + 6, y + 5.5);
    font('bold', 22);
    ink(C.text);
    text('WCAG 2.2 AA Compliance Report', M + 6, y + 14);
    font('normal', 10);
    ink(C.muted);
    text(clip(meta.title || 'Untitled page', 90), M + 6, y + 20.5);
    y += 28;

    font('bold', 8);
    ink(C.muted);
    text('TARGET URL', M, y);
    y += 1;
    paragraph(url, { size: 10, color: C.cyan, after: 1 });
    font('normal', 8);
    ink(C.muted);
    var vp = obj(meta.viewport);
    text('Audited ' + dateStr +
      (meta.durationMs ? '   |   Scan time ' + (num(meta.durationMs) / 1000).toFixed(1) + 's' : '') +
      (vp.width ? '   |   Viewport ' + num(vp.width) + 'x' + num(vp.height) : '') +
      (meta.axeVersion ? '   |   axe-core ' + meta.axeVersion : ''), M, y + 3);
    y += 9;

    // Scorecard panel
    var panelY = y, panelH = 62;
    fill(C.surface);
    stroke(C.border);
    doc.setLineWidth(0.2);
    doc.roundedRect(M, panelY, CW, panelH, 3, 3, 'FD');
    var sc = scoreColor(score);
    scoreRing(M + 34, panelY + panelH / 2, 21, score, sc, 'COMPLIANCE SCORE');

    var gx = M + 70;
    font('normal', 8);
    ink(C.muted);
    text('GRADE', gx, panelY + 12);
    font('bold', 34);
    ink(sc);
    text(grade, gx, panelY + 27);
    font('normal', 8);
    ink(C.muted);
    text('RISK LEVEL', gx + 40, panelY + 12);
    var rc = riskColor(risk);
    fill(rc);
    doc.roundedRect(gx + 40, panelY + 16, 34, 10, 5, 5, 'F');
    font('bold', 11);
    ink(C.page);
    text(risk.toUpperCase(), gx + 57, panelY + 22.6, { align: 'center' });

    font('normal', 8.5);
    ink(C.body);
    var stats = [
      ['Failing rules', totalRules],
      ['Affected elements', totalNodes],
      ['Passed axe rules', num(summary.passes)],
      ['Needs manual review', num(summary.incomplete)]
    ];
    for (var si = 0; si < stats.length; si++) {
      var sx = gx + (si % 2) * 52, sy = panelY + 38 + Math.floor(si / 2) * 10;
      font('normal', 7.5);
      ink(C.muted);
      text(stats[si][0].toUpperCase(), sx, sy);
      font('bold', 11);
      ink(C.text);
      text(String(stats[si][1]), sx, sy + 5);
    }
    y = panelY + panelH + 8;

    subTitle('Violation Severity Matrix', C.cyan, 'Failing rules by impact, with affected element totals');
    var nodesBy = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    violations.forEach(function (v) { if (nodesBy[v.impact] !== undefined) nodesBy[v.impact] += arr(v.nodes).length; });
    tiles(IMPACTS.map(function (k) {
      return { label: k, value: String(cnt[k]), color: impactColor(k), sub: plural(nodesBy[k], 'element') };
    }), 24);

    var sr = obj(data.screenReader), tab = obj(data.tabOrder), mob = obj(data.mobile);
    subTitle('Module Scores');
    tiles([
      { label: 'Screen reader', value: sr.score !== undefined ? num(sr.score) + '/100' : 'No data',
        color: sr.score !== undefined ? scoreColor(num(sr.score)) : C.muted, sub: sanitize(sr.headingStatus || '') },
      { label: 'Tab navigation', value: sanitize(tab.status || 'No data'),
        color: tab.status === 'Sequential' ? C.pass : (tab.status === 'Disrupted' ? C.critical : (tab.status ? C.moderate : C.muted)),
        sub: tab.total !== undefined ? plural(num(tab.total), 'focus stop') : '' },
      { label: 'Mobile health', value: mob.score !== undefined ? num(mob.score) + '/100' : 'No data',
        color: mob.score !== undefined ? scoreColor(num(mob.score)) : C.muted,
        sub: plural(arr(mob.devices).length, 'device') + ' reviewed' }
    ], 22);

    subTitle('Executive Findings Summary');
    paragraph(executiveSummary(data, score, grade, risk, cnt, totalRules, totalNodes), { size: 9.5, after: 2 });

    // =========================================================================
    // SECTION 1: WCAG violations
    // =========================================================================
    sectionTitle(1, 'WCAG 2.2 AA Compliance Violations',
      'Automated axe-core findings plus Mattccessibility custom checks (ARIA label-in-name, :hover contrast, tab order, links, mobile). Grouped by severity, with one row per affected element.');

    if (!violations.length) {
      noData('No WCAG violations were detected by the automated checks.');
    } else {
      IMPACTS.forEach(function (imp) {
        var group = violations.filter(function (v) { return v.impact === imp; });
        if (!group.length) return;
        var nodeTotal = group.reduce(function (a, v) { return a + arr(v.nodes).length; }, 0);
        subTitle(imp.charAt(0).toUpperCase() + imp.slice(1) + ' severity', impactColor(imp),
          plural(group.length, 'rule') + ', ' + plural(nodeTotal, 'element'));
        var body = [];
        group.forEach(function (v) {
          var nodes = arr(v.nodes);
          var crit = arr(v.wcag).length ? arr(v.wcag).map(function (w) { return 'WCAG ' + w; }).join('\n') :
            (arr(v.tags).indexOf('best-practice') >= 0 ? 'Best practice' : (arr(v.tags).join(', ') || '-'));
          var ruleCell = sanitize(v.id || 'unknown-rule') + (v.title ? '\n' + clip(v.title, 140) : '');
          if (!nodes.length) {
            body.push([ruleCell, crit, imp, clip(v.description || '-', 600), '-']);
            return;
          }
          nodes.forEach(function (n, ni) {
            n = obj(n);
            // Rule title only on the first row of each rule keeps long reports compact.
            if (ni === 1) ruleCell = sanitize(v.id || 'unknown-rule');
            var fs = clip(n.failureSummary || v.description || '-', 600);
            var ct = obj(n.contrast);
            if (ct.ratio !== undefined) {
              fs += '\nContrast (' + sanitize(ct.state || 'rest') + '): ' + num(ct.ratio) + ':1, needs ' + num(ct.required) +
                ':1. Suggested text ' + sanitize(ct.suggestedFg || '') + ' (' + num(ct.suggestedRatio) + ':1).';
            }
            var sel = clip(n.selector || '-', 300) + (n.html ? '\n\n' + clip(n.html, 160) : '');
            body.push([ruleCell, crit, imp, fs, sel]);
          });
        });
        table(['Rule ID', 'Criterion', 'Impact', 'Failure Summary', 'Affected Selector'], body, {
          columnStyles: {
            0: { cellWidth: 34, fontStyle: 'bold' }, 1: { cellWidth: 20 }, 2: { cellWidth: 17 },
            3: { cellWidth: 56 }, 4: { cellWidth: 55, font: 'courier', fontSize: 7 }
          },
          didParseCell: colourColumn(2)
        });
      });

      // Remediation snippets
      var withFixes = violations.filter(function (v) {
        return arr(v.nodes).some(function (n) { return n && n.fix && (n.fix.css || n.fix.html || n.fix.note); });
      });
      subTitle('Recommended Remediation Code Snippets');
      if (!withFixes.length) {
        noData('No automated remediation snippets were generated.');
      } else {
        withFixes.forEach(function (v) {
          var seen = {}, snippets = [], notes = [];
          arr(v.nodes).forEach(function (n) {
            var f = n && n.fix;
            if (!f) return;
            if (f.css && !seen['c' + f.css]) { seen['c' + f.css] = 1; snippets.push(['CSS', f.css]); }
            if (f.html && !seen['h' + f.html]) { seen['h' + f.html] = 1; snippets.push(['HTML', f.html]); }
            if (f.note && !seen['n' + f.note]) { seen['n' + f.note] = 1; notes.push(f.note); }
          });
          ensure(22);
          fill(impactColor(v.impact));
          doc.circle(M + 1.5, y + 2.2, 1.3, 'F');
          font('bold', 9.5);
          ink(C.text);
          var head = doc.splitTextToSize(sanitize((v.id || 'rule') + ' - ' + (v.title || '')), CW - 6);
          doc.text(head[0], M + 5, y + 3.3);
          y += 6;
          notes.slice(0, 2).forEach(function (t) { paragraph('Note: ' + t, { size: 8.5, color: C.muted, after: 1 }); });
          snippets.slice(0, SNIPPETS_PER_RULE).forEach(function (s) { codeBlock(s[1], s[0]); });
          if (snippets.length > SNIPPETS_PER_RULE) {
            note('+ ' + (snippets.length - SNIPPETS_PER_RULE) + ' more similar snippet(s) for this rule omitted.');
          }
          y += 1;
        });
      }
    }

    // =========================================================================
    // SECTION 2: Screen reader
    // =========================================================================
    sectionTitle(2, 'Screen Reader & VoiceOver Compatibility',
      'Simulated reading flow for Apple VoiceOver, Android TalkBack, NVDA and Windows Narrator, weighted across headings, landmarks, labelling, focus and images.');
    if (!Object.keys(sr).length) {
      noData('No screen reader data in this audit.');
    } else {
      var srScore = Math.round(num(sr.score));
      tiles([
        { label: 'Screen reader score', value: srScore + '/100', color: scoreColor(srScore) },
        { label: 'Heading hierarchy', value: sr.headingStatus || 'No data',
          color: sr.headingStatus === 'Sequential' ? C.pass : C.serious },
        { label: 'Landmarks', value: sr.landmarkStatus || 'No data',
          color: sr.landmarkStatus === 'Verified' ? C.pass : C.serious },
        { label: 'Barriers', value: String(num(sr.barrierCount)), color: num(sr.barrierCount) ? C.critical : C.pass,
          sub: plural(arr(sr.silentControls).length, 'silent control') }
      ], 22);

      subTitle('Category Breakdown');
      var cats = obj(sr.categories);
      var catNames = { headings: 'Heading hierarchy', landmarks: 'Landmark coverage', labeling: 'Interactive control labelling',
        focus: 'Focus & tab flow', images: 'Image text alternatives' };
      table(['Category', 'Weight', 'Score', 'Detail'], Object.keys(catNames).filter(function (k) { return cats[k]; }).map(function (k) {
        var c = obj(cats[k]);
        return [catNames[k], num(c.weight) + '%', { content: num(c.score) + '/100', styles: { textColor: scoreColor(num(c.score)), fontStyle: 'bold' } }, c.detail || '-'];
      }), { columnStyles: { 0: { cellWidth: 50, fontStyle: 'bold' }, 1: { cellWidth: 18 }, 2: { cellWidth: 20 } } });

      subTitle('Heading Hierarchy', C.cyan, sanitize(sr.headingStatus || ''));
      table(['Level', 'Heading Text', 'Selector', 'Issue'], arr(sr.headings).map(function (h) {
        h = obj(h);
        return ['H' + num(h.level), clip(h.text || '(empty)', 200), clip(h.selector, 200),
          h.issue ? { content: h.issue, styles: { textColor: C.serious, fontStyle: 'bold' } } : { content: 'OK', styles: { textColor: C.pass } }];
      }), { emptyMessage: 'No headings found on the page.',
        columnStyles: { 0: { cellWidth: 14, fontStyle: 'bold' }, 2: { font: 'courier', fontSize: 7 } } });

      subTitle('Landmark Completeness', C.cyan, sanitize(sr.landmarkStatus || ''));
      var lm = obj(sr.landmarks);
      table(['Landmark', 'Purpose', 'Present'], [
        ['banner', 'Site header', yesNo(lm.banner)],
        ['main', 'Primary content', yesNo(lm.main)],
        ['navigation', 'Navigation menu', yesNo(lm.navigation)],
        ['contentinfo', 'Site footer', yesNo(lm.contentinfo)]
      ], { columnStyles: { 0: { cellWidth: 40, fontStyle: 'bold' }, 2: { cellWidth: 25 } }, didParseCell: colourColumn(2) });
      if (arr(lm.list).length) {
        table(['Role', 'Label', 'Selector'], arr(lm.list).slice(0, 60).map(function (l) {
          l = obj(l);
          return [l.role || '-', l.label || '(none)', clip(l.selector, 200)];
        }), { columnStyles: { 0: { cellWidth: 35 }, 2: { font: 'courier', fontSize: 7 } } });
      }

      if (arr(sr.silentControls).length) {
        subTitle('Silent Controls (no accessible name)', C.critical);
        table(['Role', 'Selector', 'HTML'], arr(sr.silentControls).slice(0, 60).map(function (s) {
          s = obj(s);
          return [s.role || '-', clip(s.selector, 200), clip(s.html, 220)];
        }), { columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 70, font: 'courier', fontSize: 7 }, 2: { font: 'courier', fontSize: 7 } } });
      }

      var seq = arr(sr.sequence);
      subTitle('Sequential Speech Readout Sample', C.cyan,
        seq.length ? 'Showing ' + Math.min(seq.length, SPEECH_ROW_CAP) + ' of ' + seq.length + ' items' : '');
      table(['#', 'Element'].concat(PERSONAS.map(function (p) { return p[1]; })), seq.slice(0, SPEECH_ROW_CAP).map(function (s) {
        s = obj(s);
        var a = obj(s.announcements);
        var el = (s.role || s.category || '-') + (s.isBarrier ? '\nBARRIER: ' + (s.barrierReason || 'Accessibility barrier') : '');
        return [String(num(s.index)), s.isBarrier ? { content: el, styles: { textColor: C.critical, fontStyle: 'bold' } } : el]
          .concat(PERSONAS.map(function (p) { return clip(a[p[0]] || '-', 220); }));
      }), { emptyMessage: 'No reading sequence was captured.',
        columnStyles: { 0: { cellWidth: 9 }, 1: { cellWidth: 29 } } });
      if (seq.length > SPEECH_ROW_CAP) {
        note('Truncated: ' + (seq.length - SPEECH_ROW_CAP) + ' further reading-order items are not shown. Use the in-extension simulator for the full sequence.');
      }
    }

    // =========================================================================
    // SECTION 3: Tab navigation
    // =========================================================================
    sectionTitle(3, 'Keyboard Tab Navigation & Tab-Trail Analysis',
      'Focus order of all keyboard-focusable elements, positive tabindex anti-patterns, skip-link validation and visual flow anomalies (WCAG 2.4.1, 2.4.3, 2.4.7).');
    if (!Object.keys(tab).length) {
      noData('No tab navigation data in this audit.');
    } else {
      var sk = obj(tab.skipLink);
      var posTi = num(tab.positiveTabindexCount);
      tiles([
        { label: 'Focus flow status', value: tab.status || 'No data',
          color: tab.status === 'Sequential' ? C.pass : (tab.status === 'Disrupted' ? C.critical : C.moderate) },
        { label: 'Focus stops', value: String(num(tab.total, arr(tab.sequence).length)), color: C.cyan },
        { label: 'tabindex > 0', value: String(posTi), color: posTi ? C.critical : C.pass },
        { label: 'Anomalies', value: String(arr(tab.anomalies).length), color: arr(tab.anomalies).length ? C.serious : C.pass }
      ], 22);

      subTitle('Skip-to-Content Validation');
      table(['Check', 'Result', 'Detail'], [
        ['Skip link present', yesNo(sk.present), sk.selector ? clip(sk.selector, 200) : 'No skip link detected'],
        ['Target exists (functional)', yesNo(sk.functional), sk.present ? (sk.functional ? 'Moves focus to main content' : 'Link target missing or not focusable') : '-'],
        ['Visible on focus', yesNo(sk.visibleOnFocus), sk.present ? (sk.visibleOnFocus ? 'Becomes visible when focused (2.4.7)' : 'Remains hidden when focused') : '-']
      ], { columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' }, 1: { cellWidth: 22 } }, didParseCell: colourColumn(1) });

      subTitle('Visual Flow Anomaly Log', C.serious);
      table(['From', 'To', 'Type', 'Message'], arr(tab.anomalies).map(function (a) {
        a = obj(a);
        return [num(a.fromIndex) < 0 ? '-' : '#' + num(a.fromIndex), '#' + num(a.toIndex),
          { content: a.type || '-', styles: { textColor: a.type === 'upward-leap' ? C.moderate : C.critical, fontStyle: 'bold' } },
          a.message || '-'];
      }), { emptyMessage: 'No focus-order anomalies detected.',
        columnStyles: { 0: { cellWidth: 14 }, 1: { cellWidth: 14 }, 2: { cellWidth: 32 } } });

      var ts = arr(tab.sequence);
      subTitle('Focus Order Sample', C.cyan, ts.length ? 'Showing ' + Math.min(ts.length, TAB_ROW_CAP) + ' of ' + ts.length + ' stops' : '');
      table(['#', 'Role', 'Accessible Name', 'tabindex', 'Selector', 'Warning'], ts.slice(0, TAB_ROW_CAP).map(function (t) {
        t = obj(t);
        return ['#' + num(t.index), t.role || '-', clip(t.name || '(no name)', 120),
          t.tabindex === null || t.tabindex === undefined ? '-' : String(t.tabindex), clip(t.selector, 200),
          t.warning ? { content: t.warning, styles: { textColor: C.serious, fontStyle: 'bold' } } : ''];
      }), { emptyMessage: 'No focusable elements found.',
        columnStyles: { 0: { cellWidth: 11 }, 1: { cellWidth: 18 }, 2: { cellWidth: 40 }, 3: { cellWidth: 16 },
          4: { font: 'courier', fontSize: 7 }, 5: { cellWidth: 30 } } });
      if (ts.length > TAB_ROW_CAP) note('Truncated: ' + (ts.length - TAB_ROW_CAP) + ' further focus stops are not shown.');
    }

    // =========================================================================
    // SECTION 4: Mobile
    // =========================================================================
    sectionTitle(4, 'Mobile & Responsive Layout Assessment',
      'Viewport configuration, cross-device layout review, element collisions, horizontal overflow and touch target sizing (WCAG 1.4.4, 1.4.10, 2.5.8).');
    if (!Object.keys(mob).length) {
      noData('No mobile layout data in this audit.');
    } else {
      var vm = obj(mob.viewportMeta);
      var tt = obj(mob.touchTargets);
      var mScore = Math.round(num(mob.score));
      tiles([
        { label: 'Mobile health score', value: mScore + '/100', color: scoreColor(mScore) },
        { label: 'Overlaps', value: String(arr(mob.overlaps).length), color: arr(mob.overlaps).length ? C.serious : C.pass },
        { label: 'Overflows', value: String(arr(mob.overflows).length), color: arr(mob.overflows).length ? C.serious : C.pass },
        { label: 'Touch target fails', value: String(arr(tt.failures).length), color: arr(tt.failures).length ? C.moderate : C.pass }
      ], 22);

      subTitle('Viewport Configuration');
      var mv = obj(mob.measuredViewport);
      table(['Check', 'Result'], [
        ['Viewport meta present', yesNo(vm.present)],
        ['Content', vm.content || '(none)'],
        ['width=device-width', yesNo(vm.widthDeviceWidth)],
        ['Pinch zoom allowed (no user-scalable=no)', vm.userScalableNo ? 'No' : 'Yes'],
        ['Zoom not capped by maximum-scale', vm.maxScaleRestricted ? 'No' : 'Yes'],
        ['Measured viewport', mv.width ? num(mv.width) + ' x ' + num(mv.height) + ' px' : '-'],
        ['Issues', arr(vm.issues).length ? arr(vm.issues).join('; ') : 'None']
      ], { columnStyles: { 0: { cellWidth: 70, fontStyle: 'bold' } }, didParseCell: colourColumn(1) });

      var mabd = obj(options.mobileAnalysisByDevice);
      subTitle('Cross-Device Layout Review');
      table(['Device', 'Viewport', 'Score', 'Overflow', 'Fixed-width / Overflowing Elements', 'Source'], arr(mob.devices).map(function (d) {
        d = obj(d);
        var m = mabd[d.id] && typeof mabd[d.id] === 'object' ? mabd[d.id] : null;
        var s, oc, els, src;
        if (m) {
          s = Math.round(num(m.score));
          oc = arr(m.overflows).length;
          els = arr(m.overflows).map(function (o) { return o && o.selector; }).filter(Boolean);
          src = 'Simulator-measured';
        } else {
          s = Math.round(num(d.score));
          oc = num(d.estimatedOverflowCount);
          els = arr(d.fixedWidthElements);
          src = 'Estimated (desktop DOM)';
        }
        var shown = els.slice(0, 5).map(function (e) { return clip(e, 120); }).join('\n') + (els.length > 5 ? '\n+' + (els.length - 5) + ' more' : '');
        return [d.name || d.id || '-', num(d.width) + ' x ' + num(d.height),
          { content: s + '/100', styles: { textColor: scoreColor(s), fontStyle: 'bold' } },
          String(oc), shown || 'None',
          { content: src, styles: { textColor: m ? C.pass : C.muted } }];
      }), { emptyMessage: 'No device estimates in this audit.',
        columnStyles: { 0: { cellWidth: 34, fontStyle: 'bold' }, 1: { cellWidth: 19 }, 2: { cellWidth: 15 }, 3: { cellWidth: 15 },
          4: { font: 'courier', fontSize: 7 }, 5: { cellWidth: 31 } } });

      subTitle('Overlap Collisions', C.serious);
      table(['Element A', 'Element B', 'Overlap Area'], arr(mob.overlaps).map(function (o) {
        o = obj(o);
        return [clip(o.selectorA, 200), clip(o.selectorB, 200), Math.round(num(o.area)) + ' px2'];
      }), { emptyMessage: 'No overlapping elements detected.',
        columnStyles: { 0: { font: 'courier', fontSize: 7 }, 1: { font: 'courier', fontSize: 7 }, 2: { cellWidth: 26 } } });

      subTitle('Horizontal Overflows', C.serious);
      table(['Element', 'Right Edge', 'scrollWidth', 'clientWidth'], arr(mob.overflows).map(function (o) {
        o = obj(o);
        return [clip(o.selector, 220), Math.round(num(o.right)) + ' px', Math.round(num(o.scrollWidth)) + ' px', Math.round(num(o.clientWidth)) + ' px'];
      }), { emptyMessage: 'No horizontal overflow detected.',
        columnStyles: { 0: { font: 'courier', fontSize: 7 }, 1: { cellWidth: 24 }, 2: { cellWidth: 24 }, 3: { cellWidth: 24 } } });

      subTitle('Touch Target Deficiencies', C.moderate, 'AA = below 24x24px (2.5.8); advisory = below 44x44px');
      table(['Element', 'Size', 'Level'], arr(tt.failures).map(function (f) {
        f = obj(f);
        return [clip(f.selector, 220), Math.round(num(f.width)) + ' x ' + Math.round(num(f.height)) + ' px', f.level || '-'];
      }), { emptyMessage: 'No touch target size failures detected.',
        columnStyles: { 0: { font: 'courier', fontSize: 7 }, 1: { cellWidth: 30 }, 2: { cellWidth: 24 } }, didParseCell: colourColumn(2) });

      if (arr(tt.crowding).length) {
        subTitle('Touch Target Crowding (< 8px apart)', C.moderate);
        table(['Element A', 'Element B', 'Distance'], arr(tt.crowding).map(function (c) {
          c = obj(c);
          return [clip(c.selectorA, 200), clip(c.selectorB, 200), num(c.distance) + ' px'];
        }), { columnStyles: { 0: { font: 'courier', fontSize: 7 }, 1: { font: 'courier', fontSize: 7 }, 2: { cellWidth: 22 } } });
      }
      if (arr(mob.stickyOcclusions).length) {
        subTitle('Sticky / Fixed Element Occlusion (> 30% of screen)', C.moderate);
        table(['Element', 'Screen Height Used'], arr(mob.stickyOcclusions).map(function (s) {
          s = obj(s);
          return [clip(s.selector, 220), Math.round(num(s.heightPct)) + '%'];
        }), { columnStyles: { 0: { font: 'courier', fontSize: 7 }, 1: { cellWidth: 40 } } });
      }
    }

    // =========================================================================
    // Final pass: header / footer on every page
    // =========================================================================
    var total = doc.getNumberOfPages();
    var headerUrl = clip(url, 70);
    for (var p = 1; p <= total; p++) {
      doc.setPage(p);
      fill(C.band);
      doc.rect(0, 0, PW, 13, 'F');
      fill(C.cyan);
      doc.rect(0, 13, PW, 0.6, 'F');
      font('bold', 9);
      ink(C.cyan);
      doc.text(TOOL_NAME, M, 8.4);
      font('normal', 7.5);
      ink(C.muted);
      doc.text(headerUrl, M + 38, 8.4);
      doc.text(dateStr, PW - M, 8.4, { align: 'right' });

      stroke(C.border);
      doc.setLineWidth(0.2);
      doc.line(M, PH - 11, PW - M, PH - 11);
      font('normal', 7.5);
      ink(C.muted);
      doc.text(TOOL_NAME + ' v' + TOOL_VERSION + '  |  WCAG 2.2 AA Compliance Report', M, PH - 6);
      font('bold', 7.5);
      ink(C.body);
      doc.text('Page ' + p + ' of ' + total, PW - M, PH - 6, { align: 'right' });
    }

    doc.setProperties({
      title: 'WCAG 2.2 AA Compliance Report - ' + clip(meta.title || url, 100),
      subject: 'Accessibility audit of ' + url,
      author: TOOL_NAME,
      creator: TOOL_NAME + ' v' + TOOL_VERSION,
      keywords: 'WCAG 2.2, accessibility, audit, compliance'
    });

    return doc;
  }

  function executiveSummary(data, score, grade, risk, cnt, totalRules, totalNodes) {
    var parts = [];
    var meta = obj(data.meta);
    var host = sanitize(meta.url || 'the audited page');
    parts.push('The automated WCAG 2.2 AA audit of ' + host + ' produced a compliance score of ' + score +
      '/100 (grade ' + grade + ', ' + risk + ' risk).');
    if (!totalRules) {
      parts.push('No automated violations were found. Manual testing with assistive technology is still recommended, because automated checks cover only part of WCAG.');
    } else {
      parts.push(plural(totalRules, 'failing rule') + ' affect ' + plural(totalNodes, 'element') + ': ' +
        cnt.critical + ' critical, ' + cnt.serious + ' serious, ' + cnt.moderate + ' moderate and ' + cnt.minor + ' minor.');
      var top = arr(data.violations).filter(function (v) { return v && (v.impact === 'critical' || v.impact === 'serious'); })
        .slice(0, 3).map(function (v) { return sanitize(v.title || v.id); });
      if (top.length) parts.push('Priority issues: ' + top.join('; ') + '.');
      if (cnt.critical) parts.push('Critical issues block some users completely and should be fixed before release.');
    }
    var sr = obj(data.screenReader);
    if (sr.score !== undefined) {
      parts.push('Screen reader compatibility scored ' + Math.round(num(sr.score)) + '/100' +
        (sr.headingStatus ? ' (headings: ' + sanitize(sr.headingStatus) : '') +
        (sr.landmarkStatus ? (sr.headingStatus ? ', ' : ' (') + 'landmarks: ' + sanitize(sr.landmarkStatus) : '') +
        (sr.headingStatus || sr.landmarkStatus ? ')' : '') +
        (num(sr.barrierCount) ? ', with ' + plural(num(sr.barrierCount), 'reading barrier') : '') + '.');
    }
    var tab = obj(data.tabOrder);
    if (tab.status) {
      var sk = obj(tab.skipLink);
      parts.push('Keyboard focus flow is ' + sanitize(tab.status).toLowerCase() + ' across ' + plural(num(tab.total), 'stop') +
        (num(tab.positiveTabindexCount) ? ', with ' + num(tab.positiveTabindexCount) + ' positive tabindex value(s)' : '') +
        (sk.present ? (sk.functional ? '; a working skip link is present' : '; the skip link is not functional') : '; no skip link was found') + '.');
    }
    var mob = obj(data.mobile);
    if (mob.score !== undefined) {
      var tt = obj(mob.touchTargets);
      parts.push('Mobile health scored ' + Math.round(num(mob.score)) + '/100, with ' + plural(arr(mob.overlaps).length, 'overlap') + ', ' +
        plural(arr(mob.overflows).length, 'horizontal overflow') + ' and ' + plural(arr(tt.failures).length, 'touch target issue') + '.');
    }
    return parts.join(' ');
  }

  window.generateWcagPdfReport = function generateWcagPdfReport(auditData, options) {
    return new Promise(function (resolve) {
      try {
        var JsPDF = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : window.jsPDF;
        if (typeof JsPDF !== 'function') throw new Error('jsPDF library is not loaded');
        var doc = build(JsPDF, obj(auditData), obj(options));
        var pages = doc.getNumberOfPages();
        doc.save(FILENAME);
        resolve({ ok: true, filename: FILENAME, pages: pages });
      } catch (err) {
        try { console.error('[Mattccessibility] PDF generation failed', err); } catch (e) { /* ignore */ }
        resolve({ ok: false, filename: FILENAME, pages: 0, error: String((err && err.message) || err) });
      }
    });
  };
})();
