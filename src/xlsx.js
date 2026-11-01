// Excel (.xlsx) and CSV reader — no dependencies.
import zlib from 'node:zlib';

// ---------- ZIP ----------
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error('Unsupported compression in .xlsx');
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- XML helpers ----------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decode(m[1]) : null; };
const textOf = (xml) => { let out = ''; for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decode(m[1]); return out; };

export function colToIndex(col) { let n = 0; for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
export function indexToCol(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function resolveSheets(files) {
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!wb || !rels) throw new Error('Not a valid Excel workbook');
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'); let target = attr(m[0], 'Target') || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    relMap[id] = target;
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const rid = attr(m[0], 'r:id') || (m[0].match(/\s[\w]+:id="([^"]*)"/) || [])[1];
    sheets.push({ name: attr(m[0], 'name'), path: relMap[rid] });
  }
  return sheets;
}

export function readWorkbook(buf) {
  const entries = unzip(buf);
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const sheets = resolveSheets(files);
  const ssXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  return { entries, files, sheets, shared };
}

// Returns rows as arrays of strings (row index 0 = sheet row 1).
export function readSheet(buf, sheetName) {
  const wb = readWorkbook(buf);
  const sheet = wb.sheets.find((s) => s.name === sheetName) || wb.sheets[0];
  if (!sheet) throw new Error('Workbook has no sheets');
  const xml = wb.files.get(sheet.path)?.toString('utf8') || '';
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(attr('<row' + rm[1] + '>', 'r'));
    const arr = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = '<c' + cm[1] + '>';
      const ref = attr(tag, 'r'); if (!ref) continue;
      const col = colToIndex(ref.replace(/\d+/g, ''));
      const t = attr(tag, 't'); const inner = cm[2] || '';
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = wb.shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v != null ? decode(v) : '';
      arr[col] = val;
    }
    rows[r - 1] = Array.from(arr, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x || []);
}
