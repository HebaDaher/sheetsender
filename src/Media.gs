/**
 * Photos and videos for WhatsApp messages.
 *
 * The file is kept in the app administrator's Google Drive, in one folder the app made itself
 * ("Shop Follow-ups — photos and videos"). The app may only see files it made (permission "drive.file"), never the
 * rest of the Drive. Each workspace's Sheet has a "Media" tab with its files; nobody can use another workspace's file.
 *
 * Uploading: the page sends the file in parts of 2 MB (google.script.run cannot take very large arguments); each part
 * goes straight into a Drive "resumable upload", so nothing is kept in the meantime except the upload's address
 * (in the script cache, for 6 hours, bound to the person and workspace that started it).
 *
 * Limits are WhatsApp's own: photos JPG/PNG up to 5 MB, videos MP4/3GP up to 16 MB.
 */

const MEDIA = {
  CHUNK: 2 * 1024 * 1024,           // multiple of 256 KB, as Drive requires for every part except the last
  FOLDER_PROP: 'MEDIA_FOLDER',
  FOLDER_NAME: 'Shop Follow-ups — photos and videos (used by the app)',
  MAX_PER_SHOP: 60,
  TYPES: {
    'image/jpeg': { kind: 'image', max: 5 * 1024 * 1024, ext: '.jpg' },
    'image/png': { kind: 'image', max: 5 * 1024 * 1024, ext: '.png' },
    'video/mp4': { kind: 'video', max: 16 * 1024 * 1024, ext: '.mp4' },
    'video/3gpp': { kind: 'video', max: 16 * 1024 * 1024, ext: '.3gp' }
  },
  DRIVE: 'https://www.googleapis.com/drive/v3/files',
  UPLOAD: 'https://www.googleapis.com/upload/drive/v3/files'
};

