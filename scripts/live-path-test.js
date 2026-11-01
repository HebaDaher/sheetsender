// Verifies the REAL provider code paths (Gmail, WhatsApp Cloud API, Google Sheets, OneDrive Excel)
// by intercepting fetch() and inspecting the exact requests. No network access needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-live-'));
Object.assign(process.env, { ENV_FILE: path.join(dir, 'none.env'), DATA_DIR: dir, BASE_URL: 'https://app.example.com', ADMIN_PASSWORD: 'x'.repeat(12),
  SESSION_SECRET: crypto.randomBytes(40).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), EMAIL_ATTACHMENT_LIMIT_MB: '1',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'msec' });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };

// ---------- fake providers ----------
const calls = [];
let sheetValues = [['Name', 'Email', 'Phone Number', 'Consent Status'], ['Old', 'old@x.com', '0500000000', 'yes']];
let waFail = null, gmailFail = null, xlsxBuf = null, xlsxEtag = '"v1"', msUsed = null, bumpAfterDownload = false;
const reply = (status, obj) => new Response(typeof obj === 'string' || obj instanceof Uint8Array ? obj : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const body = opts.body;
  calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
  if (url.includes('gmail.googleapis.com')) { if (gmailFail) { const f = gmailFail; gmailFail = null; return reply(f.status, f.body); } return reply(200, { id: 'gmail-' + calls.length }); }
  if (url.includes('sheets.googleapis.com') && url.includes(':batchUpdate')) {
    for (const d of JSON.parse(body).data) {
      const m = d.range.match(/!([A-Z]+)(\d+)$/); const c = m[1].charCodeAt(0) - 65, r = Number(m[2]) - 1;
      while (sheetValues.length <= r) sheetValues.push([]); sheetValues[r][c] = d.values[0][0];
    }
    return reply(200, {});
  }
  if (url.includes('sheets.googleapis.com')) return reply(200, { values: sheetValues });
  if (url.includes('graph.facebook.com') && url.endsWith('/media')) return reply(200, { id: 'wa-media-1' });
  if (url.includes('graph.facebook.com') && url.endsWith('/messages')) { if (waFail) { const f = waFail; waFail = null; return reply(f.status, f.body); } return reply(200, { messages: [{ id: 'wamid.' + calls.length }] }); }
  if (url.includes('graph.microsoft.com') && url.includes('usedRange')) return reply(200, { address: 'Leads!B2:E4', text: msUsed });
  if (url.includes('graph.microsoft.com') && url.includes("range(address=")) return reply(200, {});
  if (url.includes('graph.microsoft.com') && url.endsWith('/content') && opts.method === 'PUT') {
    if (opts.headers['if-match'] !== xlsxEtag) return reply(412, { error: { code: 'resourceModified', message: 'ETag does not match' } });
    xlsxBuf = Buffer.from(body); xlsxEtag = '"v' + (Number(xlsxEtag.slice(2, -1)) + 1) + '"'; return reply(200, { eTag: xlsxEtag });
  }
  if (url.includes('graph.microsoft.com') && url.endsWith('/content')) { const r = new Response(xlsxBuf, { status: 200 }); if (bumpAfterDownload) { bumpAfterDownload = false; xlsxEtag = '"v50"'; } return r; }
  if (url.includes('graph.microsoft.com') && url.includes('select=eTag')) return reply(200, { eTag: xlsxEtag, size: xlsxBuf.length });
  if (url.includes('oauth2.googleapis.com/token')) return reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  return reply(404, { error: { message: 'unexpected ' + url } });
};

const { run, one, all, getShop, DEFAULT_SHOP_SETTINGS } = await import('../lib/db.js');
const { saveAccount, getAccessToken } = await import('../lib/accounts.js');
const { pollShop, processJob } = await import('../lib/engine.js');
const media = await import('../lib/media.js');
const xlsx = await import('../lib/xlsx.js');

const future = Date.now() + 3600e3;
const G = saveAccount({ provider: 'google', label: 'me@gmail.com', identifier: 'me@gmail.com', secret: { refresh_token: 'r', access_token: 'gtok', expires_at: future } });
const W = saveAccount({ provider: 'whatsapp', label: 'WA', identifier: '111', secret: { access_token: 'watok' }, info: { phone_number_id: '111', waba_id: '222' } });
run("UPDATE accounts SET tested_at=datetime('now')");

