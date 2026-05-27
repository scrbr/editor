'use strict';

// report.js — depends on globals defined in scrbr.js:
//   snapshots, unsignedSnapshots, progressSnapshots, noteSpaceState,
//   sessionVerifier, workerKeyVersion, COLORS, WORKER_URL, K,
//   SNAP_MIN_MS, SNAP_MAX_MS, SNAP_TOLERANCE,
//   computeSessions, sessionIdsFor, fmtDur, fmtElapsed, countWords,
//   getVerifier, storageGet, escHtml, renderMd, fetchWithTimeout,
//   cumulativeWritingMs, triggerBundleSigning, showToast, safeFilename,
//   gatedExport

/* ── Static styles (used in downloaded export) ───────────────────────────── */

const BASE_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,600;1,8..60,300;1,8..60,400&display=swap');
  body { max-width: 720px; margin: 60px auto; padding: 0 24px 120px; font-family: 'Source Serif 4', Georgia, serif; font-size: 17px; line-height: 1.85; color: #1C1A16; background: #FEFCF8; }
  h1 { font-size: 2em; font-weight: 400; margin: 0 0 .25em; }
  h2 { font-size: 1.5em; font-weight: 400; margin: 1.6em 0 .5em; }
  h3 { font-size: 1.2em; font-weight: 400; margin: 1.3em 0 .4em; }
  p { margin: 0 0 1em; }
  blockquote { border-left: 3px solid #D4CEC2; padding-left: 1em; color: #72695E; margin: 1em 0; font-style: italic; }
  code { font-family: 'Source Serif 4', Georgia, serif; font-size: .88em; background: #ECEAE3; padding: 1px 5px; border-radius: 3px; }
  pre { background: #ECEAE3; border: 1px solid #D4CEC2; border-radius: 4px; padding: 14px; overflow-x: auto; margin: 0 0 1em; }
  pre code { background: none; padding: 0; }
  ul, ol { margin: 0 0 1em 1.6em; } li { margin: .25em 0; }
  hr { border: none; border-top: 1px solid #D4CEC2; margin: 2em 0; }
  table { width: 100%; border-collapse: collapse; margin: 0 0 1em; }
  th, td { border: 1px solid #D4CEC2; padding: 7px 12px; text-align: left; }
  th { background: #ECEAE3; font-weight: 600; }
  .footnote-ref { color: #2C4B70; text-decoration: none; }
  .fn-rule { margin-top: 3em; }
  .footnote { font-size: .875em; color: #72695E; padding: 3px 0; }
  .footnote-back { color: #2C4B70; text-decoration: none; }
  strong { font-weight: 600; } em { font-style: italic; }
`;

const REPORT_STYLES = `
  .doc-byline { color: #72695E; font-style: italic; margin: 0 0 2.5em; }
  .report-divider { border: none; border-top: 3px solid #D4CEC2; margin: 80px 0 60px; page-break-before: always; }
  .rs { font-family: 'Source Sans 3', system-ui, sans-serif; }
  .rs h1 { font-family: 'Source Sans 3', system-ui, sans-serif; font-size: 1.5em; font-weight: 600; margin: 0 0 4px; }
  .rs h2 { font-family: 'Source Sans 3', system-ui, sans-serif; font-size: .8em; font-weight: 600; margin: 2.2em 0 .8em; color: #2C4B70; border-bottom: 1px solid #D4CEC2; padding-bottom: 6px; letter-spacing: .04em; text-transform: uppercase; }
  .rs h3 { font-family: 'Source Sans 3', system-ui, sans-serif; font-size: .75em; font-weight: 600; margin: 1.6em 0 .5em; color: #4A6A90; letter-spacing: .04em; text-transform: uppercase; }
  .rs .sub { color: #72695E; font-style: italic; margin: 0 0 2em; font-size: .9em; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 0 0 2em; }
  .stat { background: #ECEAE3; border: 1px solid #D4CEC2; border-radius: 5px; padding: 12px 16px; }
  .stat-l { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #72695E; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .stat-v { font-size: 1.5em; font-weight: 600; color: #1C1A16; margin-top: 3px; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .rtable { width: 100%; border-collapse: collapse; font-size: 13px; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .rtable th { text-align: left; padding: 8px 12px; background: #ECEAE3; border: 1px solid #D4CEC2; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #72695E; font-weight: 600; }
  .rtable td { padding: 8px 12px; border: 1px solid #D4CEC2; }
  .rtable tr:nth-child(even) td { background: #F5F1EA; }
  .utl { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .utl-session-gap { padding: 8px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #72695E; border-top: 1px dashed #D4CEC2; margin-top: 6px; }
  .utl-row { display: grid; grid-template-columns: 7em 1fr 1fr auto; gap: 4px 12px; align-items: start; padding: 7px 10px; border-left: 3px solid; border-radius: 0 3px 3px 0; background: #FAFAFA; }
  .utl-row.signed-row { background: #F3F6FB; }
  .utl-snap { color: #72695E; font-size: 11px; }
  .utl-words { font-weight: 600; }
  .utl-wt { color: #4A4640; }
  .utl-event { font-size: 11px; color: #2C4B70; font-weight: 600; text-align: right; }
  .utl-unsigned { font-size: 11px; color: #9A7A40; text-align: right; }
  .legend { margin: 0 0 .5em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .leg-item { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 3px 0; }
  .leg-sw { width: 28px; height: 16px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
  .leg-unsn { width: 28px; height: 16px; border-radius: 3px; display: inline-block; flex-shrink: 0; border: 1px dashed #aaa; }
  .cdoc-note { font-size: 12.5px; font-style: italic; color: #72695E; margin: .5em 0 1.2em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .cdoc { font-family: 'Source Serif 4', Georgia, serif; font-size: 14.5px; line-height: 1.85; background: #fff; border: 1px solid #D4CEC2; border-radius: 5px; padding: 28px; white-space: pre-wrap; word-break: break-word; }
  .cseg { border-radius: 2px; padding: 0 1px; }
  .psnap-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 14.5px; line-height: 1.85; background: #fff; border: 1px solid #D4CEC2; border-radius: 5px; padding: 28px; white-space: pre-wrap; word-break: break-word; margin: 0 0 1.5em; }
  .psnap-meta { font-size: 12px; color: #72695E; font-style: italic; margin: .25em 0 1em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .psnap-note { font-size: 12.5px; font-style: italic; color: #72695E; margin: .5em 0 1em; font-family: 'Source Sans 3', system-ui, sans-serif; line-height: 1.6; }
  .nsnap-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 13.5px; line-height: 1.8; background: #FFFEF5; border: 1px solid #C8A84B; border-radius: 5px; padding: 20px 24px; white-space: pre-wrap; word-break: break-word; margin: 0 0 1em; }
  .nsnap-meta { font-size: 12px; color: #72695E; font-style: italic; margin: .25em 0 .6em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .block-event-notice { background: #7A1A1A; color: #FFF5F5; padding: 14px 20px; border-radius: 5px; font-size: 13px; margin: 0 0 2em; font-family: 'Source Sans 3', system-ui, sans-serif; line-height: 1.6; }
  .unverified-note { font-size: 13px; color: #72695E; font-style: italic; margin: .5em 0 1.5em; font-family: 'Source Sans 3', system-ui, sans-serif; line-height: 1.6; }
  .unverified-snap { margin: 0 0 1.5em; }
  .unverified-meta { font-size: 12px; color: #7A5510; font-style: italic; margin: .25em 0 .6em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .unverified-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 13.5px; line-height: 1.8; background: #FFFDF5; border: 1px solid #C8A84B; border-left: 4px solid #B8922A; border-radius: 0 5px 5px 0; padding: 20px 24px; white-space: pre-wrap; word-break: break-word; }
  .signing-events-note { font-size: 12.5px; font-style: italic; color: #72695E; margin: .5em 0 1em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .local-verify-note { font-size: 12px; color: #9A7A40; background: #FFFDF0; border: 1px solid #D4B870; border-radius: 4px; padding: 8px 12px; margin: .5em 0 1em; font-family: 'Source Sans 3', system-ui, sans-serif; }
`;

/* ── Inline preview page styles (injected once into the live document) ────── */

const PREVIEW_INJECT_STYLES = `
  /* Preview pane layout */
  #preview-pane {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: 100%;
  }
  #preview-toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 20px;
    background: #F5F1EA;
    border-bottom: 1px solid #D4CEC2;
  }
  #preview-toolbar .preview-title {
    font-family: 'Source Sans 3', system-ui, sans-serif;
    font-size: 12px;
    color: #72695E;
    flex: 1;
    text-transform: uppercase;
    letter-spacing: .06em;
  }
  #preview-content-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 40px 48px 80px;
  }

  /* Document section — matches editing window appearance */
  .preview-doc-section {
    max-width: 680px;
    margin: 0 auto 60px;
  }
  .preview-doc-title {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 2em;
    font-weight: 400;
    color: #1C1A16;
    margin: 0 0 .2em;
    line-height: 1.25;
  }
  .preview-doc-byline {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 1em;
    color: #72695E;
    font-style: italic;
    margin: 0 0 2em;
  }
  /* Editor-matching document body: same font, size, line-height as the editor */
  .preview-doc-body {
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 17px;
    line-height: 1.85;
    color: #1C1A16;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Headings rendered in the doc body */
  .preview-doc-body h1 { font-size: 1.9em; font-weight: 400; margin: 1.2em 0 .3em; }
  .preview-doc-body h2 { font-size: 1.4em; font-weight: 400; margin: 1.5em 0 .4em; }
  .preview-doc-body h3 { font-size: 1.15em; font-weight: 400; margin: 1.2em 0 .3em; }
  .preview-doc-body p  { margin: 0 0 1em; white-space: pre-wrap; }
  .preview-doc-body blockquote { border-left: 3px solid #D4CEC2; padding-left: 1em; color: #72695E; margin: 1em 0; font-style: italic; }
  .preview-doc-body ul, .preview-doc-body ol { margin: 0 0 1em 1.6em; }
  .preview-doc-body li { margin: .25em 0; }
  .preview-doc-body hr { border: none; border-top: 1px solid #D4CEC2; margin: 2em 0; }
  .preview-doc-body .footnote-ref { color: #2C4B70; text-decoration: none; }
  .preview-doc-body .fn-rule { margin-top: 3em; border-top: 1px solid #D4CEC2; }
  .preview-doc-body .footnote { font-size: .875em; color: #72695E; padding: 3px 0; }
  .preview-doc-body .footnote-back { color: #2C4B70; text-decoration: none; }

  /* Report section inside preview */
  .preview-report-section {
    max-width: 680px;
    margin: 0 auto;
    border-top: 3px solid #D4CEC2;
    padding-top: 48px;
  }
  .preview-report-section .rs h1 { font-size: 1.3em; }

  /* Loading state */
  .preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    font-family: 'Source Sans 3', system-ui, sans-serif;
    font-size: 13px;
    color: #72695E;
    font-style: italic;
  }
`;

/* ── Color-segment diffing ───────────────────────────────────────────────── */

function wordNormalizeProv(text, prov) {
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    let j = i;
    while (j < text.length && !/\s/.test(text[j])) j++;
    const votes = new Map();
    for (let k = i; k < j; k++) if (prov[k] !== -1) votes.set(prov[k], (votes.get(prov[k]) || 0) + 1);
    if (votes.size > 0) {
      let best = -1, bestN = 0;
      for (const [c, n] of votes) if (n > bestN) { best = c; bestN = n; }
      for (let k = i; k < j; k++) if (prov[k] !== -1) prov[k] = best;
    }
    i = j;
  }
}

function buildColorSegments(snaps) {
  if (!snaps.length) return [];
  if (snaps.length === 1) return [{ text: snaps[0].content, ci: snaps[0].colorIndex % COLORS.length }];
  const dmp = new diff_match_patch(); dmp.Diff_Timeout = 3.0;
  let text = snaps[0].content;
  const initCi = snaps[0].colorIndex % COLORS.length;
  let prov = Array.from({ length: text.length }, () => initCi);
  for (let si = 1; si < snaps.length; si++) {
    const ci = snaps[si].colorIndex % COLORS.length;
    const diffs = dmp.diff_main(text, snaps[si].content);
    dmp.diff_cleanupSemantic(diffs);
    let newText = '', newProv = [], pos = 0;
    for (const [op, chunk] of diffs) {
      if (op === 0)       { newText += chunk; for (let j = 0; j < chunk.length; j++) newProv.push(prov[pos + j]); pos += chunk.length; }
      else if (op === -1) { pos += chunk.length; }
      else                { newText += chunk; for (let j = 0; j < chunk.length; j++) newProv.push(ci); }
    }
    text = newText; prov = newProv;
  }
  wordNormalizeProv(text, prov);
  if (!text.length) return [];
  const segs = []; let start = 0, cur = prov[0];
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || prov[i] !== cur) { segs.push({ text: text.slice(start, i), ci: cur }); start = i; if (i < text.length) cur = prov[i]; }
  }
  return segs;
}

function buildColorSegmentsWithCurrent(snaps, currentContent) {
  if (!currentContent) return [];
  if (!snaps.length) return [{ text: currentContent, ci: -1 }];
  const baseSegs = buildColorSegments(snaps);
  const baseText = baseSegs.map(s => s.text).join('');
  if (currentContent === baseText) return baseSegs;
  const prov = [];
  for (const seg of baseSegs) for (let k = 0; k < seg.text.length; k++) prov.push(seg.ci);
  const dmp = new diff_match_patch(); dmp.Diff_Timeout = 3.0;
  const diffs = dmp.diff_main(baseText, currentContent);
  dmp.diff_cleanupSemantic(diffs);
  let newText = '', newProv = [], pos = 0;
  for (const [op, chunk] of diffs) {
    if (op === 0)       { newText += chunk; for (let i = 0; i < chunk.length; i++) newProv.push(pos + i < prov.length ? prov[pos + i] : -1); pos += chunk.length; }
    else if (op === -1) { pos += chunk.length; }
    else                { newText += chunk; for (let i = 0; i < chunk.length; i++) newProv.push(-1); }
  }
  wordNormalizeProv(newText, newProv);
  if (!newText.length) return [];
  const result = []; let start = 0, cur = newProv[0];
  for (let i = 1; i <= newText.length; i++) {
    if (i === newText.length || newProv[i] !== cur) { result.push({ text: newText.slice(start, i), ci: cur }); start = i; if (i < newText.length) cur = newProv[i]; }
  }
  return result;
}

/* ── Editor content extraction ───────────────────────────────────────────── */
// Works for both the legacy <textarea> and the new contenteditable <div>
// For the contenteditable editor (render.js), we walk the DOM to reconstruct
// the full markdown source, including hidden .md-raw-syntax chars (**bold**, etc.)

function getEditorContent() {
  const el = document.getElementById('editor');
  if (!el) return '';
  // Legacy textarea
  if (el.tagName === 'TEXTAREA') return el.value;
  // Contenteditable: walk ALL text nodes (including md-raw-syntax) to get markdown
  function allText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeName === 'BR') return '';
    let s = '';
    for (const c of node.childNodes) s += allText(c);
    return s;
  }
  const lines = [];
  for (const child of el.children) {
    lines.push(allText(child));
  }
  return lines.length ? lines.join('\n') : (el.innerText || '');
}

/* ── Download helper ─────────────────────────────────────────────────────── */

function downloadHtml(filename, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Server signing log ──────────────────────────────────────────────────── */

async function fetchSigningLog(vid) {
  if (!vid) return [];
  try {
    const res = await fetchWithTimeout(WORKER_URL + '/log/' + vid, { method: 'GET' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : [];
  } catch { return []; }
}

/* ── Shared report body builder ──────────────────────────────────────────── */
// Returns { docHtml, reportHtml } — both strings of HTML markup.
// docHtml: the rendered document (for the "document" section of the export).
// reportHtml: the statistics, timeline, and history sections.

async function buildReportBody(content) {
  const title   = document.getElementById('title-input').value || 'Untitled';
  const author  = document.getElementById('author-input').value;
  const kv      = workerKeyVersion || storageGet(K.KEY_VERSION);
  const vid     = sessionVerifier;

  const bylineHtml = author ? `<p class="doc-byline">${escHtml(author)}</p>` : '';
  const docHtml    = renderMd(content);

  // Color document
  const segs    = buildColorSegmentsWithCurrent(snapshots, content);
  const hasUnsn = segs.some(s => s.ci === -1);

  let colored = '<div class="cdoc">';
  for (const seg of segs) {
    const esc = escHtml(seg.text).replace(/\n/g, '<br>');
    if (seg.ci === -1) {
      colored += `<span class="cseg">${esc}</span>`;
    } else {
      const c = COLORS[seg.ci];
      colored += `<span class="cseg" style="background:${c.bg};border-bottom:2px solid ${c.line}" title="${c.name}">${esc}</span>`;
    }
  }
  colored += '</div>';

  // Legend
  const colorSnaps = new Map();
  for (const snap of snapshots) {
    const ci = snap.colorIndex % COLORS.length;
    if (!colorSnaps.has(ci)) colorSnaps.set(ci, []);
    colorSnaps.get(ci).push(snap);
  }
  let legend = '<div class="legend">';
  for (const [ci, snaps_] of [...colorSnaps.entries()].sort(([a],[b]) => a - b)) {
    const c     = COLORS[ci];
    const nums  = snaps_.map(s => '#' + (snapshots.indexOf(s) + 1));
    const label = nums.length === 1 ? `Snapshot ${nums[0]}` : `Snapshots ${nums.join(', ')}`;
    legend += `<div class="leg-item"><span class="leg-sw" style="background:${c.bg};border:2px solid ${c.line}"></span><span><strong>${c.name}</strong> — ${label}</span></div>`;
  }
  if (hasUnsn) legend += `<div class="leg-item"><span class="leg-unsn"></span><span><em>Current text — not yet snapshotted</em></span></div>`;
  legend += '</div>';

  // Fetch signing log
  const logEntries = await fetchSigningLog(vid);

  // Map signed snapshots to log events
  const signedSnapsInOrder = snapshots
    .map((s, i) => ({ ...s, _arrayIdx: i }))
    .filter(s => s.signed || s.keyVersion);

  let logCursor = 0;
  const snapIdxToEvent = new Map();
  for (let ei = 0; ei < logEntries.length; ei++) {
    const entry = logEntries[ei];
    for (let k = 0; k < entry.snapshotCount && logCursor < signedSnapsInOrder.length; k++) {
      snapIdxToEvent.set(signedSnapsInOrder[logCursor]._arrayIdx, ei + 1);
      logCursor++;
    }
  }

  const authorLine = author ? ` · ${escHtml(author)}` : '';
  const kvLine     = kv ? ` · Key ${escHtml(kv)}` : '';

  // Block event
  let blockEventHtml = '';
  try {
    const be = storageGet(K.BLOCK_EVENT);
    if (be) {
      const bev = JSON.parse(be);
      blockEventHtml = `<div class="block-event-notice"><strong>Editing was suspended</strong> after ${bev.failCount} consecutive signing failures. This event was logged automatically.</div>`;
    }
  } catch(_) {}

  const hasWorkerSigned = snapshots.some(s => s.keyVersion);
  const localVerifyNote = hasWorkerSigned
    ? `<p class="local-verify-note">⚠ This session contains worker-signed snapshots. Local integrity verification is not possible without a network call to the signing service. The snapshot chain should be treated as verified only when confirmed via the /verify endpoint.</p>`
    : '';

  let reportHtml = '';

  if (snapshots.length) {
    const sessions    = computeSessions(snapshots);
    const snapIds     = sessionIdsFor(snapshots);
    const lastSigned  = [...snapshots].reverse().find(s => s.signed || s.keyVersion);
    const verifiedWt  = lastSigned ? (lastSigned.writingTime || 0) : cumulativeWritingMs;
    const finalWords  = snapshots[snapshots.length-1].wordCount;
    const signedCount = snapshots.filter(s => s.keyVersion).length;

    let sessionRows = '';
    for (const s of sessions) {
      const wtSpan = s.snapCount > 1 ? fmtDur(s.endWt - s.startWt) : '—';
      sessionRows += `<tr><td>${s.id}</td><td>${wtSpan}</td><td>${s.snapCount}</td><td>${s.wordCount.toLocaleString()}</td></tr>`;
    }

    // Signing events
    let signingEventsHtml = '';
    if (logEntries.length) {
      signingEventsHtml += `<h2>Signing Events</h2>
<p class="signing-events-note">These entries are written by the signing service at the moment of signing and stored server-side. They cannot be altered by the author. Times shown are active writing-time offsets, not wall-clock times.</p>`;
      logEntries.forEach((entry, i) => {
        signingEventsHtml +=
          `<div style="padding:10px 14px;border-left:3px solid #2C4B70;background:#F3F6FB;margin:0 0 6px;border-radius:0 4px 4px 0;font-family:'Source Sans 3',system-ui,sans-serif;font-size:12.5px;">` +
            `<strong style="color:#2C4B70">Event ${i + 1}</strong>` +
            (entry.keyVersion ? ` <span style="color:#72695E;font-style:italic">· Key ${escHtml(entry.keyVersion)}</span>` : '') +
            `<br><span style="color:#4A4640">Writing time covered: ${fmtDur(entry.firstWritingTime)} → ${fmtDur(entry.lastWritingTime)} · ${entry.snapshotCount} snapshot${entry.snapshotCount !== 1 ? 's' : ''} in this batch</span>` +
          `</div>`;
      });
    } else if (vid) {
      signingEventsHtml = `<h2>Signing Events</h2><p class="signing-events-note">No server-side log entries found. The session may not have been signed yet, or entries have expired (30-day TTL).</p>`;
    }

    // Unified snapshot timeline
    let timeline = '<div class="utl">';
    let prevSid = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const snap    = snapshots[i];
      const sid     = snapIds[i];
      const color   = COLORS[snap.colorIndex % COLORS.length];
      const eventNum = snapIdxToEvent.get(i);
      const isSigned = snap.signed || !!snap.keyVersion;

      if (sid !== prevSid) {
        if (prevSid !== 0) {
          const gapMs = snap.timestamp - snapshots[i-1].timestamp;
          timeline += `<div class="utl-session-gap">↓ ${fmtDur(gapMs)} gap · Session ${sid} begins</div>`;
        }
        prevSid = sid;
      }

      const eventTag = eventNum
        ? `<span class="utl-event">Event ${eventNum}</span>`
        : `<span class="utl-unsigned">${isSigned ? 'Signed' : 'Unsigned'}</span>`;

      const kvTag = snap.keyVersion ? ` · ${snap.keyVersion}` : '';
      timeline +=
        `<div class="utl-row${isSigned ? ' signed-row' : ''}" style="border-left-color:${color.line}">` +
          `<span class="utl-snap">Snap #${i+1} · S${sid}${kvTag}</span>` +
          `<span class="utl-words">${snap.wordCount.toLocaleString()} words</span>` +
          `<span class="utl-wt">wt ${fmtDur(snap.writingTime || 0)}</span>` +
          eventTag +
        `</div>`;
    }
    timeline += '</div>';

    // Manual snapshots
    let psnapHtml = '';
    if (progressSnapshots.length > 0) {
      psnapHtml = `<h2>Manual Snapshots</h2>
<p class="psnap-note">Author-initiated captures of document state at specific points in writing. These are not part of the verified signing chain; they record the document as the author explicitly chose to preserve it. Numbered as Checkpoint 1, 2… to distinguish from signed snapshots.</p>`;
      progressSnapshots.forEach((ps, i) => {
        psnapHtml += `<p class="psnap-meta">Checkpoint ${i+1} of ${progressSnapshots.length} · Active writing time at capture: ${fmtElapsed(ps.elapsed)} · ${countWords(ps.text).toLocaleString()} words</p><div class="psnap-block">${escHtml(ps.text)}</div>`;
      });
    }

    // Note snapshots
    let nsnapHtml = '';
    const spacesWithSnaps = noteSpaceState.filter(sp => sp.exists && sp.snapshots.length > 0);
    if (spacesWithSnaps.length > 0) {
      nsnapHtml = '<h2>Note Snapshots</h2>';
      spacesWithSnaps.forEach(sp => {
        if (spacesWithSnaps.length > 1) nsnapHtml += `<h3>Space ${sp.slot}</h3>`;
        sp.snapshots.forEach((ns, i) => {
          nsnapHtml += `<p class="nsnap-meta">Snapshot ${i+1}/${sp.snapshots.length} · Active writing time at capture: ${fmtElapsed(ns.elapsed)} · ${countWords(ns.text).toLocaleString()} words</p><div class="nsnap-block">${escHtml(ns.text)}</div>`;
        });
      });
    }

    // Unverified snapshots
    let unverifiedHtml = '';
    if (unsignedSnapshots.length > 0) {
      const reasonLabels = {
        network_error:   'Network unreachable',
        worker_rejected: 'Rejected by signing service',
        timeout:         'Request timed out',
        queue_lost:      'Queue lost on reload',
      };
      unverifiedHtml = `<h2>Unverified Snapshots</h2>
<p class="unverified-note">The following snapshots could not be verified by the signing service at the time they were taken (typically a connectivity gap). They are stored separately from the verified chain and do not affect its integrity. Their authenticity should be assessed on the basis of content plausibility relative to the surrounding verified record.</p>`;
      unsignedSnapshots.forEach((u, i) => {
        const label = reasonLabels[u.reason] || u.reason;
        unverifiedHtml += `<div class="unverified-snap"><p class="unverified-meta">Unverified ${i+1} of ${unsignedSnapshots.length} · ${u.wordCount.toLocaleString()} words · Reason: ${escHtml(label)}</p><div class="unverified-block">${escHtml(u.content)}</div></div>`;
      });
    }

    const vidLine = vid ? `Document ID: ${escHtml(vid)}${kvLine}` : kvLine.slice(3);
    reportHtml = `<div class="rs">
  ${blockEventHtml}
  ${localVerifyNote}
  <h1>Writing Report</h1>
  <p class="sub">${escHtml(title)}${authorLine}${vidLine ? ' · ' + vidLine : ''}</p>
  <div class="stats">
    <div class="stat"><div class="stat-l">Sessions</div><div class="stat-v">${sessions.length}</div></div>
    <div class="stat"><div class="stat-l">Snapshots</div><div class="stat-v">${snapshots.length}</div></div>
    <div class="stat"><div class="stat-l">Signed</div><div class="stat-v">${signedCount}/${snapshots.length}</div></div>
    <div class="stat"><div class="stat-l">Active writing time (verified)</div><div class="stat-v">${fmtDur(verifiedWt)}</div></div>
    <div class="stat"><div class="stat-l">Final words</div><div class="stat-v">${finalWords.toLocaleString()}</div></div>
  </div>
  <h2>Sessions</h2>
  <p class="signing-events-note">Writing time shows the wt span from first to last snapshot within the session (keystroke-based active typing). Single-snapshot sessions show "—" because no span can be computed from one data point.</p>
  <table class="rtable"><thead><tr><th>#</th><th>Writing time</th><th>Snapshots</th><th>Words</th></tr></thead><tbody>${sessionRows}</tbody></table>
  ${signingEventsHtml}
  ${psnapHtml}${nsnapHtml}
  <h2>Snapshot Timeline</h2>
  <p class="signing-events-note">Each row combines client-side data (word count, writing time) with the signing event number from the server log. Signed rows are shaded blue.</p>
  ${timeline}
  ${unverifiedHtml}
  <h2>Color Legend</h2>${legend}
  <h2>Document with Writing History</h2>
  <p class="cdoc-note">Raw markdown source. Each color shows text <em>first captured</em> in that snapshot interval (randomised 1.5–3 min per session). Colors cycle after 6 intervals. Retroactive insertions are attributed to the snapshot in which they were first recorded, not to the moment they were typed. Uncolored text has not yet been snapshotted.</p>
  ${colored}
</div>`;
  } else {
    const vidLine = vid ? `Document ID: ${escHtml(vid)}${kvLine ? ' · ' + kvLine.slice(3) : ''}` : '';
    reportHtml = `<div class="rs">
  ${blockEventHtml}
  ${localVerifyNote}
  <h1>Writing Report</h1>
  <p class="sub">${escHtml(title)}${authorLine}${vidLine ? ' · ' + vidLine : ''}</p>
  <p style="color:#72695E;font-style:italic;margin:0 0 2em">No snapshots recorded yet.</p>
  <h2>Document with Writing History</h2>
  <p class="cdoc-note">No snapshots taken — all text shown uncolored.</p>
  <div class="legend">${hasUnsn ? `<div class="leg-item"><span class="leg-unsn"></span><span><em>Current text — not yet snapshotted</em></span></div>` : ''}</div>
  ${colored}
</div>`;
  }

  return { bylineHtml, docHtml, reportHtml };
}

/* ── Inject preview styles (once) ────────────────────────────────────────── */

function injectPreviewStyles() {
  if (document.getElementById('scrbr-preview-styles')) return;
  const style = document.createElement('style');
  style.id = 'scrbr-preview-styles';
  style.textContent = REPORT_STYLES + PREVIEW_INJECT_STYLES;
  document.head.appendChild(style);
}

/* ── Inline preview renderer ─────────────────────────────────────────────── */

async function renderReportPreview() {
  injectPreviewStyles();

  const pc = document.getElementById('preview-content');
  if (!pc) return;

  // Show loading state immediately
  pc.innerHTML = '<div class="preview-loading">Generating report…</div>';

  const title   = document.getElementById('title-input').value || 'Untitled';
  const author  = document.getElementById('author-input').value;
  const content = getEditorContent();

  const { bylineHtml, docHtml, reportHtml } = await buildReportBody(content);

  // Document section: rendered markdown in editor-matching styles
  const authorLine = author
    ? `<p class="preview-doc-byline">${escHtml(author)}</p>`
    : '';

  pc.innerHTML = `
    <div class="preview-doc-section">
      <h1 class="preview-doc-title">${escHtml(title)}</h1>
      ${authorLine}
      <div class="preview-doc-body">${docHtml}</div>
    </div>
    <div class="preview-report-section">
      ${reportHtml}
    </div>
  `;
}

/* ── Combined export (download) ──────────────────────────────────────────── */

async function exportCombined() {
  const title   = document.getElementById('title-input').value || 'Untitled';
  const content = getEditorContent();

  const { bylineHtml, docHtml, reportHtml } = await buildReportBody(content);

  downloadHtml(safeFilename(title) + '.html', `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>${BASE_STYLES}${REPORT_STYLES}</style></head>
<body>
<h1>${escHtml(title)}</h1>
${bylineHtml}
${docHtml}
<hr class="report-divider">
${reportHtml}
</body></html>`);
}

/* ── Override setView: preview now shows the report ──────────────────────── */
// We replace scrbr.js's setView (a global function) so the Preview button
// renders the writing report instead of raw markdown.

window.setView = function(v) {
  const ep = document.getElementById('editor-pane');
  const pp = document.getElementById('preview-pane');
  const bw = document.getElementById('btn-write');
  const bp = document.getElementById('btn-preview');

  if (v === 'write') {
    ep.classList.remove('hidden');
    pp.classList.add('hidden');
    bw.classList.add('active');
    bp.classList.remove('active');
    const ed = document.getElementById('editor');
    if (ed) ed.focus();
  } else {
    ep.classList.add('hidden');
    pp.classList.remove('hidden');
    bw.classList.remove('active');
    bp.classList.add('active');
    renderReportPreview();
  }
};

/* ── Wire download button in preview toolbar ─────────────────────────────── */

document.addEventListener('DOMContentLoaded', function () {
  const dlBtn = document.getElementById('btn-download-report');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => gatedExport(exportCombined));
  }
});
