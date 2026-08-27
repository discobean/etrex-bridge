'use strict';

/* eTrex Bridge — File System Access API front-end for a Garmin eTrex 30x
 * mounted as USB mass storage. No dependencies, no build step.
 *
 * The device is just a filesystem, so there is no protocol here: we pick the
 * mounted volume with showDirectoryPicker(), stash the handle in IndexedDB so
 * return visits can re-ask for permission instead of re-picking, and read and
 * write files under /Garmin.
 */

/* ── Device firmware ceilings ───────────────────────────────────────────
 * The eTrex truncates silently past these, so we warn before writing. */
const LIMITS = {
  waypoints:        2000,
  routes:            200,
  tracks:            200,
  pointsPerTrack:  10000,
};

const DEVICE_NAME_RE = {
  gpx: /^[A-Za-z0-9 ._-]{1,64}\.gpx$/i,
  kmz: /^[A-Za-z0-9 ._-]{1,64}\.kmz$/i,
};

/* Where GPX files live on the device, relative to /Garmin. */
const GPX_DIRS = [
  { label: 'GPX',     path: ['GPX'] },
  { label: 'Current', path: ['GPX', 'Current'] },
  { label: 'Archive', path: ['GPX', 'Archive'] },
];

/* ── DOM ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const el = {
  unsupported:    $('unsupported'),
  unsupportedWhy: $('unsupportedWhy'),
  connectCard:    $('connectCard'),
  inventoryCard:  $('inventoryCard'),
  viewerCard:     $('viewerCard'),
  transferCard:   $('transferCard'),
  btnConnect:     $('btnConnect'),
  btnReconnect:   $('btnReconnect'),
  reconnectName:  $('reconnectName'),
  btnRefresh:     $('btnRefresh'),
  btnForget:      $('btnForget'),
  status:         $('status'),
  mapInfo:        $('mapInfo'),
  kmzList:        $('kmzList'),
  gpxList:        $('gpxList'),
  tree:           $('tree'),
  treeSummary:    $('treeSummary'),
  gpxTitle:       $('gpxTitle'),
  gpxStats:       $('gpxStats'),
  gpxWarnings:    $('gpxWarnings'),
  gpxNames:       $('gpxNames'),
  tilesToggle:    $('tilesToggle'),
  basemap:        $('basemap'),
  mapNote:        $('mapNote'),
  attrib:         $('attrib'),
  exportDetails:  $('exportDetails'),
  exportZoom:     $('exportZoom'),
  exportPad:      $('exportPad'),
  exportBudget:   $('exportBudget'),
  exportName:     $('exportName'),
  btnExport:      $('btnExport'),
  exportEstimate: $('exportEstimate'),
  exportProgressWrap: $('exportProgressWrap'),
  exportBar:      $('exportBar'),
  exportText:     $('exportText'),
  plot:           $('plot'),
  gpxInput:       $('gpxInput'),
  renameRow:      $('renameRow'),
  gpxName:        $('gpxName'),
  nameHint:       $('nameHint'),
  btnResetName:   $('btnResetName'),
  btnUpload:      $('btnUpload'),
  imgInput:       $('imgInput'),
  btnInstall:     $('btnInstall'),
  progressWrap:   $('progressWrap'),
  progressBar:    $('progressBar'),
  progressText:   $('progressText'),
  log:            $('log'),
  btnClearLog:    $('btnClearLog'),
};

/* ── State ──────────────────────────────────────────────────────────── */
let rootHandle = null;   // the mounted volume (GARMIN or the SD card)
let busy = false;
let viewing = null;      // device path of the GPX currently in the viewer
let lastSegments = null; // segments of the open GPX, for re-rendering

/* ── Logging ────────────────────────────────────────────────────────── */
function log(message, level) {
  const line = document.createElement('div');

  const stamp = document.createElement('span');
  stamp.className = 't';
  stamp.textContent = new Date().toLocaleTimeString([], { hour12: false }) + '  ';

  const body = document.createElement('span');
  if (level) body.className = 'l-' + level;
  body.textContent = message;          // device-derived text: never innerHTML

  line.append(stamp, body);
  el.log.append(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = 'status ' + (kind || 'idle');
}

/* ── Formatting ─────────────────────────────────────────────────────── */
function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 2 : 1) + ' ' + units[i];
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/* ── IndexedDB handle persistence ───────────────────────────────────────
 * Directory handles are structured-cloneable, so IndexedDB can hold one
 * across sessions. The handle alone does not grant access — permission is
 * re-checked, and re-granting needs a user gesture. */
const DB_NAME = 'etrex-bridge';
const STORE   = 'handles';
const KEY     = 'root';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbSet(value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror   = () => { db.close(); reject(req.error); };
  });
}

async function idbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = () => { db.close(); reject(tx.error); };
  });
}

/* ── Permissions ────────────────────────────────────────────────────── */
async function ensurePermission(handle, request) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

/* ── Filesystem helpers ─────────────────────────────────────────────── */
async function getDir(parent, segments, create) {
  let dir = parent;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: !!create });
  }
  return dir;
}

/** Resolve a directory path, returning null when any segment is missing. */
async function tryGetDir(parent, segments) {
  try {
    return await getDir(parent, segments, false);
  } catch (err) {
    if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return null;
    throw err;
  }
}

async function tryGetFile(dir, name) {
  try {
    return await dir.getFileHandle(name, { create: false });
  } catch (err) {
    if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return null;
    throw err;
  }
}

/* ── Filename safety ────────────────────────────────────────────────────
 * A name from a file picker becomes a path component on the device, so strip
 * anything separator-like first, then allowlist. */
function safeDeviceName(rawName, ext) {
  const base = String(rawName).split(/[/\\]/).pop().trim();
  if (base === '' || base === '.' || base === '..') return null;
  if (base.includes('\0')) return null;
  return DEVICE_NAME_RE[ext].test(base) ? base : null;
}

const safeGpxName = (name) => safeDeviceName(name, 'gpx');
const safeKmzName = (name) => safeDeviceName(name, 'kmz');

/* Latin letters NFD cannot decompose — they are distinct letters, not accented
 * forms, so they need an explicit ASCII fallback. Derived by diffing NFD against
 * @sindresorhus/transliterate across Latin-1 Supplement and Latin Extended-A:
 * these 21 are the entire gap, which is why no dependency is carried for it. */
const LATIN_FALLBACKS = {
  'Æ': 'AE', 'Ð': 'D',  'Ø': 'O',  'Þ': 'TH', 'ß': 'ss', 'æ': 'ae',
  'ð': 'd',  'ø': 'o',  'þ': 'th', 'Đ': 'D',  'đ': 'd',  'Ħ': 'H',
  'ħ': 'h',  'ı': 'i',  'Ĳ': 'IJ', 'ĳ': 'ij', 'Ł': 'L',  'ł': 'l',
  'Œ': 'OE', 'œ': 'oe', 'Ə': 'A',
};

/** Best-effort legal name for a file the allowlist would reject.
 *
 * This only proposes a name — it is shown in an editable field and the result
 * still has to pass safeGpxName() before any write. Sanitising is never a
 * substitute for the allowlist, only a way to offer the user a way forward. */
function sanitizeDeviceName(rawName, ext) {
  const base = String(rawName).split(/[/\\]/).pop().trim();

  /* Work on the stem so the extension can't be mangled or doubled. */
  let stem = base.replace(/\.(gpx|kmz)$/i, '');

  /* Fold to ASCII first, so "detour" beats "d_tour" for European place names:
   * the explicit map for letters NFD can't touch, then NFD for the accents. */
  stem = stem
    .replace(/[^\u0000-\u007f]/g, (ch) => LATIN_FALLBACKS[ch] || ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  stem = stem
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')   // disallowed runs collapse to one _
    .replace(/[\s_]*_[\s_]*/g, '_')       // ...and absorb the spaces around it
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s._-]+/, '')             // no leading dot/space/separator
    .replace(/[\s._-]+$/, '');

  /* The allowlist caps the stem at 64 characters. */
  if (stem.length > 64) stem = stem.slice(0, 64).replace(/[\s._-]+$/, '');
  if (!stem) stem = 'Track';

  return stem + '.' + ext;
}

