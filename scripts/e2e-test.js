// End-to-end test: starts the real web server + background worker on a temporary database,
// creates two shops with demo sheets and checks isolation, duplicates, consent, edits, pauses,
// status write-back, webhooks and unsubscribe. Nothing is sent to any real provider.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, ENV_FILE: path.join(dir, 'none.env'), PORT: String(PORT), BASE_URL: BASE, DATA_DIR: dir, POLL_SECONDS: '15',
  ADMIN_PASSWORD: 'e2e-password-123', SESSION_SECRET: crypto.randomBytes(40).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  META_APP_SECRET: 'app-secret-e2e', WHATSAPP_VERIFY_TOKEN: 'verify-e2e' };
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function startProc(file) {
  const p = spawn(process.execPath, ['--no-warnings', path.join(ROOT, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${file}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${file} ERR] ${d}`));
  procs.push(p); return p;
}
let cookie = '';
async function api(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'sheetsender', cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const db = () => new DatabaseSync(path.join(dir, 'app.db'));
function sheetRows(shopId) { const d = db(); const r = d.prepare('SELECT rows FROM demo_sheets WHERE shop_id=?').get(shopId); d.close(); return JSON.parse(r.rows); }
function setSheet(shopId, rows) { const d = db(); d.prepare('UPDATE demo_sheets SET rows=? WHERE shop_id=?').run(JSON.stringify(rows), shopId); d.prepare('UPDATE shops SET last_polled_at=NULL WHERE id=?').run(shopId); d.close(); }
const jobs = async (shop) => (await api('GET', `/api/jobs?shop=${shop}`)).body;
async function waitFor(fn, label, ms = 40000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(1000); } ok(false, `timed out waiting: ${label}`); return false; }
const col = (rows, name) => rows[0].indexOf(name);

try {
  startProc('server.js'); startProc('worker.js');
  await waitFor(async () => { try { return (await fetch(BASE + '/healthz')).ok; } catch { return false; } }, 'server up', 15000);

  console.log('\nAuth & security');
  ok((await api('GET', '/api/overview')).status === 401, 'API requires sign-in');
  ok((await api('POST', '/api/login', { password: 'wrong' })).status === 401, 'wrong password rejected');
  ok((await api('POST', '/api/login', { password: 'e2e-password-123' })).status === 200, 'sign in works');
  ok((await api('POST', '/api/shops', { name: 'X' }, { 'x-requested-with': '' })).status === 403, 'state-changing request without CSRF header rejected');
  await waitFor(async () => (await api('GET', '/api/overview')).body.worker_online, 'worker heartbeat');
  ok(true, 'background worker is online');

  console.log('\nSetup two shops');
  await api('PUT', '/api/settings', { owner_email: 'owner@example.com', owner_phone: '0501234567' });
  const s = (await api('GET', '/api/settings')).body;
  ok(s.owner_phone === '+971501234567', 'owner phone normalised to +971501234567');
  const A = (await api('POST', '/api/shops', { name: 'Sunrise Bakery' })).body.id;
  const B = (await api('POST', '/api/shops', { name: 'Blue Wave Gym' })).body.id;
  ok((await api('POST', '/api/shops', { name: 'sunrise bakery' })).status === 400, 'duplicate shop name rejected');
  const ca = await api('POST', `/api/shops/${A}/sheet`, { provider: 'demo' });
  ok(ca.status === 200 && ca.body.column_map?.email === 'Email' && ca.body.column_map?.consent === 'Consent Status', 'demo sheet connected, columns auto-matched');
  await api('POST', `/api/shops/${B}/sheet`, { provider: 'demo' });
  await api('PATCH', `/api/shops/${A}`, { settings: { channels: 'both' } });
  await api('PATCH', `/api/shops/${B}`, { settings: { channels: 'email', consent: { required: false } } });
  await api('PUT', `/api/shops/${A}/templates/email`, { subject: 'Hi {{name}} from {{business_name}}', body: 'Welcome {{first_name}}!' });
  await api('PUT', `/api/shops/${B}/templates/email`, { subject: 'Blue Wave Gym says hi {{name}}', body: 'Workout time, {{name}}!' });
  const wt = await api('PUT', `/api/shops/${A}/templates/whatsapp`, { template_name: 'welcome', language: 'en', template: { body_params: 1 }, body_params: ['{{name}}'] });
  ok(wt.status === 200, 'WhatsApp template saved for shop A');
  ok((await api('PUT', `/api/shops/${A}/templates/whatsapp`, { template_name: 'welcome', language: 'en', template: { body_params: 2 }, body_params: ['{{name}}'] })).status === 400, 'template with missing variables rejected');
  await api('PUT', `/api/shops/${A}/templates/whatsapp`, { template_name: 'welcome', language: 'en', template: { body_params: 1 }, body_params: ['{{name}}'] });
  const prev = (await api('POST', `/api/shops/${A}/preview/email`, { subject: 'Hi {{name}} from {{business_name}}', body: 'x' })).body;
  ok(prev.subject === 'Hi Existing Customer from Sunrise Bakery', `preview uses this shop's data ("${prev.subject}")`);
  const live = await api('POST', `/api/shops/${A}/start`, { mode: 'live' });
  ok(live.status === 400 && /Not ready to go live/.test(live.body.error), 'Live is blocked until integrations are connected and tested');

  console.log('\nStart test mode → existing rows are not messaged');
  await api('POST', `/api/shops/${A}/start`, { mode: 'test' });
  await api('POST', `/api/shops/${B}/start`, { mode: 'test' });
  await waitFor(async () => { const d = db(); const r = d.prepare('SELECT baseline_test_done a FROM shops WHERE id IN (?,?)').all(A, B); d.close(); return r.every((x) => x.a); }, 'baseline');
  ok((await jobs(A)).length === 0 && (await jobs(B)).length === 0, 'existing row was recorded but NOT messaged');

  console.log('\nAdd new rows');
  let ra = sheetRows(A);
  ra.push(['Ali Hassan', 'ali@example.com', '050 111 2222', 'Yes']);   // eligible
  ra.push(['Noor', 'noor@example.com', '0503334444', '']);             // no consent
  ra.push(['Bad Email', 'not-an-email', 'abc', 'yes']);               // invalid
  ra.push(['Ali Again', 'ALI@example.com', '0509999999', 'yes']);     // same contact again (email, different case)
  ra.push(['Ali Phone', '', '+971 50 111 2222', 'yes']);             // different row, same WhatsApp number as row 3
  setSheet(A, ra);
  const rb = sheetRows(B); rb.push(['Sara', 'sara@example.com', '', '']); setSheet(B, rb);
  await waitFor(async () => (await jobs(A)).filter((j) => j.status === 'sent').length >= 2 && (await jobs(B)).some((j) => j.status === 'sent'), 'rows processed');
  await sleep(16000); // let status write-back run
  const ja = await jobs(A), jb = await jobs(B);
  const byRow = (js, row, ch) => js.find((j) => j.row_number === row && j.channel === ch);
  ok(byRow(ja, 3, 'email')?.status === 'sent' && byRow(ja, 3, 'email')?.simulated === 1, 'eligible row: email SIMULATED (no account yet)');
  ok(byRow(ja, 3, 'whatsapp')?.status === 'sent' && byRow(ja, 3, 'whatsapp')?.simulated === 1, 'eligible row: WhatsApp handled independently (simulated)');
  ok(byRow(ja, 4, 'email')?.error_kind === 'no_consent', 'missing consent → "skipped – no consent" (not a failure)');
  ok(byRow(ja, 5, 'email')?.status === 'invalid' && byRow(ja, 5, 'whatsapp')?.status === 'invalid', 'invalid email and phone → Invalid contact');
  ok(!byRow(ja, 6, 'email') && !byRow(ja, 6, 'whatsapp'), 'same contact repeated in the sheet → no second message');
  ok(byRow(ja, 7, 'whatsapp')?.error_kind === 'duplicate', 'same WhatsApp number in a different row → duplicate, not sent twice');
  ok(byRow(ja, 7, 'email')?.error_kind === 'no_address', 'row without email → skipped – no address');
  ok(jb.length === 1 && jb[0].channel === 'email' && jb[0].status === 'sent', 'shop B: email only, its own row only');
  ok(!ja.some((j) => j.row_number === 3 && j.recipient?.startsWith('sa')), 'no cross-shop jobs');

  ra = sheetRows(A);
  const es = col(ra, 'Email Status'), ws = col(ra, 'WhatsApp Status'), ed = col(ra, 'Error Details');
  ok(es > 0 && ws > 0 && ed > 0, 'status columns were added to the header row');
  ok(ra[2][es] === 'SIMULATED – not sent', `sheet row 3 Email Status = "${ra[2][es]}"`);
  ok(ra[3][es] === 'Skipped – no consent', `sheet row 4 Email Status = "${ra[3][es]}"`);
  ok(ra[4][es] === 'Invalid contact' && /Invalid email/.test(ra[4][ed]), `sheet row 5: "${ra[4][es]}" / "${ra[4][ed]}"`);
  ok(ra[5][es] === 'Skipped – duplicate of row 3', `sheet row 6 Email Status = "${ra[5][es]}"`);
  ok(ra[6][ws] === 'Skipped – duplicate', `sheet row 7 WhatsApp Status = "${ra[6][ws]}"`);
  const rbNow = sheetRows(B);
  ok(col(rbNow, 'WhatsApp Status') === -1 && rbNow[2][col(rbNow, 'Email Status')] === 'SIMULATED – not sent', 'shop B sheet: only email columns, own status');

  console.log('\nEdits');
  ra = sheetRows(A); ra[2][0] = 'Ali H. (edited)'; ra[3][3] = 'Yes'; setSheet(A, ra);
  await waitFor(async () => (await jobs(A)).filter((j) => j.row_number === 4 && j.status === 'sent').length === 2, 'consent edit processed');
  const ja2 = await jobs(A);
  ok(ja2.filter((j) => j.row_number === 3 && j.channel === 'email').length === 1, 'editing a messaged row did NOT resend');
  ok(byRow(ja2, 4, 'email')?.status === 'sent', 'row whose consent changed to Yes was sent');

  console.log('\nPause one shop, the other keeps running');
  await api('POST', `/api/shops/${A}/pause`);
  ra = sheetRows(A); ra.push(['Paused Row', 'p@example.com', '', 'yes']); setSheet(A, ra);
  const rb2 = sheetRows(B); rb2.push(['Omar', 'omar@example.com', '', '']); setSheet(B, rb2);
  await waitFor(async () => (await jobs(B)).length === 2, 'shop B processed while A paused');
  await sleep(3000);
  ok(!(await jobs(A)).some((j) => j.row_number === 8), 'paused shop A did not process its new row');
  await api('POST', `/api/shops/${A}/start`, { mode: 'test' });
  await waitFor(async () => (await jobs(A)).some((j) => j.row_number === 8 && j.status === 'sent'), 'A resumes');
  ok(true, 'after resume, the row added while paused was processed');

  console.log('\nGlobal pause');
  await api('POST', '/api/global-pause', { paused: true });
  const rb3 = sheetRows(B); rb3.push(['Global Pause', 'gp@example.com', '', '']); setSheet(B, rb3);
  await sleep(20000);
  ok((await jobs(B)).length === 2, 'nothing processed while globally paused');
  await api('POST', '/api/global-pause', { paused: false });
  await waitFor(async () => (await jobs(B)).length === 3, 'resumes after global pause');
  ok(true, 'processing resumes after global resume');

  console.log('\nWhatsApp webhook');
  { const d = db(); d.prepare("UPDATE jobs SET provider_message_id='wamid.TEST1', simulated=0 WHERE shop_id=? AND channel='whatsapp' AND row_number=3").run(A); d.close(); }
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TEST1', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }],
    messages: [{ from: '971501112222', text: { body: 'STOP' } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', env.META_APP_SECRET).update(payload).digest('hex');
  ok((await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': 'sha256=bad' } })).status === 401, 'webhook with wrong signature rejected');
  ok((await fetch(`${BASE}/webhooks/whatsapp`, { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig } })).status === 200, 'signed webhook accepted');
  ok(byRow(await jobs(A), 3, 'whatsapp')?.status === 'delivered', 'delivery update recorded as Delivered');
  ok((await api('GET', `/api/optouts?shop=${A}`)).body.some((o) => o.value === '+971501112222'), 'STOP reply added the number to this shop\'s opt-out list');
  const vr = await fetch(`${BASE}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-e2e&hub.challenge=12345`);
  ok(vr.status === 200 && (await vr.text()) === '12345', 'Meta webhook verification works');

  console.log('\nOpt-outs and unsubscribe');
  process.env.SESSION_SECRET = env.SESSION_SECRET; process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
  const { sign } = await import(path.join(ROOT, 'lib/crypto.js'));
  const u = await fetch(`${BASE}/u/${sign({ s: B, c: 'email', v: 'zed@example.com' })}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  ok(u.status === 200, 'one-click unsubscribe accepted');
  const page = await (await fetch(`${BASE}/u/${sign({ s: B, c: 'email', v: 'zed@example.com' })}`)).text();
  ok(page.includes('Blue Wave Gym'), 'unsubscribe page names the right shop');
  await api('POST', '/api/optouts', { scope: 'global', channel: 'all', value: 'blocked@example.com' });
  const rb4 = sheetRows(B); rb4.push(['Zed', 'Zed@Example.com', '', ''], ['Blocked', 'blocked@example.com', '', '']); setSheet(B, rb4);
  await waitFor(async () => (await jobs(B)).some((j) => j.status === 'opted_out' && j.recipient?.startsWith('bl')), 'global opt-out respected');
  ok(true, 'global suppression list blocks every shop');
  ok((await jobs(B)).some((j) => j.status === 'opted_out' && j.recipient?.startsWith('ze')), 'contact who unsubscribed from this shop is not messaged');
  // The same person can still get messages from a different shop (shop-level opt-out).
  const rz = sheetRows(A); rz.push(['Zed', 'zed@example.com', '', 'yes']); setSheet(A, rz);
  await waitFor(async () => (await jobs(A)).some((j) => j.recipient?.startsWith('ze') && j.status === 'sent'), 'other shop unaffected');
  ok(true, 'a shop-level opt-out does not block other shops');

  console.log('\nRetry safety');
  { const d = db(); d.prepare("UPDATE jobs SET status='failed', last_error='test failure' WHERE shop_id=? AND row_number=8 AND channel='email'").run(A); d.close(); }
  const before = (await jobs(A)).filter((j) => j.status === 'sent').length;
  const rr = await api('POST', `/api/shops/${A}/retry`, {});
  ok(rr.body.count === 1, 'retry only picks the failed message (not the successful ones)');
  await waitFor(async () => byRow(await jobs(A), 8, 'email')?.status === 'sent', 'retried message sent');
  ok((await jobs(A)).filter((j) => j.status === 'sent').length === before + 1, 'successful messages were not re-sent');

  const ov = (await api('GET', '/api/overview')).body;
  const cardA = ov.shops.find((x) => x.id === A);
  ok(cardA.contacts >= 5 && cardA.simulated > 0, `dashboard card: ${cardA.contacts} contacts, ${cardA.counts.sent} sent (${cardA.simulated} simulated)`);
  const act = (await api('GET', `/api/activity?shop=${A}`)).body;
  ok(act.some((a) => a.event === 'simulated' && a.simulated === 1) && !act.some((a) => a.detail?.includes('ali@example.com')), 'activity log records sends, marks simulations, hides full emails');
  const html = await (await fetch(BASE + '/')).text();
  ok(html.includes('SheetSender') && html.includes('app.js'), 'dashboard page served');
} catch (e) {
  fail++; console.error(e);
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await sleep(500);
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
