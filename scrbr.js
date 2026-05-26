'use strict';

const OPFS_FILENAME    = 'scrbr-session.json';
const GDRIVE_CLIENT_ID = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';
const GDRIVE_FILE_NAME = 'scrbr-session.json';

const SNAP_MIN_MS        = 1.5 * 60 * 1000;  // 90 s
const SNAP_MAX_MS        = 3   * 60 * 1000;  // 180 s
const SNAP_TOLERANCE     = 0.4;              
const MAX_WORDS_PER_MIN  = 60;               
const SESSION_GAP        = 15  * 60 * 1000;
const DEBOUNCE_MS        = 600;
const MAX_NOTE_SNAPS     = 5;
const MAX_PROGRESS_SNAPS = 5;
const MAX_NOTE_SPACES    = 3;
const MIN_SPACE_PCT      = 25;
const MAX_CHARS_PER_MIN  = 400;
const MIN_DELETION_RATIO = 0.05;
const MAX_DELETION_RATIO = 0.60;
const FETCH_TIMEOUT_MS   = 10_000;           

const WORKER_URL          = 'https://0476756423.zzcjmd2b7y.workers.dev';
const SIGN_TRIGGER_COUNT  = 4;
const FAILURE_WARN_COUNT  = 3;
const FAILURE_BLOCK_COUNT = 10;
const FAILURE_BLOCK_MS    = 15 * 60 * 1000;

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

let snapshots           = [];
let lastSnapContent     = '';
let lastSaveTime        = null;
let currentView         = 'write';
let notesVisible        = false;
let autosaveTimer       = null;
let toastTimer          = null;
let snapshotTimerId     = null;
let _hmacKey            = null;
let _internalDrag       = false;
let progressSnapshots   = [];
let fontSize            = 16;
let splitNotesWidthPct  = 33;
let isDraggingSplit     = false;
let sessionVerifier     = null;
let noteSpaceState = [
  { slot: 1, exists: true,  open: true,  content: '', snapshots: [] },
  { slot: 2, exists: false, open: false, content: '', snapshots: [] },
  { slot: 3, exists: false, open: false, content: '', snapshots: [] },
];

let unsignedSnapshots      = [];
let autoSnapsSinceLastSign = 0;
let consecutiveFailures    = 0;
let firstFailureTime       = null;
let workerKeyVersion       = null;
let signingInProgress      = false;
let cumulativeWritingMs    = 0;
let lastKeystrokeTime      = null;
let deletedCount           = 0;
let nextColorIndex         = 0;  

let gdriveAccessToken = null;
let gdriveFileId      = null;

async function opfsWrite(jsonString) {
  try {
    const root   = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_FILENAME, { create: true });
    const writer = await handle.createWritable();
    await writer.write(jsonString);
    await writer.close();
  } catch (err) {
    console.warn('OPFS write failed:', err);
  }
}

async function opfsRead() {
  try {
    const root   = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_FILENAME);
    const file   = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


function gdriveAuth(callback) {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GDRIVE_CLIENT_ID,
    scope:     'https://www.googleapis.com/auth/drive.file',
    callback:  (response) => {
      if (response.error) { showToast('Google sign-in failed'); return; }
      gdriveAccessToken = response.access_token;
      callback();
    },
  });
  client.requestAccessToken();
}

async function gdriveFindFile() {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_FILE_NAME}' and trashed=false&fields=files(id,name,modifiedTime)`,
    { headers: { Authorization: 'Bearer ' + gdriveAccessToken } }
  );
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function gdriveSave() {
  const json = await serializeToJson();
  if (!gdriveFileId) {
    const existing = await gdriveFindFile();
    if (existing) gdriveFileId = existing.id;
  }
  const metadata = { name: GDRIVE_FILE_NAME, mimeType: 'application/json' };
  const form     = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file',     new Blob([json],                     { type: 'application/json' }));
  const method = gdriveFileId ? 'PATCH' : 'POST';
  const url    = gdriveFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${gdriveFileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const res  = await fetch(url, { method, headers: { Authorization: 'Bearer ' + gdriveAccessToken }, body: form });
  const data = await res.json();
  if (data.id) gdriveFileId = data.id;
  return res.ok;
}

async function gdriveRestore() {
  const file = await gdriveFindFile();
  if (!file) { showToast('No scrbr session found in your Drive'); return; }
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
    { headers: { Authorization: 'Bearer ' + gdriveAccessToken } }
  );
  if (!res.ok) { showToast('Could not read Drive file'); return; }
  const raw = await res.text();
  let data;
  try { data = await deserializeFromJson(raw); }
  catch { showToast('Drive session data appears corrupt'); return; }
  await loadFromJsonData(data);
  opfsWrite(raw).catch(console.warn);
  showToast('Session restored from Google Drive — ' + data.snapshots.length + ' snapshots');
}

function triggerGdriveSave() {
  if (!gdriveAccessToken) {
    gdriveAuth(async () => {
      showToast('Saving to Google Drive…');
      const ok = await gdriveSave();
      showToast(ok ? 'Saved to Google Drive' : 'Drive save failed');
    });
  } else {
    gdriveSave().then(ok => showToast(ok ? 'Saved to Google Drive' : 'Drive save failed'));
  }
}

function triggerGdriveRestore() {
  if (!gdriveAccessToken) gdriveAuth(() => gdriveRestore());
  else gdriveRestore();
}

async function computeTextHash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return uint8ToBase64(new Uint8Array(buf));
}