const sanitizeGpxName = (name) => sanitizeDeviceName(name, 'gpx');
const sanitizeKmzName = (name) => sanitizeDeviceName(name, 'kmz');

/* ── Upload filename field ──────────────────────────────────────────── */
function suggestName() {
  const file = el.gpxInput.files && el.gpxInput.files[0];
  el.gpxName.value = file ? sanitizeGpxName(file.name) : '';
  refreshNameHint();
  updateTransferButtons();
}

function refreshNameHint() {
  const file = el.gpxInput.files && el.gpxInput.files[0];

  el.nameHint.textContent = '';
  el.nameHint.className = '';
  el.gpxName.classList.remove('bad');

  if (!file) { el.renameRow.hidden = true; return; }
  el.renameRow.hidden = false;

  const typed = el.gpxName.value;
  const safe = safeGpxName(typed);

  if (!safe) {
    el.gpxName.classList.add('bad');
    el.nameHint.className = 'notice';
    el.nameHint.textContent =
      'Not a legal device filename. Allowed: letters, digits, space, dot, underscore and hyphen — ' +
      'at most 64 characters before ".gpx".';
    return;
  }

  el.nameHint.className = 'muted';
  el.nameHint.textContent = safe === file.name
    ? 'Will be written as /Garmin/GPX/' + safe
    : 'Will be written as /Garmin/GPX/' + safe + ' — renamed from "' + file.name + '".';
}

/* ── Connect / reconnect ────────────────────────────────────────────── */
async function connect() {
  if (busy) return;
  try {
    const handle = await window.showDirectoryPicker({
      id: 'etrex-volume',
      mode: 'readwrite',
      startIn: 'desktop',
    });
    rootHandle = handle;
    await idbSet(handle);
    log('Picked volume: ' + handle.name, 'ok');
    await afterConnect();
  } catch (err) {
    if (err && err.name === 'AbortError') { log('Volume picker dismissed.'); return; }
    fail('Could not open the volume', err);
  }
}

async function reconnect() {
  if (busy) return;
  try {
    const handle = await idbGet();
    if (!handle) { log('No stored volume to reconnect to.', 'warn'); return; }
    if (!(await ensurePermission(handle, true))) {
      setStatus('Permission denied for ' + handle.name + '. Use "Connect volume…" instead.', 'warn');
      log('Permission not granted for stored handle: ' + handle.name, 'warn');
      return;
    }
    rootHandle = handle;
    log('Reconnected to ' + handle.name, 'ok');
    await afterConnect();
  } catch (err) {
    /* A stored handle goes stale when the volume is unmounted or renamed. */
    fail('Reconnect failed — the volume may not be mounted. Try "Connect volume…".', err);
  }
}

async function afterConnect() {
  el.btnRefresh.disabled = false;
  el.btnForget.hidden = false;
  el.inventoryCard.hidden = false;
  el.transferCard.hidden = false;
  el.reconnectName.textContent = rootHandle.name;
  el.btnReconnect.hidden = false;
  updateTransferButtons();
  await scan();
}

async function forget() {
  await idbClear();
  rootHandle = null;
  el.btnReconnect.hidden = true;
  el.btnForget.hidden = true;
  el.btnRefresh.disabled = true;
  el.inventoryCard.hidden = true;
  el.viewerCard.hidden = true;
  el.transferCard.hidden = true;
  setStatus('Not connected', 'idle');
  log('Stored volume handle cleared.');
}

function fail(message, err) {
  const detail = err ? (err.name ? err.name + ': ' + err.message : String(err)) : '';
  setStatus(message, 'error');
  log(message + (detail ? ' — ' + detail : ''), 'error');
  if (err) console.error(err);
}

/* ── Inventory scan ─────────────────────────────────────────────────── */
async function scan() {
  if (!rootHandle || busy) return;
  busy = true;
  el.btnRefresh.disabled = true;
  try {
    if (!(await ensurePermission(rootHandle, false))) {
      setStatus('Read-write permission lapsed. Click Reconnect.', 'warn');
      return;
    }

    const garmin = await tryGetDir(rootHandle, ['Garmin']);

    if (!garmin) {
      /* Legitimate for a blank SD card — warn, don't block. */
      setStatus('Connected to "' + rootHandle.name +
        '" — no /Garmin folder here. That is normal for a blank card; it will be created on first write.', 'warn');
      log('No /Garmin folder on ' + rootHandle.name, 'warn');
      renderMapInfo(null);
      renderKmz([]);
      renderGpxList([]);
      renderTree([]);
      return;
    }

    setStatus('Connected to "' + rootHandle.name + '" — /Garmin found.', 'ok');

    const imgHandle = await tryGetFile(garmin, 'gmapsupp.img');
    renderMapInfo(imgHandle ? await imgHandle.getFile() : null);

    renderKmz(await listKmz(garmin));

    const gpxFiles = await listGpx(garmin);
    renderGpxList(gpxFiles);

    renderTree(await walk(garmin, '/Garmin', 0));
    log('Scan complete: ' + gpxFiles.length + ' GPX file(s).');
  } catch (err) {
    fail('Scan failed', err);
  } finally {
    busy = false;
    el.btnRefresh.disabled = !rootHandle;
  }
}

async function listGpx(garmin) {
  const out = [];
  for (const spec of GPX_DIRS) {
    const dir = await tryGetDir(garmin, spec.path);
    if (!dir) continue;
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      if (!/\.gpx$/i.test(entry.name)) continue;
      const file = await entry.getFile();
      out.push({
        where:  spec.label,
        name:   entry.name,
        size:   file.size,
        mtime:  file.lastModified,
        handle: entry,
        dir,                    // removeEntry() is a method on the parent
      });
    }
  }
  out.sort((a, b) =>
    a.where.localeCompare(b.where) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/* Depth- and count-capped recursive listing of /Garmin.
 *
 * This exists to answer "what else is actually on here?" with data rather than
 * assumption — the eTrex keeps more than GPX under /Garmin, and the only
 * reliable way to know what is to look. */
const TREE_MAX_DEPTH   = 4;
const TREE_MAX_ENTRIES = 800;

async function walk(dir, path, depth, acc) {
  const out = acc || [];
  if (depth > TREE_MAX_DEPTH || out.length >= TREE_MAX_ENTRIES) return out;

  const entries = [];
  for await (const entry of dir.values()) entries.push(entry);
  entries.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
    a.name.localeCompare(b.name, undefined, { numeric: true }));

  for (const entry of entries) {
    if (out.length >= TREE_MAX_ENTRIES) break;
    const childPath = path + '/' + entry.name;

    if (entry.kind === 'directory') {
      out.push({ path: childPath, depth, dir: true, size: null });
      await walk(entry, childPath, depth + 1, out);
    } else {
      let size = null;
      try { size = (await entry.getFile()).size; } catch (err) { /* unreadable */ }
      out.push({ path: childPath, depth, dir: false, size });
    }
  }
  return out;
}

