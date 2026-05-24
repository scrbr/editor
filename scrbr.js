'use strict';

const SNAP_MIN_MS        = 1.5 * 60 * 1000;   // 90 s
const SNAP_MAX_MS        = 3   * 60 * 1000;   // 180 s
const SESSION_GAP        = 15  * 60 * 1000;   // 15 min inactivity
const DEBOUNCE_MS        = 600;
const MAX_NOTE_SNAPS     = 5;
const MAX_PROGRESS_SNAPS = 5;
const MAX_NOTE_SPACES    = 3;
const MIN_SPACE_PCT      = 25;

const WORKER_URL          = 'https://0476756423.zzcjmd2b7y.workers.dev';
const SIGN_TRIGGER_COUNT  = 4;    // sign after every N new auto-snapshots
const FAILURE_WARN_COUNT  = 3;    // consecutive failures before persistent warning
const FAILURE_BLOCK_COUNT = 10;   // consecutive failures before editing is blocked
const FAILURE_BLOCK_MS    = 15 * 60 * 1000; // must span at least 15 min to block

const HMAC_KEY_MATERIAL  = 'chr-snap-integrity-v1-9f4a2e8d-c3b7-41f0-a6d5-7e1b3f829c14';
const CONTENT_SEED       = 0xC4710D3E;
const TITLE_SEED         = 0x8B2AF651;
const NOTES_SEED         = 0x3F9A17C2;
const NOTE_SNAP_SEED     = 0xA7B3C9D1;
const PROGRESS_SNAP_SEED = 0x9D3F5E2A;

const K = {
  CONTENT:        'chr4_content',
  TITLE:          'chr4_title',
  AUTHOR:         'chr4_author',
  SNAPSHOTS:      'chr4_snapshots',
  PROGRESS_SNAPS: 'chr4_psnaps',
  NOTES_1:        'chr4_notes_1',
  NOTES_2:        'chr4_notes_2',
  NOTES_3:        'chr4_notes_3',
  NSNAPS_1:       'chr4_nsnaps_1',
  NSNAPS_2:       'chr4_nsnaps_2',
  NSNAPS_3:       'chr4_nsnaps_3',
  SPACE_STATE:    'chr4_space_state',
  FONT_SIZE:      'chr4_fontsize',
  SPLIT_PCT:      'chr4_splitpct',
  VERIFIER:       'chr4_verifier',
  UNSIGNED_SNAPS: 'chr4_unsigned_snaps',
  KEY_VERSION:    'chr4_key_version',
  FAIL_COUNT:     'chr4_fail_count',
  FIRST_FAIL_TIME:'chr4_first_fail_time',
  BLOCK_EVENT:    'chr4_block_event',
  VID_CLAIMED:    'chr4_vid_claimed',
};

function noteContentKey(slot) { return K['NOTES_' + slot]; }
function noteSnapsKey(slot)   { return K['NSNAPS_' + slot]; }

const COLORS = [
  { bg: '#FDF6CC', line: '#D4A800', name: 'Amber'      },
  { bg: '#D4EDDA', line: '#3A8A50', name: 'Sage'       },
  { bg: '#CCE5FF', line: '#2A72B8', name: 'Blue'       },
  { bg: '#EDD9F5', line: '#8840A8', name: 'Violet'     },
  { bg: '#FFE0CC', line: '#C06020', name: 'Terracotta' },
  { bg: '#C8EEF0', line: '#1A8090', name: 'Teal'       },
];

let snapshots        = [];
let lastSnapContent  = '';
let lastSaveTime     = null;
let currentView      = 'write';
let notesVisible     = false;
let autosaveTimer    = null;
let toastTimer       = null;
let snapshotTimerId  = null;
let cloudSaveInProgress = false;
let _hmacKey         = null;
let _internalDrag    = false;
let progressSnapshots = [];
let fontSize         = 16;
let splitNotesWidthPct = 33;
let isDraggingSplit  = false;
let sessionVerifier  = null;
let noteSpaceState = [
  { slot: 1, exists: true,  open: true,  content: '', snapshots: [] },
  { slot: 2, exists: false, open: false, content: '', snapshots: [] },
  { slot: 3, exists: false, open: false, content: '', snapshots: [] },
];
let sessionCurrentStart = null;
let sessionCurrentEnd   = null;

let unsignedSnapshots      = [];
let autoSnapsSinceLastSign = 0;
let consecutiveFailures    = 0;
let firstFailureTime       = null;
let workerKeyVersion       = null;
let signingInProgress      = false;

function generateVerifier() {
  return String(Math.floor(Math.random() * 9000000000) + 1000000000);
}

function getOrCreateVerifier() {
  if (sessionVerifier) return sessionVerifier;
  const stored = storageGet(K.VERIFIER);
  if (stored) { sessionVerifier = stored; return sessionVerifier; }
  return null;
}

function ensureVerifier() {
  if (!sessionVerifier) {
    sessionVerifier = generateVerifier();
    storageSet(K.VERIFIER, sessionVerifier);
  }
  return sessionVerifier;
}

function showVerifierError(msg) {
  const el = document.getElementById('verifier-error');
  el.innerHTML = msg + '<br><button onclick="document.getElementById(\'verifier-error\').classList.add(\'hidden\')">Dismiss</button>';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 18000);
}

function checkVerifierForLoad(fileVerifier) {
  const local = storageGet(K.VERIFIER);
  if (!local) return { ok: true };
  if (!fileVerifier) return { ok: 'warn', reason: 'unverifiable' };
  if (local === fileVerifier) return { ok: true };
  return { ok: false, reason: 'mismatch' };
}

function wordCountDiffPct(countA, countB) {
  const larger = Math.max(countA, countB);
  if (larger === 0) return 0;
  return Math.abs(countA - countB) / larger;
}

function trackWritingSession() {
  const now = Date.now();
  if (sessionCurrentStart === null) {
    sessionCurrentStart = now;
    sessionCurrentEnd   = now;
  } else {
    if (now - (sessionCurrentEnd || 0) > SESSION_GAP) {
      sessionCurrentStart = now;
    }
    sessionCurrentEnd = now;
  }
}

function computeTotalWritingTime() {
  const sessions = computeSessions(snapshots);
  let total = sessions.reduce((sum, s) => sum + (s.end - s.start), 0);

  if (sessionCurrentStart !== null && sessionCurrentEnd !== null) {
    const now = Date.now();
    const isActive = (now - sessionCurrentEnd) < SESSION_GAP;
    const lastSnapTs = snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp : 0;

    if (isActive) {
      if (sessionCurrentStart > lastSnapTs) {
        total += now - sessionCurrentStart;
      } else {
        total += Math.max(0, now - lastSnapTs);
      }
    } else {
      if (sessionCurrentStart > lastSnapTs) {
        total += sessionCurrentEnd - sessionCurrentStart;
      } else {
        total += Math.max(0, sessionCurrentEnd - lastSnapTs);
      }
    }
  } else if (snapshots.length === 0 && sessionCurrentStart !== null) {
    total += (sessionCurrentEnd || Date.now()) - sessionCurrentStart;
  }

  return total;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function base64ToUint8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function deriveXorKey(seed) {
  const km = HMAC_KEY_MATERIAL, key = new Uint8Array(64);
  let s = ((seed >>> 0) ^ 0xDEADBEEF) >>> 0;
  for (let i = 0; i < 64; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    key[i] = (s ^ km.charCodeAt(i % km.length)) & 0xFF;
  }
  return key;
}
function obfuscateText(text, seed) {
  if (!text) return '';
  const c = LZString.compressToUint8Array(text), k = deriveXorKey(seed), r = new Uint8Array(c.length);
  for (let i = 0; i < c.length; i++) r[i] = c[i] ^ k[i % 64];
  return uint8ToBase64(r);
}
function deobfuscateText(encoded, seed) {
  if (!encoded) return '';
  try {
    const b = base64ToUint8(encoded), k = deriveXorKey(seed), c = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) c[i] = b[i] ^ k[i % 64];
    return LZString.decompressFromUint8Array(c) || '';
  } catch (_) { return ''; }
}
async function chainedSeed(timestamp, prevContent) {
  const base = (timestamp & 0xFFFFFFFF) >>> 0;
  if (!prevContent) return base;
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prevContent));
  return (base ^ new DataView(hashBuf).getUint32(0, false)) >>> 0;
}

async function getHmacKey() {
  if (_hmacKey) return _hmacKey;
  _hmacKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(HMAC_KEY_MATERIAL),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return _hmacKey;
}

function deriveInterval(sessionStartTs) {
  let h = sessionStartTs >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  return Math.floor(SNAP_MIN_MS + (h / 0x100000000) * (SNAP_MAX_MS - SNAP_MIN_MS));
}

function snapMsg(snap, idx, prevSig, rhythm) {
  return new TextEncoder().encode(`${idx}|${snap.timestamp}|${snap.wordCount}|${rhythm}|${prevSig}`);
}
async function signSnapshotLocal(snap, idx, prevSig, rhythm) {
  const k = await getHmacKey(), buf = await crypto.subtle.sign('HMAC', k, snapMsg(snap, idx, prevSig, rhythm));
  return uint8ToBase64(new Uint8Array(buf));
}

async function verifySnapshot(snap, idx, prevSig, rhythm) {
  if (!snap.sig) return 'unsigned';
  if (snap.keyVersion) return 'ok';
  try {
    const k = await getHmacKey();
    return await crypto.subtle.verify('HMAC', k, base64ToUint8(snap.sig), snapMsg(snap, idx, prevSig, rhythm))
      ? 'ok' : 'tampered';
  } catch (_) { return 'tampered'; }
}

function computeSessionStarts(snaps, ids) {
  const map = new Map();
  for (let i = 0; i < snaps.length; i++)
    if (!map.has(ids[i])) map.set(ids[i], snaps[i].timestamp);
  return map;
}

