// Cleaning and checking customer details from the spreadsheet.

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export function normalizeEmail(raw) {
  let s = String(raw || '').trim().replace(/^mailto:/i, '');
  const m = s.match(/<([^>]+)>/); if (m) s = m[1];
  s = s.trim().toLowerCase();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

// Country calling codes and the usual national-number lengths (without the leading 0).
export const COUNTRIES = {
  AE: { cc: '971', len: [8, 9], name: 'United Arab Emirates' },
  SA: { cc: '966', len: [8, 9], name: 'Saudi Arabia' },
  KW: { cc: '965', len: [8], name: 'Kuwait' },
  QA: { cc: '974', len: [8], name: 'Qatar' },
  BH: { cc: '973', len: [8], name: 'Bahrain' },
  OM: { cc: '968', len: [8], name: 'Oman' },
  EG: { cc: '20', len: [9, 10], name: 'Egypt' },
  JO: { cc: '962', len: [8, 9], name: 'Jordan' },
  LB: { cc: '961', len: [7, 8], name: 'Lebanon' },
  SY: { cc: '963', len: [9], name: 'Syria' },
  IQ: { cc: '964', len: [10], name: 'Iraq' },
  IN: { cc: '91', len: [10], name: 'India' },
  PK: { cc: '92', len: [10], name: 'Pakistan' },
  PH: { cc: '63', len: [10], name: 'Philippines' },
  GB: { cc: '44', len: [10], name: 'United Kingdom' },
  US: { cc: '1', len: [10], name: 'United States / Canada' },
};

// Returns digits in international format without "+" (what WhatsApp expects), or null if it can't be a real number.
export function normalizePhone(raw, defaultCountry = 'AE') {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/\d[.,]?\d*e[+-]?\d/i.test(s)) return null; // scientific notation: digits were lost in Excel/CSV
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/(ext|x|#).*$/i, '');
  const plus = /^\s*\+/.test(s);
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (!plus && d.startsWith('00')) d = d.slice(2);
  else if (!plus) {
    const c = COUNTRIES[defaultCountry] || COUNTRIES.AE;
    if (d.startsWith(c.cc) && c.len.includes(d.length - c.cc.length)) { /* already international */ }
    else {
      const national = d.replace(/^0+/, '');
      if (c.len.includes(national.length)) d = c.cc + national;
      else if (!(d.length >= 11 && d.length <= 15)) return null;
    }
  }
  if (d.length < 8 || d.length > 15 || /^(\d)\1+$/.test(d) || d.startsWith('0')) return null;
  // UAE numbers must be 971 + 8 or 9 digits
  if (d.startsWith('971') && ![11, 12].includes(d.length)) return null;
  if (d.startsWith('971') && d.length === 12 && d[3] !== '5') return null;
  return d;
}

const YES = new Set(['yes', 'y', 'true', '1', 'ok', 'opted in', 'opt-in', 'opt in', 'optin', 'opted-in', 'subscribed', 'consented', 'consent given',
  'agreed', 'agree', 'accepted', 'granted', 'allowed', '✓', '✔', '☑', 'نعم', 'موافق', 'موافقة', 'اي', 'ايوه', 'أوافق', 'اوافق']);

export function parseConsent(raw) {
  return YES.has(String(raw ?? '').trim().toLowerCase());
}

// Builds contact rows from an upload and the column mapping chosen by the user.
export function buildContacts(upload, mapping, defaultCountry) {
  const idx = (h) => (h ? upload.headers.indexOf(h) : -1);
  const col = Object.fromEntries(['name', 'email', 'phone', 'whatsapp', 'consent', 'consent_email', 'consent_whatsapp'].map((k) => [k, idx(mapping[k])]));
  const get = (row, k) => (col[k] >= 0 ? String(row[col[k] + 1] ?? '').trim() : '');
  return upload.rows.map((row) => {
    const extra = {};
    upload.headers.forEach((h, i) => { extra[h] = String(row[i + 1] ?? ''); });
    const consentRaw = get(row, 'consent');
    const general = parseConsent(consentRaw);
    const waRaw = get(row, 'whatsapp') || get(row, 'phone');
    return {
      row_number: row[0],
      name: get(row, 'name'),
      email_raw: get(row, 'email'),
      email: normalizeEmail(get(row, 'email')),
      phone_raw: waRaw,
      phone: normalizePhone(waRaw, defaultCountry),
      consent_raw: [consentRaw, get(row, 'consent_email'), get(row, 'consent_whatsapp')].filter(Boolean).join(' / '),
      consent_email: col.consent_email >= 0 && get(row, 'consent_email') !== '' ? parseConsent(get(row, 'consent_email')) : general,
      consent_whatsapp: col.consent_whatsapp >= 0 && get(row, 'consent_whatsapp') !== '' ? parseConsent(get(row, 'consent_whatsapp')) : general,
      extra,
    };
  });
}

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