function renderTree(entries) {
  el.tree.textContent = '';
  el.tree.classList.toggle('muted', entries.length === 0);

  if (!entries.length) {
    el.tree.textContent = 'Nothing to list.';
    el.treeSummary.textContent = 'Show the full tree';
    return;
  }

  const files = entries.filter((e) => !e.dir);
  const bytes = files.reduce((n, e) => n + (e.size || 0), 0);
  el.treeSummary.textContent =
    'Show the full tree — ' + files.length + ' file(s), ' +
    (entries.length - files.length) + ' folder(s), ' + formatBytes(bytes);

  for (const entry of entries) {
    const row = document.createElement('div');

    const name = document.createElement('span');
    name.className = 'p' + (entry.dir ? ' d' : '');
    name.textContent = '  '.repeat(entry.depth) + entry.path.split('/').pop() + (entry.dir ? '/' : '');

    const size = document.createElement('span');
    size.className = 's';
    size.textContent = entry.dir ? '' : formatBytes(entry.size);

    row.append(name, size);
    row.title = entry.path;                       // device-derived, textContent-safe
    el.tree.append(row);
  }

  if (entries.length >= TREE_MAX_ENTRIES) {
    const more = document.createElement('div');
    more.textContent = '… listing capped at ' + TREE_MAX_ENTRIES + ' entries.';
    el.tree.append(more);
  }
}

async function listKmz(garmin) {
  const dir = await tryGetDir(garmin, ['CustomMaps']);
  if (!dir) return [];
  const out = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !/\.kmz$/i.test(entry.name)) continue;
    const file = await entry.getFile();
    out.push({ name: entry.name, size: file.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/* ── Inventory rendering ────────────────────────────────────────────── */
function renderMapInfo(file) {
  el.mapInfo.textContent = '';
  el.mapInfo.classList.toggle('muted', !file);

  if (!file) {
    el.mapInfo.textContent = 'No /Garmin/gmapsupp.img on this volume.';
    return;
  }
  const rows = [
    ['Path',     '/Garmin/gmapsupp.img'],
    ['Size',     formatBytes(file.size) + '  (' + file.size.toLocaleString() + ' bytes)'],
    ['Modified', formatDate(file.lastModified)],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    const kn = document.createElement('span'); kn.className = 'k'; kn.textContent = k;
    const vn = document.createElement('span'); vn.className = 'v'; vn.textContent = v;
    row.append(kn, vn);
    el.mapInfo.append(row);
  }
}

function renderKmz(items) {
  el.kmzList.textContent = '';
  el.kmzList.classList.toggle('muted', items.length === 0);
  if (!items.length) {
    el.kmzList.textContent = 'No custom maps.';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'file';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;                 // device-derived
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(item.size);
    row.append(name, size);
    el.kmzList.append(row);
  }
}

function renderGpxList(files) {
  el.gpxList.textContent = '';
  el.gpxList.classList.toggle('muted', files.length === 0);

  if (!files.length) {
    el.gpxList.textContent = 'No GPX files found under /Garmin/GPX.';
    return;
  }

  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'file';

    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = f.where;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;                    // device-derived

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(f.size);

    const open = document.createElement('button');
    open.className = 'small';
    open.textContent = 'open';
    open.style.marginLeft = '0';
    open.addEventListener('click', () => openGpx(f));

    const del = document.createElement('button');
    del.className = 'small del';
    del.textContent = 'delete';
    del.style.marginLeft = '0';
    del.title = 'Delete ' + devicePath(f) + ' from the device';
    del.addEventListener('click', () => deleteGpx(f));

    row.append(where, name, size, open, del);
    el.gpxList.append(row);
  }
}

/** Full on-device path for a listed GPX, for display and confirmations. */
function devicePath(entry) {
  const dir = entry.where === 'GPX' ? 'GPX' : 'GPX/' + entry.where;
  return '/Garmin/' + dir + '/' + entry.name;
}

/* ── GPX parsing ────────────────────────────────────────────────────────
 * Well-formed XML with a <gpx> root, checked before anything is written to
 * the device — a malformed file on the device is worse than no file. */
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length) {
    const node = doc.getElementsByTagName('parsererror')[0];
    return { ok: false, error: 'Not well-formed XML: ' + (node.textContent || '').trim().split('\n')[0] };
  }

  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'gpx') {
    return { ok: false, error: 'Root element is <' + (root ? root.localName : 'empty') + '>, expected <gpx>.' };
  }

  /* getElementsByTagNameNS('*', …) so both GPX 1.1 and namespace-less files
   * are counted the same way. */
  const all = (tag) => Array.from(root.getElementsByTagNameNS('*', tag));

  /* Only a direct <name> child counts — a descendant search would pick up the
   * <name> inside a <trkpt> or <rtept> and mislabel the parent. */
  const childName = (node) => {
    for (const child of node.children) {
      if (child.localName === 'name') return (child.textContent || '').trim();
    }
    return '';
  };

  const trks = all('trk');
  const segments = [];
  let trkptCount = 0;
  let maxPerTrack = 0;

  const trackInfo = [];

  for (const trk of trks) {
    let inThisTrack = 0;
    for (const seg of Array.from(trk.getElementsByTagNameNS('*', 'trkseg'))) {
      const pts = [];
      for (const pt of Array.from(seg.getElementsByTagNameNS('*', 'trkpt'))) {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
      }
      inThisTrack += pts.length;
      if (pts.length > 1) segments.push(pts);
    }
    trkptCount += inThisTrack;
    if (inThisTrack > maxPerTrack) maxPerTrack = inThisTrack;
    trackInfo.push({ name: childName(trk), points: inThisTrack });
  }

  const metadata = Array.from(root.children).find((c) => c.localName === 'metadata');
  const title = metadata ? childName(metadata) : '';

  const routeInfo = all('rte').map((rte) => ({
    name: childName(rte),
    points: rte.getElementsByTagNameNS('*', 'rtept').length,
  }));
  const waypointNames = all('wpt').map(childName);

  return {
    ok: true,
    title,
    creator: root.getAttribute('creator') || '',
    trackInfo,
    routeInfo,
    waypointNames,
    counts: {
      tracks:     trks.length,
      trkpts:     trkptCount,
      waypoints:  all('wpt').length,
      routes:     all('rte').length,
      rtepts:     all('rtept').length,
      maxPerTrack,
    },
    segments,
  };
}

/** Firmware ceilings this file would breach on its own. */
function ceilingWarnings(counts) {
  const warnings = [];
  if (counts.waypoints  > LIMITS.waypoints)
    warnings.push(counts.waypoints.toLocaleString() + ' waypoints exceeds the device ceiling of ' + LIMITS.waypoints.toLocaleString() + '.');
  if (counts.routes     > LIMITS.routes)
    warnings.push(counts.routes + ' routes exceeds the device ceiling of ' + LIMITS.routes + '.');
  if (counts.tracks     > LIMITS.tracks)
    warnings.push(counts.tracks + ' tracks exceeds the device ceiling of ' + LIMITS.tracks + '.');
  if (counts.maxPerTrack > LIMITS.pointsPerTrack)
    warnings.push('Longest track has ' + counts.maxPerTrack.toLocaleString() + ' points, over the ' + LIMITS.pointsPerTrack.toLocaleString() + '-point per-track ceiling.');
  return warnings;
}

/* ── GPX viewer ─────────────────────────────────────────────────────── */
async function openGpx(entry) {
  if (busy) return;
  busy = true;
  try {
    const file = await entry.handle.getFile();
    const text = await file.text();
    const parsed = parseGpx(text);

    el.viewerCard.hidden = false;
    el.gpxTitle.textContent = devicePath(entry);
    viewing = devicePath(entry);

    if (!parsed.ok) {
      el.gpxStats.textContent = '';
      el.gpxNames.textContent = '';
      showWarnings([parsed.error]);
      el.plot.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing to draw.';
      el.plot.append(empty);
      log('Parse failed for ' + entry.name + ': ' + parsed.error, 'error');
      return;
    }

    renderStats(parsed);
    renderNames(parsed);
    el.exportName.value = sanitizeKmzName(
      (parsed.trackInfo[0] && parsed.trackInfo[0].name) || parsed.title || entry.name);
    showWarnings(ceilingWarnings(parsed.counts));
    renderTrack(parsed.segments);

    const c = parsed.counts;
    log('Opened ' + entry.name + ' — ' + c.tracks + ' track(s), ' + c.trkpts +
        ' point(s), ' + c.waypoints + ' waypoint(s), ' + c.routes + ' route(s).', 'ok');
    el.viewerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    fail('Could not read ' + entry.name, err);
  } finally {
    busy = false;
  }
}