async function verifyAllSnapshots(snaps) {
  if (!snaps.length) return { results: [], tampered: 0, unsigned: 0 };
  const ids = sessionIdsFor(snaps), starts = computeSessionStarts(snaps, ids), results = [];
  for (let i = 0; i < snaps.length; i++) {
    const prevSig = i === 0 ? 'genesis' : (snaps[i-1].sig || 'genesis');
    results.push(await verifySnapshot(snaps[i], i, prevSig, deriveInterval(starts.get(ids[i]))));
  }
  return { results, tampered: results.filter(r => r === 'tampered').length, unsigned: results.filter(r => r === 'unsigned').length };
}

async function computeStructuralChecksum(snaps) {
  const n = snaps.length, ft = n ? snaps[0].timestamp : 0, lt = n ? snaps[n-1].timestamp : 0,
        lw = n ? snaps[n-1].wordCount : 0, lg = n ? (snaps[n-1].sig || '') : '';
  const k = await getHmacKey(), buf = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${n}|${ft}|${lt}|${lw}|${lg}`));
  return uint8ToBase64(new Uint8Array(buf));
}

async function verifyStructuralChecksum(checksum, snaps) {
  if (!checksum) return 'unsigned';
  if (snaps.length && snaps.every(s => s.keyVersion)) return 'ok';
  try {
    const n = snaps.length, ft = n ? snaps[0].timestamp : 0, lt = n ? snaps[n-1].timestamp : 0,
          lw = n ? snaps[n-1].wordCount : 0, lg = n ? (snaps[n-1].sig || '') : '';
    const k = await getHmacKey();
    return await crypto.subtle.verify('HMAC', k, base64ToUint8(checksum), new TextEncoder().encode(`${n}|${ft}|${lt}|${lw}|${lg}`))
      ? 'ok' : 'tampered';
  } catch (_) { return 'tampered'; }
}

async function serializeToJson() {
  const title   = document.getElementById('title-input').value;
  const author  = document.getElementById('author-input').value;
  const content = document.getElementById('editor').value;
  const vid     = ensureVerifier();

  const obfSnaps = [];
  let prev = '';
  for (const s of snapshots) {
    const seed = await chainedSeed(s.timestamp, prev);
    obfSnaps.push({
      ts: s.timestamp, w: s.wordCount,
      d: obfuscateText(s.content, seed),
      g: s.sig || null,
      kv: s.keyVersion || null,
      signed: s.signed || false,
    });
    prev = s.content;
  }

  const obfProgressSnaps = progressSnapshots.map(ps => ({
    ts: ps.takenAt, e: ps.elapsed,
    d: obfuscateText(ps.text, PROGRESS_SNAP_SEED), pt: ps.text
  }));

  const spacesData = noteSpaceState.map(sp => {
    if (!sp.exists) return { slot: sp.slot, exists: false, open: false };
    const obfNoteSnaps = sp.snapshots.map(n => {
      const seed = ((n.takenAt & 0xFFFFFFFF) ^ (NOTE_SNAP_SEED ^ sp.slot)) >>> 0;
      return { ts: n.takenAt, e: n.elapsed, d: obfuscateText(n.text, seed), pt: n.text };
    });
    return {
      slot: sp.slot, exists: true, open: sp.open,
      n: obfuscateText(sp.content, NOTES_SEED ^ sp.slot),
      notes_pt: sp.content,
      ns: obfNoteSnaps,
    };
  });

  const kv = workerKeyVersion || storageGet(K.KEY_VERSION);

  const obfUnsigned = unsignedSnapshots.map(u => ({
    ts: u.timestamp, w: u.wordCount,
    d: obfuscateText(u.content, CONTENT_SEED),
    pt: u.content,
    reason: u.reason,
  }));

  let blockEvent = null;
  try { const be = storageGet(K.BLOCK_EVENT); if (be) blockEvent = JSON.parse(be); } catch(_) {}

  return JSON.stringify({
    v: 4, vid,
    keyVersion: kv || null,
    blockEvent,
    t: obfuscateText(title, TITLE_SEED), a: author,
    c: obfuscateText(content, CONTENT_SEED), plaintext: content,
    s: obfSnaps, ps: obfProgressSnaps,
    spaces: spacesData,
    unsignedSnaps: obfUnsigned,
    x: await computeStructuralChecksum(snapshots),
  });
}

async function deserializeFromJson(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (!data || data.v !== 4) throw new Error('not editor v4');

  const title   = deobfuscateText(data.t || '', TITLE_SEED);
  const author  = data.a || '';
  const content = deobfuscateText(data.c || '', CONTENT_SEED);

  const snaps = [];
  let prev = '';
  for (const s of data.s || []) {
    const seed = await chainedSeed(s.ts, prev);
    const c = deobfuscateText(s.d || '', seed);
    snaps.push({
      timestamp: s.ts, wordCount: s.w, content: c,
      sig: s.g || null,
      keyVersion: s.kv || null,
      signed: s.signed || (s.g ? true : false),
    });
    prev = c;
  }

  const progSnaps = (data.ps || []).map(ps => ({
    takenAt: ps.ts, elapsed: ps.e,
    text: deobfuscateText(ps.d || '', PROGRESS_SNAP_SEED) || ps.pt || ''
  }));

  const rawSpaces = data.spaces || [];
  const spaces = [1, 2, 3].map(slot => {
    const sp = rawSpaces.find(s => s.slot === slot);
    if (!sp || !sp.exists) return { slot, exists: false, open: false, content: '', snapshots: [] };
    const noteSnaps = (sp.ns || []).map(n => {
      const seed = ((n.ts & 0xFFFFFFFF) ^ (NOTE_SNAP_SEED ^ slot)) >>> 0;
      return { takenAt: n.ts, elapsed: n.e, text: deobfuscateText(n.d || '', seed) || n.pt || '' };
    });
    return {
      slot, exists: true, open: !!sp.open,
      content: deobfuscateText(sp.n || '', NOTES_SEED ^ slot) || sp.notes_pt || '',
      snapshots: noteSnaps,
    };
  });

  const unsnaps = (data.unsignedSnaps || []).map(u => ({
    timestamp: u.ts, wordCount: u.w,
    content: deobfuscateText(u.d || '', CONTENT_SEED) || u.pt || '',
    reason: u.reason,
    takenAt: u.ts,
  }));

  return {
    title, author, content, vid: data.vid || null,
    keyVersion: data.keyVersion || null,
    blockEvent: data.blockEvent || null,
    snapshots: snaps, progressSnapshots: progSnaps,
    spaces, unsignedSnapshots: unsnaps,
    _checksum: data.x || null,
  };
}

function storageSet(key, value) { try { localStorage.setItem(key, value); return true; } catch (_) { return false; } }
function storageGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

// ── Cloud: claim VID ─────────────────────────────────────────────────────────
async function claimVidIfNeeded() {
  if (storageGet(K.VID_CLAIMED) === 'true' && sessionVerifier) return sessionVerifier;

  const localVid = ensureVerifier();
  try {
    const res = await fetch(WORKER_URL + '/claim-id', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ vid: localVid }),
    });
    if (!res.ok) throw new Error('claim failed');
    const data = await res.json();

    if (data.vid !== localVid) {
      sessionVerifier = data.vid;
      storageSet(K.VERIFIER, sessionVerifier);
    }

    storageSet(K.VID_CLAIMED, 'true');
    return sessionVerifier;
  } catch {
    return null;
  }
}

// ── Cloud: save session ───────────────────────────────────────────────────────
async function saveToCloud() {
  if (cloudSaveInProgress) return;
  cloudSaveInProgress = true;
  showToast('Saving to cloud…');

  try {
    const vid = await claimVidIfNeeded();
    if (!vid) {
      showToast('Could not reach server — try again or save to file');
      return;
    }

    const json = await serializeToJson();
    const res  = await fetch(WORKER_URL + '/session/' + vid, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    json,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Cloud save failed: ' + (err.error || res.status));
      return;
    }

    lastSaveTime = new Date();
    updateStatusBar();
    showSessionIdNotice(vid);
  } catch {
    showToast('Cloud save failed — check connection');
  } finally {
    cloudSaveInProgress = false;
  }
}

// ── Cloud: restore session ────────────────────────────────────────────────────
async function restoreFromCloud(vid) {
  vid = (vid || '').trim();
  if (!/^\d{10}$/.test(vid)) { showToast('Session IDs are 10 digits'); return; }

  showToast('Fetching session…');
  try {
    const res = await fetch(WORKER_URL + '/session/' + vid, { method: 'GET' });
    if (res.status === 404) { showToast('Session not found — check your ID'); return; }
    if (!res.ok)            { showToast('Could not reach server'); return; }

    const raw = await res.text();
    let data;
    try { data = await deserializeFromJson(raw); }
    catch { showToast('Session data appears corrupt'); return; }

    const local = storageGet(K.VERIFIER);
    if (local && local !== vid) {
      const proceed = confirm(
        'This session ID does not match your current local session.\n\n' +
        'Loading it will replace your current local data.\n\n' +
        'Make sure you have saved your current session first.'
      );
      if (!proceed) return;
    }

    await loadFromJsonData(data);

    sessionVerifier = vid;
    storageSet(K.VERIFIER, vid);
    storageSet(K.VID_CLAIMED, 'true');
    showToast('Session restored from cloud — ' + data.snapshots.length + ' snapshots');
  } catch {
    showToast('Restore failed — check connection');
  }
}

// ── UI: session ID notice ─────────────────────────────────────────────────────
function showSessionIdNotice(vid) {
  const existing = document.getElementById('vid-notice');
  if (existing) existing.remove();

  const box = document.createElement('div');
  box.id = 'vid-notice';
  box.style.cssText = `
    position:fixed; bottom:60px; left:50%; transform:translateX(-50%);
    background:var(--accent); color:var(--bg); padding:12px 20px;
    border-radius:6px; font-family:var(--font-ui); font-size:13px;
    z-index:999; text-align:center; line-height:1.6; max-width:360px;
    box-shadow:0 4px 16px rgba(0,0,0,.2);
  `;
  box.innerHTML = `
    Saved to cloud. Your session ID:<br>
    <strong style="font-size:1.4em;letter-spacing:.08em">${vid}</strong><br>
    <span style="opacity:.8;font-size:11.5px">Keep this to restore your session from any browser.</span><br>
    <button id="vid-copy-btn" style="margin-top:8px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:inherit;padding:4px 14px;border-radius:3px;font-family:var(--font-ui);font-size:12px;cursor:pointer">Copy ID</button>
    <button id="vid-close-btn" style="margin-top:8px;margin-left:6px;background:none;border:1px solid rgba(255,255,255,.3);color:inherit;padding:4px 14px;border-radius:3px;font-family:var(--font-ui);font-size:12px;cursor:pointer">Dismiss</button>
  `;

  document.body.appendChild(box);
  document.getElementById('vid-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(vid).then(() => showToast('Session ID copied'));
  });
  document.getElementById('vid-close-btn').addEventListener('click', () => box.remove());
  setTimeout(() => { if (box.isConnected) box.remove(); }, 20000);
}

async function loadFromJsonData(data) {
  const editor     = document.getElementById('editor');
  const titleInput = document.getElementById('title-input');
  const authorInput= document.getElementById('author-input');

  editor.value = data.content; titleInput.value = data.title;
  if (data.author) authorInput.value = data.author;
  document.title = (data.title || 'Untitled') + ' — Editor';

  snapshots = data.snapshots;
  if (snapshots.length) lastSnapContent = snapshots[snapshots.length - 1].content;
  lastSaveTime = new Date();

  if (Array.isArray(data.unsignedSnapshots) && data.unsignedSnapshots.length) {
    unsignedSnapshots = data.unsignedSnapshots;
    persistUnsignedSnapshots();
  }

  if (data.keyVersion) {
    workerKeyVersion = data.keyVersion;
    storageSet(K.KEY_VERSION, data.keyVersion);
  }

  progressSnapshots = Array.isArray(data.progressSnapshots) ? data.progressSnapshots.slice(0, MAX_PROGRESS_SNAPS) : [];
  updateProgressButton();

  if (Array.isArray(data.spaces)) {
    noteSpaceState = data.spaces.map(sp => ({ ...sp, snapshots: [...(sp.snapshots || [])] }));
    while (noteSpaceState.length < 3) noteSpaceState.push({ slot: noteSpaceState.length + 1, exists: false, open: false, content: '', snapshots: [] });
    persistNoteSpaceState();
    noteSpaceState.forEach(sp => {
      if (sp.exists) {
        try { storageSet(noteContentKey(sp.slot), LZString.compressToUTF16(sp.content)); } catch(_) {}
        try { storageSet(noteSnapsKey(sp.slot), JSON.stringify(sp.snapshots)); } catch(_) {}
      }
    });
  }

  if (data.vid) { sessionVerifier = data.vid; storageSet(K.VERIFIER, sessionVerifier); }

  storageSet(K.CONTENT, LZString.compressToUTF16(data.content));
  storageSet(K.TITLE, data.title);
  if (data.author) storageSet(K.AUTHOR, data.author);
  try {
    storageSet(K.SNAPSHOTS, LZString.compressToUTF16(JSON.stringify(snapshots)));
    storageSet(K.PROGRESS_SNAPS, JSON.stringify(progressSnapshots));
  } catch (_) {}

  applyFontSize(); updateStatusBar(); scheduleNextSnapshot(); renderNotesUI();

  const [schk, chain] = await Promise.all([
    verifyStructuralChecksum(data._checksum, data.snapshots),
    verifyAllSnapshots(data.snapshots),
  ]);
  const issues = [];
  if (schk === 'tampered') issues.push('structure modified');
  if (chain.tampered > 0) issues.push(`${chain.tampered} snapshot${chain.tampered !== 1 ? 's' : ''} altered`);
  if (issues.length) showToast('⚠ Integrity: ' + issues.join(', '));
}

function saveContent(text) {
  if (text.trim()) ensureVerifier();
  storageSet(K.CONTENT, LZString.compressToUTF16(text)) || storageSet(K.CONTENT, text);
}
function loadContent() { const r = storageGet(K.CONTENT); if (!r) return ''; try { const d = LZString.decompressFromUTF16(r); if (d != null) return d; } catch(_){} return r; }
function saveSnapshots() { try { storageSet(K.SNAPSHOTS, LZString.compressToUTF16(JSON.stringify(snapshots))); } catch(_){} }
function loadSnapshots() { const r = storageGet(K.SNAPSHOTS); if (!r) return []; try { const p = JSON.parse(LZString.decompressFromUTF16(r)); return Array.isArray(p) ? p : []; } catch(_){ return []; } }
function saveTitle(t)    { storageSet(K.TITLE, t); }
function loadTitle()     { return storageGet(K.TITLE) || ''; }
function saveAuthor(a)   { storageSet(K.AUTHOR, a); }
function loadAuthor()    { return storageGet(K.AUTHOR) || ''; }

function persistUnsignedSnapshots() {
  try { storageSet(K.UNSIGNED_SNAPS, JSON.stringify(unsignedSnapshots)); } catch(_) {}
}

function persistNoteSpaceState() {
  const state = noteSpaceState.map(s => ({ exists: s.exists, open: s.open }));
  storageSet(K.SPACE_STATE, JSON.stringify(state));
}

function saveNoteSpaceContent(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp || !sp.exists) return;
  try { storageSet(noteContentKey(slot), LZString.compressToUTF16(sp.content)); } catch(_) { storageSet(noteContentKey(slot), sp.content); }
}

function saveNoteSpaceSnaps(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp) return;
  try { storageSet(noteSnapsKey(slot), JSON.stringify(sp.snapshots)); } catch(_) {}
}

function updateConnectivityIndicator(state) {
  const el = document.getElementById('status-worker');
  if (!el) return;
  el.className = 'worker-indicator ' + state;
  el.textContent = state === 'connected' ? '' : state === 'warning' ? 'Signing delayed' : 'Connection required';
  el.title = {
    connected: 'Signing service connected · Key ' + (workerKeyVersion || '?'),
    warning:   'Signing service unreachable — snapshots queued',
    blocked:   'Signing service unreachable — editing suspended',
  }[state] || 'Checking signing service…';
}

async function checkWorkerHealth() {
  try {
    const res = await fetch(WORKER_URL + '/health', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      workerKeyVersion = data.keyVersion;
      storageSet(K.KEY_VERSION, workerKeyVersion);
      resetFailureState();
      updateConnectivityIndicator('connected');
    } else {
      handleSigningFailure('health_check_failed');
    }
  } catch {
    handleSigningFailure('network_error');
  }
}

async function triggerBundleSigning(isExport = false) {
  if (signingInProgress) return;
  signingInProgress = true;

  const toSign = snapshots
    .map((s, i) => ({ ...s, _idx: i }))
    .filter(s => !s.signed);

  if (toSign.length === 0) {
    signingInProgress = false;
    return;
  }

  const lastSignedIdx = snapshots.reduce((best, s, i) => (s.signed ? i : best), -1);
  const anchorSig = lastSignedIdx >= 0 ? snapshots[lastSignedIdx].sig : 'genesis';

  const payload = {
    sessionId: ensureVerifier(),
    anchorSig,
    snapshots: toSign.map((s, bundleIdx) => ({
      index:     s._idx,
      timestamp: s.timestamp,
      wordCount: s.wordCount,
      prevSig:   bundleIdx === 0 ? anchorSig : null,
    })),
  };

  try {
    const res = await fetch(WORKER_URL + '/sign', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      handleSigningFailure(err.error || 'worker_rejected');
      moveToUnsigned(toSign, err.error ? 'worker_rejected' : 'worker_rejected');
    } else {
      const data = await res.json();
      applySignatures(toSign, data.signatures, data.keyVersion);
      autoSnapsSinceLastSign = 0;
      resetFailureState();
      saveSnapshots();
      persistUnsignedSnapshots();
      updateStatusBar();
    }
  } catch {
    handleSigningFailure('network_error');
    moveToUnsigned(toSign, 'network_error');
  }

  signingInProgress = false;
}

function applySignatures(toSign, signatures, keyVersion) {
  toSign.forEach((s, i) => {
    snapshots[s._idx].sig        = signatures[i];
    snapshots[s._idx].signed     = true;
    snapshots[s._idx].keyVersion = keyVersion;
  });
}

function moveToUnsigned(toSign, reason) {
  const failedIndices = new Set(toSign.map(s => s._idx));
  toSign.forEach(s => {
    unsignedSnapshots.push({
      timestamp: s.timestamp,
      wordCount: s.wordCount,
      content:   s.content,
      reason,
      takenAt:   s.timestamp,
    });
  });
  snapshots = snapshots.filter((_, i) => !failedIndices.has(i));
  persistUnsignedSnapshots();
  saveSnapshots();
}

function handleSigningFailure(reason) {
  consecutiveFailures++;

  if (firstFailureTime === null) {
    firstFailureTime = Date.now();
    storageSet(K.FIRST_FAIL_TIME, String(firstFailureTime));
  }

  storageSet(K.FAIL_COUNT, String(consecutiveFailures));

  const failureDuration = Date.now() - firstFailureTime;

  if (
    consecutiveFailures >= FAILURE_BLOCK_COUNT &&
    failureDuration >= FAILURE_BLOCK_MS
  ) {
    blockEditing(reason);
    updateConnectivityIndicator('blocked');
  } else if (consecutiveFailures >= FAILURE_WARN_COUNT) {
    updateConnectivityIndicator('warning');
    showPersistentWarning(
      'The signing service is unreachable. Snapshots are being stored locally as unverified. ' +
      'Please check your connection. (' + consecutiveFailures + ' consecutive failures)'
    );
  } else {
    updateConnectivityIndicator('warning');
  }
}

function blockEditing(reason) {
  const editor = document.getElementById('editor');
  if (editor) editor.disabled = true;

  const blockEvent = { timestamp: Date.now(), reason, failCount: consecutiveFailures };
  storageSet(K.BLOCK_EVENT, JSON.stringify(blockEvent));

  showPersistentWarning(
    '⚠ Editing suspended. The signing service has been unreachable for an extended period. ' +
    'This event has been logged in your session file. Please resolve your connection and reload, ' +
    'or contact your supervisor.',
    true
  );
}

function resetFailureState() {
  consecutiveFailures = 0;
  firstFailureTime    = null;
  storageSet(K.FAIL_COUNT,      '0');
  storageSet(K.FIRST_FAIL_TIME, '');
  hidePersistentWarning();
  updateConnectivityIndicator('connected');
}

function showPersistentWarning(message, nonDismissible = false) {
  const el = document.getElementById('persistent-warning');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden', 'non-dismissible');
  if (nonDismissible) el.classList.add('non-dismissible');
}

function hidePersistentWarning() {
  const el = document.getElementById('persistent-warning');
  if (el) el.classList.add('hidden');
}

async function gatedExport(exportFn) {
  await triggerBundleSigning(true);

  const stillUnsigned = snapshots.filter(s => !s.signed).length;

  if (stillUnsigned > 0) {
    showToast('Export blocked: signing service unreachable. Resolve connection first.');
    return;
  }

  if (unsignedSnapshots.length > 0) {
    const n = unsignedSnapshots.length;
    const proceed = confirm(
      `Your session contains ${n} unverified snapshot${n !== 1 ? 's' : ''} taken during connectivity gaps. ` +
      `These are stored separately from the verified chain and clearly labelled in the report.\n\nProceed with export?`
    );
    if (!proceed) return;
  }

  exportFn();
}

function updateNoteSpaceSnapBtn(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp) return;
  const btn = document.querySelector(`.note-snap-btn[data-slot="${slot}"]`);
  if (!btn) return;
  const n = sp.snapshots.length;
  btn.textContent = `Snap ${n}/${MAX_NOTE_SNAPS}`;
  btn.classList.remove('full', 'taken');
  if (n >= MAX_NOTE_SNAPS) { btn.classList.add('full'); btn.title = `Maximum note snapshots reached (${n}/${MAX_NOTE_SNAPS})`; }
  else if (n > 0) { btn.classList.add('taken'); btn.title = `${n} note snapshot${n !== 1 ? 's' : ''} saved — click to add another`; }
  else { btn.title = `Save a note snapshot (max ${MAX_NOTE_SNAPS})`; }
}

function updateNoteSpaceWordCount(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp) return;
  const el = document.querySelector(`.note-tab-wc[data-slot="${slot}"]`);
  if (el) el.textContent = countWords(sp.content) + ' w';
}

function takeNoteSpaceSnapshot(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp || !sp.exists) return;
  if (!sp.content.trim()) { showToast('No notes to snapshot'); return; }
  if (sp.snapshots.length >= MAX_NOTE_SNAPS) { showToast(`Maximum note snapshots reached (${MAX_NOTE_SNAPS}/${MAX_NOTE_SNAPS})`); return; }
  const elapsed = computeTotalWritingTime();
  sp.snapshots.push({ text: sp.content, elapsed, takenAt: Date.now() });
  saveNoteSpaceSnaps(slot);
  updateNoteSpaceSnapBtn(slot);
  showToast(`Space ${slot} · Snapshot ${sp.snapshots.length}/${MAX_NOTE_SNAPS} — ${fmtElapsed(elapsed)} writing time`);
}

function addNoteSpace() {
  const slot = noteSpaceState.find(s => !s.exists);
  if (!slot) { showToast('Maximum 3 note spaces'); return; }
  slot.exists = true;
  slot.open = true;
  slot.content = '';
  slot.snapshots = [];
  persistNoteSpaceState();
  renderNotesUI();
  showToast(`Space ${slot.slot} created`);
}

function openNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp || !sp.exists) return;
  sp.open = true;
  persistNoteSpaceState();
  renderNotesUI();
  showToast(`Space ${slotNum} reopened`);
}

function closeNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp) return;
  sp.open = false;
  persistNoteSpaceState();
  renderNotesUI();
}

function clearNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp) return;
  if (!confirm(`Permanently clear Space ${slotNum} and all its snapshots?\n\nThis cannot be undone.`)) return;
  sp.exists = false;
  sp.open = false;
  sp.content = '';
  sp.snapshots = [];
  try { localStorage.removeItem(noteContentKey(slotNum)); } catch(_) {}
  try { localStorage.removeItem(noteSnapsKey(slotNum)); } catch(_) {}
  persistNoteSpaceState();
  renderNotesUI();
  showToast(`Space ${slotNum} cleared`);
}

function showNoteSpaceMenu(btn) {
  closeNoteSpaceMenu();
  const menu = document.getElementById('note-space-menu');
  menu.innerHTML = '';

  const closedSpaces = noteSpaceState.filter(s => s.exists && !s.open);
  const totalExisting = noteSpaceState.filter(s => s.exists).length;

  closedSpaces.forEach(sp => {
    const item = document.createElement('button');
    item.textContent = `Reopen Space ${sp.slot}`;
    item.addEventListener('click', () => { openNoteSpace(sp.slot); closeNoteSpaceMenu(); });
    menu.appendChild(item);
  });

  if (totalExisting < MAX_NOTE_SPACES) {
    const item = document.createElement('button');
    item.textContent = 'New Space';
    item.addEventListener('click', () => { addNoteSpace(); closeNoteSpaceMenu(); });
    menu.appendChild(item);
  }

  if (!menu.children.length) return;

  const rect = btn.getBoundingClientRect();
  menu.style.top  = (rect.bottom + 3) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.left  = 'auto';
  menu.classList.remove('hidden');

  setTimeout(() => {
    const handler = e => {
      if (!menu.contains(e.target) && e.target !== btn) { closeNoteSpaceMenu(); document.removeEventListener('click', handler); }
    };
    document.addEventListener('click', handler);
  }, 0);
}

function closeNoteSpaceMenu() {
  document.getElementById('note-space-menu').classList.add('hidden');
  document.getElementById('note-space-menu').innerHTML = '';
}

function renderNotesUI() {
  const tabbar    = document.getElementById('notes-tabbar');
  const spacesRow = document.getElementById('notes-spaces-row');
  if (!tabbar || !spacesRow) return;
  tabbar.innerHTML = '';
  spacesRow.innerHTML = '';

  const openSpaces  = noteSpaceState.filter(s => s.exists && s.open);
  const closedCount = noteSpaceState.filter(s => s.exists && !s.open).length;
  const totalExist  = noteSpaceState.filter(s => s.exists).length;
  const canAdd      = closedCount > 0 || totalExist < MAX_NOTE_SPACES;
  tabbar.classList.toggle('has-add', canAdd);

  openSpaces.forEach(sp => {
    const tab = document.createElement('div');
    tab.className = 'note-tab';
    tab.dataset.slot = sp.slot;

    const label = document.createElement('span');
    label.className = 'note-tab-label';
    label.textContent = `Note Space ${sp.slot}`;

    const wc = document.createElement('span');
    wc.className = 'note-tab-wc';
    wc.dataset.slot = sp.slot;
    wc.textContent = countWords(sp.content) + ' w';

    const snapBtn = document.createElement('button');
    snapBtn.className = 'btn note-snap-btn';
    snapBtn.dataset.slot = sp.slot;
    const n = sp.snapshots.length;
    snapBtn.textContent = `Snap ${n}/${MAX_NOTE_SNAPS}`;
    if (n >= MAX_NOTE_SNAPS) { snapBtn.classList.add('full'); snapBtn.title = `Max snapshots reached (${n}/${MAX_NOTE_SNAPS})`; }
    else if (n > 0) { snapBtn.classList.add('taken'); snapBtn.title = `${n} snapshot${n !== 1 ? 's' : ''} — add another`; }
    else { snapBtn.title = `Save note snapshot (max ${MAX_NOTE_SNAPS})`; }
    snapBtn.addEventListener('click', () => takeNoteSpaceSnapshot(sp.slot));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'note-tab-btn';
    closeBtn.textContent = '–';
    closeBtn.title = `Hide Space ${sp.slot} (content preserved)`;
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeNoteSpace(sp.slot); });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'note-tab-btn clear-btn';
    clearBtn.textContent = '×';
    clearBtn.title = `Clear Space ${sp.slot} permanently`;
    clearBtn.addEventListener('click', e => { e.stopPropagation(); clearNoteSpace(sp.slot); });

    tab.appendChild(label);
    tab.appendChild(wc);
    tab.appendChild(snapBtn);
    tab.appendChild(closeBtn);
    tab.appendChild(clearBtn);
    tabbar.appendChild(tab);

    const spaceDiv = document.createElement('div');
    spaceDiv.className = 'note-space';
    spaceDiv.dataset.slot = sp.slot;

    const ta = document.createElement('textarea');
    ta.className = 'note-space-editor';
    ta.dataset.slot = sp.slot;
    ta.spellcheck = true;
    ta.placeholder = `Space ${sp.slot} notes…`;
    ta.value = sp.content;
    ta.style.fontSize = fontSize + 'px';

    ta.addEventListener('paste', e => { e.preventDefault(); showToast('Pasting is disabled in Editor'); });
    ta.addEventListener('dragstart', () => { _internalDrag = true; });
    ta.addEventListener('dragend', () => { _internalDrag = false; });
    ta.addEventListener('drop', e => { if (!_internalDrag) { e.preventDefault(); showToast('External drop is disabled'); } });

    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); showToast('Pasting is disabled in Editor'); }
    });

    ta.addEventListener('input', () => {
      trackWritingSession();
      sp.content = ta.value;
      updateNoteSpaceWordCount(sp.slot);
      clearTimeout(sp._saveTimer);
      sp._saveTimer = setTimeout(() => saveNoteSpaceContent(sp.slot), DEBOUNCE_MS);
    });

    spaceDiv.appendChild(ta);
    spacesRow.appendChild(spaceDiv);
  });

  if (canAdd) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn note-tab-add';
    addBtn.title = 'Add or reopen a note space';
    addBtn.textContent = openSpaces.length === 0 ? 'Open space' : '+';
    addBtn.addEventListener('click', e => { e.stopPropagation(); showNoteSpaceMenu(addBtn); });
    if (openSpaces.length > 0) {
      tabbar.querySelector('.note-tab:last-child').appendChild(addBtn);
    } else {
      tabbar.appendChild(addBtn);
    }
  }

  if (openSpaces.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'note-spaces-empty';
    ph.innerHTML = '<span>No note spaces open.</span>';
    spacesRow.appendChild(ph);
  }

  if (notesVisible) enforceNotesPaneWidth();
}

function enforceNotesPaneWidth() {
  const openCount = noteSpaceState.filter(s => s.exists && s.open).length || 1;
  const minPct = Math.min(openCount * MIN_SPACE_PCT, 75);
  if (splitNotesWidthPct < minPct) {
    splitNotesWidthPct = minPct;
    const p = document.getElementById('notes-pane');
    if (p) p.style.width = splitNotesWidthPct + '%';
    storageSet(K.SPLIT_PCT, splitNotesWidthPct);
  }
}

function sessionIdsFor(snaps) {
  if (!snaps.length) return [];
  const ids = [1];
  for (let i = 1; i < snaps.length; i++)
    ids.push(snaps[i].timestamp - snaps[i-1].timestamp > SESSION_GAP ? ids[i-1] + 1 : ids[i-1]);
  return ids;
}

function computeSessions(snaps) {
  const ids = sessionIdsFor(snaps), map = new Map();
  for (let i = 0; i < snaps.length; i++) {
    const sid = ids[i];
    if (!map.has(sid)) map.set(sid, { id: sid, start: snaps[i].timestamp, end: snaps[i].timestamp, snapCount: 1, wordCount: snaps[i].wordCount });
    else { const s = map.get(sid); s.end = snaps[i].timestamp; s.wordCount = snaps[i].wordCount; s.snapCount++; }
  }
  return [...map.values()];
}

function currentSessionId() {
  if (!snapshots.length) return 1;
  const ids = sessionIdsFor(snapshots), lastId = ids[ids.length-1];
  return Date.now() - snapshots[snapshots.length-1].timestamp > SESSION_GAP ? lastId + 1 : lastId;
}

function fmtElapsed(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function fmtAgo(date) {
  const ms = Date.now() - date.getTime(), s = Math.floor(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
}
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function countWords(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

function updateProgressButton() {
  const btn = document.getElementById('btn-progress-snap');
  const countEl = document.getElementById('progress-snap-count');
  if (!btn) return;
  const n = progressSnapshots.length;
  if (countEl) countEl.textContent = `(${n}/${MAX_PROGRESS_SNAPS})`;
  btn.classList.remove('full', 'taken');
  if (n >= MAX_PROGRESS_SNAPS) {
    btn.classList.add('full');
    btn.title = `Maximum progress snapshots reached (${n}/${MAX_PROGRESS_SNAPS})`;
  } else if (n > 0) {
    btn.classList.add('taken');
    btn.title = `${n} progress snapshot${n !== 1 ? 's' : ''} saved — click to add another`;
  } else {
    btn.title = `Save a progress snapshot (max ${MAX_PROGRESS_SNAPS})`;
  }
}

function saveProgressSnapshots() {
  try { storageSet(K.PROGRESS_SNAPS, JSON.stringify(progressSnapshots)); } catch(_) {}
}

function takeProgressSnapshot() {
  const text = document.getElementById('editor').value;
  if (!text.trim()) { showToast('Nothing to snapshot yet'); return; }
  if (progressSnapshots.length >= MAX_PROGRESS_SNAPS) {
    showToast(`Maximum progress snapshots reached (${MAX_PROGRESS_SNAPS}/${MAX_PROGRESS_SNAPS})`); return;
  }
  const elapsed = computeTotalWritingTime();
  progressSnapshots.push({ text, elapsed, takenAt: Date.now() });
  saveProgressSnapshots();
  showToast(`Progress snapshot ${progressSnapshots.length}/${MAX_PROGRESS_SNAPS} — ${fmtElapsed(elapsed)} writing time`);
  updateProgressButton();
}

function applyFontSize() {
  const e = document.getElementById('editor');
  if (e) e.style.fontSize = fontSize + 'px';
  document.querySelectorAll('.note-space-editor').forEach(el => { el.style.fontSize = fontSize + 'px'; });
  try { localStorage.setItem(K.FONT_SIZE, fontSize); } catch(_) {}
}

function setNotesWidth(pct) {
  const openCount = noteSpaceState.filter(s => s.exists && s.open).length || 1;
  const minPct = Math.min(openCount * MIN_SPACE_PCT, 75);
  splitNotesWidthPct = Math.max(minPct, Math.min(75, pct));
  const p = document.getElementById('notes-pane');
  if (p) p.style.width = splitNotesWidthPct + '%';
  try { localStorage.setItem(K.SPLIT_PCT, splitNotesWidthPct); } catch(_) {}
}

function toggleNotes() {
  notesVisible = !notesVisible;
  const np = document.getElementById('notes-pane'), h = document.getElementById('split-handle'), btn = document.getElementById('btn-notes');
  if (notesVisible) {
    const anyOpen = noteSpaceState.some(s => s.exists && s.open);
    if (!anyOpen) {
      const first = noteSpaceState.find(s => s.exists);
      if (first) { first.open = true; }
      else { noteSpaceState[0].exists = true; noteSpaceState[0].open = true; }
      persistNoteSpaceState();
      renderNotesUI();
    }
    np.classList.remove('hidden');
    enforceNotesPaneWidth();
    np.style.width = splitNotesWidthPct + '%';
    h.classList.remove('hidden');
    btn.classList.add('active');
  } else {
    np.classList.add('hidden');
    h.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function initSplitResize() {
  const handle = document.getElementById('split-handle'), main = document.getElementById('main');
  handle.addEventListener('mousedown', e => { isDraggingSplit = true; handle.classList.add('dragging'); document.body.classList.add('split-dragging'); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!isDraggingSplit) return; const r = main.getBoundingClientRect(); setNotesWidth(((r.right - e.clientX) / r.width) * 100); });
  document.addEventListener('mouseup', () => { if (isDraggingSplit) { isDraggingSplit = false; handle.classList.remove('dragging'); document.body.classList.remove('split-dragging'); } });
  handle.addEventListener('touchstart', e => { isDraggingSplit = true; handle.classList.add('dragging'); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => { if (!isDraggingSplit) return; const r = main.getBoundingClientRect(); setNotesWidth(((r.right - e.touches[0].clientX) / r.width) * 100); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchend', () => { if (isDraggingSplit) { isDraggingSplit = false; handle.classList.remove('dragging'); } });
}

function getCurrentSessionInterval() {
  if (!snapshots.length) return Math.round((SNAP_MIN_MS + SNAP_MAX_MS) / 2);
  const ids = sessionIdsFor(snapshots), sid = ids[ids.length-1];
  if (Date.now() - snapshots[snapshots.length-1].timestamp > SESSION_GAP) return Math.round((SNAP_MIN_MS + SNAP_MAX_MS) / 2);
  return deriveInterval(snapshots[ids.findIndex(id => id === sid)].timestamp);
}

function scheduleNextSnapshot() {
  clearTimeout(snapshotTimerId);
  snapshotTimerId = setTimeout(async () => {
    const text = document.getElementById('editor').value;
    if (text.trim() && text !== lastSnapContent) await takeSnapshot(text, false);
    scheduleNextSnapshot();
  }, getCurrentSessionInterval());
}

async function takeSnapshot(text, silent) {
  const snap = {
    timestamp: Date.now(),
    content:   text,
    wordCount: countWords(text),
    sig:       null,
    signed:    false,
    keyVersion: null,
  };

  snapshots.push(snap);
  lastSnapContent = text;
  autoSnapsSinceLastSign++;

  saveSnapshots();
  updateStatusBar();
  if (!silent) blinkSnap();

  if (autoSnapsSinceLastSign >= SIGN_TRIGGER_COUNT) {
    await triggerBundleSigning();
  }
}

async function doSaveSnapshot(silent) {
  const text = document.getElementById('editor').value;
  saveContent(text); lastSaveTime = new Date();
  if (text.trim() && text !== lastSnapContent) { await takeSnapshot(text, silent); scheduleNextSnapshot(); }
  updateStatusBar();
}

function insertFootnote() {
  const el = document.getElementById('editor'), text = el.value, pos = el.selectionStart;
  const existing = [...text.matchAll(/\[\^(\d+)\]/g)].map(m => parseInt(m[1]));
  const n = existing.length ? Math.max(...existing) + 1 : 1;
  const withDef = text.slice(0, pos) + `[^${n}]` + text.slice(pos) + `\n\n[^${n}]: `;
  el.value = withDef; el.selectionStart = el.selectionEnd = withDef.length;
  el.focus(); onInput();
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function processFootnotes(md) {
  const defs = new Map();
  const nodef = md.replace(/^\[\^([^\]\r\n]+)\]:\s*(.+)$/gm, (_, l, t) => { defs.set(l.trim(), t.trim()); return ''; });
  let counter = 0; const numMap = new Map();
  const processed = nodef.replace(/\[\^([^\]\r\n]+)\]/g, (_, label) => {
    label = label.trim();
    if (!numMap.has(label)) numMap.set(label, ++counter);
    const n = numMap.get(label), title = defs.has(label) ? ` title="${escHtml(defs.get(label))}"` : '';
    return `<sup id="fnref-${label}"><a href="#fn-${label}" class="footnote-ref"${title}>${n}</a></sup>`;
  });
  const fns = [...defs.entries()].map(([l, t]) => ({ label: l, text: t, num: numMap.get(l) || ++counter })).sort((a,b) => a.num - b.num);
  return { processed, fns };
}

function renderMd(md) {
  const { processed, fns } = processFootnotes(md);
  let html = marked.parse(processed);
  if (fns.length) {
    html += '<hr class="fn-rule"><section class="footnotes">';
    for (const fn of fns)
      html += `<div class="footnote" id="fn-${fn.label}"><sup>${fn.num}</sup> ${fn.text} <a href="#fnref-${fn.label}" class="footnote-back">↩</a></div>`;
    html += '</section>';
  }
  return html;
}

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
  if (snaps.length === 1) return [{ text: snaps[0].content, ci: 0 }];
  const dmp = new diff_match_patch(); dmp.Diff_Timeout = 3.0;
  let text = snaps[0].content, prov = Array.from({ length: text.length }, () => 0);
  for (let si = 1; si < snaps.length; si++) {
    const ci = si % COLORS.length, diffs = dmp.diff_main(text, snaps[si].content);
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

function safeFilename(s) { return (s || 'document').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F ]/g, '').trim() || 'document'; }

function downloadHtml(filename, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
  .tl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; font-size: 12.5px; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .tl-row { display: flex; flex-direction: column; gap: 3px; padding: 7px 10px; border-left: 3px solid; border-radius: 0 3px 3px 0; background: #FAFAFA; }
  .tl-num { color: #72695E; font-size: 11px; }
  .tl-words { font-size: 12px; font-weight: 600; }
  .tl-gap { grid-column: 1/-1; padding: 8px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #72695E; border-top: 1px dashed #D4CEC2; margin-top: 6px; }
  .legend { margin: 0 0 .5em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .leg-item { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 3px 0; }
  .leg-sw { width: 28px; height: 16px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
  .leg-unsn { width: 28px; height: 16px; border-radius: 3px; display: inline-block; flex-shrink: 0; border: 1px dashed #aaa; }
  .cdoc-note { font-size: 12.5px; font-style: italic; color: #72695E; margin: .5em 0 1.2em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .cdoc { font-family: 'Source Serif 4', Georgia, serif; font-size: 14.5px; line-height: 1.85; background: #fff; border: 1px solid #D4CEC2; border-radius: 5px; padding: 28px; white-space: pre-wrap; word-break: break-word; }
  .cseg { border-radius: 2px; padding: 0 1px; }
  .psnap-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 14.5px; line-height: 1.85; background: #fff; border: 1px solid #D4CEC2; border-radius: 5px; padding: 28px; white-space: pre-wrap; word-break: break-word; margin: 0 0 1.5em; }
  .psnap-meta { font-size: 12px; color: #72695E; font-style: italic; margin: .25em 0 1em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .nsnap-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 13.5px; line-height: 1.8; background: #FFFEF5; border: 1px solid #C8A84B; border-radius: 5px; padding: 20px 24px; white-space: pre-wrap; word-break: break-word; margin: 0 0 1em; }
  .nsnap-meta { font-size: 12px; color: #72695E; font-style: italic; margin: .25em 0 .6em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .block-event-notice { background: #7A1A1A; color: #FFF5F5; padding: 14px 20px; border-radius: 5px; font-size: 13px; margin: 0 0 2em; font-family: 'Source Sans 3', system-ui, sans-serif; line-height: 1.6; }
  .unverified-note { font-size: 13px; color: #72695E; font-style: italic; margin: .5em 0 1.5em; font-family: 'Source Sans 3', system-ui, sans-serif; line-height: 1.6; }
  .unverified-snap { margin: 0 0 1.5em; }
  .unverified-meta { font-size: 12px; color: #7A5510; font-style: italic; margin: .25em 0 .6em; font-family: 'Source Sans 3', system-ui, sans-serif; }
  .unverified-block { font-family: 'Source Serif 4', Georgia, serif; font-size: 13.5px; line-height: 1.8; background: #FFFDF5; border: 1px solid #C8A84B; border-left: 4px solid #B8922A; border-radius: 0 5px 5px 0; padding: 20px 24px; white-space: pre-wrap; word-break: break-word; }
`;

function exportCombined() {
  const title   = document.getElementById('title-input').value || 'Untitled';
  const author  = document.getElementById('author-input').value;
  const content = document.getElementById('editor').value;
  const kv      = workerKeyVersion || storageGet(K.KEY_VERSION);

  const bylineHtml = author ? `<p class="doc-byline">${escHtml(author)}</p>` : '';
  const docHtml    = renderMd(content);

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

  const colorSnaps = new Map();
  for (let i = 0; i < snapshots.length; i++) {
    const ci = i % COLORS.length;
    if (!colorSnaps.has(ci)) colorSnaps.set(ci, []);
    colorSnaps.get(ci).push(i + 1);
  }
  let legend = '<div class="legend">';
  for (const [ci, nums] of colorSnaps) {
    const c = COLORS[ci];
    const label = ci === 0
      ? `Snapshot 1${nums.length > 1 ? ' + ' + nums.slice(1).map(n => '#' + n).join(', ') : ''}`
      : `Snapshot${nums.length > 1 ? 's' : ''} ${nums.map(n => '#' + n).join(', ')}`;
    legend += `<div class="leg-item"><span class="leg-sw" style="background:${c.bg};border:2px solid ${c.line}"></span><span><strong>${c.name}</strong> — ${label}</span></div>`;
  }
  if (hasUnsn) legend += `<div class="leg-item"><span class="leg-unsn"></span><span><em>Current text — not yet snapshotted</em></span></div>`;
  legend += '</div>';

  let reportHtml = '';
  const authorLine = author ? ` · ${escHtml(author)}` : '';
  const kvLine     = kv ? ` · Key ${escHtml(kv)}` : '';

  let blockEventHtml = '';
  try {
    const be = storageGet(K.BLOCK_EVENT);
    if (be) {
      const bev = JSON.parse(be);
      blockEventHtml = `<div class="block-event-notice"><strong>Editing was suspended</strong> at ${fmtDateTime(bev.timestamp)} due to sustained signing service unavailability (${bev.failCount} consecutive failures). This event was logged automatically.</div>`;
    }
  } catch(_) {}

  if (snapshots.length) {
    const sessions     = computeSessions(snapshots);
    const snapIds      = sessionIdsFor(snapshots);
    const totalWriting = computeTotalWritingTime();
    const finalWords   = snapshots[snapshots.length-1].wordCount;
    const signedCount  = snapshots.filter(s => s.keyVersion).length;

    let sessionRows = '';
    for (const s of sessions)
      sessionRows += `<tr><td>${s.id}</td><td>${fmtDur(s.end - s.start)}</td><td>${s.snapCount}</td><td>${s.wordCount.toLocaleString()}</td></tr>`;

    let timeline = '<div class="tl">'; let prevSid = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i], sid = snapIds[i], color = COLORS[i % COLORS.length];
      if (sid !== prevSid) {
        if (prevSid !== 0) timeline += `<div class="tl-gap">↓ ${fmtDur(snap.timestamp - snapshots[i-1].timestamp)} gap · Session ${sid} begins</div>`;
        prevSid = sid;
      }
      const kvTag = snap.keyVersion ? ` · ${snap.keyVersion}` : '';
      timeline += `<div class="tl-row" style="border-left-color:${color.line}"><span class="tl-num">Snap #${i+1} · Session ${sid}${kvTag}</span><span class="tl-words">${snap.wordCount.toLocaleString()} words</span></div>`;
    }
    timeline += '</div>';

    let psnapHtml = '';
    if (progressSnapshots.length > 0) {
      psnapHtml = '<h2>Progress Snapshots</h2>';
      progressSnapshots.forEach((ps, i) => {
        psnapHtml += `<p class="psnap-meta">Snapshot ${i+1}/${progressSnapshots.length} · Saved at ${fmtElapsed(ps.elapsed)} writing time · ${countWords(ps.text).toLocaleString()} words</p><div class="psnap-block">${escHtml(ps.text)}</div>`;
      });
    }

    let nsnapHtml = '';
    const spacesWithSnaps = noteSpaceState.filter(sp => sp.exists && sp.snapshots.length > 0);
    if (spacesWithSnaps.length > 0) {
      nsnapHtml = '<h2>Note Snapshots</h2>';
      spacesWithSnaps.forEach(sp => {
        if (spacesWithSnaps.length > 1) nsnapHtml += `<h3>Space ${sp.slot}</h3>`;
        sp.snapshots.forEach((ns, i) => {
          nsnapHtml += `<p class="nsnap-meta">Snapshot ${i+1}/${sp.snapshots.length} · ${fmtElapsed(ns.elapsed)} writing time · ${countWords(ns.text).toLocaleString()} words</p><div class="nsnap-block">${escHtml(ns.text)}</div>`;
        });
      });
    }

    let unverifiedHtml = '';
    if (unsignedSnapshots.length > 0) {
      const reasonLabels = {
        network_error:   'Network unreachable',
        worker_rejected: 'Rejected by signing service',
        timeout:         'Request timed out',
        queue_lost:      'Queue lost on reload',
      };
      unverifiedHtml = `<h2>Unverified Snapshots</h2>
<p class="unverified-note">The following snapshots could not be verified by the signing service at the time they were taken, typically due to a network interruption. They are stored separately from the verified chain and do not affect its integrity. Their authenticity should be assessed on the basis of content plausibility in the context of the surrounding verified record.</p>`;
      unsignedSnapshots.forEach((u, i) => {
        const label = reasonLabels[u.reason] || u.reason;
        unverifiedHtml += `<div class="unverified-snap"><p class="unverified-meta">Unverified snapshot ${i+1} · ${fmtDateTime(u.timestamp)} · ${u.wordCount.toLocaleString()} words · Reason: ${escHtml(label)}</p><div class="unverified-block">${escHtml(u.content)}</div></div>`;
      });
    }

    reportHtml = `<div class="rs">
  ${blockEventHtml}
  <h1>Writing Report</h1>
  <p class="sub">${escHtml(title)}${authorLine} · Generated ${fmtDateTime(Date.now())}${kvLine}</p>
  <div class="stats">
    <div class="stat"><div class="stat-l">Sessions</div><div class="stat-v">${sessions.length}</div></div>
    <div class="stat"><div class="stat-l">Snapshots</div><div class="stat-v">${snapshots.length}</div></div>
    <div class="stat"><div class="stat-l">Signed</div><div class="stat-v">${signedCount}/${snapshots.length}</div></div>
    <div class="stat"><div class="stat-l">Writing time</div><div class="stat-v">${fmtDur(totalWriting)}</div></div>
    <div class="stat"><div class="stat-l">Final words</div><div class="stat-v">${finalWords.toLocaleString()}</div></div>
  </div>
  <h2>Sessions</h2>
  <table class="rtable"><thead><tr><th>#</th><th>Duration</th><th>Snapshots</th><th>Words</th></tr></thead><tbody>${sessionRows}</tbody></table>
  ${psnapHtml}${nsnapHtml}
  <h2>Snapshot Timeline</h2>${timeline}
  ${unverifiedHtml}
  <h2>Color Legend</h2>${legend}
  <h2>Document with Writing History</h2>
  <p class="cdoc-note">Raw markdown source. Each color shows text added within one snapshot interval (randomised 1.5–3 min per session). Colors cycle after 6 intervals. Uncolored text has not yet been snapshotted.</p>
  ${colored}
</div>`;
  } else {
    reportHtml = `<div class="rs">
  ${blockEventHtml}
  <h1>Writing Report</h1>
  <p class="sub">${escHtml(title)}${authorLine} · Generated ${fmtDateTime(Date.now())}${kvLine}</p>
  <p style="color:#72695E;font-style:italic;margin:0 0 2em">No snapshots recorded yet.</p>
  <h2>Document with Writing History</h2>
  <p class="cdoc-note">No snapshots taken — all text shown uncolored.</p>
  ${legend}${colored}
</div>`;
  }

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

