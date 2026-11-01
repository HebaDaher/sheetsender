// Official Meta WhatsApp Business Platform (Cloud API).
// Business-initiated messages MUST use an approved template. Free-form messages (including extra
// media) are only allowed inside the 24-hour customer service window (after the contact messages you).
import fs from 'node:fs';
import { config } from './config.js';
import { getAccessToken, getAccount } from './accounts.js';
import { request, ProviderError } from './http.js';
import { one, run } from './db.js';
import { mediaPath, WA_TYPES } from './media.js';

const G = () => `https://graph.facebook.com/${config.meta.apiVersion}`;

const AUTH_CODES = new Set([190, 102, 10, 200]);
const ACCOUNT_CODES = new Set([131031, 131042, 368, 131045]);
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
export const WA_ERROR_HELP = {
  131026: 'This number cannot receive the message (not on WhatsApp, old app version, or has not accepted the new Terms).',
  131030: 'Your WhatsApp test number can only message numbers added to its allowed list in Meta (WhatsApp → API Setup → To).',
  131047: 'More than 24 hours since this contact last messaged you, so only template messages are allowed.',
  131049: 'Meta did not deliver this marketing message to protect user experience (per-user marketing limit). Try later.',
  131050: 'The contact has stopped marketing messages from your business.',
  132000: 'The number of template variables does not match the approved template. Check the Message Templates page.',
  132001: 'The template does not exist in this language or is not approved yet.',
  132012: 'A template variable is in the wrong format (e.g. header media missing).',
  131051: 'This message type is not supported.',
  131053: 'WhatsApp could not use the uploaded media (wrong format or size).',
  133010: 'This phone number is not registered on the WhatsApp Business Platform.',
  131042: 'Payment problem on the WhatsApp Business account. Add or fix the payment method in Meta Business Settings.',
  131031: 'The WhatsApp Business account is locked or restricted by Meta.',
};

function classify(e) {
  if (!(e instanceof ProviderError)) return e;
  const c = Number(e.code);
  if (AUTH_CODES.has(c) || e.status === 401) e.kind = 'auth';
  else if (ACCOUNT_CODES.has(c)) e.kind = 'account';
  else if (TRANSIENT_CODES.has(c) || e.status >= 500) e.kind = 'transient';
  else if (e.kind !== 'transient' && e.kind !== 'rate_limit') e.kind = 'permanent';
  if (WA_ERROR_HELP[c]) e.message += ' — ' + WA_ERROR_HELP[c];
  return e;
}

async function api(account, path, opts = {}) {
  const t = await getAccessToken(account.id);
  try { return await request('WhatsApp', `${G()}/${path}`, { ...opts, headers: { authorization: `Bearer ${t}`, ...(opts.headers || {}) } }); }
  catch (e) { throw classify(e); }
}

export async function waTest(account) {
  const info = account.info || {};
  const p = await api(account, `${info.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,name_status`);
  const tpl = await api(account, `${info.waba_id}/message_templates?fields=name&limit=1`);
  run('UPDATE accounts SET info=? WHERE id=?', JSON.stringify({ ...info, display_phone_number: p.display_phone_number, verified_name: p.verified_name, quality_rating: p.quality_rating }), account.id);
  return `Connected to ${p.verified_name} (${p.display_phone_number}), quality: ${p.quality_rating || 'n/a'}. Templates readable${tpl.data ? '' : ''}.`;
}

// Validates credentials before saving (used by the Connect form).
export async function waProbe({ phone_number_id, waba_id, access_token }) {
  const headers = { authorization: `Bearer ${access_token}` };
  try {
    const p = await request('WhatsApp', `${G()}/${phone_number_id}?fields=display_phone_number,verified_name`, { headers });
    await request('WhatsApp', `${G()}/${waba_id}/message_templates?fields=name&limit=1`, { headers });
    return p;
  } catch (e) { throw classify(e); }
}

export async function listTemplates(accountId) {
  const a = getAccount(accountId);
  const out = [];
  let url = `${a.info.waba_id}/message_templates?fields=name,language,status,category,components&limit=100`;
  for (let i = 0; i < 10 && url; i++) {
    const r = await api(a, url);
    out.push(...(r.data || []));
    url = r.paging?.next ? r.paging.next.replace(`${G()}/`, '') : null;
  }
  return out.map((t) => describeTemplate(t));
}