function renderStats(parsed) {
  el.gpxStats.textContent = '';

  const header = [];
  if (parsed.title)   header.push('Metadata name: ' + parsed.title);
  if (parsed.creator) header.push('creator="' + parsed.creator + '"');
  if (header.length) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.style.width = '100%';
    t.textContent = header.join('  ·  ');              // device-derived
    el.gpxStats.append(t);
  }

  const c = parsed.counts;
  const cells = [
    ['Tracks', c.tracks],
    ['Track points', c.trkpts],
    ['Longest track', c.maxPerTrack],
    ['Waypoints', c.waypoints],
    ['Routes', c.routes],
    ['Route points', c.rtepts],
  ];
  for (const [label, value] of cells) {
    const box = document.createElement('div');
    box.className = 'stat';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = value.toLocaleString();
    const l = document.createElement('span'); l.className = 'l'; l.textContent = label;
    box.append(n, l);
    el.gpxStats.append(box);
  }
}

/* The <name> elements inside the file — this is what the eTrex shows in Track
 * Manager, Waypoint Manager and Route Planner. The filename is not displayed
 * on the device, so a rename on upload does not change what you see there. */
function renderNames(parsed) {
  el.gpxNames.textContent = '';
  el.gpxNames.className = 'names';

  const section = (caption, rows) => {
    if (!rows.length) return;

    const table = document.createElement('table');
    const cap = document.createElement('caption');
    cap.textContent = caption;
    table.append(cap);

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');

      const idx = document.createElement('td');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const nm = document.createElement('td');
      nm.className = 'nm';
      if (row.name) {
        nm.textContent = row.name;              // device-derived
      } else {
        nm.classList.add('none');
        nm.textContent = '(no <name> element)';
      }

      const ct = document.createElement('td');
      ct.className = 'ct';
      ct.textContent = row.detail || '';

      tr.append(idx, nm, ct);
      table.append(tr);
    });

    el.gpxNames.append(table);
  };

  section('Track names', parsed.trackInfo.map((t) => ({
    name: t.name, detail: t.points.toLocaleString() + ' pts',
  })));

  section('Route names', parsed.routeInfo.map((r) => ({
    name: r.name, detail: r.points.toLocaleString() + ' pts',
  })));

  /* Waypoint lists run long; show a sample and say how many were elided. */
  const wpts = parsed.waypointNames;
  const shown = wpts.slice(0, 12);
  section('Waypoint names', shown.map((n) => ({ name: n, detail: '' })));
  if (wpts.length > shown.length) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.style.padding = '0.25rem 0';
    more.textContent = '…and ' + (wpts.length - shown.length).toLocaleString() + ' more waypoint(s).';
    el.gpxNames.append(more);
  }
}

function showWarnings(messages) {
  el.gpxWarnings.textContent = '';
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.textContent = m;
    el.gpxWarnings.append(div);
  }
}

/* ── Basemap tiles ──────────────────────────────────────────────────────
 * On by default, and the one thing here that touches the network: a tile
 * request tells the tile server roughly where the track is. The toggle states
 * which way it sits and the choice is remembered, so it stays the user's call.
 *
 * No mapping library — a slippy map is a little arithmetic and some <img>
 * elements. All three sources are free and keyless; all require attribution. */
const TILE_SIZE = 256;
const MAX_TILES = 60;

const BASEMAPS = {
  opentopo: {
    label: 'OpenTopoMap',
    maxZoom: 17,
    subdomains: ['a', 'b', 'c'],
    url: (sub, z, x, y) => 'https://' + sub + '.tile.opentopomap.org/' + z + '/' + x + '/' + y + '.png',
    attribution: [
      ['Map data © ', 'https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'],
      [', SRTM · Rendering © ', 'https://opentopomap.org/', 'OpenTopoMap'],
      [' (CC-BY-SA)', null, null],
    ],
  },
  cyclosm: {
    label: 'CyclOSM',
    maxZoom: 18,
    subdomains: ['a', 'b', 'c'],
    url: (sub, z, x, y) =>
      'https://' + sub + '.tile-cyclosm.openstreetmap.fr/cyclosm/' + z + '/' + x + '/' + y + '.png',
    attribution: [
      ['Map data © ', 'https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'],
      [' · Rendering © ', 'https://www.cyclosm.org/', 'CyclOSM'],
    ],
  },
  osm: {
    label: 'OpenStreetMap',
    maxZoom: 19,
    subdomains: ['a', 'b', 'c'],
    url: (sub, z, x, y) => 'https://' + sub + '.tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png',
    attribution: [
      ['© ', 'https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'],
    ],
  },
};

/* Web Mercator, in tile units at a given zoom. */
const lonToTileX = (lon, z) => ((lon + 180) / 360) * Math.pow(2, z);
const latToTileY = (lat, z) => {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
};

/** Largest zoom at which the bounding box still fits the viewport. */
function fitZoom(bounds, W, H, pad, maxZoom) {
  for (let z = maxZoom; z >= 0; z--) {
    const spanX = (lonToTileX(bounds.maxLon, z) - lonToTileX(bounds.minLon, z)) * TILE_SIZE;
    const spanY = (latToTileY(bounds.minLat, z) - latToTileY(bounds.maxLat, z)) * TILE_SIZE;
    if (spanX <= W - 2 * pad && spanY <= H - 2 * pad) return z;
  }
  return 0;
}

function boundsOf(segments) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const seg of segments) {
    for (const [lat, lon] of seg) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return { minLat, maxLat, minLon, maxLon };
}

/* Draw the track as an inline SVG polyline.
 *
 * Equirectangular projection with a cos(latitude) correction on x: one degree
 * of longitude covers cos(lat) as much ground as one degree of latitude, so
 * without it the shape is stretched horizontally — badly so at high latitude. */
function renderTrack(segments) {
  lastSegments = segments;

  el.plot.textContent = '';
  el.plot.className = 'plot';
  el.plot.style.height = '';
  el.attrib.textContent = '';

  if (!segments.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No track points to draw.';
    el.plot.append(empty);
    return;
  }

  if (el.tilesToggle.checked) renderTiledTrack(segments);
  else renderPlainTrack(segments);

  refreshExportEstimate();
}

