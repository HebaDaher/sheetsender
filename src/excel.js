// Turns an uploaded .xlsx or .csv file into { headers, rows } and guesses which column is which.
import { readWorkbook, readSheet } from './xlsx.js';

export const MAX_ROWS = 20000;

export const FIELDS = [
  { key: 'name', label: 'Name', required: false },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'whatsapp', label: 'WhatsApp Number' },
  { key: 'consent', label: 'Consent Status' },
  { key: 'consent_email', label: 'Email consent (optional, overrides Consent Status for email)' },
  { key: 'consent_whatsapp', label: 'WhatsApp consent (optional, overrides Consent Status for WhatsApp)' },
];

function cleanCell(v) {
  let s = String(v ?? '').replace(/ /g, ' ').trim();
  // Excel may store long numbers as 9.71501234567E+11. Convert only when no digits were lost
  // (e.g. "9.71502E+11" from a CSV has lost digits, so it is left as-is and later rejected as invalid).
  const sci = s.match(/^(\d)(?:\.(\d+))?E\+(\d+)$/i);
  if (sci && 1 + (sci[2] || '').length === Number(sci[3]) + 1) { const n = Number(s); if (Number.isSafeInteger(n)) s = String(n); }
  // Whole numbers stored as 971501234567.0
  if (/^\d{6,}\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch;
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function parseSpreadsheet(buf, filename) {
  const lower = filename.toLowerCase();
  let grid;
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    grid = parseCsv(buf.toString('utf8'));
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    let wb;
    try { wb = readWorkbook(buf); } catch { throw new Error('This file could not be read as an Excel workbook. Open it in Excel and use File → Save As → Excel Workbook (.xlsx).'); }
    grid = [];
    for (const s of wb.sheets) {
      const g = readSheet(wb, s.name);
      if (g.some((r) => r.some((c) => String(c).trim()))) { grid = g; break; }
    }
  } else if (lower.endsWith('.xls')) {
    throw new Error('Old .xls files are not supported. Open the file in Excel and use File → Save As → Excel Workbook (.xlsx), then upload that.');
  } else {
    throw new Error('Please upload an Excel file (.xlsx) or a CSV file.');
  }

  grid = grid.map((r) => (r || []).map(cleanCell));
  const headerIdx = grid.findIndex((r) => r.some((c) => c));
  if (headerIdx === -1) throw new Error('The file is empty.');
  const width = Math.max(...grid.slice(headerIdx, headerIdx + 50).map((r) => r.length));
  const seen = new Map();
  const headers = [];
  for (let i = 0; i < width; i++) {
    let h = grid[headerIdx][i] || `Column ${i + 1}`;
    const k = h.toLowerCase();
    if (seen.has(k)) { seen.set(k, seen.get(k) + 1); h = `${h} (${seen.get(k)})`; } else seen.set(k, 1);
    headers.push(h);
  }
  const rows = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const cells = grid[r] || [];
    if (!cells.some((c) => c)) continue;
    rows.push([r + 1, ...headers.map((_, i) => cells[i] ?? '')]);
  }
  if (!rows.length) throw new Error('The file has column titles but no customer rows.');
  if (rows.length > MAX_ROWS) throw new Error(`The file has ${rows.length} rows. The limit is ${MAX_ROWS} per upload — please split it.`);
  return { headers, rows };
}

const PATTERNS = {
  consent_email: [/consent.*(e-?mail)|(e-?mail).*(consent|opt|agree|permission)/i],
  consent_whatsapp: [/consent.*(whats|wa\b)|(whats ?app|wa\b).*(consent|opt|agree|permission)/i],
  consent: [/consent|opt.?in|opted|agree|permission|subscri|marketing ok|موافق|موافقة|الموافقة/i],
  email: [/^e-?mail|e-?mail ?address|البريد|ايميل|إيميل/i],
  whatsapp: [/whats ?app|واتس|واتساب/i],
  phone: [/phone|mobile|tel\b|telephone|cell|contact number|^number$|الهاتف|هاتف|جوال|موبايل|رقم/i],
  name: [/^(full ?name|name|customer ?name|client ?name|customer|client|first ?name|الاسم|اسم|اسم العميل)$/i, /name|الاسم|اسم/i],
};

export function guessMapping(headers) {
  const map = {}; const used = new Set();
  for (const key of ['consent_email', 'consent_whatsapp', 'consent', 'email', 'whatsapp', 'phone', 'name']) {
    for (const re of PATTERNS[key]) {
      const h = headers.find((x) => !used.has(x) && re.test(x));
      if (h) { map[key] = h; used.add(h); break; }
    }
  }
  return map;
}
