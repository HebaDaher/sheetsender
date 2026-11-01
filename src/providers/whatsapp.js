// Official WhatsApp Business Platform (Cloud API) — sending templates, media, opt-out handling.
import crypto from 'node:crypto';
import { config } from '../config.js';

export class WaError extends Error {
  constructor(status, err = {}, retryAfterSec) {
    super(err.error_user_msg || err.error_data?.details || err.message || `WhatsApp request failed (${status})`);
    this.status = status; this.code = err.code; this.subcode = err.error_subcode; this.title = err.title || err.error_user_title;
    this.details = err.error_data?.details; this.retryAfterSec = retryAfterSec;
  }
}

function retryAfterFrom(res) {
  const ra = Number(res.headers.get('retry-after'));
  if (ra > 0) return ra;
  for (const h of ['x-business-use-case-usage', 'x-app-usage']) {
    const v = res.headers.get(h); if (!v) continue;
    try {
      const obj = JSON.parse(v);
      const list = Array.isArray(obj) ? obj : Object.values(obj).flat();
      const mins = Math.max(0, ...list.map((x) => Number(x?.estimated_time_to_regain_access || 0)));
      if (mins > 0) return mins * 60;
    } catch {}
  }
  return undefined;
}

export async function graph(token, method, path, { query, body, form } = {}) {
  const url = new URL(`${config.graphBase}/${config.graphVersion}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new WaError(0, { message: `Could not reach WhatsApp (${e.cause?.code || e.message})`, code: 'network' });
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.error) throw new WaError(res.status, data.error || {}, retryAfterFrom(res));
  return data;
}

export function parseLimit(v) {
  if (!v) return null;
  const s = String(v).toUpperCase();
  if (s.includes('UNLIMITED')) return Infinity;
  const m = s.match(/(\d+)\s*(K)?/);
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
}

// Checks that the token, number and business account all work and belong together.
export async function checkSender({ token, phone_number_id, waba_id }) {
  const base = 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status';
  let num;
  try {
    num = await graph(token, 'GET', phone_number_id, { query: { fields: `${base},whatsapp_business_manager_messaging_limit` } });
  } catch (e) {
    if (Number(e.code) !== 100 || !/field/i.test(e.message)) throw e;
    num = await graph(token, 'GET', phone_number_id, { query: { fields: base } }); // older API version without the portfolio limit field
  }
  const list = await graph(token, 'GET', `${waba_id}/phone_numbers`, { query: { fields: 'id', limit: '100' } });
  if (!(list.data || []).some((p) => String(p.id) === String(phone_number_id))) {
    throw new WaError(400, { message: 'This phone number ID does not belong to that WhatsApp Business Account ID. Copy both from the same WhatsApp → API Setup page.' });
  }
  await graph(token, 'GET', `${waba_id}/message_templates`, { query: { limit: '1', fields: 'name' } });
  let subscribed = true;
  try { await graph(token, 'POST', `${waba_id}/subscribed_apps`); } catch { subscribed = false; }
  return {
    display_phone: num.display_phone_number, verified_name: num.verified_name, quality: num.quality_rating,
    limit_raw: num.whatsapp_business_manager_messaging_limit || null, limit: parseLimit(num.whatsapp_business_manager_messaging_limit),
    number_status: num.status || num.code_verification_status || '', name_status: num.name_status || '', app_subscribed: subscribed,
  };
}

export async function listTemplates({ token, waba_id }) {
  const out = []; let after;
  for (let i = 0; i < 10; i++) {
    const query = { fields: 'name,language,status,category,components,parameter_format', limit: '100' };
    if (after) query.after = after;
    const r = await graph(token, 'GET', `${waba_id}/message_templates`, { query });
    out.push(...(r.data || []));
    after = r.paging?.cursors?.after;
    if (!r.paging?.next || !after) break;
  }
  return out;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const varsIn = (text) => [...new Set([...String(text || '').matchAll(VAR_RE)].map((m) => m[1]))];
const OPT_OUT_BUTTON = /stop|unsubscribe|opt.?out|no more|إيقاف|ايقاف|الغاء|إلغاء|توقف|أوقف|اوقف/i;
const OPT_OUT_TEXT = /\bstop\b|unsubscribe|opt.?out|إلغاء الاشتراك|الغاء الاشتراك|توقف|إيقاف|ايقاف/i;

// Works out what a template needs (variables, header media) and whether this app can send it.
export function analyzeTemplate(t) {
  const comps = t.components || [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const footer = comps.find((c) => c.type === 'FOOTER');
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const named = t.parameter_format === 'NAMED';
  const vars = [];
  let reason = null;
  if (t.status !== 'APPROVED') reason = `This template is ${String(t.status || '').toLowerCase()} — only APPROVED templates can be sent.`;
  if (t.category === 'AUTHENTICATION') reason = 'Authentication (one-time code) templates cannot be used for campaigns.';
  if (comps.some((c) => !['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))) reason = 'This template uses a special layout (carousel or limited-time offer) that this app does not send.';
  const headerFormat = header ? header.format : null;
  if (headerFormat && !['TEXT', 'IMAGE', 'VIDEO'].includes(headerFormat)) reason = `Templates with a ${headerFormat.toLowerCase()} header are not supported here. Use one with no header, a text header, an image or a video.`;
  if (headerFormat === 'TEXT') varsIn(header.text).forEach((n) => vars.push({ component: 'header', name: n, named }));
  varsIn(body?.text).forEach((n) => vars.push({ component: 'body', name: n, named }));
  buttons.forEach((b, i) => {
    if (b.type === 'URL' && varsIn(b.url).length) vars.push({ component: 'button', index: i, name: varsIn(b.url)[0], named: false, fixedOnly: true });
    else if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.type)) reason = reason || `Templates with a "${b.type}" button are not supported here.`;
  });
  const hasOptOut = buttons.some((b) => b.type === 'QUICK_REPLY' && OPT_OUT_BUTTON.test(b.text)) || OPT_OUT_TEXT.test(`${body?.text || ''}\n${footer?.text || ''}`);
  return {
    name: t.name, language: t.language, category: t.category, status: t.status, headerFormat, headerText: headerFormat === 'TEXT' ? header.text : null,
    bodyText: body?.text || '', footerText: footer?.text || '', buttons: buttons.map((b) => ({ type: b.type, text: b.text })),
    vars, named, hasOptOut, supported: !reason, reason,
  };
}

export function fillText(text, values, named) {
  return String(text || '').replace(VAR_RE, (_, n) => values[n] ?? `{{${n}}}`);
}

// values: { "header:1": "...", "body:1": "...", "button:0:1": "..." }
export function buildTemplateMessage(info, values, mediaId) {
  const components = [];
  const param = (v, name) => ({ type: 'text', text: String(v ?? '').slice(0, 1024) || '-', ...(info.named ? { parameter_name: name } : {}) });
  if (info.headerFormat === 'IMAGE' || info.headerFormat === 'VIDEO') {
    const kind = info.headerFormat.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: { id: mediaId } }] });
  } else if (info.headerFormat === 'TEXT') {
    const hv = info.vars.filter((v) => v.component === 'header');
    if (hv.length) components.push({ type: 'header', parameters: hv.map((v) => param(values[`header:${v.name}`], v.name)) });
  }
  const bv = info.vars.filter((v) => v.component === 'body');
  if (bv.length) components.push({ type: 'body', parameters: bv.map((v) => param(values[`body:${v.name}`], v.name)) });
  for (const v of info.vars.filter((x) => x.component === 'button')) {
    components.push({ type: 'button', sub_type: 'url', index: String(v.index), parameters: [{ type: 'text', text: String(values[`button:${v.index}:${v.name}`] ?? '') }] });
  }
  return { name: info.name, language: { code: info.language }, ...(components.length ? { components } : {}) };
}

export async function sendTemplate({ token, phone_number_id }, to, template) {
  const r = await graph(token, 'POST', `${phone_number_id}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template } });
  return r.messages?.[0]?.id;
}