/* Shape-only rendering: no basemap, no network, equirectangular. */
function renderPlainTrack(segments) {
  const W = 900, H = 480, PAD = 18;
  const NS = 'http://www.w3.org/2000/svg';

  const { minLat, maxLat, minLon, maxLon } = boundsOf(segments);

  const lat0 = ((minLat + maxLat) / 2) * Math.PI / 180;
  const kx = Math.max(Math.cos(lat0), 1e-6);

  /* Projected extent, in "degrees of latitude" units. */
  const spanX = Math.max((maxLon - minLon) * kx, 1e-9);
  const spanY = Math.max( maxLat - minLat,       1e-9);

  /* One scale for both axes preserves shape; letterbox the smaller one. */
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;

  const project = (lat, lon) => [
    offX + (lon - minLon) * kx * scale,
    /* y is flipped: latitude increases northward, SVG y increases downward. */
    offY + (maxLat - lat) * scale,
  ];

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Track outline');

  let drawn = 0;
  for (const seg of segments) {
    const pts = decimate(seg, 6000);
    const coords = pts.map(([lat, lon]) => {
      const [x, y] = project(lat, lon);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', coords);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--track)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
    drawn += pts.length;
  }

  /* Start and end markers on the first and last segment. */
  addDot(svg, NS, project(...segments[0][0]), 'var(--ok)');
  const lastSeg = segments[segments.length - 1];
  addDot(svg, NS, project(...lastSeg[lastSeg.length - 1]), 'var(--danger)');

  el.plot.append(svg);

  const caption = document.createElement('div');
  caption.className = 'muted';
  caption.style.padding = '0.4rem 0.7rem';
  caption.textContent =
    segments.length + ' segment(s), ' + drawn.toLocaleString() + ' point(s) drawn · ' +
    'lat ' + minLat.toFixed(5) + '…' + maxLat.toFixed(5) + ' · ' +
    'lon ' + minLon.toFixed(5) + '…' + maxLon.toFixed(5);
  el.plot.append(caption);
}

/* Basemap rendering: Web Mercator, because that is the projection the tiles
 * are cut in. The plain view keeps equirectangular — over a single track's
 * extent the two agree closely, but they must not be mixed with raster tiles,
 * which would misregister the track against the terrain beneath it. */
function renderTiledTrack(segments) {
  const NS = 'http://www.w3.org/2000/svg';
  const spec = BASEMAPS[el.basemap.value] || BASEMAPS.opentopo;
  const PAD = 24;

  /* Raster tiles are fixed-size images, so this view is laid out in real CSS
   * pixels rather than viewBox units. */
  const W = Math.max(320, Math.min(el.plot.clientWidth || 900, 1400));
  const H = Math.round(W * 0.58);

  const bounds = boundsOf(segments);
  const z = fitZoom(bounds, W, H, PAD, spec.maxZoom);
  const worldTiles = Math.pow(2, z);

  const centreX = (lonToTileX(bounds.minLon, z) + lonToTileX(bounds.maxLon, z)) / 2;
  const centreY = (latToTileY(bounds.minLat, z) + latToTileY(bounds.maxLat, z)) / 2;
  const originX = centreX * TILE_SIZE - W / 2;   // world pixels at the top-left
  const originY = centreY * TILE_SIZE - H / 2;

  el.plot.className = 'plot map';
  el.plot.style.height = H + 'px';

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  el.plot.append(tiles);

  const x0 = Math.floor(originX / TILE_SIZE), x1 = Math.floor((originX + W) / TILE_SIZE);
  const y0 = Math.floor(originY / TILE_SIZE), y1 = Math.floor((originY + H) / TILE_SIZE);

  let requested = 0;
  let failed = 0;

  for (let ty = y0; ty <= y1 && requested < MAX_TILES; ty++) {
    if (ty < 0 || ty >= worldTiles) continue;     // nothing beyond the poles
    for (let tx = x0; tx <= x1 && requested < MAX_TILES; tx++) {
      const wrapped = ((tx % worldTiles) + worldTiles) % worldTiles;   // antimeridian
      const sub = spec.subdomains[Math.abs(tx + ty) % spec.subdomains.length];

      const img = document.createElement('img');
      img.src = spec.url(sub, z, wrapped, ty);
      img.alt = '';
      img.referrerPolicy = 'no-referrer';         // don't leak the page URL
      img.decoding = 'async';
      img.style.left = (tx * TILE_SIZE - originX) + 'px';
      img.style.top  = (ty * TILE_SIZE - originY) + 'px';
      img.addEventListener('error', () => {
        img.style.visibility = 'hidden';
        if (++failed === 1) {
          log('Some ' + spec.label + ' tiles did not load — offline, or the tile server declined.', 'warn');
        }
      });

      tiles.append(img);
      requested++;
    }
  }

  const project = (lat, lon) => [
    lonToTileX(lon, z) * TILE_SIZE - originX,
    latToTileY(lat, z) * TILE_SIZE - originY,
  ];

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Track over ' + spec.label);

  let drawn = 0;
  for (const seg of segments) {
    const pts = decimate(seg, 6000);
    const coords = pts.map(([lat, lon]) => {
      const [x, y] = project(lat, lon);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    /* A casing under the line — contour and hillshade rendering is busy, and a
     * bare stroke disappears into it. */
    for (const [stroke, width, opacity] of [['#ffffff', 5, 0.85], ['var(--track-map)', 2.4, 1]]) {
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', coords);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', stroke);
      line.setAttribute('stroke-width', String(width));
      line.setAttribute('stroke-opacity', String(opacity));
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.append(line);
    }
    drawn += pts.length;
  }

  addDot(svg, NS, project(...segments[0][0]), 'var(--ok)');
  const lastSeg = segments[segments.length - 1];
  addDot(svg, NS, project(...lastSeg[lastSeg.length - 1]), 'var(--danger)');

  el.plot.append(svg);

  renderAttribution(spec,
    'zoom ' + z + ' · ' + requested + ' tile(s) · ' +
    segments.length + ' segment(s), ' + drawn.toLocaleString() + ' point(s) · ' +
    'lat ' + bounds.minLat.toFixed(5) + '…' + bounds.maxLat.toFixed(5) + ' · ' +
    'lon ' + bounds.minLon.toFixed(5) + '…' + bounds.maxLon.toFixed(5));
}

/** Attribution is a licence condition of all three sources, not decoration. */
function renderAttribution(spec, caption) {
  el.attrib.textContent = '';

  for (const [text, href, linkText] of spec.attribution) {
    el.attrib.append(document.createTextNode(text));
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = linkText;
      el.attrib.append(a);
    }
  }

  if (caption) {
    el.attrib.append(document.createElement('br'));
    el.attrib.append(document.createTextNode(caption));
  }
}

function addDot(svg, NS, [x, y], color) {
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', y.toFixed(1));
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', color);
  svg.append(dot);
}

/** Evenly thin a point list so a 10k-point track stays a cheap polyline. */
function decimate(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/* ── Delete a GPX from the device ───────────────────────────────────────
 * There is no trash on a mass-storage volume: removeEntry() is immediate and
 * final, so this always confirms and never batches. */
async function deleteGpx(entry) {
  if (busy || !rootHandle) return;

  const path = devicePath(entry);

  const lines = [
    'Delete this file from the device?',
    '',
    '    ' + path,
    '    ' + formatBytes(entry.size) + ', modified ' + formatDate(entry.mtime),
    '',
  ];

  if (entry.where === 'Current') {
    lines.push('WARNING: this is the active recording. If the device is still');
    lines.push('logging, deleting it will discard the track in progress.');
    lines.push('');
  }

  lines.push('This cannot be undone — the volume has no trash.');
  lines.push('');
  lines.push('Note: the eTrex imports GPX into internal storage, so the track');
  lines.push('may still appear in Track Manager until the device is restarted.');

  if (!confirm(lines.join('\n'))) {
    log('Delete cancelled: ' + path);
    return;
  }

  busy = true;
  try {
    await entry.dir.removeEntry(entry.name);
    log('Deleted ' + path + ' (' + formatBytes(entry.size) + ')', 'ok');
    setStatus('Deleted ' + entry.name, 'ok');

    /* Don't leave the viewer showing a file that no longer exists. */
    if (viewing === path) {
      viewing = null;
      el.viewerCard.hidden = true;
      el.gpxTitle.textContent = '—';
      el.gpxStats.textContent = '';
      el.gpxNames.textContent = '';
      el.gpxWarnings.textContent = '';
      el.plot.textContent = '';
    }
  } catch (err) {
    fail('Could not delete ' + path, err);
    return;
  } finally {
    busy = false;
  }

  await scan();
}

/* ── Upload GPX ─────────────────────────────────────────────────────── */
async function uploadGpx() {
  if (busy || !rootHandle) return;
  const file = el.gpxInput.files && el.gpxInput.files[0];
  if (!file) return;

  /* The name comes from the editable field, but the allowlist is still the
   * gate — a typed name is no more trusted than a picked one. */
  const name = safeGpxName(el.gpxName.value);
  if (!name) {
    fail('Rejected filename "' + el.gpxName.value + '" — must match letters, digits, space, dot, underscore or hyphen, 1–64 chars, ending in .gpx.');
    return;
  }
  if (name !== file.name) {
    log('Renaming for the device: "' + file.name + '" → "' + name + '"');
  }

  busy = true;
  el.btnUpload.disabled = true;
  try {
    /* Validate before we touch the device. */
    const text = await file.text();
    const parsed = parseGpx(text);
    if (!parsed.ok) {
      fail('Not uploading — ' + parsed.error);
      return;
    }

    const warnings = ceilingWarnings(parsed.counts);
    if (warnings.length) {
      const proceed = confirm(
        'This file exceeds eTrex firmware limits:\n\n  • ' + warnings.join('\n  • ') +
        '\n\nThe device truncates silently past these. Upload anyway?');
      if (!proceed) { log('Upload cancelled at ceiling warning.', 'warn'); return; }
      for (const w of warnings) log('Ceiling warning: ' + w, 'warn');
    }

    const gpxDir = await getDir(rootHandle, ['Garmin', 'GPX'], true);

    const existing = await tryGetFile(gpxDir, name);
    if (existing) {
      const proceed = confirm('/Garmin/GPX/' + name + ' already exists on the device.\n\nOverwrite it?');
      if (!proceed) { log('Upload cancelled — would overwrite ' + name, 'warn'); return; }
    }

    const handle = await gpxDir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();

    const c = parsed.counts;
    log('Uploaded ' + name + ' (' + formatBytes(file.size) + ') → /Garmin/GPX/ — ' +
        c.tracks + ' track(s), ' + c.waypoints + ' waypoint(s), ' + c.routes + ' route(s).', 'ok');
    setStatus('Uploaded ' + name + ' to /Garmin/GPX/', 'ok');

    el.gpxInput.value = '';
    el.gpxName.value = '';
    el.renameRow.hidden = true;
    el.nameHint.textContent = '';
    el.nameHint.className = '';
    await scan();
  } catch (err) {
    fail('Upload failed', err);
  } finally {
    busy = false;
    updateTransferButtons();
  }
}

/* ── Install map ────────────────────────────────────────────────────────
 * Streamed: a Garmin gmapsupp.img is routinely over 1 GB, so the file is
 * piped chunk-by-chunk and never materialised in memory. */
function byteMeter(total, onProgress) {
  let loaded = 0;
  let lastPaint = 0;
  return new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - lastPaint > 100) { lastPaint = now; onProgress(loaded, total); }
      controller.enqueue(chunk);
    },
    flush() { onProgress(loaded, total); },
  });
}