const settings = { ...DEFAULT_SHOP_SETTINGS, channels: 'both' };
const map = { name: 'Name', email: 'Email', phone: 'Phone Number', consent: 'Consent Status', email_status: 'Email Status', whatsapp_status: 'WhatsApp Status', email_sent_at: 'Email Sent At', whatsapp_sent_at: 'WhatsApp Sent At', error_details: 'Error Details' };
const S = Number(run(`INSERT INTO shops (name, sheet_provider, sheet_account_id, sheet_ref, sheet_tab, column_map, gmail_account_id, whatsapp_account_id, status, mode, settings)
  VALUES ('Palm Tree Spa', 'google', ?, ?, 'Leads', ?, ?, ?, 'active', 'live', ?)`, G, JSON.stringify({ spreadsheetId: 'sheet123' }), JSON.stringify(map), G, W, JSON.stringify(settings)).lastInsertRowid);
run('INSERT INTO templates (shop_id, channel, data) VALUES (?,?,?)', S, 'email', JSON.stringify({ subject: 'مرحبا {{name}} — {{business_name}}', body: 'Hi {{first_name}},\nWelcome to {{business_name}}.' }));

// media: small PDF (attached), 2 MB PDF (over 1 MB test limit → link), image (WhatsApp header), website link
const mk = (name, size, mime) => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.alloc(size, 7)); return media.storeUpload(S, name, mime, p, size); };
const small = mk('price list.pdf', 20000, 'application/pdf');
const big = mk('Brochure 2026.pdf', 2 * 1048576, 'application/pdf');
const img = mk('offer.png', 30000, 'image/png');
const link = media.addLink(S, 'Book online', 'https://palmtree.example.com/book');
media.setSelection(S, 'email', [small, big, link]);
media.setSelection(S, 'whatsapp', [small, link]);
run('INSERT INTO templates (shop_id, channel, data) VALUES (?,?,?)', S, 'whatsapp', JSON.stringify({ template_name: 'hammam_offer', language: 'ar', header_format: 'IMAGE', header_media_id: img, body_params: ['{{name}}', '{{media_links}}'], parameter_format: 'POSITIONAL', url_buttons: [] }));

console.log('\nGoogle Sheets: baseline + new rows');
await pollShop(S);
ok(all('SELECT * FROM jobs').length === 0, 'first check records existing rows without messaging them');
sheetValues.push(['Fatima Ali', 'fatima@example.com', '050 123 4567', 'Yes']);
await pollShop(S);
const jobs = all('SELECT * FROM jobs WHERE shop_id=? ORDER BY id', S);
ok(jobs.length === 2 && jobs.every((j) => j.status === 'pending'), 'new row → one email job + one WhatsApp job');
ok(jobs.find((j) => j.channel === 'whatsapp').recipient === '+971501234567', 'UAE number normalised to +971501234567');