async function exportBackup() {
  const title = document.getElementById('title-input').value || 'Untitled';
  const blob = new Blob([await serializeToJson()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = safeFilename(title) + ' — Editor.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Session file saved — ' + snapshots.length + ' snapshot' + (snapshots.length !== 1 ? 's' : ''));
}

function importBackup() { document.getElementById('backup-file-input').click(); }

async function handleBackupFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const raw = e.target.result;
    let data;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.v === 4) { data = await deserializeFromJson(raw); }
      else { showToast('Not a valid session file'); return; }
    } catch (_) { showToast('Could not read file — invalid JSON'); return; }

    const vCheck = checkVerifierForLoad(data.vid);
    if (!vCheck.ok) {
      showVerifierError(
        '<strong>Session mismatch.</strong> This file belongs to a different session than your current cache.<br>' +
        'To load it safely: (1) Save your current session via <em>File → Save Session File</em>, ' +
        '(2) <em>File → Clear &amp; Reset</em>, then (3) restore this file again.'
      );
      return;
    }
    if (vCheck.ok === 'warn') {
      if (!confirm('This file has no session ID (older format). Load it anyway?')) return;
    }

    const { tampered, unsigned } = await verifyAllSnapshots(data.snapshots);
    if (tampered > 0 && !confirm(`⚠ Integrity check failed\n\n${tampered} of ${data.snapshots.length} snapshot${data.snapshots.length !== 1 ? 's' : ''} appear modified.\n\nLoad anyway?`)) return;

    const hasExisting = snapshots.length > 0;
    let mode = 'replace';
    if (hasExisting) {
      const localWC  = snapshots.length ? snapshots[snapshots.length - 1].wordCount : 0;
      const fileWC   = data.snapshots.length ? data.snapshots[data.snapshots.length - 1].wordCount : 0;
      const diffPct  = wordCountDiffPct(localWC, fileWC);

      const wantMerge = confirm(`Backup: ${data.snapshots.length} snapshot${data.snapshots.length !== 1 ? 's' : ''} from "${data.title || 'Untitled'}".\n\nOK → Merge   Cancel → Replace`);
      if (wantMerge) {
        if (diffPct > 0.05) {
          alert(`⚠ Merge denied: word counts differ by ${Math.round(diffPct * 100)}% (local: ${localWC}, file: ${fileWC}).\n\nThe documents have diverged too much to merge safely. Use Replace instead.`);
          return;
        }
        if (diffPct > 0) showToast(`Note: word counts differ by ${Math.round(diffPct * 100)}% — merging`);
        mode = 'merge';
      }
    }

    const editor = document.getElementById('editor'), titleInput = document.getElementById('title-input');
    if (mode === 'replace') {
      snapshots = data.snapshots;
      if (Array.isArray(data.unsignedSnapshots)) { unsignedSnapshots = data.unsignedSnapshots; persistUnsignedSnapshots(); }
      editor.value = data.content || (snapshots.length ? snapshots[snapshots.length-1].content : '');
      if (data.title) { titleInput.value = data.title; document.title = data.title + ' — Editor'; }
      if (Array.isArray(data.progressSnapshots)) { progressSnapshots = data.progressSnapshots.slice(0, MAX_PROGRESS_SNAPS); updateProgressButton(); }
      if (Array.isArray(data.spaces)) {
        noteSpaceState = data.spaces.map(sp => ({ ...sp, snapshots: [...(sp.snapshots || [])] }));
        while (noteSpaceState.length < 3) noteSpaceState.push({ slot: noteSpaceState.length + 1, exists: false, open: false, content: '', snapshots: [] });
        persistNoteSpaceState();
        renderNotesUI();
      }
    } else {
      const merged = [...snapshots, ...data.snapshots].sort((a,b) => a.timestamp - b.timestamp);
      snapshots = merged.filter((s, i) => i === 0 || s.timestamp !== merged[i-1].timestamp);
    }

    if (snapshots.length) lastSnapContent = snapshots[snapshots.length-1].content;
    saveContent(editor.value); saveTitle(titleInput.value); saveSnapshots();
    saveProgressSnapshots();
    updateStatusBar(); updateProgressButton(); scheduleNextSnapshot();
    let msg = (mode === 'replace' ? 'Restored' : 'Merged') + ' — ' + snapshots.length + ' snapshot' + (snapshots.length !== 1 ? 's' : '') + ' total';
    if (unsigned > 0 && tampered === 0) msg += ` (${unsigned} legacy unsigned)`;
    showToast(msg);
  };
  reader.readAsText(file);
}

