// Mock email (SMTP over TLS) and WhatsApp Graph API servers used by the automated tests.
import tls from 'node:tls';
import http from 'node:http';
import zlib from 'node:zlib';

export function startSmtp({ key, cert, password }) {
  const state = { mails: [], next: [] }; // next: [{ at: 'rcpt'|'data', code, text }]
  const server = tls.createServer({ key, cert }, (sock) => {
    let buf = ''; let inData = false; let data = ''; let from = ''; let to = '';
    const reply = (s) => sock.write(s + '\r\n');
    const fail = (at) => { const i = state.next.findIndex((x) => x.at === at); if (i < 0) return null; return state.next.splice(i, 1)[0]; };
    reply('220 mock ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const f = fail('data');
            if (f && f.drop) { state.mails.push({ from, to, data, dropped: true }); sock.destroy(); return; }
            if (f) reply(`${f.code} ${f.text}`);
            else { state.mails.push({ from, to, data }); reply('250 2.0.0 OK queued'); }
            data = '';
          } else data += line.replace(/^\.\./, '.') + '\r\n';
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) { sock.write('250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 35882577\r\n'); }
        else if (cmd.startsWith('AUTH PLAIN')) {
          const [, , pw] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          reply(pw === password ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted');
        } else if (cmd.startsWith('MAIL FROM')) { from = line.slice(10); reply('250 OK'); }
        else if (cmd.startsWith('RCPT TO')) { to = line.match(/<([^>]+)>/)[1]; const f = fail('rcpt'); reply(f ? `${f.code} ${f.text}` : '250 OK'); }
        else if (cmd === 'DATA') { inData = true; reply('354 go'); }
        else if (cmd === 'RSET') reply('250 OK');
        else if (cmd === 'QUIT') { reply('221 bye'); sock.end(); }
        else reply('502 unknown');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

export const TEMPLATES = [
  { name: 'promo_offer', language: 'en', status: 'APPROVED', category: 'MARKETING', parameter_format: 'POSITIONAL', components: [
    { type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}, 20% off at {{2}} this week!' },
    { type: 'FOOTER', text: 'Tap Stop promotions to unsubscribe' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] }] },
  { name: 'plain_offer', language: 'ar', status: 'APPROVED', category: 'MARKETING', parameter_format: 'POSITIONAL', components: [
    { type: 'BODY', text: 'مرحبا {{1}}، عرض خاص اليوم. أرسل توقف لإلغاء الاشتراك' }] },
  { name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello World' }] },
  { name: 'no_optout', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Big sale {{1}}!' }] },
  { name: 'pending_one', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] },
];

export function startGraph({ token, pnid, waba }) {
  const state = { sent: [], media: 0, created: [], next: [], usageHeader: null };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/v[\d.]+\//, '');
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${token}` && !String(req.headers.authorization).startsWith('OAuth')) return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
    if (req.method === 'GET' && p === pnid) return send(200, { id: pnid, display_phone_number: '+971 50 000 0000', verified_name: 'GoSkate', quality_rating: 'GREEN', whatsapp_business_manager_messaging_limit: state.limit || 'TIER_250', code_verification_status: 'VERIFIED', name_status: 'APPROVED' });
    if (req.method === 'GET' && p === `${waba}/phone_numbers`) return send(200, { data: [{ id: pnid }] });
    if (req.method === 'GET' && p === `${waba}/message_templates`) return send(200, { data: TEMPLATES });
    if (req.method === 'POST' && p === `${waba}/subscribed_apps`) return send(200, { success: true });
    if (req.method === 'POST' && p === `${waba}/message_templates`) { const j = JSON.parse(body); state.created.push(j); return send(200, { id: '999', status: 'PENDING', category: 'MARKETING' }); }
    if (req.method === 'POST' && p.endsWith('/uploads')) return send(200, { id: 'upload:abc' });
    if (req.method === 'POST' && p === 'upload:abc') return send(200, { h: '4::handle' });
    if (req.method === 'POST' && p === `${pnid}/media`) { state.media++; if (!body.includes(Buffer.from('messaging_product'))) return send(400, { error: { code: 100, message: 'bad' } }); return send(200, { id: `media${state.media}` }); }
    if (req.method === 'POST' && p === `${pnid}/messages`) {
      const j = JSON.parse(body);
      const n = state.next.shift();
      if (n) return send(n.status || 400, { error: { code: n.code, message: n.message || 'err', error_data: { details: n.details || 'details' } } }, n.headers || {});
      state.sent.push(j);
      return send(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: j.to }], messages: [{ id: `wamid.${state.sent.length}` }] });
    }
    send(404, { error: { code: 100, message: `mock: no route ${req.method} ${p}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

// Builds a minimal real .xlsx file (shared strings + one sheet) for upload tests.
export function makeXlsx(rows) {
  const strings = []; const idx = new Map();
  const si = (s) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s); };
  const col = (i) => String.fromCharCode(65 + i);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) =>
    typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
  };
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text); const nm = Buffer.from(name); const comp = zlib.deflateRawSync(data); const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nm); offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