console.log('\nGmail send');
const ej = jobs.find((j) => j.channel === 'email');
await processJob(ej.id);
const gcall = calls.find((c) => c.url.includes('gmail'));
ok(gcall && gcall.url.includes('/upload/gmail/v1/users/me/messages/send?uploadType=media') && gcall.headers['content-type'] === 'message/rfc822', 'uses Gmail API upload endpoint with RFC 822 message');
const mime = gcall.body;
ok(/^From: =\?UTF-8\?B\?|^From: Palm Tree Spa <me@gmail\.com>/m.test(mime) && mime.includes('<me@gmail.com>'), 'From shows the shop name and the connected Gmail address');
ok(mime.includes('To: fatima@example.com'), 'sent to the contact (live mode)');
ok(/Subject: =\?UTF-8\?B\?/.test(mime), 'Arabic subject encoded correctly (RFC 2047)');
const subj = Buffer.from(mime.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1], 'base64').toString();
ok(subj === 'مرحبا Fatima Ali — Palm Tree Spa', `subject rendered: "${subj}"`);
ok(mime.includes('List-Unsubscribe: <https://app.example.com/u/') && mime.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'), 'one-click unsubscribe headers present');
ok(mime.includes('filename="price list.pdf"'), 'small PDF attached');
ok(!mime.includes('filename="Brochure 2026.pdf"'), 'oversized PDF NOT attached');
const html = Buffer.from(mime.split('Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('--')[0].replace(/\s/g, ''), 'base64').toString();
ok(html.includes('https://app.example.com/f/') && html.includes('Brochure 2026.pdf'), 'oversized file sent as a secure download link instead');
ok(html.includes('https://palmtree.example.com/book') && html.includes('Unsubscribe') && html.includes('Palm Tree Spa'), 'website link, shop footer and unsubscribe link in body');
const ejDone = one('SELECT * FROM jobs WHERE id=?', ej.id);
ok(ejDone.status === 'sent' && ejDone.simulated === 0 && ejDone.provider_message_id.startsWith('gmail-'), 'email job marked Sent (real, not simulated)');

console.log('\nWhatsApp send (official template)');
const wj = jobs.find((j) => j.channel === 'whatsapp');
await processJob(wj.id);
const up = calls.find((c) => c.url.endsWith('/111/media'));
ok(up && up.body instanceof FormData && up.body.get('messaging_product') === 'whatsapp' && up.body.get('type') === 'image/png', 'header image uploaded to WhatsApp media endpoint');
const msg = JSON.parse(calls.filter((c) => c.url.endsWith('/111/messages')).pop().body);
ok(msg.type === 'template' && msg.template.name === 'hammam_offer' && msg.template.language.code === 'ar' && msg.to === '971501234567', 'template message to 971501234567 with the approved template + language');
const header = msg.template.components.find((c) => c.type === 'header');
ok(header?.parameters[0].type === 'image' && header.parameters[0].image.id === 'wa-media-1', 'header image passed by media ID');
const bp = msg.template.components.find((c) => c.type === 'body').parameters;
ok(bp[0].text === 'Fatima Ali' && bp[1].text.includes('price list.pdf: https://app.example.com/f/') && bp[1].text.includes('Book online: https://palmtree.example.com/book') && !/\n/.test(bp[1].text), 'variables filled; PDF sent as link (outside 24h window); no line breaks (WhatsApp rule)');
ok(calls.filter((c) => c.url.endsWith('/111/messages')).length === 1, 'no free-form media sent outside the 24-hour window');
const wjDone = one('SELECT * FROM jobs WHERE id=?', wj.id);
ok(wjDone.status === 'sent' && wjDone.provider_message_id.startsWith('wamid.'), 'WhatsApp job Sent with message ID (for delivery webhooks)');

console.log('\nInside the 24h window → extra media as separate messages');
run('INSERT INTO wa_inbound (phone, last_inbound_at) VALUES (?, ?)', '+971551112222', Date.now());
sheetValues.push(['Mariam', '', '+971551112222', 'yes']);
await pollShop(S);
const mj = one("SELECT * FROM jobs WHERE shop_id=? AND channel='whatsapp' AND recipient='+971551112222'", S);
const n0 = calls.filter((c) => c.url.endsWith('/111/messages')).length;
await processJob(mj.id);
const sent = calls.filter((c) => c.url.endsWith('/111/messages')).slice(n0).map((c) => JSON.parse(c.body));
ok(sent.length === 2 && sent[0].type === 'template' && sent[1].type === 'document' && sent[1].document.filename === 'price list.pdf', 'template first, then the PDF as a document message (configured order)');

console.log('\nSheet write-back (Google)');
await pollShop(S);
const h = sheetValues[0];
const row = sheetValues[2];
ok(h.includes('Email Status') && h.includes('WhatsApp Sent At') && h.includes('Error Details'), 'status headers added to the sheet');
ok(row[h.indexOf('Email Status')] === 'Sent' && row[h.indexOf('WhatsApp Status')] === 'Sent', 'row shows Sent for both channels');
ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(row[h.indexOf('Email Sent At')]), `Sent At timestamp in shop time zone ("${row[h.indexOf('Email Sent At')]}")`);
const writes = calls.filter((c) => c.url.includes(':batchUpdate'));
ok(writes.every((c) => JSON.parse(c.body).valueInputOption === 'RAW'), 'values written as plain text (RAW)');
const before = calls.filter((c) => c.url.includes('gmail')).length;
await pollShop(S); await pollShop(S);
ok(calls.filter((c) => c.url.includes('gmail')).length === before, 'repeated checks never resend');

console.log('\nErrors, retries and account problems');
sheetValues.push(['Retry Me', 'retry@example.com', '0505550000', 'yes']);
await pollShop(S);
const rj = one("SELECT * FROM jobs WHERE recipient='retry@example.com'");
gmailFail = { status: 503, body: { error: { message: 'Backend Error', code: 503 } } };
await processJob(rj.id);
let r = one('SELECT * FROM jobs WHERE id=?', rj.id);
ok(r.status === 'pending' && r.attempts === 1 && r.next_attempt_at > Date.now() + 50000, 'temporary Gmail error → retried later with backoff');
run('UPDATE jobs SET next_attempt_at=0 WHERE id=?', rj.id);
await processJob(rj.id);
r = one('SELECT * FROM jobs WHERE id=?', rj.id);
ok(r.status === 'sent' && r.attempts === 2, 'second attempt succeeded');
await processJob(rj.id);
ok(one('SELECT attempts FROM jobs WHERE id=?', rj.id).attempts === 2, 'a sent job is never processed again');

const wr = one("SELECT * FROM jobs WHERE channel='whatsapp' AND recipient='+971505550000'");
waFail = { status: 400, body: { error: { message: 'Template name does not exist in the translation', code: 132001 } } };
await processJob(wr.id);
r = one('SELECT * FROM jobs WHERE id=?', wr.id);
ok(r.status === 'failed' && /not approved yet|does not exist/.test(r.last_error), 'permanent WhatsApp error → Failed with clear explanation');
ok(one("SELECT status FROM jobs WHERE id=?", rj.id).status === 'sent', 'the email for the same row is unaffected (channels independent)');

sheetValues.push(['Token Test', 'tok@example.com', '0506660000', 'yes']);
await pollShop(S);
const tj = one("SELECT * FROM jobs WHERE channel='whatsapp' AND recipient='+971506660000'");
waFail = { status: 401, body: { error: { message: 'Error validating access token', code: 190 } } };
await processJob(tj.id);
r = one('SELECT * FROM jobs WHERE id=?', tj.id);
ok(r.status === 'blocked' && r.error_kind === 'account', 'expired WhatsApp token → message waits (not lost, not failed)');
ok(one('SELECT status FROM accounts WHERE id=?', W).status === 'needs_attention', 'WhatsApp account flagged "needs attention"');
ok(!!one("SELECT 1 FROM alerts WHERE key=? AND resolved_at IS NULL", `account:${W}`), 'alert raised for the dashboard + email notification');
saveAccount({ id: W, provider: 'whatsapp', label: 'WA', identifier: '111', secret: { access_token: 'newtok' }, info: { phone_number_id: '111', waba_id: '222' } });
ok(one('SELECT status FROM jobs WHERE id=?', tj.id).status === 'pending', 'reconnecting the account releases waiting messages');
await processJob(tj.id);
ok(one('SELECT status FROM jobs WHERE id=?', tj.id).status === 'sent', 'and they are sent');

run("UPDATE accounts SET secret=? WHERE id=?", (await import('../lib/crypto.js')).encryptJson({ refresh_token: 'r', access_token: 'old', expires_at: 0 }), G);
try { await getAccessToken(G); ok(false, 'expired Google refresh should fail'); } catch (e) { ok(e.kind === 'auth', 'revoked Google sign-in detected (invalid_grant)'); }
ok(one('SELECT status FROM accounts WHERE id=?', G).status === 'needs_attention', 'Google account flagged "needs attention"');

console.log('\nOneDrive Excel — business (workbook API)');
const MS = saveAccount({ provider: 'microsoft', label: 'me@outlook.com', identifier: 'me@outlook.com', secret: { refresh_token: 'r', access_token: 'mstok', expires_at: future } });
run("UPDATE accounts SET tested_at=datetime('now') WHERE id=?", MS);
const S2 = Number(run(`INSERT INTO shops (name, sheet_provider, sheet_account_id, sheet_ref, sheet_tab, header_row, column_map, status, mode, settings, baseline_test_done)
  VALUES ('Shop Two', 'microsoft', ?, ?, 'Leads', 2, ?, 'active', 'test', ?, 1)`, MS, JSON.stringify({ driveId: 'd1', itemId: 'i1', mode: 'workbook' }),
  JSON.stringify(map), JSON.stringify({ ...DEFAULT_SHOP_SETTINGS, channels: 'email', consent: { required: false } })).lastInsertRowid);
run('INSERT INTO templates (shop_id, channel, data) VALUES (?,?,?)', S2, 'email', JSON.stringify({ subject: 'Hi', body: 'Hi {{name}}' }));
msUsed = [['Name', 'Email', 'Phone Number', 'Consent Status'], ['Khalid', 'khalid@example.com', '', ''], ['', '', '', '']];
await pollShop(S2);
const kj = one('SELECT * FROM jobs WHERE shop_id=?', S2);
ok(kj && kj.row_number === 3, 'usedRange starting at B2 mapped to the right sheet row (row 3)');
ok(one('SELECT COUNT(*) n FROM jobs WHERE shop_id=? AND recipient LIKE ?', S, '%khalid%').n === 0, 'other shop never sees this shop\'s contacts');
await processJob(kj.id); // test mode, Gmail account not set → simulated
ok(one('SELECT simulated FROM jobs WHERE id=?', kj.id).simulated === 1, 'no Gmail account for this shop → SIMULATED, clearly labelled');
await pollShop(S2);
const patch = calls.filter((c) => c.url.includes("range(address='F3")).pop();
ok(patch && JSON.parse(patch.body).values[0][0] === 'SIMULATED – not sent', 'status written to the correct Excel cells (column F, row 3)');

console.log('\nOneDrive Excel — personal (file mode with ETag protection)');
const tmpl = fs.readFileSync(new URL('./fixtures/blank.xlsx', import.meta.url));
xlsxBuf = xlsx.writeCells(tmpl, 'Sheet1', [
  { row: 1, col: 0, value: 'Name' }, { row: 1, col: 1, value: 'Email' }, { row: 2, col: 0, value: 'Old' }, { row: 2, col: 1, value: 'old@x.com' }]);
const S3 = Number(run(`INSERT INTO shops (name, sheet_provider, sheet_account_id, sheet_ref, sheet_tab, column_map, status, mode, settings)
  VALUES ('Shop Three', 'microsoft', ?, ?, 'Sheet1', ?, 'active', 'test', ?)`, MS, JSON.stringify({ driveId: 'd1', itemId: 'i1', mode: 'file' }),
  JSON.stringify({ ...map, phone: undefined, consent: undefined }), JSON.stringify({ ...DEFAULT_SHOP_SETTINGS, channels: 'email', consent: { required: false } })).lastInsertRowid);
run('INSERT INTO templates (shop_id, channel, data) VALUES (?,?,?)', S3, 'email', JSON.stringify({ subject: 'Hi', body: 'Hi {{name}}' }));
await pollShop(S3);
xlsxBuf = xlsx.writeCells(xlsxBuf, 'Sheet1', [{ row: 3, col: 0, value: 'Huda' }, { row: 3, col: 1, value: 'huda@example.com' }]); xlsxEtag = '"v7"';
await pollShop(S3);
const hj = one('SELECT * FROM jobs WHERE shop_id=?', S3);
ok(hj && hj.recipient === 'huda@example.com', 'new row detected in a downloaded .xlsx');
await processJob(hj.id);
bumpAfterDownload = true; // someone saves the file in Excel between our download and our upload
const r1 = await pollShop(S3);
ok(r1.writeError && /busy or was just changed/.test(r1.writeError), 'upload refused (ETag changed) → their edit is kept, status waits');
ok(!!one('SELECT 1 FROM sheet_dirty WHERE shop_id=?', S3), 'pending status update kept for the next check');
await pollShop(S3);
const out = xlsx.readSheet(xlsxBuf, 'Sheet1');
ok(out[0].includes('Email Status') && out[2][out[0].indexOf('Email Status')] === 'SIMULATED – not sent', 'next check writes the status into the latest version of the file');
ok(!one('SELECT 1 FROM sheet_dirty WHERE shop_id=?', S3), 'nothing left pending');
ok(calls.filter((c) => c.method === 'PUT').every((c) => c.headers['if-match']), 'every upload uses If-Match (never overwrites newer edits)');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