function driveFetch_(url, opts) {
  opts = opts || {};
  opts.muteHttpExceptions = true;
  opts.followRedirects = false;
  opts.headers = Object.assign({ Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, opts.headers || {});
  return UrlFetchApp.fetch(url, opts);
}

function driveError_(res, what) {
  const code = res.getResponseCode();
  let msg = '';
  try { msg = (JSON.parse(res.getContentText()).error || {}).message || ''; } catch (e) { msg = ''; }
  if (code === 401 || code === 403 && /scope|insufficient|permission/i.test(msg)) {
    return new Error(what + ': the app is not allowed to use Google Drive yet. The app administrator must run Install.command again and click Allow (one time).');
  }
  return new Error(what + ' (Google Drive answered ' + code + (msg ? ': ' + msg : '') + '). Try again in a minute.');
}

function headerOf_(res, name) {
  const h = res.getHeaders() || {};
  const want = name.toLowerCase();
  const k = Object.keys(h).filter(function (x) { return x.toLowerCase() === want; })[0];
  return k ? String(h[k]) : '';
}

/** The app's own Drive folder (made once). */
function mediaFolder_(forceNew) {
  const props = sp_();
  let id = forceNew ? '' : String(props.getProperty(MEDIA.FOLDER_PROP) || '');
  if (id) return id;
  return withLock_(function () {
    id = forceNew ? '' : String(sp_().fresh(MEDIA.FOLDER_PROP) || '');
    if (id) return id;
    const res = driveFetch_(MEDIA.DRIVE + '?fields=id', { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ name: MEDIA.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
    if (res.getResponseCode() !== 200) throw driveError_(res, 'Could not make the photos folder in Google Drive');
    id = JSON.parse(res.getContentText()).id;
    sp_().setProperty(MEDIA.FOLDER_PROP, id);
    return id;
  });
}

function mediaRows_(ss) { return readTable_(ss, TABS.MEDIA); }

/**
 * The Media tab is in a Sheet its owner can edit, so its Drive id is never trusted alone: Drive itself must say the
 * file was made by the app for THIS workspace and shop (the name the app gave it) and is not in the bin.
 * Returns Drive's own size, md5 and type.
 */
function verifiedDriveFile_(m, wsId) {
  const bad = new Error('This photo or video was removed in the app.');
  if (!m || !/^[A-Za-z0-9_-]{1,200}$/.test(String(m.drive_id || ''))) throw bad;
  const res = driveFetch_(MEDIA.DRIVE + '/' + encodeURIComponent(m.drive_id) + '?fields=id,name,size,md5Checksum,mimeType,trashed', {});
  if (res.getResponseCode() === 404) throw bad;
  if (res.getResponseCode() !== 200) throw driveError_(res, 'Could not read the photo or video');
  const f = parseJson_(res.getContentText()) || {};
  if (f.trashed || String(f.name || '').indexOf(wsId + ' ' + m.shop_id + ' ') !== 0 || !MEDIA.TYPES[f.mimeType]) throw bad;
  return { size: Number(f.size) || 0, md5: String(f.md5Checksum || ''), mime: f.mimeType };
}

function publicMedia_(m) {
  return { media_id: m.media_id, shop_id: m.shop_id, name: m.name, mime: m.mime, kind: m.kind, size: Number(m.size) || 0,
    created_at: m.created_at, created_by: m.created_by };
}

function shopMedia_(ss, shopId) {
  if (!ss.getSheetByName(TABS.MEDIA)) return [];
  return mediaRows_(ss).rows.filter(function (m) { return m.shop_id === shopId && m.status !== 'removed' && m.drive_id; })
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
}

/** A photo/video of this shop (or an error the person understands). '' means "no photo or video". */
function mediaFor_(ss, shopId, mediaId) {
  mediaId = String(mediaId || '').trim();
  if (!mediaId) return null;
  const m = shopMedia_(ss, shopId).filter(function (r) { return r.media_id === mediaId; })[0];
  if (!m) throw new Error('The chosen photo or video was removed. Choose it again.');
  return m;
}

function cleanMediaName_(name, ext) {
  let n = String(name || '').replace(/[\u0000-\u001f\u007f\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return n || ('file' + ext);
}

/** Step 1: the page says what it will send; Drive gives an upload address. */
function startMediaUpload(shopId, info) {
  const ctx = requireUser_();
  info = info || {};
  const type = MEDIA.TYPES[String(info.mime || '').toLowerCase()];
  if (!type) throw new Error('This kind of file cannot be sent. Use a photo (JPG or PNG) or a video (MP4).');
  const size = Number(info.size);
  if (!(size > 0) || Math.floor(size) !== size) throw new Error('The file is empty.');
  if (size > type.max) {
    throw new Error(type.kind === 'image' ? 'This photo is bigger than 5 MB (WhatsApp\'s limit). Make it smaller and try again.'
      : 'This video is bigger than 16 MB (WhatsApp\'s limit). Make it shorter or smaller and try again.');
  }
  findShop_(ctx.ss, shopId);
  if (shopMedia_(ctx.ss, shopId).length >= MEDIA.MAX_PER_SHOP) {
    throw new Error('This shop already has ' + MEDIA.MAX_PER_SHOP + ' photos and videos. Remove some you no longer need first.');
  }
  rateLimit_('mediaup_' + ctx.email, 30);
  const name = cleanMediaName_(info.name, type.ext);
  const start = function (folder) {
    return driveFetch_(MEDIA.UPLOAD + '?uploadType=resumable&fields=id,size,md5Checksum,mimeType', {
      method: 'post', contentType: 'application/json; charset=UTF-8',
      headers: { 'X-Upload-Content-Type': String(info.mime).toLowerCase(), 'X-Upload-Content-Length': String(size) },
      payload: JSON.stringify({ name: WS.id + ' ' + shopId + ' ' + name, parents: [folder], mimeType: String(info.mime).toLowerCase() })
    });
  };
  let res = start(mediaFolder_());
  if (res.getResponseCode() === 404) res = start(mediaFolder_(true)); // the folder was deleted in Drive: make it again
  const loc = headerOf_(res, 'Location');
  if (res.getResponseCode() !== 200 || !/^https:\/\/www\.googleapis\.com\/upload\/drive\//.test(loc)) throw driveError_(res, 'Could not start the upload');
  const id = 'MU' + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('MUP_' + id, JSON.stringify({ loc: loc, ws: WS.id, by: ctx.email, shop: shopId, name: name,
    mime: String(info.mime).toLowerCase(), kind: type.kind, size: size, got: 0 }), 21600);
  return { uploadId: id, chunk: MEDIA.CHUNK };
}

/** The first bytes must really be a JPG / PNG / MP4 / 3GP (not just named like one). */
function looksLike_(mime, bytes) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (mime === 'image/jpeg') return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  if (mime === 'image/png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
  return String.fromCharCode(b(4), b(5), b(6), b(7)) === 'ftyp'; // MP4 / 3GP
}

/** Step 2 (repeated): one part of the file. The last part saves the photo/video and returns it. */
function uploadMediaChunk(uploadId, offset, base64) {
  const ctx = requireUser_();
  const cache = CacheService.getScriptCache();
  const key = 'MUP_' + String(uploadId || '');
  offset = Number(offset);
  // Claim this part (two calls for the same part at once: only one goes on).
  const up = withLock_(function () {
    const u = parseJson_(cache.get(key) || '');
    if (!u || !u.loc || u.ws !== WS.id || u.by !== ctx.email) throw new Error('This upload expired. Choose the file again.');
    if (offset !== u.got || (u.busy && Date.now() - u.busy < 120000)) throw new Error('Part of the upload was lost. Choose the file again.');
    u.busy = Date.now();
    cache.put(key, JSON.stringify(u), 21600);
    return u;
  });
  const bytes = Utilities.base64Decode(String(base64 || ''));
  const end = offset + bytes.length;
  if (!bytes.length || end > up.size || (end < up.size && bytes.length % (256 * 1024) !== 0)) throw new Error('The upload went wrong. Choose the file again.');
  if (offset === 0 && !looksLike_(up.mime, bytes)) {
    cache.remove(key);
    throw new Error('This file is not really a ' + (up.kind === 'image' ? 'JPG or PNG photo' : 'MP4 video') + '. Save it again as one and try again.');
  }
  const res = driveFetch_(up.loc, { method: 'put', contentType: up.mime, payload: bytes,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + up.size } });
  const code = res.getResponseCode();
  if (end < up.size) {
    if (code !== 308) { cache.remove(key); throw driveError_(res, 'The upload stopped'); }
    up.got = end; up.busy = 0;
    cache.put(key, JSON.stringify(up), 21600);
    return { got: end, done: false };
  }
  if (code !== 200 && code !== 201) { cache.remove(key); throw driveError_(res, 'The upload did not finish'); }
  const file = parseJson_(res.getContentText());
  cache.remove(key);
  if (!file || !file.id || Number(file.size) !== up.size) throw new Error('The upload did not finish completely. Try again.');
  return withLock_(function () {
    const table = mediaRows_(ctx.ss);
    const same = table.rows.filter(function (r) { return r.drive_id === file.id; })[0];
    if (same) return { done: true, media: publicMedia_(same) };
    const row = { media_id: newId_('P'), shop_id: up.shop, name: up.name, mime: up.mime, size: String(up.size), kind: up.kind,
      drive_id: file.id, md5: String(file.md5Checksum || ''), created_at: nowIso_(), created_by: ctx.email,
      meta_id: '', meta_uploaded_at: '', meta_pnid: '', status: '' };
    appendRows_(table, [row]);
    return { done: true, media: publicMedia_(row) };
  });
}

/** Removes a photo/video from the list (and moves the file to the Drive bin). Sends already done are not affected. */
function removeMedia(shopId, mediaId) {
  const ctx = requireUser_();
  return withLock_(function () {
    const table = mediaRows_(ctx.ss);
    const m = table.rows.filter(function (r) { return r.media_id === mediaId && r.shop_id === shopId && r.status !== 'removed'; })[0];
    if (!m) throw new Error('That photo or video was not found. Reload the page.');
    const busy = readTable_(ctx.ss, TABS.CAMPAIGNS).rows.some(function (k) {
      return k.media_id === mediaId && (k.status === 'running' || k.status === 'paused');
    });
    if (busy) throw new Error('A send that is still running uses this photo or video. Stop it (or wait until it finishes) first.');
    m.status = 'removed';
    updateRow_(table, m);
    try {
      verifiedDriveFile_(m, WS.id); // only ever the file the app made for this workspace
      if (!mediaRows_(ctx.ss).rows.some(function (r) { return r.drive_id === m.drive_id && r.status !== 'removed'; })) {
        driveFetch_(MEDIA.DRIVE + '/' + encodeURIComponent(m.drive_id), { method: 'patch', contentType: 'application/json', payload: JSON.stringify({ trashed: true }) });
      }
    } catch (e) { /* the list entry is gone either way */ }
    return true;
  });
}

/** What the Mac helper needs to fetch the file (no Drive address, no secrets). */
function mediaForJob_(m) {
  if (!m) return null;
  return { media_id: m.media_id, name: m.name, mime: m.mime, kind: m.kind, size: Number(m.size) || 0, md5: m.md5 || '' };
}

/** Bridge: one part (base64) of a workspace's photo/video for its Mac helper. */
function bridgeMediaPart_(ws, mediaId, offset) {
  const ss = SpreadsheetApp.openById(ws.sheet_id);
  if (!ss.getSheetByName(TABS.MEDIA)) throw new Error('This photo or video was removed in the app.');
  const m = mediaRows_(ss).rows.filter(function (r) { return r.media_id === String(mediaId || '') && r.status !== 'removed' && r.drive_id; })[0];
  if (!m) throw new Error('This photo or video was removed in the app.');
  const size = verifiedDriveFile_(m, ws.id).size;
  offset = Math.floor(Number(offset) || 0);
  if (offset < 0 || offset >= size) throw new Error('bad offset');
  const end = Math.min(size, offset + MEDIA.CHUNK) - 1;
  const res = driveFetch_(MEDIA.DRIVE + '/' + encodeURIComponent(m.drive_id) + '?alt=media', { headers: { Range: 'bytes=' + offset + '-' + end } });
  if (res.getResponseCode() !== 206 && res.getResponseCode() !== 200) throw driveError_(res, 'Could not read the photo or video');
  let bytes = res.getContent();
  if (res.getResponseCode() === 200) bytes = bytes.slice(offset, end + 1); // server ignored Range
  return { data: Utilities.base64Encode(bytes), offset: offset, size: size };
}

/* ---------------- WhatsApp Business API: the file is uploaded to Meta, which returns an id valid for 30 days ---------------- */

const META_MEDIA_DAYS = 25; // upload again before Meta forgets it

/** Forgets Meta's copy so it is uploaded again. Returns 'recent' (and forgets nothing) if it was uploaded within recentMs. */
function forgetMetaMedia_(ss, mediaId, recentMs) {
  const table = mediaRows_(ss);
  const m = table.rows.filter(function (r) { return r.media_id === mediaId; })[0];
  if (!m || !m.meta_id) return '';
  if (recentMs && Date.now() - new Date(m.meta_uploaded_at || 0).getTime() < recentMs) return 'recent';
  m.meta_id = ''; m.meta_uploaded_at = ''; updateRow_(table, m);
  return 'forgot';
}

/** Returns the Meta media id for this photo/video (uploads it when needed). Throws a clear error otherwise. */
function metaMediaId_(ss, mediaId, cfg, token) {
  const table = mediaRows_(ss);
  const m = table.rows.filter(function (r) { return r.media_id === mediaId && r.drive_id; })[0];
  if (!m || m.status === 'removed') throw new Error('The photo or video of this send was removed.');
  const fresh = m.meta_id && m.meta_pnid === String(cfg.phone_number_id) &&
    Date.now() - new Date(m.meta_uploaded_at || 0).getTime() < META_MEDIA_DAYS * 86400000;
  if (fresh) return m.meta_id;
  const f = verifiedDriveFile_(m, WS.id);
  const res = driveFetch_(MEDIA.DRIVE + '/' + encodeURIComponent(m.drive_id) + '?alt=media', {});
  if (res.getResponseCode() !== 200) throw driveError_(res, 'Could not read the photo or video');
  const blob = res.getBlob().setContentType(f.mime).setName('file' + MEDIA.TYPES[f.mime].ext);
  let r;
  try {
    const up = UrlFetchApp.fetch(WA_API.BASE + cfg.phone_number_id + '/media', { method: 'post', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token }, payload: { messaging_product: 'whatsapp', type: f.mime, file: blob } });
    r = { code: up.getResponseCode(), body: parseJson_(up.getContentText()) };
  } catch (e) {
    r = { code: 0, body: { error: { message: 'Could not reach Meta (' + (e && e.message ? e.message : e) + ')' } } };
  }
  if (r.code !== 200 || !r.body || !r.body.id) {
    const err = new Error('Meta did not accept the ' + (m.kind === 'video' ? 'video' : 'photo') + ': ' + graphError_(r).message);
    err.graph = graphError_(r);
    throw err;
  }
  m.meta_id = String(r.body.id); m.meta_pnid = String(cfg.phone_number_id); m.meta_uploaded_at = nowIso_();
  updateRow_(table, m);
  return m.meta_id;
}