function showProgress(loaded, total) {
  const pct = total ? (loaded / total) * 100 : 0;
  el.progressBar.style.width = pct.toFixed(2) + '%';
  el.progressText.textContent =
    formatBytes(loaded) + ' / ' + formatBytes(total) + '  (' + pct.toFixed(1) + '%)';
}

async function installMap() {
  if (busy || !rootHandle) return;
  const file = el.imgInput.files && el.imgInput.files[0];
  if (!file) return;

  if (!/\.img$/i.test(file.name)) {
    fail('Rejected "' + file.name + '" — expected a .img map image.');
    return;
  }

  busy = true;
  el.btnInstall.disabled = true;
  try {
    const garmin = await getDir(rootHandle, ['Garmin'], true);

    const existing = await tryGetFile(garmin, 'gmapsupp.img');
    let prompt = 'Write ' + file.name + ' (' + formatBytes(file.size) +
                 ') to /Garmin/gmapsupp.img on "' + rootHandle.name + '"?';
    if (existing) {
      const old = await existing.getFile();
      prompt = 'This will OVERWRITE the existing map on "' + rootHandle.name + '".\n\n' +
               'Current: ' + formatBytes(old.size) + ', modified ' + formatDate(old.lastModified) + '\n' +
               'New:     ' + file.name + ', ' + formatBytes(file.size) + '\n\nProceed?';
    }
    if (!confirm(prompt)) { log('Map install cancelled.', 'warn'); return; }

    el.progressWrap.hidden = false;
    showProgress(0, file.size);
    setStatus('Writing gmapsupp.img — do not unplug the device.', 'warn');
    log('Streaming ' + file.name + ' (' + formatBytes(file.size) + ') → /Garmin/gmapsupp.img');

    const handle = await garmin.getFileHandle('gmapsupp.img', { create: true });
    const writable = await handle.createWritable();

    const started = performance.now();
    /* pipeTo closes the writable stream on success, committing the file. */
    await file.stream()
      .pipeThrough(byteMeter(file.size, showProgress))
      .pipeTo(writable);

    const secs = (performance.now() - started) / 1000;
    showProgress(file.size, file.size);
    log('Map installed in ' + secs.toFixed(1) + ' s (' +
        formatBytes(file.size / Math.max(secs, 0.001)) + '/s).', 'ok');
    setStatus('Map installed. Eject the volume before unplugging.', 'ok');

    el.imgInput.value = '';
    await scan();
  } catch (err) {
    /* An aborted pipe leaves a .crswap temp file next to the target; Chrome
     * cleans it up, and the original gmapsupp.img is left untouched. */
    fail('Map install failed — the existing map was not replaced', err);
  } finally {
    busy = false;
    updateTransferButtons();
  }
}

function updateTransferButtons() {
  const connected = !!rootHandle;
  refreshExportEstimate();
  const picked = !!(el.gpxInput.files && el.gpxInput.files.length);
  el.btnUpload.disabled  = !connected || !picked || !safeGpxName(el.gpxName.value);
  el.btnInstall.disabled = !connected || !(el.imgInput.files && el.imgInput.files.length);
}

/* ── Garmin Custom Map export ───────────────────────────────────────────
 * The eTrex will not take raster tiles as a basemap — gmapsupp.img is a vector
 * format. The one place it accepts imagery is /Garmin/CustomMaps/*.kmz: JPEGs
 * plus a KML GroundOverlay georeferencing each. That is what this builds.
 *
 * Garmin stretches each overlay linearly between its LatLonBox edges, while
 * tiles are Mercator. Over one 1024 px block that mismatch peaks at ~5 cm at
 * z16 and ~21 cm at z15 — far below GPS error, so it is ignored here. */
const CM_BLOCK = 4;                 // source tiles per output image edge (4×256 = 1024)
const CM_FETCH_CONCURRENCY = 6;
const CM_JPEG_QUALITY = 0.75;

/* Measured against real OpenTopoMap tiles: contour-and-hillshade art costs
 * roughly 420 KB per megapixel at q0.75, so a full 1024×1024 overlay tile lands
 * near 440 KB. Used only to estimate the export size before committing. */
const CM_KB_PER_MEGAPIXEL = 420;

/* Inverse Web Mercator, for the GroundOverlay corners. */
const tileXToLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
const tileYToLat = (y, z) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / Math.pow(2, z)))) * 180) / Math.PI;

/** Track extent plus a margin in kilometres. */
function paddedBounds(segments, padKm) {
  const b = boundsOf(segments);
  const dLat = padKm / 110.574;
  const midLat = ((b.minLat + b.maxLat) / 2) * Math.PI / 180;
  const dLon = padKm / (111.320 * Math.max(Math.cos(midLat), 1e-6));
  return {
    minLat: b.minLat - dLat, maxLat: b.maxLat + dLat,
    minLon: b.minLon - dLon, maxLon: b.maxLon + dLon,
  };
}