export async function sendText({ token, phone_number_id }, to, text) {
  const r = await graph(token, 'POST', `${phone_number_id}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } } });
  return r.messages?.[0]?.id;
}

export async function uploadMedia({ token, phone_number_id }, { data, mime, filename }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([data], { type: mime }), filename);
  const r = await graph(token, 'POST', `${phone_number_id}/media`, { form });
  return r.id;
}

// Uses Meta's Resumable Upload API to get a sample-media handle (needed when creating a template with an image/video header).
async function sampleHandle({ token, app_id }, { data, mime, filename }) {
  const s = await graph(token, 'POST', `${app_id}/uploads`, { query: { file_name: filename, file_length: String(data.length), file_type: mime } });
  const url = `${config.graphBase}/${config.graphVersion}/${s.id}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: data, signal: AbortSignal.timeout(120000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.h) throw new WaError(res.status, out.error || { message: 'Uploading the sample image/video to Meta failed.' });
  return out.h;
}

// Creates a MARKETING template with the customer's name as {{1}}, an optional image/video header and a "Stop promotions" button.
export async function createTemplate(creds, { name, language, bodyText, footerText, buttonText, media }) {
  const components = [];
  if (media) {
    const handle = await sampleHandle(creds, media);
    components.push({ type: 'HEADER', format: media.kind === 'video' ? 'VIDEO' : 'IMAGE', example: { header_handle: [handle] } });
  }
  const body = { type: 'BODY', text: bodyText };
  if (/\{\{1\}\}/.test(bodyText)) body.example = { body_text: [['Sara']] };
  components.push(body);
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  components.push({ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: buttonText || 'Stop promotions' }] });
  return graph(creds.token, 'POST', `${creds.waba_id}/message_templates`, {
    body: { name, language, category: 'MARKETING', parameter_format: 'POSITIONAL', components },
  });
}

