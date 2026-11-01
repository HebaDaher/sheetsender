// Per-shop media library. Files are stored privately on the server and only reachable through
// signed, expiring download links. Each file belongs to exactly one shop.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all, one, run } from './db.js';
import { sign, randomId } from './crypto.js';

export const MEDIA_DIR = path.join(config.dataDir, 'media');

// WhatsApp Cloud API supported types and size limits (official Media reference).
const MB = 1024 * 1024;
export const WA_TYPES = {
  'image/jpeg': { type: 'image', max: 5 * MB }, 'image/png': { type: 'image', max: 5 * MB },
  'video/mp4': { type: 'video', max: 16 * MB }, 'video/3gpp': { type: 'video', max: 16 * MB },
  'audio/aac': { type: 'audio', max: 16 * MB }, 'audio/amr': { type: 'audio', max: 16 * MB }, 'audio/mpeg': { type: 'audio', max: 16 * MB },
  'audio/mp4': { type: 'audio', max: 16 * MB }, 'audio/ogg': { type: 'audio', max: 16 * MB },
  'application/pdf': { type: 'document', max: 100 * MB }, 'text/plain': { type: 'document', max: 100 * MB },
  'application/msword': { type: 'document', max: 100 * MB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { type: 'document', max: 100 * MB },
  'application/vnd.ms-excel': { type: 'document', max: 100 * MB },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { type: 'document', max: 100 * MB },
  'application/vnd.ms-powerpoint': { type: 'document', max: 100 * MB },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { type: 'document', max: 100 * MB },
};

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
export const mimeFor = (filename) => EXT_MIME[String(filename).split('.').pop().toLowerCase()] || 'application/octet-stream';

export function kindLabel(m) {
  if (m.kind === 'link') return 'Website link';
  if (m.mime.startsWith('image/')) return 'Picture';
  if (m.mime.startsWith('video/')) return 'Video';
  if (m.mime.startsWith('audio/')) return 'Audio';
  if (m.mime === 'application/pdf') return 'PDF';
  if (/spreadsheet|ms-excel/.test(m.mime)) return 'Excel';
  if (/word/.test(m.mime)) return 'Word';
  if (/presentation|powerpoint/.test(m.mime)) return 'Presentation';
  return 'File';
}

// Can this item be sent as a WhatsApp media message? Returns { ok, type } or { ok:false, reason, alternative }.
export function whatsappSupport(m) {
  if (m.kind === 'link') return { ok: true, type: 'link', note: 'Sent as a link inside the message' };
  const t = WA_TYPES[m.mime];
  if (!t) return { ok: false, reason: `WhatsApp does not accept ${m.mime} files`, alternative: 'Will be sent as a secure download link instead' };
  if (m.size > t.max) return { ok: false, reason: `Too large for WhatsApp (${(m.size / MB).toFixed(1)} MB; limit ${t.max / MB} MB for ${t.type})`, alternative: 'Will be sent as a secure download link instead' };
  return { ok: true, type: t.type };
}

export function listMedia(shopId) {
  return all('SELECT * FROM media WHERE shop_id = ? ORDER BY id DESC', shopId).map((m) => ({ ...m, label: kindLabel(m), whatsapp: whatsappSupport(m) }));
}
export function getMedia(shopId, id) { return one('SELECT * FROM media WHERE id = ? AND shop_id = ?', id, shopId); }

export function selection(shopId, channel) {
  return all(`SELECT m.* FROM media_selection s JOIN media m ON m.id = s.media_id
              WHERE s.shop_id = ? AND s.channel = ? AND m.shop_id = s.shop_id ORDER BY s.position`, shopId, channel);
}
export function setSelection(shopId, channel, ids) {
  run('DELETE FROM media_selection WHERE shop_id = ? AND channel = ?', shopId, channel);
  ids.forEach((id, i) => {
    if (getMedia(shopId, id)) run('INSERT INTO media_selection (shop_id, channel, media_id, position) VALUES (?,?,?,?)', shopId, channel, id, i);
  });
}

export function storeUpload(shopId, filename, mime, tmpPath, size) {
  const safe = String(filename).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file';
  const storage = `${shopId}-${randomId(12)}-${safe.replace(/\s+/g, '_')}`;
  fs.renameSync(tmpPath, path.join(MEDIA_DIR, storage));
  return Number(run('INSERT INTO media (shop_id, kind, title, filename, mime, size, storage_name) VALUES (?,?,?,?,?,?,?)',
    shopId, 'file', safe, safe, mime || mimeFor(safe), size, storage).lastInsertRowid);
}
export function addLink(shopId, title, url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Links must start with http:// or https://');
  return Number(run('INSERT INTO media (shop_id, kind, title, url, mime, size) VALUES (?,?,?,?,?,0)', shopId, 'link', title || url, url, 'text/uri-list').lastInsertRowid);
}
export function deleteMedia(shopId, id) {
  const m = getMedia(shopId, id);
  if (!m) return;
  run('DELETE FROM media WHERE id = ?', id);
  if (m.storage_name) fs.rmSync(path.join(MEDIA_DIR, m.storage_name), { force: true });
}
export const mediaPath = (m) => path.join(MEDIA_DIR, m.storage_name);

// Signed link valid for 90 days (people often open emails later).
export function downloadLink(m, days = 90) {
  if (m.kind === 'link') return m.url;
  return `${config.baseUrl}/f/${sign({ m: m.id, s: m.shop_id, exp: Date.now() + days * 86400000 })}`;
}