/** Source-tile range and output-block count for an extent at a zoom. */
function customMapPlan(segments, z, padKm) {
  const b = paddedBounds(segments, padKm);
  const tx0 = Math.floor(lonToTileX(b.minLon, z));
  const tx1 = Math.floor(lonToTileX(b.maxLon, z));
  const ty0 = Math.floor(latToTileY(b.maxLat, z));
  const ty1 = Math.floor(latToTileY(b.minLat, z));

  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const blocksX = Math.ceil(cols / CM_BLOCK);
  const blocksY = Math.ceil(rows / CM_BLOCK);
  const midLat = ((b.minLat + b.maxLat) / 2) * Math.PI / 180;

  return {
    bounds: b, z, tx0, tx1, ty0, ty1, cols, rows,
    sourceTiles: cols * rows,
    kmzTiles: blocksX * blocksY,
    blocksX, blocksY,
    metresPerPixel: (156543.03392 * Math.cos(midLat)) / Math.pow(2, z),
    estimatedBytes: cols * rows * 65536 / 1e6 * CM_KB_PER_MEGAPIXEL * 1024,
    widthKm: (b.maxLon - b.minLon) * 111.320 * Math.cos(midLat),
    heightKm: (b.maxLat - b.minLat) * 110.574,
  };
}

/* ── Minimal ZIP writer (store only) ────────────────────────────────────
 * A KMZ is a ZIP. JPEGs are already compressed, so stored entries cost nothing
 * and save pulling in a deflate implementation. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const DOS_DATE = 0x0021;          // 1980-01-01; KMZ carries no meaningful mtime

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);              // version needed
    head.setUint16(6, 0, true);               // flags
    head.setUint16(8, 0, true);               // method 0 = store
    head.setUint16(10, 0, true);              // mod time
    head.setUint16(12, DOS_DATE, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, file.bytes.length, true);
    head.setUint32(22, file.bytes.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);

    parts.push(new Uint8Array(head.buffer), nameBytes, file.bytes);
    central.push({ nameBytes, crc, size: file.bytes.length, offset });
    offset += 30 + nameBytes.length + file.bytes.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);              // version made by
    head.setUint16(6, 20, true);              // version needed
    head.setUint16(8, 0, true);
    head.setUint16(10, 0, true);              // store
    head.setUint16(12, 0, true);
    head.setUint16(14, DOS_DATE, true);
    head.setUint32(16, entry.crc, true);
    head.setUint32(20, entry.size, true);
    head.setUint32(24, entry.size, true);
    head.setUint16(28, entry.nameBytes.length, true);
    head.setUint32(42, entry.offset, true);

    parts.push(new Uint8Array(head.buffer), entry.nameBytes);
    offset += 46 + entry.nameBytes.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, offset - centralStart, true);
  end.setUint32(16, centralStart, true);
  parts.push(new Uint8Array(end.buffer));

  return new Blob(parts, { type: 'application/vnd.google-earth.kmz' });
}

/* ── Export ─────────────────────────────────────────────────────────── */
const xmlEscape = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function fetchTile(url) {
  const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return createImageBitmap(await res.blob());
}

/** Bounded-concurrency map, so the tile server sees a queue and not a flood. */
async function runPool(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;

  const runner = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = null;
      }
      onProgress(++done, items.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG encode failed'))),
      'image/jpeg', quality);
  });
}

async function exportCustomMap() {
  if (busy || !rootHandle || !lastSegments || !lastSegments.length) return;

  const spec = BASEMAPS[el.basemap.value] || BASEMAPS.opentopo;
  const z = parseInt(el.exportZoom.value, 10);
  const padKm = parseFloat(el.exportPad.value);
  const budget = Math.max(1, Math.min(500, parseInt(el.exportBudget.value, 10) || 100));

  const name = safeKmzName(el.exportName.value);
  if (!name) {
    fail('Rejected filename "' + el.exportName.value + '" — letters, digits, space, dot, underscore or hyphen, 1–64 chars, ending in .kmz.');
    return;
  }

  const plan = customMapPlan(lastSegments, z, padKm);

  if (plan.kmzTiles > budget) {
    fail('This extent needs ' + plan.kmzTiles + ' Custom Map tiles, over the budget of ' +
         budget + '. Drop the detail level, trim the margin, or raise the budget if the device allows it.');
    return;
  }

  const proceed = confirm(
    'Build a Custom Map from ' + spec.label + ' imagery?\n\n' +
    '    area      ' + plan.widthKm.toFixed(1) + ' × ' + plan.heightKm.toFixed(1) + ' km\n' +
    '    detail    z' + z + ', ' + plan.metresPerPixel.toFixed(1) + ' m/pixel\n' +
    '    requests  ' + plan.sourceTiles + ' tiles from ' + spec.label + '\n' +
    '    result    ' + plan.kmzTiles + ' overlay tile(s), about ' + formatBytes(plan.estimatedBytes) + '\n' +
    '              → /Garmin/CustomMaps/' + name + '\n\n' +
    'This downloads from a donated, volunteer-run tile service. Keep exports to\n' +
    'areas you actually walk, and do not re-run them needlessly.');
  if (!proceed) { log('Custom Map export cancelled.', 'warn'); return; }

  busy = true;
  el.btnExport.disabled = true;
  el.exportProgressWrap.hidden = false;
  el.exportBar.style.width = '0%';

  try {
    /* 1 — fetch every source tile. */
    const wanted = [];
    for (let ty = plan.ty0; ty <= plan.ty1; ty++) {
      for (let tx = plan.tx0; tx <= plan.tx1; tx++) wanted.push({ tx, ty });
    }

    log('Custom Map: fetching ' + wanted.length + ' tile(s) from ' + spec.label + ' at z' + z + '…');

    const worldTiles = Math.pow(2, z);
    const bitmaps = new Map();
    let failedTiles = 0;

    await runPool(wanted, CM_FETCH_CONCURRENCY, async ({ tx, ty }) => {
      const wrapped = ((tx % worldTiles) + worldTiles) % worldTiles;
      const sub = spec.subdomains[Math.abs(tx + ty) % spec.subdomains.length];
      const bitmap = await fetchTile(spec.url(sub, z, wrapped, ty));
      bitmaps.set(tx + ',' + ty, bitmap);
      return true;
    }, (done, total) => {
      const pct = (done / total) * 70;                 // fetching is ~70% of the work
      el.exportBar.style.width = pct.toFixed(1) + '%';
      el.exportText.textContent = 'fetching tiles  ' + done + ' / ' + total;
    });

    failedTiles = wanted.length - bitmaps.size;
    if (failedTiles > 0) {
      const ratio = failedTiles / wanted.length;
      if (ratio > 0.02) {
        fail('Aborted: ' + failedTiles + ' of ' + wanted.length +
             ' tiles failed to download. A Custom Map with holes is worse than none.');
        return;
      }
      log(failedTiles + ' tile(s) failed; those patches will be blank.', 'warn');
    }

    /* 2 — stitch into ≤1024×1024 JPEGs and collect their georeferencing. */
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const overlays = [];
    const members = [];
    let built = 0;

    for (let by = plan.ty0; by <= plan.ty1; by += CM_BLOCK) {
      for (let bx = plan.tx0; bx <= plan.tx1; bx += CM_BLOCK) {
        const cols = Math.min(CM_BLOCK, plan.tx1 - bx + 1);
        const rows = Math.min(CM_BLOCK, plan.ty1 - by + 1);

        canvas.width = cols * 256;
        canvas.height = rows * 256;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const bitmap = bitmaps.get((bx + i) + ',' + (by + j));
            if (bitmap) ctx.drawImage(bitmap, i * 256, j * 256);
          }
        }

        const blob = await canvasToJpeg(canvas, CM_JPEG_QUALITY);
        const file = 'tiles/t_' + (bx - plan.tx0) + '_' + (by - plan.ty0) + '.jpg';
        members.push({ name: file, bytes: new Uint8Array(await blob.arrayBuffer()) });

        overlays.push({
          href: file,
          north: tileYToLat(by, z),
          south: tileYToLat(by + rows, z),
          west:  tileXToLon(bx, z),
          east:  tileXToLon(bx + cols, z),
        });

        built++;
        const pct = 70 + (built / plan.kmzTiles) * 25;
        el.exportBar.style.width = pct.toFixed(1) + '%';
        el.exportText.textContent = 'building overlays  ' + built + ' / ' + plan.kmzTiles;
      }
    }

    for (const bitmap of bitmaps.values()) bitmap.close();

    /* 3 — the KML, then the KMZ. */
    const title = name.replace(/\.kmz$/i, '');
    const kml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      '  <Document>',
      '    <name>' + xmlEscape(title) + '</name>',
      '    <description>' + xmlEscape(spec.label + ' z' + z + ' — built by eTrex Bridge') + '</description>',
    ];
    overlays.forEach((o, i) => {
      kml.push(
        '    <GroundOverlay>',
        '      <name>' + xmlEscape(title + ' ' + (i + 1)) + '</name>',
        '      <drawOrder>50</drawOrder>',
        '      <Icon><href>' + xmlEscape(o.href) + '</href></Icon>',
        '      <LatLonBox>',
        '        <north>' + o.north.toFixed(9) + '</north>',
        '        <south>' + o.south.toFixed(9) + '</south>',
        '        <east>'  + o.east.toFixed(9)  + '</east>',
        '        <west>'  + o.west.toFixed(9)  + '</west>',
        '      </LatLonBox>',
        '    </GroundOverlay>');
    });
    kml.push('  </Document>', '</kml>', '');

    /* doc.kml first, as Garmin expects the KML at the archive root. */
    members.unshift({ name: 'doc.kml', bytes: new TextEncoder().encode(kml.join('\n')) });

    const kmz = zipStore(members);
    el.exportBar.style.width = '97%';
    el.exportText.textContent = 'writing ' + formatBytes(kmz.size) + ' to the device…';

    const dir = await getDir(rootHandle, ['Garmin', 'CustomMaps'], true);

    const existing = await tryGetFile(dir, name);
    if (existing && !confirm('/Garmin/CustomMaps/' + name + ' already exists.\n\nOverwrite it?')) {
      log('Custom Map export cancelled — would overwrite ' + name, 'warn');
      return;
    }

    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await kmz.stream().pipeTo(writable);

    el.exportBar.style.width = '100%';
    el.exportText.textContent = formatBytes(kmz.size) + ' written';
    log('Custom Map written: /Garmin/CustomMaps/' + name + ' — ' + plan.kmzTiles +
        ' overlay tile(s), ' + formatBytes(kmz.size) + ', z' + z + ' (' +
        plan.metresPerPixel.toFixed(1) + ' m/px).', 'ok');
    setStatus('Custom Map installed. Restart the eTrex, then enable it under Setup → Map.', 'ok');

    await scan();
  } catch (err) {
    fail('Custom Map export failed', err);
  } finally {
    busy = false;
    el.btnExport.disabled = false;
  }
}