function setView(v) {
  currentView = v;
  const ep = document.getElementById('editor-pane'), pp = document.getElementById('preview-pane');
  const bw = document.getElementById('btn-write'), bp = document.getElementById('btn-preview');
  if (v === 'write') {
    ep.classList.remove('hidden'); pp.classList.add('hidden');
    bw.classList.add('active'); bp.classList.remove('active');
    document.getElementById('editor').focus();
  } else {
    ep.classList.add('hidden'); pp.classList.remove('hidden');
    bw.classList.remove('active'); bp.classList.add('active');
    document.getElementById('preview-content').innerHTML = renderMd(document.getElementById('editor').value);
  }
}

function updateStatusBar() {
  const words = countWords(document.getElementById('editor').value);
  document.getElementById('status-session').textContent = `Session ${currentSessionId()}`;
  document.getElementById('status-words').textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;

  const wtEl = document.getElementById('status-writing-time');
  if (wtEl) { const wt = computeTotalWritingTime(); wtEl.textContent = wt > 0 ? fmtDur(wt) + ' writing' : ''; }

  const saveEl = document.getElementById('status-save');
  if (saveEl) saveEl.textContent = lastSaveTime ? 'Saved ' + fmtAgo(lastSaveTime) : '';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function blinkSnap() {
  const dot = document.getElementById('status-snap-blink');
  dot.classList.add('active'); setTimeout(() => dot.classList.remove('active'), 1800);
}

function onInput() {
  trackWritingSession();
  const text = document.getElementById('editor').value;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { saveContent(text); lastSaveTime = new Date(); updateStatusBar(); }, DEBOUNCE_MS);
  updateStatusBar();
  if (currentView === 'preview') document.getElementById('preview-content').innerHTML = renderMd(text);
}