async function computeCommitment(wordCount, charCount, dc, textHash, prevSig) {
  const raw = `${wordCount}|${charCount}|${dc}|${textHash}|${prevSig}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return uint8ToBase64(new Uint8Array(buf));
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
  if (snap.keyVersion) return 'worker-signed'; // cannot verify locally without network call
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
  return {
    results,
    tampered: results.filter(r => r === 'tampered').length,
    unsigned: results.filter(r => r === 'unsigned').length,
  };
}

async function computeStructuralChecksum(snaps) {
  const n = snaps.length, ft = n ? snaps[0].timestamp : 0, lt = n ? snaps[n-1].timestamp : 0,
        lw = n ? snaps[n-1].wordCount : 0, lg = n ? (snaps[n-1].sig || '') : '';
  const k = await getHmacKey(), buf = await crypto.subtle.sign(
    'HMAC', k, new TextEncoder().encode(`${n}|${ft}|${lt}|${lw}|${lg}`)
  );
  return uint8ToBase64(new Uint8Array(buf));
}

async function verifyStructuralChecksum(checksum, snaps) {
  if (!checksum) return 'unsigned';
  if (snaps.length && snaps.every(s => s.keyVersion)) return 'worker-signed';
  try {
    const n = snaps.length, ft = n ? snaps[0].timestamp : 0, lt = n ? snaps[n-1].timestamp : 0,
          lw = n ? snaps[n-1].wordCount : 0, lg = n ? (snaps[n-1].sig || '') : '';
    const k = await getHmacKey();
    return await crypto.subtle.verify(
      'HMAC', k, base64ToUint8(checksum), new TextEncoder().encode(`${n}|${ft}|${lt}|${lw}|${lg}`)
    ) ? 'ok' : 'tampered';
  } catch (_) { return 'tampered'; }
}

function generateVerifier() {
  return String(Math.floor(Math.random() * 9000000000) + 1000000000);
}

function getVerifier() {
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

function recoverNextColorIndex() {
  nextColorIndex = snapshots.reduce((max, s) =>
    typeof s.colorIndex === 'number' ? Math.max(max, s.colorIndex + 1) : max, 0);
}

async function serializeToJson() {
  const title   = document.getElementById('title-input').value;
  const author  = document.getElementById('author-input').value;
  const content = document.getElementById('editor').value;
  const vid     = getVerifier(); 

  const obfSnaps = [];
  let prev = '';
  for (const s of snapshots) {
    const seed = await chainedSeed(s.timestamp, prev);
    obfSnaps.push({
      ts:     s.timestamp,
      wt:     s.writingTime  || 0,
      w:      s.wordCount,
      cc:     s.charCount    || 0,
      dc:     s.deletedCount || 0,
      cm:     s.commitment   || null,
      d:      obfuscateText(s.content, seed),
      g:      s.sig          || null,
      kv:     s.keyVersion   || null,
      signed: s.signed       || false,
      ci:     typeof s.colorIndex === 'number' ? s.colorIndex : null,  // Bug 15
    });
    prev = s.content;
  }

  const obfProgressSnaps = progressSnapshots.map(ps => ({
    ts: ps.takenAt, e: ps.elapsed,
    d: obfuscateText(ps.text, PROGRESS_SNAP_SEED), pt: ps.text,
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
  if (!data || data.v !== 4) throw new Error('not scrbr v4');

  const title   = deobfuscateText(data.t || '', TITLE_SEED);
  const author  = data.a || '';
  const content = deobfuscateText(data.c || '', CONTENT_SEED);

  const snaps = [];
  let prev = '';
  for (const s of data.s || []) {
    const seed = await chainedSeed(s.ts, prev);
    const c    = deobfuscateText(s.d || '', seed);
    snaps.push({
      timestamp:    s.ts,
      writingTime:  s.wt  || 0,
      wordCount:    s.w,
      charCount:    s.cc  || 0,
      deletedCount: s.dc  || 0,
      commitment:   s.cm  || null,
      content:      c,
      sig:          s.g   || null,
      keyVersion:   s.kv  || null,
      signed:       s.signed || (s.g ? true : false),
      colorIndex:   typeof s.ci === 'number' ? s.ci : null,  // Bug 15
    });
    prev = c;
  }

  let maxCi = -1;
  snaps.forEach((s, i) => {
    if (typeof s.colorIndex !== 'number') s.colorIndex = i;
    if (s.colorIndex > maxCi) maxCi = s.colorIndex;
  });

  const progSnaps = (data.ps || []).map(ps => ({
    takenAt: ps.ts, elapsed: ps.e,
    text: deobfuscateText(ps.d || '', PROGRESS_SNAP_SEED) || ps.pt || '',
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
    reason: u.reason, takenAt: u.ts,
  }));

  return {
    title, author, content, vid: data.vid || null,
    keyVersion: data.keyVersion || null,
    blockEvent: data.blockEvent || null,
    snapshots: snaps, progressSnapshots: progSnaps,
    spaces, unsignedSnapshots: unsnaps,
    _checksum:       data.x || null,
    _nextColorIndex: maxCi + 1,  
  };
}

function storageSet(key, value) { try { localStorage.setItem(key, value); return true; } catch (_) { return false; } }
function storageGet(key)        { try { return localStorage.getItem(key); } catch (_) { return null; } }

function saveContent(text) {
  if (text.trim()) getVerifier();  // Bug 11
  try { localStorage.setItem(K.CONTENT, LZString.compressToUTF16(text)); } catch(_) {}
}
function loadContent() {
  const r = storageGet(K.CONTENT);
  if (!r) return '';
  try { const d = LZString.decompressFromUTF16(r); if (d != null) return d; } catch(_) {}
  return r;
}
function saveSnapshots() {
  try { storageSet(K.SNAPSHOTS, LZString.compressToUTF16(JSON.stringify(snapshots))); } catch(_) {}
}
function loadSnapshots() {
  const r = storageGet(K.SNAPSHOTS);
  if (!r) return [];
  try { const p = JSON.parse(LZString.decompressFromUTF16(r)); return Array.isArray(p) ? p : []; } catch(_) { return []; }
}
function saveTitle(t)  { storageSet(K.TITLE, t); }
function loadTitle()   { return storageGet(K.TITLE) || ''; }
function saveAuthor(a) { storageSet(K.AUTHOR, a); }
function loadAuthor()  { return storageGet(K.AUTHOR) || ''; }

function persistUnsignedSnapshots() {
  try { storageSet(K.UNSIGNED_SNAPS, JSON.stringify(unsignedSnapshots)); } catch(_) {}
}
function persistNoteSpaceState() {
  storageSet(K.SPACE_STATE, JSON.stringify(noteSpaceState.map(s => ({ exists: s.exists, open: s.open }))));
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

async function loadFromJsonData(data) {
  const editor      = document.getElementById('editor');
  const titleInput  = document.getElementById('title-input');
  const authorInput = document.getElementById('author-input');

  editor.value = data.content; titleInput.value = data.title;
  if (data.author) authorInput.value = data.author;
  document.title = (data.title || 'Untitled') + ' — scrbr';

  snapshots = data.snapshots;
  if (snapshots.length) {
    lastSnapContent     = snapshots[snapshots.length - 1].content;
    cumulativeWritingMs = snapshots[snapshots.length - 1].writingTime || 0;
  }
  nextColorIndex = data._nextColorIndex || 0;  // Bug 15
  lastSaveTime   = new Date();

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
    while (noteSpaceState.length < 3)
      noteSpaceState.push({ slot: noteSpaceState.length + 1, exists: false, open: false, content: '', snapshots: [] });
    persistNoteSpaceState();
    noteSpaceState.forEach(sp => {
      if (sp.exists) {
        try { storageSet(noteContentKey(sp.slot), LZString.compressToUTF16(sp.content)); } catch(_) {}
        try { storageSet(noteSnapsKey(sp.slot), JSON.stringify(sp.snapshots)); } catch(_) {}
      }
    });
  }

  if (data.vid) { sessionVerifier = data.vid; storageSet(K.VERIFIER, sessionVerifier); }

  saveTitle(titleInput.value);
  if (data.author) saveAuthor(data.author);
  opfsWrite(await serializeToJson()).catch(console.warn);

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
    const res = await fetchWithTimeout(WORKER_URL + '/health', { method: 'GET' });  // Bug 14
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

function checkClientPlausibility(snaps) {
  for (let i = 1; i < snaps.length; i++) {
    const gap = snaps[i].writingTime - snaps[i - 1].writingTime;
    if (gap <= 0)
      throw new Error(`Snapshot ${i}: writing time does not advance`);
    const charDelta = snaps[i].charCount - snaps[i - 1].charCount;
    const minutes   = gap / 60_000;
    if (minutes > 0 && charDelta > MAX_CHARS_PER_MIN * minutes)
      throw new Error(`Snapshot ${i}: implausible typing speed (${charDelta} chars in ${Math.round(minutes * 60)}s)`);
  }
  if (snaps.length < 2) return;
  const last          = snaps[snaps.length - 1];
  const first         = snaps[0];
  const totalDeleted  = last.deletedCount - first.deletedCount;
  const totalInserted = totalDeleted + (last.charCount - first.charCount);
  if (totalInserted > 500) {
    const ratio = totalDeleted / totalInserted;
    if (ratio < MIN_DELETION_RATIO)
      throw new Error(`Deletion ratio ${(ratio * 100).toFixed(1)}% is implausibly low`);
    if (ratio > MAX_DELETION_RATIO)
      throw new Error(`Deletion ratio ${(ratio * 100).toFixed(1)}% is implausibly high`);
  }
}

async function triggerBundleSigning(isExport = false) {
  if (signingInProgress) return;
  signingInProgress = true;

  try {
    const toSign = snapshots
      .map((s, i) => ({ ...s, _idx: i }))
      .filter(s => !s.signed);

    if (toSign.length === 0) return;

    const signable = [];
    for (const s of toSign) {
      if (!signable.length || s.writingTime > signable[signable.length - 1].writingTime) {
        signable.push(s);
      }
    }

    if (signable.length === 0) return;

    try {
      checkClientPlausibility(signable);
    } catch (err) {
      showToast('Plausibility check: ' + err.message);
      return;
    }

    const lastSignedIdx = snapshots.reduce((best, s, i) => (s.signed ? i : best), -1);
    const anchorSig     = lastSignedIdx >= 0 ? snapshots[lastSignedIdx].sig : 'genesis';

    const payload = {
      sessionId: getVerifier(),  
      anchorSig,
      snapshots: signable.map(s => ({
        index:       s._idx,
        writingTime: s.writingTime,
        commitment:  s.commitment,
        wordCount:   s.wordCount,   
      })),
    };

    let res;
    try {
      res = await fetchWithTimeout(WORKER_URL + '/sign', {  
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
    } catch {
      handleSigningFailure('network_error');
      await moveToUnsigned(signable, 'network_error');  
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      handleSigningFailure(err.error || 'worker_rejected');
      await moveToUnsigned(signable, 'worker_rejected');  
    } else {
      const data = await res.json();
      applySignatures(signable, data.signatures, data.keyVersion);
      autoSnapsSinceLastSign = 0;
      resetFailureState();
      opfsWrite(await serializeToJson()).catch(console.warn);
      persistUnsignedSnapshots();
      updateStatusBar();
    }
  } finally {
    signingInProgress = false; 
  }
}

function applySignatures(signable, signatures, keyVersion) {
  signable.forEach((s, i) => {
    snapshots[s._idx].sig        = signatures[i];
    snapshots[s._idx].signed     = true;
    snapshots[s._idx].keyVersion = keyVersion;
  });
}

async function moveToUnsigned(signable, reason) {
  const failedIndices = new Set(signable.map(s => s._idx));
  signable.forEach(s => {
    unsignedSnapshots.push({
      timestamp:  s.timestamp,
      wordCount:  s.wordCount,
      content:    s.content,
      reason,
      takenAt:    s.timestamp,
    });
  });
  snapshots = snapshots.filter((_, i) => !failedIndices.has(i));
  autoSnapsSinceLastSign = 0;   
  persistUnsignedSnapshots();
  opfsWrite(await serializeToJson()).catch(console.warn);  
}

function handleSigningFailure(reason) {
  consecutiveFailures++;
  if (firstFailureTime === null) {
    firstFailureTime = Date.now();
    storageSet(K.FIRST_FAIL_TIME, String(firstFailureTime));
  }
  storageSet(K.FAIL_COUNT, String(consecutiveFailures));
  const failureDuration = Date.now() - firstFailureTime;
  if (consecutiveFailures >= FAILURE_BLOCK_COUNT && failureDuration >= FAILURE_BLOCK_MS) {
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
    'Editing suspended. The signing service has been unreachable for an extended period. ' +
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
  await exportFn();
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
    if (!map.has(sid)) {
      map.set(sid, {
        id: sid,
        start:   snaps[i].timestamp,
        end:     snaps[i].timestamp,
        startWt: snaps[i].writingTime || 0,
        endWt:   snaps[i].writingTime || 0,
        snapCount: 1,
        wordCount: snaps[i].wordCount,
      });
    } else {
      const s = map.get(sid);
      s.end     = snaps[i].timestamp;
      s.endWt   = snaps[i].writingTime || 0;
      s.wordCount = snaps[i].wordCount;
      s.snapCount++;
    }
  }
  return [...map.values()];
}

function currentSessionId() {
  if (!snapshots.length) return 1;
  const ids = sessionIdsFor(snapshots), lastId = ids[ids.length-1];
  return Date.now() - snapshots[snapshots.length-1].timestamp > SESSION_GAP ? lastId + 1 : lastId;
}

function getCurrentSessionInterval() {
  if (!snapshots.length) return Math.round((SNAP_MIN_MS + SNAP_MAX_MS) / 2);
  const ids = sessionIdsFor(snapshots), sid = ids[ids.length-1];
  if (Date.now() - snapshots[snapshots.length-1].timestamp > SESSION_GAP)
    return Math.round((SNAP_MIN_MS + SNAP_MAX_MS) / 2);
  return deriveInterval(snapshots[ids.findIndex(id => id === sid)].timestamp);
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
function countWords(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

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

function updateProgressButton() {
  const btn = document.getElementById('btn-progress-snap');
  const countEl = document.getElementById('progress-snap-count');
  if (!btn) return;
  const n = progressSnapshots.length;
  if (countEl) countEl.textContent = `(${n}/${MAX_PROGRESS_SNAPS})`;
  btn.classList.remove('full', 'taken');
  if (n >= MAX_PROGRESS_SNAPS)  { btn.classList.add('full');  btn.title = `Maximum manual snapshots reached (${n}/${MAX_PROGRESS_SNAPS})`; }
  else if (n > 0)               { btn.classList.add('taken'); btn.title = `${n} manual snapshot${n !== 1 ? 's' : ''} saved — click to add another`; }
  else                          { btn.title = `Save a manual snapshot (max ${MAX_PROGRESS_SNAPS})`; }
}
function saveProgressSnapshots() {
  try { storageSet(K.PROGRESS_SNAPS, JSON.stringify(progressSnapshots)); } catch(_) {}
}

function takeProgressSnapshot() {
  const text = document.getElementById('editor').value;
  if (!text.trim()) { showToast('Nothing to snapshot yet'); return; }
  if (progressSnapshots.length >= MAX_PROGRESS_SNAPS) { showToast(`Maximum manual snapshots reached (${MAX_PROGRESS_SNAPS}/${MAX_PROGRESS_SNAPS})`); return; }
  const elapsed = cumulativeWritingMs;  // Bug 6/7
  progressSnapshots.push({ text, elapsed, takenAt: Date.now() });
  saveProgressSnapshots();
  showToast(`Manual snapshot ${progressSnapshots.length}/${MAX_PROGRESS_SNAPS} — ${fmtElapsed(elapsed)} writing time`);
  updateProgressButton();
}

function applyFontSize() {
  const e = document.getElementById('editor');
  if (e) e.style.fontSize = fontSize + 'px';
  document.querySelectorAll('.note-space-editor').forEach(el => { el.style.fontSize = fontSize + 'px'; });
  try { localStorage.setItem(K.FONT_SIZE, fontSize); } catch(_) {}
}

function updateNoteSpaceSnapBtn(slot) {
  const sp = noteSpaceState[slot - 1];
  if (!sp) return;
  const btn = document.querySelector(`.note-snap-btn[data-slot="${slot}"]`);
  if (!btn) return;
  const n = sp.snapshots.length;
  btn.textContent = `Snap ${n}/${MAX_NOTE_SNAPS}`;
  btn.classList.remove('full', 'taken');
  if (n >= MAX_NOTE_SNAPS)      { btn.classList.add('full');  btn.title = `Maximum note snapshots reached (${n}/${MAX_NOTE_SNAPS})`; }
  else if (n > 0)               { btn.classList.add('taken'); btn.title = `${n} note snapshot${n !== 1 ? 's' : ''} saved — click to add another`; }
  else                          { btn.title = `Save a note snapshot (max ${MAX_NOTE_SNAPS})`; }
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
  const elapsed = cumulativeWritingMs;  // Bug 6/7
  sp.snapshots.push({ text: sp.content, elapsed, takenAt: Date.now() });
  saveNoteSpaceSnaps(slot);
  updateNoteSpaceSnapBtn(slot);
  showToast(`Space ${slot} · Snapshot ${sp.snapshots.length}/${MAX_NOTE_SNAPS} — ${fmtElapsed(elapsed)} writing time`);
}

function addNoteSpace() {
  const slot = noteSpaceState.find(s => !s.exists);
  if (!slot) { showToast('Maximum 3 note spaces'); return; }
  slot.exists = true; slot.open = true; slot.content = ''; slot.snapshots = [];
  persistNoteSpaceState(); renderNotesUI(); showToast(`Space ${slot.slot} created`);
}
function openNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp || !sp.exists) return;
  sp.open = true; persistNoteSpaceState(); renderNotesUI(); showToast(`Space ${slotNum} reopened`);
}
function closeNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp) return;
  sp.open = false; persistNoteSpaceState(); renderNotesUI();
}
function clearNoteSpace(slotNum) {
  const sp = noteSpaceState[slotNum - 1];
  if (!sp) return;
  if (!confirm(`Permanently clear Space ${slotNum} and all its snapshots?\n\nThis cannot be undone.`)) return;
  sp.exists = false; sp.open = false; sp.content = ''; sp.snapshots = [];
  try { localStorage.removeItem(noteContentKey(slotNum)); } catch(_) {}
  try { localStorage.removeItem(noteSnapsKey(slotNum)); } catch(_) {}
  persistNoteSpaceState(); renderNotesUI(); showToast(`Space ${slotNum} cleared`);
}

function showNoteSpaceMenu(btn) {
  closeNoteSpaceMenu();
  const menu = document.getElementById('note-space-menu');
  menu.innerHTML = '';
  const closedSpaces  = noteSpaceState.filter(s => s.exists && !s.open);
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
  menu.style.top   = (rect.bottom + 3) + 'px';
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
  const m = document.getElementById('note-space-menu');
  m.classList.add('hidden'); m.innerHTML = '';
}

function renderNotesUI() {
  const tabbar    = document.getElementById('notes-tabbar');
  const spacesRow = document.getElementById('notes-spaces-row');
  if (!tabbar || !spacesRow) return;
  tabbar.innerHTML = ''; spacesRow.innerHTML = '';

  const openSpaces  = noteSpaceState.filter(s => s.exists && s.open);
  const closedCount = noteSpaceState.filter(s => s.exists && !s.open).length;
  const totalExist  = noteSpaceState.filter(s => s.exists).length;
  const canAdd      = closedCount > 0 || totalExist < MAX_NOTE_SPACES;
  tabbar.classList.toggle('has-add', canAdd);

  openSpaces.forEach(sp => {
    const tab = document.createElement('div');
    tab.className = 'note-tab'; tab.dataset.slot = sp.slot;

    const label = document.createElement('span'); label.className = 'note-tab-label'; label.textContent = `Note Space ${sp.slot}`;
    const wc    = document.createElement('span'); wc.className = 'note-tab-wc'; wc.dataset.slot = sp.slot; wc.textContent = countWords(sp.content) + ' w';

    const snapBtn = document.createElement('button');
    snapBtn.className = 'btn note-snap-btn'; snapBtn.dataset.slot = sp.slot;
    const n = sp.snapshots.length;
    snapBtn.textContent = `Snap ${n}/${MAX_NOTE_SNAPS}`;
    if (n >= MAX_NOTE_SNAPS)  { snapBtn.classList.add('full');  snapBtn.title = `Max snapshots reached (${n}/${MAX_NOTE_SNAPS})`; }
    else if (n > 0)           { snapBtn.classList.add('taken'); snapBtn.title = `${n} snapshot${n !== 1 ? 's' : ''} — add another`; }
    else                      { snapBtn.title = `Save note snapshot (max ${MAX_NOTE_SNAPS})`; }
    snapBtn.addEventListener('click', () => takeNoteSpaceSnapshot(sp.slot));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'note-tab-btn'; closeBtn.textContent = '–';
    closeBtn.title = `Hide Space ${sp.slot} (content preserved)`;
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeNoteSpace(sp.slot); });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'note-tab-btn clear-btn'; clearBtn.textContent = '×';
    clearBtn.title = `Clear Space ${sp.slot} permanently`;
    clearBtn.addEventListener('click', e => { e.stopPropagation(); clearNoteSpace(sp.slot); });

    tab.append(label, wc, snapBtn, closeBtn, clearBtn);
    tabbar.appendChild(tab);

    const spaceDiv = document.createElement('div');
    spaceDiv.className = 'note-space'; spaceDiv.dataset.slot = sp.slot;
    const ta = document.createElement('textarea');
    ta.className = 'note-space-editor'; ta.dataset.slot = sp.slot;
    ta.spellcheck = true; ta.placeholder = `Space ${sp.slot} notes…`; ta.value = sp.content;
    ta.style.fontSize = fontSize + 'px';

    ta.addEventListener('paste',    e => { e.preventDefault(); showToast('Pasting is disabled in Editor'); });
    ta.addEventListener('dragstart', () => { _internalDrag = true; });
    ta.addEventListener('dragend',   () => { _internalDrag = false; });
    ta.addEventListener('drop', e => { if (!_internalDrag) { e.preventDefault(); showToast('External drop is disabled'); } });
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); showToast('Pasting is disabled in Editor'); }
    });
    ta.addEventListener('input', () => {
      lastKeystrokeTime = Date.now();
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
    if (openSpaces.length > 0) tabbar.querySelector('.note-tab:last-child').appendChild(addBtn);
    else tabbar.appendChild(addBtn);
  }

  if (openSpaces.length === 0) {
    const ph = document.createElement('div'); ph.className = 'note-spaces-empty';
    ph.innerHTML = '<span>No note spaces open.</span>'; spacesRow.appendChild(ph);
  }
  if (notesVisible) enforceNotesPaneWidth();
}

function enforceNotesPaneWidth() {
  const openCount = noteSpaceState.filter(s => s.exists && s.open).length || 1;
  const minPct    = Math.min(openCount * MIN_SPACE_PCT, 75);
  if (splitNotesWidthPct < minPct) {
    splitNotesWidthPct = minPct;
    const p = document.getElementById('notes-pane');
    if (p) p.style.width = splitNotesWidthPct + '%';
    storageSet(K.SPLIT_PCT, splitNotesWidthPct);
  }
}

function setNotesWidth(pct) {
  const openCount = noteSpaceState.filter(s => s.exists && s.open).length || 1;
  const minPct    = Math.min(openCount * MIN_SPACE_PCT, 75);
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
      if (first) first.open = true;
      else { noteSpaceState[0].exists = true; noteSpaceState[0].open = true; }
      persistNoteSpaceState(); renderNotesUI();
    }
    np.classList.remove('hidden'); enforceNotesPaneWidth(); np.style.width = splitNotesWidthPct + '%';
    h.classList.remove('hidden'); btn.classList.add('active');
  } else {
    np.classList.add('hidden'); h.classList.add('hidden'); btn.classList.remove('active');
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

function scheduleNextSnapshot() {
  clearTimeout(snapshotTimerId);
  snapshotTimerId = setTimeout(async () => {
    const text = document.getElementById('editor').value;
    if (text.trim() && text !== lastSnapContent) await takeSnapshot(text, false);
    scheduleNextSnapshot();
  }, getCurrentSessionInterval());
}

async function takeSnapshot(text, silent) {
  const prevSig    = snapshots.filter(s => s.signed).pop()?.sig || 'genesis';
  const wordCount  = countWords(text);
  const charCount  = text.length;
  const textHash   = await computeTextHash(text);
  const commitment = await computeCommitment(wordCount, charCount, deletedCount, textHash, prevSig);

  const prevSnap  = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const prevWc    = prevSnap ? prevSnap.wordCount : 0;
  const prevWt    = prevSnap ? (prevSnap.writingTime || 0) : 0;
  const wordDelta = wordCount - prevWc;
  const wtMin     = (cumulativeWritingMs - prevWt) / 60_000;
  if (wordDelta > 0 && wtMin > 0 && wordDelta / wtMin > MAX_WORDS_PER_MIN) {
    showToast('⚠ Writing faster than expected — please slow down to maintain a verified record');
  }

  const snap = {
    timestamp:    Date.now(),
    writingTime:  cumulativeWritingMs,
    content:      text,
    wordCount,
    charCount,
    deletedCount,
    commitment,
    colorIndex:   nextColorIndex++,  
    sig:          null,
    signed:       false,
    keyVersion:   null,
  };

  snapshots.push(snap);
  lastSnapContent = text;
  autoSnapsSinceLastSign++;

  opfsWrite(await serializeToJson()).catch(console.warn);
  updateStatusBar();
  if (!silent) blinkSnap();

  if (autoSnapsSinceLastSign >= SIGN_TRIGGER_COUNT) {
    await triggerBundleSigning();
  }
}

async function doSaveSnapshot(silent) {
  const text = document.getElementById('editor').value;
  lastSaveTime = new Date();
  if (text.trim() && text !== lastSnapContent) {
    await takeSnapshot(text, silent);
    scheduleNextSnapshot();
  } else {
    opfsWrite(await serializeToJson()).catch(console.warn);
  }
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

function setView(v) {
  currentView = v;
  const ep = document.getElementById('editor-pane'), pp = document.getElementById('preview-pane');
  const bw = document.getElementById('btn-write'),   bp = document.getElementById('btn-preview');
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
  document.getElementById('status-words').textContent   = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
  const wtEl = document.getElementById('status-writing-time');
  if (wtEl) wtEl.textContent = cumulativeWritingMs > 0 ? fmtDur(cumulativeWritingMs) + ' writing' : '';
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
  lastKeystrokeTime = Date.now();
  const text = document.getElementById('editor').value;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    opfsWrite(await serializeToJson()).catch(console.warn);
    lastSaveTime = new Date();
    updateStatusBar();
  }, DEBOUNCE_MS);
  updateStatusBar();
  if (currentView === 'preview')
    document.getElementById('preview-content').innerHTML = renderMd(text);
}

function safeFilename(s) {
  return (s || 'document').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F ]/g, '').trim() || 'document';
}

async function exportBackup() {
  const title = document.getElementById('title-input').value || 'Untitled';
  const blob = new Blob([await serializeToJson()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = safeFilename(title) + ' — scrbr.json';
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
      const localWC = snapshots.length ? snapshots[snapshots.length - 1].wordCount : 0;
      const fileWC  = data.snapshots.length ? data.snapshots[data.snapshots.length - 1].wordCount : 0;
      const diffPct = wordCountDiffPct(localWC, fileWC);
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
      if (data.title) { titleInput.value = data.title; document.title = data.title + ' — scrbr'; }
      if (Array.isArray(data.progressSnapshots)) { progressSnapshots = data.progressSnapshots.slice(0, MAX_PROGRESS_SNAPS); updateProgressButton(); }
      if (Array.isArray(data.spaces)) {
        noteSpaceState = data.spaces.map(sp => ({ ...sp, snapshots: [...(sp.snapshots || [])] }));
        while (noteSpaceState.length < 3) noteSpaceState.push({ slot: noteSpaceState.length + 1, exists: false, open: false, content: '', snapshots: [] });
        persistNoteSpaceState(); renderNotesUI();
      }
    } else {
      const merged = [...snapshots, ...data.snapshots].sort((a,b) => a.timestamp - b.timestamp);
      snapshots = merged.filter((s, i) => i === 0 || s.timestamp !== merged[i-1].timestamp);
    }

    if (snapshots.length) {
      lastSnapContent     = snapshots[snapshots.length-1].content;
      cumulativeWritingMs = snapshots[snapshots.length-1].writingTime || 0;
    }
    recoverNextColorIndex();  // Bug 15

    saveTitle(titleInput.value);
    opfsWrite(await serializeToJson()).catch(console.warn);
    saveProgressSnapshots();
    updateStatusBar(); updateProgressButton(); scheduleNextSnapshot();
    let msg = (mode === 'replace' ? 'Restored' : 'Merged') + ' — ' + snapshots.length + ' snapshot' + (snapshots.length !== 1 ? 's' : '') + ' total';
    if (unsigned > 0 && tampered === 0) msg += ` (${unsigned} legacy unsigned)`;
    showToast(msg);
  };
  reader.readAsText(file);
}

async function init() {
  marked.setOptions({ gfm: true, breaks: false });

  const editor      = document.getElementById('editor');
  const titleInput  = document.getElementById('title-input');
  const authorInput = document.getElementById('author-input');

  let loadedFromOPFS = false;
  const opfsRaw = await opfsRead();

  if (opfsRaw) {
    try {
      const data = await deserializeFromJson(opfsRaw);
      editor.value = data.content; titleInput.value = data.title;
      if (data.author) authorInput.value = data.author;
      document.title = (data.title || 'Untitled') + ' — scrbr';
      snapshots = data.snapshots;
      if (snapshots.length) {
        lastSnapContent     = snapshots[snapshots.length - 1].content;
        cumulativeWritingMs = snapshots[snapshots.length - 1].writingTime || 0;
      }
      nextColorIndex    = data._nextColorIndex || 0;  // Bug 15
      progressSnapshots = Array.isArray(data.progressSnapshots) ? data.progressSnapshots.slice(0, MAX_PROGRESS_SNAPS) : [];
      if (Array.isArray(data.spaces)) {
        noteSpaceState = data.spaces.map(sp => ({ ...sp, snapshots: [...(sp.snapshots || [])] }));
        while (noteSpaceState.length < 3)
          noteSpaceState.push({ slot: noteSpaceState.length + 1, exists: false, open: false, content: '', snapshots: [] });
      }
      unsignedSnapshots = Array.isArray(data.unsignedSnapshots) ? data.unsignedSnapshots : [];
      if (data.keyVersion)  { workerKeyVersion = data.keyVersion; storageSet(K.KEY_VERSION, data.keyVersion); }
      if (data.vid)         { sessionVerifier  = data.vid; storageSet(K.VERIFIER, sessionVerifier); }
      lastSaveTime   = new Date();
      loadedFromOPFS = true;
    } catch (err) {
      console.warn('OPFS data could not be loaded, falling back to localStorage:', err);
    }
  }

  if (!loadedFromOPFS) {
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
      } catch(_) { noteSpaceState[0].exists = true; noteSpaceState[0].open = true; }
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

    const savedContent   = loadContent();
    const savedTitle     = loadTitle();
    const savedAuthor    = loadAuthor();
    const savedSnapshots = loadSnapshots();

    if (savedContent)   editor.value      = savedContent;
    if (savedTitle)     titleInput.value  = savedTitle;
    if (savedAuthor)    authorInput.value = savedAuthor;

    if (savedSnapshots.length) {
      snapshots = savedSnapshots;
      lastSnapContent     = savedSnapshots[savedSnapshots.length - 1].content;
      cumulativeWritingMs = savedSnapshots[savedSnapshots.length - 1].writingTime || 0;
      recoverNextColorIndex();  // Bug 15
    }

    if (savedContent || savedSnapshots.length) {
      opfsWrite(await serializeToJson()).then(() => {
        [K.CONTENT, K.SNAPSHOTS, K.PROGRESS_SNAPS,
         K.NOTES_1, K.NOTES_2, K.NOTES_3,
         K.NSNAPS_1, K.NSNAPS_2, K.NSNAPS_3,
        ].forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });
      }).catch(console.warn);
    }

    lastSaveTime = savedContent ? new Date() : null;
  }

  const savedFailCount = parseInt(storageGet(K.FAIL_COUNT));
  const savedFirstFail = parseInt(storageGet(K.FIRST_FAIL_TIME));
  if (!isNaN(savedFailCount) && savedFailCount > 0) {
    consecutiveFailures = savedFailCount;
    firstFailureTime    = isNaN(savedFirstFail) ? Date.now() : savedFirstFail;
  }

  const savedKV = storageGet(K.KEY_VERSION);
  if (savedKV) workerKeyVersion = savedKV;

  if (!sessionVerifier) sessionVerifier = storageGet(K.VERIFIER);

  const sf = parseInt(storageGet(K.FONT_SIZE));
  if (!isNaN(sf) && sf >= 12 && sf <= 26) fontSize = sf;
  applyFontSize();

  const sp = parseFloat(storageGet(K.SPLIT_PCT));
  if (!isNaN(sp) && sp >= 25 && sp <= 75) splitNotesWidthPct = sp;

  if (titleInput.value) document.title = titleInput.value + ' — scrbr';

  if (snapshots.length) {
    const banner = document.getElementById('restored-banner');
    if (banner) {
      banner.textContent = `Restored — ${snapshots.length} snapshot${snapshots.length !== 1 ? 's' : ''} from previous session`;
      banner.classList.remove('hidden');
      setTimeout(() => { banner.style.opacity = '0'; setTimeout(() => banner.classList.add('hidden'), 600); }, 4000);
    }
    verifyAllSnapshots(snapshots).then(({ tampered }) => {
      if (tampered > 0) showToast(`⚠ ${tampered} snapshot${tampered !== 1 ? 's' : ''} failed integrity check`);
    });
  }

  setInterval(() => {
    if (lastKeystrokeTime && Date.now() - lastKeystrokeTime < 5000) {
      cumulativeWritingMs += 1000;
    }
    const saveEl = document.getElementById('status-save');
    if (saveEl && lastSaveTime) saveEl.textContent = 'Saved ' + fmtAgo(lastSaveTime);
    const wtEl = document.getElementById('status-writing-time');
    if (wtEl) wtEl.textContent = cumulativeWritingMs > 0 ? fmtDur(cumulativeWritingMs) + ' writing' : '';
  }, 1000);

  updateStatusBar(); updateProgressButton();
  renderNotesUI();
  scheduleNextSnapshot();

  checkWorkerHealth();
  window.addEventListener('online', checkWorkerHealth);
  setInterval(checkWorkerHealth, 5 * 60 * 1000);

  initSplitResize();

  editor.addEventListener('paste',    e => { e.preventDefault(); showToast('Pasting is disabled in Editor'); });
  editor.addEventListener('dragstart', () => { _internalDrag = true; });
  editor.addEventListener('dragend',   () => { _internalDrag = false; });
  editor.addEventListener('drop', e => { if (!_internalDrag) { e.preventDefault(); showToast('External drop is disabled in Editor'); } });

  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart, en = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '\t' + editor.value.slice(en);
      editor.selectionStart = editor.selectionEnd = s + 1;
      onInput();
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const selLen = Math.abs(editor.selectionEnd - editor.selectionStart);
      deletedCount += selLen > 0 ? selLen : 1;
    }
  });

  editor.addEventListener('cut', () => {
    const selLen = Math.abs(editor.selectionEnd - editor.selectionStart);
    if (selLen > 0) deletedCount += selLen;
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's')               { e.preventDefault(); doSaveSnapshot(false); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') { e.preventDefault(); insertFootnote(); }
    if (e.key === 'Escape') {
      document.getElementById('export-menu').classList.add('hidden');
      document.getElementById('help-overlay').classList.add('hidden');
      closeNoteSpaceMenu();
    }
  });

  editor.addEventListener('input', onInput);
  editor.addEventListener('blur', async () => {
    opfsWrite(await serializeToJson()).catch(console.warn);
    lastSaveTime = new Date(); updateStatusBar();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const text = editor.value;
      saveContent(text);
      if (text.trim() && text !== lastSnapContent) {
        const lastSnapWt = snapshots.length ? (snapshots[snapshots.length - 1].writingTime || 0) : 0;
        const wtGap = cumulativeWritingMs - lastSnapWt;
        if (wtGap >= SNAP_MIN_MS * (1 - SNAP_TOLERANCE)) {
          takeSnapshot(text, true);
        }
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    const text = editor.value;
    saveContent(text);
    if (text.trim() && text !== lastSnapContent) {
      snapshots.push({
        timestamp: Date.now(), writingTime: cumulativeWritingMs,
        content: text, wordCount: countWords(text),
        charCount: text.length, deletedCount,
        commitment: null, sig: null, signed: false, keyVersion: null,
        colorIndex: nextColorIndex++,  // Bug 15
      });
      try { storageSet(K.SNAPSHOTS, LZString.compressToUTF16(JSON.stringify(snapshots))); } catch(_) {}
    }
  });

  titleInput.addEventListener('input', () => {
    saveTitle(titleInput.value);
    document.title = (titleInput.value || 'Untitled') + ' — scrbr';
  });
  authorInput.addEventListener('input', () => saveAuthor(authorInput.value));

  document.getElementById('btn-write').addEventListener('click', () => setView('write'));
  document.getElementById('btn-preview').addEventListener('click', () => setView('preview'));
  document.getElementById('btn-notes').addEventListener('click', toggleNotes);

  document.getElementById('btn-sz-down').addEventListener('click', () => { fontSize = Math.max(12, fontSize - 1); applyFontSize(); showToast(`Font size ${fontSize}px`); });
  document.getElementById('btn-sz-up').addEventListener('click',   () => { fontSize = Math.min(26, fontSize + 1); applyFontSize(); showToast(`Font size ${fontSize}px`); });

  document.getElementById('btn-fn').addEventListener('click', insertFootnote);
  document.getElementById('btn-progress-snap').addEventListener('click', takeProgressSnapshot);

  document.getElementById('btn-help').addEventListener('click', () => document.getElementById('help-overlay').classList.remove('hidden'));
  document.getElementById('help-close').addEventListener('click', () => document.getElementById('help-overlay').classList.add('hidden'));
  document.getElementById('help-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('help-overlay'))
      document.getElementById('help-overlay').classList.add('hidden');
  });

  const exportToggle = document.getElementById('btn-export-toggle');
  const exportMenu   = document.getElementById('export-menu');
  exportToggle.addEventListener('click', e => { e.stopPropagation(); exportMenu.classList.toggle('hidden'); });
  document.addEventListener('click', () => exportMenu.classList.add('hidden'));

  const btnSaveDrive = document.getElementById('btn-save-drive');
  if (btnSaveDrive) btnSaveDrive.addEventListener('click', () => { exportMenu.classList.add('hidden'); triggerGdriveSave(); });
  const btnRestoreDrive = document.getElementById('btn-restore-drive');
  if (btnRestoreDrive) btnRestoreDrive.addEventListener('click', () => { exportMenu.classList.add('hidden'); triggerGdriveRestore(); });

  document.getElementById('btn-export-backup').addEventListener('click', () => { exportMenu.classList.add('hidden'); exportBackup(); });
  document.getElementById('btn-restore-file').addEventListener('click',  () => { exportMenu.classList.add('hidden'); importBackup(); });
  document.getElementById('btn-export-combined').addEventListener('click', () => { exportMenu.classList.add('hidden'); gatedExport(exportCombined); });
  document.getElementById('backup-file-input').addEventListener('change', e => { handleBackupFile(e.target.files[0]); e.target.value = ''; });

  document.getElementById('btn-clear').addEventListener('click', () => {
    exportMenu.classList.add('hidden');
    if (confirm('Permanently delete all content, snapshots, and note spaces?\n\nThis cannot be undone.')) {
      [K.CONTENT, K.TITLE, K.AUTHOR, K.SNAPSHOTS, K.PROGRESS_SNAPS,
       K.NOTES_1, K.NOTES_2, K.NOTES_3,
       K.NSNAPS_1, K.NSNAPS_2, K.NSNAPS_3,
       K.SPACE_STATE, K.VERIFIER,
       K.UNSIGNED_SNAPS, K.FAIL_COUNT, K.FIRST_FAIL_TIME, K.BLOCK_EVENT,
      ].forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });

      opfsWrite('').catch(console.warn);
      clearTimeout(snapshotTimerId);

      snapshots = []; lastSnapContent = ''; lastSaveTime = null;
      progressSnapshots = []; sessionVerifier = null;
      unsignedSnapshots = []; autoSnapsSinceLastSign = 0;
      consecutiveFailures = 0; firstFailureTime = null;
      cumulativeWritingMs = 0; lastKeystrokeTime = null; deletedCount = 0;
      nextColorIndex = 0;
      gdriveFileId = null;
      hidePersistentWarning();

      noteSpaceState = [
        { slot: 1, exists: true,  open: true,  content: '', snapshots: [] },
        { slot: 2, exists: false, open: false, content: '', snapshots: [] },
        { slot: 3, exists: false, open: false, content: '', snapshots: [] },
      ];

      editor.value = ''; titleInput.value = ''; authorInput.value = '';
      editor.disabled = false;
      document.title = 'scrbr';
      updateStatusBar(); updateProgressButton();
      renderNotesUI();
      showToast('Reset — fresh document');
      scheduleNextSnapshot();
      checkWorkerHealth();
    }
  });

  editor.focus();
}

window.addEventListener('load', init);