function refreshExportEstimate() {
  if (!lastSegments || !lastSegments.length) {
    el.exportEstimate.textContent = '';
    el.btnExport.disabled = true;
    return;
  }

  const z = parseInt(el.exportZoom.value, 10);
  const padKm = parseFloat(el.exportPad.value);
  const budget = Math.max(1, Math.min(500, parseInt(el.exportBudget.value, 10) || 100));
  const plan = customMapPlan(lastSegments, z, padKm);

  const over = plan.kmzTiles > budget;
  el.exportEstimate.className = over ? 'notice' : 'muted';
  el.exportEstimate.textContent =
    plan.widthKm.toFixed(1) + ' × ' + plan.heightKm.toFixed(1) + ' km at ' +
    plan.metresPerPixel.toFixed(1) + ' m/px · ' + plan.sourceTiles + ' tile request(s) · ' +
    plan.kmzTiles + ' of ' + budget + ' overlay tiles · ~' + formatBytes(plan.estimatedBytes) +
    (over ? ' — over budget. Lower the detail or trim the margin.' : '');

  el.btnExport.disabled = over || !rootHandle || !safeKmzName(el.exportName.value);
}

/* ── Basemap preference ─────────────────────────────────────────────────
 * Remembered locally so the choice survives a reload — but it defaults to off,
 * and a stored preference is the user's own earlier decision, not a default. */
const MAP_PREF_KEY = 'etrex-bridge.basemap';

function saveMapPrefs() {
  try {
    localStorage.setItem(MAP_PREF_KEY, JSON.stringify({
      on: el.tilesToggle.checked,
      which: el.basemap.value,
    }));
  } catch (err) { /* private mode, quota — the app works fine without it */ }
}

function loadMapPrefs() {
  try {
    const raw = localStorage.getItem(MAP_PREF_KEY);
    if (!raw) return;
    const pref = JSON.parse(raw);
    if (pref && typeof pref.which === 'string' && BASEMAPS[pref.which]) el.basemap.value = pref.which;
    /* Honour an explicit stored false — the toggle defaults on, and turning it
     * off is a decision that should survive a reload. */
    if (pref && typeof pref.on === 'boolean') el.tilesToggle.checked = pref.on;
  } catch (err) { /* ignore malformed state */ }
}

function updateMapControls() {
  const on = el.tilesToggle.checked;
  el.basemap.disabled = !on;
  const spec = BASEMAPS[el.basemap.value] || BASEMAPS.opentopo;
  el.mapNote.textContent = on
    ? 'On: tile requests tell ' + spec.label + ' roughly where this track is.'
    : 'Off: nothing leaves this machine.';
}

function onMapControlChange() {
  updateMapControls();
  saveMapPrefs();
  if (lastSegments) renderTrack(lastSegments);
}

/* ── Boot ───────────────────────────────────────────────────────────── */
async function init() {
  const reasons = [];
  if (!window.isSecureContext) {
    reasons.push('This page is not a secure context. Serve it over https:// or from http://localhost — file:// has an opaque origin and the API is not exposed there.');
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    reasons.push('window.showDirectoryPicker() is not available in this browser.');
  }

  if (reasons.length) {
    el.unsupported.hidden = false;
    el.unsupportedWhy.textContent = reasons.join(' ');
    log('Unsupported environment: ' + reasons.join(' '), 'error');
    return;
  }

  el.connectCard.hidden = false;
  log('Ready. Plug in the eTrex, then pick a volume.');

  el.btnConnect.addEventListener('click', connect);
  el.btnReconnect.addEventListener('click', reconnect);
  el.btnRefresh.addEventListener('click', scan);
  el.btnForget.addEventListener('click', forget);
  el.btnUpload.addEventListener('click', uploadGpx);
  el.btnInstall.addEventListener('click', installMap);
  el.gpxInput.addEventListener('change', suggestName);
  el.gpxName.addEventListener('input', () => { refreshNameHint(); updateTransferButtons(); });
  el.btnResetName.addEventListener('click', suggestName);
  el.imgInput.addEventListener('change', updateTransferButtons);
  el.btnClearLog.addEventListener('click', () => { el.log.textContent = ''; });
  el.tilesToggle.addEventListener('change', onMapControlChange);
  el.basemap.addEventListener('change', onMapControlChange);

  el.btnExport.addEventListener('click', exportCustomMap);
  for (const control of [el.exportZoom, el.exportPad, el.exportBudget, el.exportName]) {
    control.addEventListener('input', refreshExportEstimate);
    control.addEventListener('change', refreshExportEstimate);
  }

  loadMapPrefs();
  updateMapControls();
  updateTransferButtons();     // also settles the export button's initial state

  /* A stored handle only offers "Reconnect" — re-granting permission needs a
   * user gesture, so we never try to access the disk on load. */
  try {
    const stored = await idbGet();
    if (stored) {
      el.btnReconnect.hidden = false;
      el.btnForget.hidden = false;
      el.reconnectName.textContent = stored.name;
      const state = await stored.queryPermission({ mode: 'readwrite' });
      setStatus('Previously used "' + stored.name + '" (permission: ' + state + '). Click Reconnect.', 'idle');
      log('Found stored volume handle: ' + stored.name + ' (permission: ' + state + ')');
    }
  } catch (err) {
    log('Could not read stored handle: ' + err.message, 'warn');
  }
}

init();
