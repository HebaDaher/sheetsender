// Contact field handling: column mapping, validation, normalization, identity, masking, templates.
import { sha256 } from './crypto.js';

// App fields a user can map their spreadsheet columns to.
export const FIELDS = [
  { key: 'name', label: 'Name', defaults: ['name', 'full name', 'customer name', 'الاسم', 'client name'] },
  { key: 'email', label: 'Email', defaults: ['email', 'e-mail', 'email address', 'البريد الإلكتروني', 'mail'] },
  { key: 'phone', label: 'Phone Number', defaults: ['phone', 'phone number', 'mobile', 'mobile number', 'رقم الهاتف', 'الجوال', 'tel'] },
  { key: 'whatsapp', label: 'WhatsApp Number', defaults: ['whatsapp', 'whatsapp number', 'واتساب', 'رقم الواتساب'] },
  { key: 'company', label: 'Company', defaults: ['company', 'company name', 'business', 'الشركة'] },
  { key: 'consent', label: 'Consent Status', defaults: ['consent', 'consent status', 'opt-in', 'opt in', 'الموافقة'] },
];
// Status columns the app writes back. If the column doesn't exist, it is added to the end of the header row.
export const STATUS_FIELDS = [
  { key: 'email_status', label: 'Email Status' },
  { key: 'whatsapp_status', label: 'WhatsApp Status' },
  { key: 'email_sent_at', label: 'Email Sent At' },
  { key: 'whatsapp_sent_at', label: 'WhatsApp Sent At' },
  { key: 'error_details', label: 'Error Details' },
];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function autoMap(headers) {
  const map = {};
  const lower = headers.map(norm);
  for (const f of FIELDS) {
    const i = lower.findIndex((h) => f.defaults.includes(h));
    if (i >= 0) map[f.key] = headers[i];
  }
  for (const f of STATUS_FIELDS) {
    const i = lower.findIndex((h) => h === norm(f.label));
    map[f.key] = i >= 0 ? headers[i] : f.label;
  }
  return map;
}

export function statusHeaderNames(columnMap) {
  return STATUS_FIELDS.map((f) => columnMap[f.key] || f.label);
}

// Turns a raw sheet row into { fields, columns } using the column map.
export function rowToRecord(headers, row, columnMap) {
  const columns = {};
  headers.forEach((h, i) => { if (h) columns[h] = row[i] == null ? '' : String(row[i]).trim(); });
  const fields = {};
  for (const f of FIELDS) { const h = columnMap[f.key]; fields[f.key] = h && columns[h] !== undefined ? columns[h] : ''; }
  return { fields, columns };
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
export function normalizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

// Converts local formats (e.g. UAE 050 123 4567) to international E.164 (+971501234567).
export function normalizePhone(v, defaultCountry = '971') {
  let s = String(v || '').trim();
  if (!s) return null;
  if (/[a-z]/i.test(s.replace(/ext.*$/i, ''))) return null;
  // Excel sometimes stores numbers as 9.71501E+11
  if (/e\+/i.test(s) && !isNaN(Number(s))) s = Number(s).toFixed(0);
  let digits = s.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1).replace(/\+/g, '');
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (defaultCountry && digits.startsWith(defaultCountry) && digits.length >= 11) { /* already has country code */ }
  else if (digits.startsWith('0')) digits = defaultCountry + digits.replace(/^0+/, '');
  else if (defaultCountry && digits.length <= 10) digits = defaultCountry + digits;
  if (!/^\d{8,15}$/.test(digits)) return null;
  return '+' + digits;
}

export function contactIdentity(fields, defaultCountry) {
  const e = normalizeEmail(fields.email);
  if (e) return 'e:' + e;
  const p = normalizePhone(fields.whatsapp || fields.phone, defaultCountry);
  if (p) return 'p:' + p;
  const raw = [fields.name, fields.email, fields.phone, fields.whatsapp].join('|').trim();
  if (raw.replace(/\|/g, '') === '') return null; // empty row
  return 'h:' + sha256(raw).slice(0, 24);
}

// Hash of the row's contact content (status columns excluded) — used to detect edits.
export function contentHash(columns, statusHeaders) {
  const keys = Object.keys(columns).filter((k) => !statusHeaders.includes(k)).sort();
  return sha256(keys.map((k) => k + '=' + columns[k]).join('\u0001')).slice(0, 32);
}

export function maskEmail(e) {
  if (!e) return '';
  const [u, d] = String(e).split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + (d || '');
}
export function maskPhone(p) {
  if (!p) return '';
  const s = String(p);
  return s.length <= 6 ? s.slice(0, 2) + '***' : s.slice(0, 5) + '****' + s.slice(-3);
}
export const maskRecipient = (channel, r) => (channel === 'email' ? maskEmail(r) : maskPhone(r));

// ---------- consent and conditions ----------
export function consentOk(settings, fields, columnMap) {
  if (!settings.consent?.required) return { ok: true };
  if (!columnMap.consent) return { ok: false, kind: 'no_consent', reason: 'Consent is required but no Consent column is mapped' };
  const v = norm(fields.consent);
  if (!v) return { ok: false, kind: 'no_consent', reason: 'Consent missing' };
  const accepted = String(settings.consent.accepted || '').split(',').map(norm).filter(Boolean);
  if (accepted.includes(v)) return { ok: true };
  const declined = ['no', 'n', 'false', '0', 'declined', 'لا', 'withdrawn', 'unsubscribed'];
  if (declined.includes(v)) return { ok: false, kind: 'no_consent', reason: `Consent declined ("${fields.consent}")` };
  return { ok: false, kind: 'consent_invalid', reason: `Consent value not recognised ("${fields.consent}")` };
}

export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'not_empty', 'is_empty'];
export function conditionsOk(conditions, columns) {
  for (const c of conditions || []) {
    if (!c.column) continue;
    const v = norm(columns[c.column]);
    const t = norm(c.value);
    const pass = c.op === 'equals' ? v === t : c.op === 'not_equals' ? v !== t : c.op === 'contains' ? v.includes(t)
      : c.op === 'not_empty' ? v !== '' : c.op === 'is_empty' ? v === '' : true;
    if (!pass) return { ok: false, reason: `Condition not met: "${c.column}" ${c.op.replace('_', ' ')} ${c.value ?? ''}`.trim() };
  }
  return { ok: true };
}

// ---------- templates ----------
// Supported variables: {{name}} {{first_name}} {{company}} {{business_name}} {{email}} {{phone}}
// {{media_links}} {{unsubscribe_link}} and any column: {{column:Header Name}}
export function buildVars(shop, rec, extra = {}) {
  const name = rec.fields.name || '';
  return {
    name: name || 'there',
    first_name: (name.split(/\s+/)[0]) || 'there',
    company: rec.fields.company || shop.name,
    business_name: shop.name,
    email: rec.fields.email || '',
    phone: rec.fields.whatsapp || rec.fields.phone || '',
    ...extra,
    __columns: rec.columns || {},
  };
}
export function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)(?::([^}]+))?\s*\}\}/gi, (m, key, col) => {
    if (key.toLowerCase() === 'column' && col) return vars.__columns?.[col.trim()] ?? '';
    const v = vars[key.toLowerCase()];
    return v === undefined ? m : String(v);
  });
}
