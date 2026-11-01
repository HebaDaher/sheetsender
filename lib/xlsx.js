// Minimal .xlsx reader/writer (no dependencies). Used only for Excel files on *personal* OneDrive,
// where Microsoft does not support the Excel workbook API. Reads cell values and writes plain-text cells.
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

export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- XML helpers ----------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
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

export function sheetNames(buf) { return readWorkbook(buf).sheets.map((s) => s.name); }

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

// cells: [{ row: 1-based, col: 0-based, value: string }]. Writes them as text cells and returns a new .xlsx buffer.
export function writeCells(buf, sheetName, cells) {
  const wb = readWorkbook(buf);
  const sheet = wb.sheets.find((s) => s.name === sheetName) || wb.sheets[0];
  let xml = wb.files.get(sheet.path).toString('utf8');
  if (/<sheetData\s*\/>/.test(xml)) xml = xml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  const byRow = new Map();
  for (const c of cells) { if (!byRow.has(c.row)) byRow.set(c.row, []); byRow.get(c.row).push(c); }

  const sdStart = xml.indexOf('<sheetData'); const sdOpenEnd = xml.indexOf('>', sdStart) + 1;
  const sdEnd = xml.indexOf('</sheetData>');
  let body = xml.slice(sdOpenEnd, sdEnd);
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const rows = [];
  for (const m of body.matchAll(rowRe)) rows.push({ r: Number(attr('<row' + m[1] + '>', 'r')), attrs: m[1], inner: m[2] || '' });

  for (const [r, list] of byRow) {
    let row = rows.find((x) => x.r === r);
    if (!row) { row = { r, attrs: ` r="${r}"`, inner: '' }; rows.push(row); }
    row.attrs = row.attrs.replace(/\sspans="[^"]*"/, '');
    const cellsInRow = [];
    for (const cm of row.inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr('<c' + cm[1] + '>', 'r');
      cellsInRow.push({ col: colToIndex(ref.replace(/\d+/g, '')), xml: cm[0], attrs: cm[1] });
    }
    for (const c of list) {
      const ref = indexToCol(c.col) + r;
      const existing = cellsInRow.find((x) => x.col === c.col);
      const style = existing ? attr('<c' + existing.attrs + '>', 's') : null;
      const newXml = `<c r="${ref}"${style != null ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${encode(c.value ?? '')}</t></is></c>`;
      if (existing) existing.xml = newXml; else cellsInRow.push({ col: c.col, xml: newXml });
    }
    cellsInRow.sort((a, b) => a.col - b.col);
    row.inner = cellsInRow.map((x) => x.xml).join('');
  }
  rows.sort((a, b) => a.r - b.r);
  body = rows.map((x) => `<row${x.attrs}>${x.inner}</row>`).join('');
  xml = xml.slice(0, sdOpenEnd) + body + xml.slice(sdEnd);
  // Remove a stale dimension so Excel recalculates it.
  xml = xml.replace(/<dimension\b[^>]*\/>/, '');
  const out = wb.entries.map((e) => (e.name === sheet.path ? { name: e.name, data: Buffer.from(xml, 'utf8') } : e));
  return zip(out);
}