function init() {
  marked.setOptions({ gfm: true, breaks: false });

  const editor      = document.getElementById('editor');
  const titleInput  = document.getElementById('title-input');
  const authorInput = document.getElementById('author-input');

  const savedSpaceState = storageGet(K.SPACE_STATE);
  if (savedSpaceState) {
    try {
      const parsed = JSON.parse(savedSpaceState);
      noteSpaceState = [1, 2, 3].map((slot, i) => {
        const saved = parsed[i] || { exists: false, open: false };
        let content = '';
        const cr = storageGet(noteContentKey(slot));
        if (cr) { try { content = LZString.decompressFromUTF16(cr) || cr; } catch(_) { content = cr; } }
        let snaps = [];
        const sr = storageGet(noteSnapsKey(slot));
        if (sr) { try { const p = JSON.parse(sr); if (Array.isArray(p)) snaps = p.slice(0, MAX_NOTE_SNAPS); } catch(_) {} }
        return { slot, exists: !!saved.exists, open: !!saved.open, content, snapshots: snaps };
      });
    } catch(_) {
      noteSpaceState[0].exists = true; noteSpaceState[0].open = true;
    }
  } else {
    noteSpaceState[0].exists = true; noteSpaceState[0].open = true;
  }

  const savedProgress = storageGet(K.PROGRESS_SNAPS);
  if (savedProgress) {
    try { const p = JSON.parse(savedProgress); if (Array.isArray(p)) progressSnapshots = p.slice(0, MAX_PROGRESS_SNAPS); } catch(_) {}
  }

  const savedUnsigned = storageGet(K.UNSIGNED_SNAPS);
  if (savedUnsigned) {
    try { const p = JSON.parse(savedUnsigned); if (Array.isArray(p)) unsignedSnapshots = p; } catch(_) {}
  }

  const savedFailCount = parseInt(storageGet(K.FAIL_COUNT));
  const savedFirstFail = parseInt(storageGet(K.FIRST_FAIL_TIME));
  if (!isNaN(savedFailCount) && savedFailCount > 0) {
    consecutiveFailures = savedFailCount;
    firstFailureTime    = isNaN(savedFirstFail) ? Date.now() : savedFirstFail;
  }

  const savedKV = storageGet(K.KEY_VERSION);
  if (savedKV) workerKeyVersion = savedKV;

  sessionVerifier = storageGet(K.VERIFIER);

  const savedContent   = loadContent();
  const savedTitle     = loadTitle();
  const savedAuthor    = loadAuthor();
  const savedSnapshots = loadSnapshots();

  if (savedContent)   editor.value      = savedContent;
  if (savedTitle)     titleInput.value  = savedTitle;
  if (savedAuthor)    authorInput.value = savedAuthor;

  const sf = parseInt(storageGet(K.FONT_SIZE));
  if (!isNaN(sf) && sf >= 12 && sf <= 26) fontSize = sf;
  applyFontSize();

  const sp = parseFloat(storageGet(K.SPLIT_PCT));
  if (!isNaN(sp) && sp >= 25 && sp <= 75) splitNotesWidthPct = sp;

  if (savedSnapshots.length) {
    snapshots = savedSnapshots;
    lastSnapContent = savedSnapshots[savedSnapshots.length-1].content;
    const banner = document.getElementById('restored-banner');
    banner.textContent = `Restored — ${snapshots.length} snapshot${snapshots.length !== 1 ? 's' : ''} from previous session`;
    banner.classList.remove('hidden');
    setTimeout(() => { banner.style.opacity = '0'; setTimeout(() => banner.classList.add('hidden'), 600); }, 4000);
    verifyAllSnapshots(snapshots).then(({ tampered }) => { if (tampered > 0) showToast(`⚠ ${tampered} snapshot${tampered !== 1 ? 's' : ''} failed integrity check`); });
  }

  lastSaveTime = savedContent ? new Date() : null;
  if (savedTitle) document.title = savedTitle + ' — Editor';

  updateStatusBar(); updateProgressButton();
  renderNotesUI();
  scheduleNextSnapshot();

  setInterval(() => {
    const saveEl = document.getElementById('status-save');
    if (saveEl && lastSaveTime) saveEl.textContent = 'Saved ' + fmtAgo(lastSaveTime);
    const wtEl = document.getElementById('status-writing-time');
    if (wtEl) { const wt = computeTotalWritingTime(); wtEl.textContent = wt > 0 ? fmtDur(wt) + ' writing' : ''; }
  }, 1000);

  checkWorkerHealth();
  window.addEventListener('online', checkWorkerHealth);
  setInterval(checkWorkerHealth, 5 * 60 * 1000);

  initSplitResize();

  editor.addEventListener('paste', e => { e.preventDefault(); showToast('Pasting is disabled in Editor'); });
  editor.addEventListener('dragstart', () => { _internalDrag = true; });
  editor.addEventListener('dragend', () => { _internalDrag = false; });
  editor.addEventListener('drop', e => { if (!_internalDrag) { e.preventDefault(); showToast('External drop is disabled in Editor'); } });

  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart, en = editor.selectionEnd; editor.value = editor.value.slice(0, s) + '\t' + editor.value.slice(en); editor.selectionStart = editor.selectionEnd = s + 1; onInput(); }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSaveSnapshot(false); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') { e.preventDefault(); insertFootnote(); }
    if (e.key === 'Escape') { document.getElementById('export-menu').classList.add('hidden'); document.getElementById('help-overlay').classList.add('hidden'); closeNoteSpaceMenu(); }
  });

  editor.addEventListener('input', onInput);
  editor.addEventListener('blur', () => { saveContent(editor.value); lastSaveTime = new Date(); updateStatusBar(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveContent(editor.value); lastSaveTime = new Date();
      const text = editor.value;
      if (text.trim() && text !== lastSnapContent) takeSnapshot(text, true);
    }
  });

  window.addEventListener('beforeunload', () => {
    const text = editor.value;
    storageSet(K.CONTENT, LZString.compressToUTF16(text));
    if (text.trim() && text !== lastSnapContent) {
      snapshots.push({ timestamp: Date.now(), content: text, wordCount: countWords(text), sig: null, signed: false, keyVersion: null });
      try { storageSet(K.SNAPSHOTS, LZString.compressToUTF16(JSON.stringify(snapshots))); } catch(_) {}
    }
  });

  titleInput.addEventListener('input', () => { saveTitle(titleInput.value); document.title = (titleInput.value || 'Untitled') + ' — Editor'; });
  authorInput.addEventListener('input', () => saveAuthor(authorInput.value));

  document.getElementById('btn-write').addEventListener('click', () => setView('write'));
  document.getElementById('btn-preview').addEventListener('click', () => setView('preview'));
  document.getElementById('btn-notes').addEventListener('click', toggleNotes);

  document.getElementById('btn-sz-down').addEventListener('click', () => { fontSize = Math.max(12, fontSize - 1); applyFontSize(); showToast(`Font size ${fontSize}px`); });
  document.getElementById('btn-sz-up').addEventListener('click', () => { fontSize = Math.min(26, fontSize + 1); applyFontSize(); showToast(`Font size ${fontSize}px`); });

  document.getElementById('btn-fn').addEventListener('click', insertFootnote);
  document.getElementById('btn-progress-snap').addEventListener('click', takeProgressSnapshot);

  document.getElementById('btn-help').addEventListener('click', () => document.getElementById('help-overlay').classList.remove('hidden'));
  document.getElementById('help-close').addEventListener('click', () => document.getElementById('help-overlay').classList.add('hidden'));
  document.getElementById('help-overlay').addEventListener('click', e => { if (e.target === document.getElementById('help-overlay')) document.getElementById('help-overlay').classList.add('hidden'); });

  const exportToggle = document.getElementById('btn-export-toggle'), exportMenu = document.getElementById('export-menu');
  exportToggle.addEventListener('click', e => { e.stopPropagation(); exportMenu.classList.toggle('hidden'); });
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));

  document.getElementById('btn-save-cloud').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    saveToCloud();
  });

  document.getElementById('btn-export-backup').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    exportBackup();
  });

  document.getElementById('btn-restore-file').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    importBackup();
  });

  document.getElementById('btn-restore-cloud').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    const vid = prompt('Enter your 10-digit session ID:');
    if (vid) restoreFromCloud(vid);
  });

  document.getElementById('btn-export-combined').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    gatedExport(exportCombined);
  });
  document.getElementById('backup-file-input').addEventListener('change', e => { handleBackupFile(e.target.files[0]); e.target.value = ''; });

  document.getElementById('btn-clear').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    if (confirm('Permanently delete all content, snapshots, and note spaces?\n\nThis cannot be undone.')) {
      [K.CONTENT, K.TITLE, K.AUTHOR, K.SNAPSHOTS, K.PROGRESS_SNAPS,
       K.NOTES_1, K.NOTES_2, K.NOTES_3,
       K.NSNAPS_1, K.NSNAPS_2, K.NSNAPS_3,
       K.SPACE_STATE, K.VERIFIER,
       K.UNSIGNED_SNAPS, K.FAIL_COUNT, K.FIRST_FAIL_TIME, K.BLOCK_EVENT,
       K.VID_CLAIMED,
      ].forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });

      clearTimeout(snapshotTimerId);
      snapshots = []; lastSnapContent = ''; lastSaveTime = null;
      progressSnapshots = []; sessionVerifier = null;
      sessionCurrentStart = null; sessionCurrentEnd = null;
      unsignedSnapshots = []; autoSnapsSinceLastSign = 0;
      consecutiveFailures = 0; firstFailureTime = null;
      cloudSaveInProgress = false;
      hidePersistentWarning();

      noteSpaceState = [
        { slot: 1, exists: true,  open: true,  content: '', snapshots: [] },
        { slot: 2, exists: false, open: false, content: '', snapshots: [] },
        { slot: 3, exists: false, open: false, content: '', snapshots: [] },
      ];

      editor.value = ''; titleInput.value = ''; authorInput.value = '';
      editor.disabled = false;
      document.title = 'Editor';
      updateStatusBar(); updateProgressButton();
      renderNotesUI();
      showToast('Reset — fresh document'); scheduleNextSnapshot();
      checkWorkerHealth();
    }
  });

  editor.focus();
}

window.addEventListener('load', init);