// Summarises an approved template: header type and how many {{n}} variables each part needs.
export function describeTemplate(t) {
  const comps = t.components || [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const count = (txt) => new Set([...String(txt || '').matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1])).size;
  const named = (txt) => [...new Set([...String(txt || '').matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]))];
  const urlButtons = (comps.find((c) => c.type === 'BUTTONS')?.buttons || []).map((b, i) => ({ index: i, type: b.type, dynamic: b.type === 'URL' && /\{\{/.test(b.url || ''), url: b.url })).filter((b) => b.dynamic);
  return {
    name: t.name, language: t.language, status: t.status, category: t.category,
    parameter_format: t.parameter_format || (named(body?.text).length ? 'NAMED' : 'POSITIONAL'),
    header_format: header?.format || 'NONE', header_text: header?.text || '', header_params: header?.format === 'TEXT' ? count(header.text) : 0,
    body_text: body?.text || '', body_params: count(body?.text), body_param_names: named(body?.text),
    url_buttons: urlButtons,
  };
}

// Uploads a library file to WhatsApp (cached for 29 days; WhatsApp keeps media IDs for 30 days).
export async function uploadMedia(account, m) {
  const c = one('SELECT wa_media_id, expires_at FROM wa_media_cache WHERE media_id=? AND account_id=?', m.id, account.id);
  if (c && c.expires_at > Date.now()) return c.wa_media_id;
  const t = WA_TYPES[m.mime];
  if (!t) throw new ProviderError(`WhatsApp does not accept ${m.mime}`, { kind: 'permanent' });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', m.mime);
  form.append('file', new Blob([fs.readFileSync(mediaPath(m))], { type: m.mime }), m.filename);
  const r = await api(account, `${account.info.phone_number_id}/media`, { method: 'POST', body: form, timeout: 180000 });
  run('INSERT INTO wa_media_cache (media_id, account_id, wa_media_id, expires_at) VALUES (?,?,?,?) ON CONFLICT(media_id, account_id) DO UPDATE SET wa_media_id=excluded.wa_media_id, expires_at=excluded.expires_at',
    m.id, account.id, r.id, Date.now() + 29 * 86400000);
  return r.id;
}

export async function sendTemplate(account, to, { name, language, headerMedia, headerType, headerTexts = [], bodyParams = [], bodyParamNames = [], urlButtonParams = [] }) {
  const components = [];
  if (headerType && headerType !== 'NONE' && headerType !== 'TEXT') {
    if (!headerMedia) throw new ProviderError(`This template needs a ${headerType.toLowerCase()} in its header — choose one on the Message Templates page`, { kind: 'permanent' });
    const id = await uploadMedia(account, headerMedia);
    const k = headerType.toLowerCase();
    const p = { type: k, [k]: { id } };
    if (k === 'document') p.document.filename = headerMedia.filename;
    components.push({ type: 'header', parameters: [p] });
  } else if (headerType === 'TEXT' && headerTexts.length) {
    components.push({ type: 'header', parameters: headerTexts.map((t) => ({ type: 'text', text: t })) });
  }
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((t, i) => ({ type: 'text', text: String(t || '-').slice(0, 1024), ...(bodyParamNames[i] ? { parameter_name: bodyParamNames[i] } : {}) })) });
  }
  for (const b of urlButtonParams) components.push({ type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: b.text }] });
  const r = await api(account, `${account.info.phone_number_id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace('+', ''), type: 'template', template: { name, language: { code: language }, components } }),
  });
  return r.messages?.[0]?.id;
}

// Free-form media message — only valid inside the 24-hour customer service window.
export async function sendMedia(account, to, m) {
  const t = WA_TYPES[m.mime];
  const id = await uploadMedia(account, m);
  const obj = { id };
  if (t.type === 'document') obj.filename = m.filename;
  if (t.type !== 'audio' && m.title && m.title !== m.filename) obj.caption = m.title.slice(0, 1024);
  const r = await api(account, `${account.info.phone_number_id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace('+', ''), type: t.type, [t.type]: obj }),
  });
  return r.messages?.[0]?.id;
}

export function inServiceWindow(phone) {
  const r = one('SELECT last_inbound_at FROM wa_inbound WHERE phone=?', phone);
  return !!(r && Date.now() - r.last_inbound_at < 23.5 * 3600 * 1000);
}