export function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const STOP_WORDS = /^\s*(stop|stop promotions|unsubscribe|opt ?out|cancel|end|quit|توقف|إيقاف|ايقاف|إيقاف العروض|ايقاف العروض|الغاء|إلغاء|الغاء الاشتراك|إلغاء الاشتراك|لا ترسل)\s*[.!]*\s*$/i;

// Decide what to do after a WhatsApp error (codes from Meta's error-code reference).
export function classifyWaError(e) {
  const code = Number(e.code);
  const text = `${e.title ? e.title + ': ' : ''}${e.message}${e.details && e.details !== e.message ? ' — ' + e.details : ''}`.slice(0, 300);
  if ([130429, 80007, 4, 131057].includes(code)) return { action: 'hold_sender', seconds: e.retryAfterSec, backoff: !e.retryAfterSec, text: `WhatsApp asked to slow down (${code}).` };
  if (code === 131056) return { action: 'retry_message', pairRate: true, text: 'Too many messages to this person in a short time (WhatsApp pair limit). Will retry this person later.' };
  if (code === 131049) return { action: 'fail_message', text: 'WhatsApp held back this marketing message to protect the person\'s experience (per-user marketing limit). Not retried.' };
  if (code === 131050) return { action: 'opted_out', text: 'This person has stopped marketing messages from your business on WhatsApp.' };
  if (code === 131048) return { action: 'pause_campaign', seconds: 24 * 3600, text: 'WhatsApp limited sending because too many recent messages were blocked or reported (spam rate limit). Campaign paused — check your quality rating in WhatsApp Manager before resuming.' };
  if ([190, 10, 200, 3, 133010].includes(code) || e.status === 401) return { action: 'sender_broken', text: `WhatsApp rejected this sender (${code}): ${text}. Reconnect the sender with a valid permanent token.` };
  if ((code >= 132000 && code < 133000) || [131042, 131031, 131045, 368, 131037].includes(code) || (code === 100 && /template|component|parameter/i.test(text))) {
    return { action: 'pause_campaign', text: `WhatsApp could not use this template or account (${code}): ${text}. Campaign paused.` };
  }
  if ([131026, 131021, 131051, 131047, 131009, 100, 131008].includes(code)) return { action: 'fail_message', text: `Not delivered (${code}): ${text}` };
  if (code === 'network' || [1, 2, 131000, 131016, 131053].includes(code) || e.status >= 500) return { action: 'retry_message', text: `Temporary WhatsApp problem: ${text}` };
  return { action: 'fail_message', text: `WhatsApp error (${code || e.status}): ${text}` };
}
