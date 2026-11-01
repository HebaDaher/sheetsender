// End-to-end test: real HTTP server + real PostgreSQL + mock Gmail (SMTP/TLS) + mock WhatsApp Graph API.
// Run: TEST_DATABASE_URL=postgres://... NODE_EXTRA_CA_CERTS=<test cert> TEST_TLS_KEY=... TEST_TLS_CERT=... node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startSmtp, startGraph, startGoogle, makeXlsx } from './mocks.js';

const BASE_DB = process.env.TEST_DATABASE_URL;
const key = fs.readFileSync(process.env.TEST_TLS_KEY); const cert = fs.readFileSync(process.env.TEST_TLS_CERT);
const WA = { token: 'EAAtest', pnid: '1234567890', waba: '9876543210', appId: '5555555', appSecret: 'appsecret123' };

let smtp, graph, google, server, base, db, worker, pgmod;

async function freshDb() {
  const u = new URL(BASE_DB); const admin = new URL(BASE_DB); admin.pathname = '/postgres';
  const p = new pgmod.Pool(admin.toString(), { max: 1 });
  await p.query('DROP DATABASE IF EXISTS ss_e2e', null); await p.query('CREATE DATABASE ss_e2e', null); p.end();
  u.pathname = '/ss_e2e'; return u.toString();
}

before(async () => {
  pgmod = await import('../src/pg.js');
  smtp = await startSmtp({ key, cert, password: 'goodpass' });
  graph = await startGraph({ token: WA.token, pnid: WA.pnid, waba: WA.waba });
  process.env.DATABASE_URL = await freshDb();
  process.env.APP_SECRET = crypto.randomBytes(32).toString('base64url');
  process.env.GRAPH_API_BASE = `http://127.0.0.1:${graph.port}`;
  google = await startGoogle();
  process.env.GOOGLE_CLIENT_ID = 'gid.apps.googleusercontent.com'; process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
  process.env.GOOGLE_AUTH_URL = 'https://accounts.example.test/o/oauth2/v2/auth';
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${google.port}/token`; process.env.GMAIL_API_BASE = `http://127.0.0.1:${google.port}`;
  process.env.SHEETSENDER_NO_LOOP = '1';
  process.env.PUBLIC_URL = 'http://127.0.0.1:0';
  db = await import('../src/db.js');
  await db.initDb();
  worker = await import('../src/worker.js');
  const { createServer } = await import('../src/server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { google?.server.close(); server?.close(); smtp?.server.close(); graph?.server.close(); db?.pool?.end(); });

class Browser {
  constructor() { this.cookie = ''; this.csrf = ''; this.html = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, body, redirect: 'manual', headers: { Cookie: this.cookie, Accept: 'text/html' } });
    const sc = res.headers.getSetCookie?.() || [];
    this.jar ||= new Map();
    for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v) this.jar.set(k, v); else this.jar.delete(k); }
    this.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/); if (m) this.csrf = m[1];
    if (res.headers.get('content-type')?.includes('html')) this.html = text;
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  }
  async get(path) {
    let r = await this.req('GET', path);
    for (let i = 0; i < 5 && r.status === 303; i++) r = await this.req('GET', r.location);
    return r;
  }
  async post(path, fields = {}, files = []) {
    let body;
    if (files.length) {
      body = new FormData();
      body.append('_csrf', this.csrf);
      for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
      for (const f of files) body.append(f.field, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
    } else {
      body = new URLSearchParams({ _csrf: this.csrf });
      for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
    }
    const r = await this.req('POST', path, body);
    if (r.status === 303) { const loc = r.location; const page = await this.get(loc); page.location = loc; page.redirected = true; return page; }
    return r;
  }
}

const notice = (b) => decodeURIComponent((b.location || '').split(/[?&]ok=/)[1]?.split('&')[0] || '').replace(/\+/g, ' ');
const errorOf = (b) => decodeURIComponent((b.location || '').split(/[?&]err=/)[1]?.split('&')[0] || '').replace(/\+/g, ' ');
const lastCode = () => { const m = smtp.state.mails.at(-1).data.match(/code[^0-9]*(\d{6})/i); return m && m[1]; };
const one = async (sql, p = []) => (await db.q(sql, p)).rows[0];

const A = new Browser(); const B = new Browser();
const ids = {};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);

test('setup page appears without settings (unit)', async () => {
  const cfg = await import('../src/config.js');
  assert.deepEqual(cfg.missingSettings(), []);
});

test('sign up two separate accounts', async () => {
  let r = await A.get('/signup');
  r = await A.post('/signup', { name: 'Heba Test', email: 'heba@example.com', password: 'short' });
  assert.match(r.text, /at least 10 characters/);
  r = await A.post('/signup', { name: 'Heba Test', email: 'heba@example.com', password: 'a-very-good-password' });
  assert.equal(r.status, 200); assert.match(r.text, /Upload a customer file/);
  await B.get('/signup');
  r = await B.post('/signup', { name: 'Other User', email: 'other@example.com', password: 'another-good-password' });
  assert.match(r.text, /Hello Other/);
  r = await B.post('/signup', { name: 'X', email: 'heba@example.com', password: 'a-very-good-password' });
  // B is logged in, so signup redirects; duplicate check via fresh browser:
  const C = new Browser(); await C.get('/signup');
  r = await C.post('/signup', { name: 'Dup', email: 'HEBA@example.com', password: 'a-very-good-password' });
  assert.match(r.text, /already exists/);
});

test('CSRF and login protection', async () => {
  const r = await fetch(base + '/shops', { method: 'POST', headers: { Cookie: A.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Evil' });
  assert.equal(r.status, 403);
  const C = new Browser(); await C.get('/login');
  const bad = await C.post('/login', { email: 'heba@example.com', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const ok = await C.post('/login', { email: 'heba@example.com', password: 'a-very-good-password' });
  assert.match(ok.text, /Hello Heba/);
});

test('settings: allow sending all day for the test', async () => {
  await A.get('/settings');
  const r = await A.post('/settings', { name: 'Heba Test', timezone: 'Asia/Dubai', send_start: '0', send_end: '24', country: 'AE' });
  assert.match(notice(r), /Saved/);
});

test('create shop, upload Excel, match columns', async () => {
  await A.get('/shops');
  let r = await A.post('/shops', { name: 'GoSkate Marina' });
  ids.shop = r.location.match(/\/shops\/(\d+)/)[1];
  const xlsx = makeXlsx([
    ['Customer Name', 'Email', 'Mobile', 'WhatsApp', 'Marketing consent', 'Branch'],
    ['Sara Ali', 'sara@example.com', '0501234567', '', 'Yes', 'Marina'],
    ['Omar', 'omar@example', '0559999999', '', 'yes', 'Marina'],            // invalid email
    ['No Consent', 'nc@example.com', '0521111111', '', 'No', 'JBR'],          // no consent
    ['Dup Sara', 'SARA@example.com', '0501234567', '', 'Yes', 'Marina'],      // duplicate
    ['ليلى', 'layla@example.com', '', '971 56 222 3333', 'نعم', 'Marina'],     // Arabic, whatsapp column
    ['Empty Consent', 'ec@example.com', '0503333333', '', '', 'Marina'],      // empty consent
    ['Num Phone', 'num@example.com', 971504444444, '', 'opted in', 'Marina'], // numeric cell
    ['Bad Phone', 'bp@example.com', '12', '', 'Yes', 'Marina'],
  ]);
  r = await A.post(`/shops/${ids.shop}/upload`, {}, [{ field: 'file', name: 'customers.xlsx', data: xlsx }]);
  assert.match(r.location, /\/uploads\/\d+\/map/);
  ids.upload = r.location.match(/uploads\/(\d+)/)[1];
  // guessed mapping is pre-selected
  assert.match(r.text, /<option value="Customer Name" selected>/);
  assert.match(r.text, /<option value="Marketing consent" selected>/);
  r = await A.post(`/uploads/${ids.upload}/map`, { name: 'Customer Name', email: 'Email', phone: 'Mobile', whatsapp: 'WhatsApp', consent: '', country: 'AE' });
  assert.match(errorOf(r), /Consent Status/);
  r = await A.post(`/uploads/${ids.upload}/map`, { name: 'Customer Name', email: 'Email', phone: 'Mobile', whatsapp: 'WhatsApp', consent: 'Marketing consent', country: 'AE' });
  assert.match(notice(r), /8 customers loaded/);
  const c = await one("SELECT phone, email, consent_whatsapp FROM contacts WHERE name='ليلى'");
  assert.equal(c.phone, '971562223333'); assert.equal(c.consent_whatsapp, true);
  assert.equal((await one("SELECT phone FROM contacts WHERE name='Num Phone'")).phone, '971504444444');
  assert.equal((await one("SELECT phone FROM contacts WHERE name='Sara Ali'")).phone, '971501234567');
  assert.equal((await one("SELECT phone FROM contacts WHERE name='Bad Phone'")).phone, null);
});

test('CSV upload works too', async () => {
  await A.get('/shops');
  let r = await A.post('/shops', { name: 'Crazy Car' });
  ids.shop2 = r.location.match(/\/shops\/(\d+)/)[1];
  const csv = '﻿Name;E-mail;Consent\n"Ali, Jr";ali@example.com;yes\nMona;mona@example.com;no\n';
  r = await A.post(`/shops/${ids.shop2}/upload`, {}, [{ field: 'file', name: 'list.csv', data: Buffer.from(csv) }]);
  const up = r.location.match(/uploads\/(\d+)/)[1];
  r = await A.post(`/uploads/${up}/map`, { name: 'Name', email: 'E-mail', consent: 'Consent', country: 'AE' });
  assert.match(notice(r), /2 customers/);
  assert.equal((await one("SELECT name FROM contacts WHERE email='ali@example.com'")).name, 'Ali, Jr');
});

test('another account cannot see this account\'s data', async () => {
  for (const p of [`/shops/${ids.shop}`, `/uploads/${ids.upload}/map`]) assert.equal((await B.get(p)).status, 404);
  const r = await B.get('/shops'); assert.doesNotMatch(r.text, /<h2>GoSkate Marina<\/h2>/); assert.match((await A.get('/shops')).text, /<h2>GoSkate Marina<\/h2>/);
  await B.get('/shops');
  const del = await B.post(`/shops/${ids.shop}/delete`, {}); assert.equal(del.status, 404);
  assert.ok(await one('SELECT 1 AS x FROM shops WHERE id=$1', [ids.shop]));
});

test('connect and verify an email sender (wrong password rejected)', async () => {
  await A.get('/senders/new/email');
  let r = await A.post('/senders/email', { label: 'Shop mail', email: 'shop@example.com', from_name: 'GoSkate', password: 'badpass', host: 'localhost', port: String(smtp.port), security: 'ssl', daily_limit: '500' });
  assert.match(errorOf(r), /Could not sign in/);
  r = await A.post('/senders/email', { label: 'Shop mail', email: 'shop@example.com', from_name: 'GoSkate', password: 'goodpass', host: 'localhost', port: String(smtp.port), security: 'ssl', daily_limit: '500' });
  ids.emailSender = r.location.match(/senders\/(\d+)/)[1];
  assert.match(r.text, /Enter the verification code/);
  assert.equal(smtp.state.mails.at(-1).to, 'shop@example.com');
  const code = lastCode(); assert.ok(code);
  r = await A.post(`/senders/${ids.emailSender}/verify`, { code: '000000' === code ? '111111' : '000000' });
  assert.match(errorOf(r), /not correct/);
  r = await A.post(`/senders/${ids.emailSender}/verify`, { code });
  assert.match(notice(r), /verified/);
  assert.equal((await one('SELECT status FROM senders WHERE id=$1', [ids.emailSender])).status, 'verified');
  const s = await one('SELECT secrets FROM senders WHERE id=$1', [ids.emailSender]);
  assert.doesNotMatch(s.secrets, /goodpass/); // stored encrypted
});

test('email campaign: preview, consent filtering, activate once, automatic sending', async () => {
  await A.get(`/campaigns/new?shop=${ids.shop}`);
  let r = await A.post('/campaigns', { name: 'Nov offer', shop_id: ids.shop, sender_id: ids.emailSender });
  ids.camp = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${ids.camp}/edit`, { subject: 'Hi {{first_name}} — offer at {{Branch}}', body: 'Dear {{name}},\nVisit https://goskate.ae', audience: 'all', skip_already: '1', action: 'preview' },
    [{ field: 'media', name: 'pic.png', data: PNG, type: 'image/png' }]);
  assert.match(r.location, /preview/);
  assert.match(r.text, /Hi Sara — offer at Marina/);
  assert.match(r.text, /<b>4<\/b><span>will be sent/); // Sara, Layla, Num Phone, Bad Phone(email ok)
  assert.match(r.text, /skipped: no consent/); assert.match(r.text, /skipped: duplicate in file/); assert.match(r.text, /skipped: invalid email address/);
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  r = await A.post(`/campaigns/${ids.camp}/activate`, { key, mode: 'auto' });
  assert.match(errorOf(r), /Tick the box/);
  r = await A.post(`/campaigns/${ids.camp}/activate`, { key, mode: 'auto', confirm: '1' });
  assert.match(notice(r), /4 messages queued/);
  r = await A.post(`/campaigns/${ids.camp}/activate`, { key, mode: 'auto', confirm: '1' });
  assert.match(notice(r), /already active/);
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='queued'", [ids.camp])).n, 4);
  // Two ticks at once must not double-send.
  const before = smtp.state.mails.length;
  await Promise.all([worker.tick(), worker.tick(), worker.processCampaign(ids.camp, { deadline: Date.now() + 5000 })]);
  await worker.tick();
  const sent = smtp.state.mails.slice(before);
  assert.equal(sent.length, 4);
  assert.equal(new Set(sent.map((m) => m.to)).size, 4);
  const m = sent.find((x) => x.to === 'sara@example.com').data;
  assert.match(m, /List-Unsubscribe: <http/); assert.match(m, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(m, /From: GoSkate <shop@example.com>/); assert.match(m, /Content-ID: <img0@sheetsender>/);
  const camp = await one('SELECT status FROM campaigns WHERE id=$1', [ids.camp]);
  assert.equal(camp.status, 'completed');
  r = await A.get(`/campaigns/${ids.camp}/status.json`);
  assert.equal(r.json().counts.sentTotal, 4);
  ids.unsub = Buffer.from(m.match(/List-Unsubscribe: <([^>]+)>/)[1]).toString();
});

test('one-click unsubscribe and re-send protection', async () => {
  const path = new URL(ids.unsub).pathname;
  let r = await fetch(base + path); assert.match(await r.text(), /Yes, unsubscribe me/); // GET only asks
  assert.ok(!(await one("SELECT 1 AS x FROM suppressions WHERE address='sara@example.com'")));
  r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.ok(await one("SELECT 1 AS x FROM suppressions WHERE address='sara@example.com' AND channel='email'"));
  const bad = await fetch(base + path.slice(0, -3) + 'xyz', { method: 'POST' }); assert.equal(bad.status, 400);
  // Copy the campaign: Sara (opted out) and everyone who already got it are skipped.
  await A.get(`/campaigns/${ids.camp}`);
  r = await A.post(`/campaigns/${ids.camp}/duplicate`, {});
  const copy = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.get(`/campaigns/${copy}/preview`);
  assert.match(r.text, /skipped: opted out/); assert.match(r.text, /skipped: already received this message/);
  assert.doesNotMatch(r.text, /Activate campaign/); // nobody left
});

test('email daily limit, provider slow-down and stale sends', async () => {
  await A.get(`/campaigns/new?shop=${ids.shop}`);
  let r = await A.post('/campaigns', { name: 'Second', shop_id: ids.shop, sender_id: ids.emailSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { subject: 'Another', body: 'Different text', audience: 'all', skip_already: '1', action: 'preview' });
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  r = await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  assert.match(notice(r), /3 messages queued/); // Sara opted out now
  // Provider says slow down on the first message → sender held, nothing failed.
  smtp.state.next.push({ at: 'rcpt', code: 421, text: '4.7.0 Try again later' });
  const n0 = smtp.state.mails.length;
  await worker.tick();
  let s = await one('SELECT hold_until, hold_reason FROM senders WHERE id=$1', [ids.emailSender]);
  assert.ok(new Date(s.hold_until) > new Date()); assert.match(s.hold_reason, /slow down/);
  assert.equal(smtp.state.mails.length, n0);
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='queued'", [id])).n, 3);
  await worker.tick(); assert.equal(smtp.state.mails.length, n0); // still waiting
  // Hold expires; daily limit is 5 and 4 were sent in the last 24h → only 1 more goes out.
  await db.q('UPDATE senders SET hold_until=NULL, daily_limit=5 WHERE id=$1', [ids.emailSender]);
  await worker.tick();
  assert.equal(smtp.state.mails.length, n0 + 1);
  s = await one('SELECT hold_until, hold_reason FROM senders WHERE id=$1', [ids.emailSender]);
  assert.match(s.hold_reason, /Daily limit of 5/);
  const camp = await A.get(`/campaigns/${id}`); assert.match(camp.text, /Waiting until/);
  // Rejected recipient → failed (not retried); quota error → held 24h.
  await db.q("UPDATE senders SET hold_until=NULL, daily_limit=500 WHERE id=$1", [ids.emailSender]);
  smtp.state.next.push({ at: 'rcpt', code: 550, text: '5.1.1 The email account that you tried to reach does not exist' });
  smtp.state.next.push({ at: 'data', code: 550, text: '5.4.5 Daily user sending limit exceeded' });
  await worker.tick();
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='failed'", [id])).n, 1);
  s = await one("SELECT extract(epoch from hold_until - now())::int AS secs FROM senders WHERE id=$1", [ids.emailSender]);
  assert.ok(s.secs > 23 * 3600);
  // A message stuck in "sending" is marked unknown, never resent automatically.
  await db.q("UPDATE senders SET hold_until=NULL WHERE id=$1", [ids.emailSender]);
  await db.q("UPDATE messages SET status='sending', updated_at=now() - interval '20 minutes' WHERE campaign_id=$1 AND status='queued'", [id]);
  const n1 = smtp.state.mails.length;
  await worker.tick();
  assert.equal(smtp.state.mails.length, n1);
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='unknown'", [id])).n, 1);
  assert.equal((await one('SELECT status FROM campaigns WHERE id=$1', [id])).status, 'completed');
});

test('allowed hours are respected', async () => {
  await A.get(`/campaigns/new?shop=${ids.shop2}`);
  let r = await A.post('/campaigns', { name: 'Hours', shop_id: ids.shop2, sender_id: ids.emailSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { subject: 'Hours', body: 'Hello', audience: 'all', skip_already: '1', action: 'preview' });
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  const h = worker.localHour('Asia/Dubai');
  await db.q('UPDATE users SET send_start=$2, send_end=$3 WHERE email=$1', ['heba@example.com', (h + 1) % 24, (h + 2) % 24]);
  const n0 = smtp.state.mails.length;
  await worker.tick();
  assert.equal(smtp.state.mails.length, n0);
  r = await A.get(`/campaigns/${id}/status.json`); assert.match(r.json().waiting, /Outside your allowed sending hours/);
  // Pause → nothing sent even inside hours; resume → sent.
  await db.q('UPDATE users SET send_start=0, send_end=24 WHERE email=$1', ['heba@example.com']);
  await A.get(`/campaigns/${id}`);
  await A.post(`/campaigns/${id}/pause`, {});
  await worker.tick(); assert.equal(smtp.state.mails.length, n0);
  await A.post(`/campaigns/${id}/resume`, {});
  await worker.tick(); assert.equal(smtp.state.mails.length, n0 + 1);
});

test('manual mode and cancel', async () => {
  await A.get('/shops');
  let r = await A.post('/shops', { name: 'Manual shop' });
  const shop = r.location.match(/\/shops\/(\d+)/)[1];
  const csv = 'Name,Email,Consent\n' + Array.from({ length: 6 }, (_, i) => `P${i},p${i}@example.com,yes`).join('\n');
  r = await A.post(`/shops/${shop}/upload`, {}, [{ field: 'file', name: 'm.csv', data: Buffer.from(csv) }]);
  const up = r.location.match(/uploads\/(\d+)/)[1];
  await A.post(`/uploads/${up}/map`, { name: 'Name', email: 'Email', consent: 'Consent', country: 'AE' });
  await A.get(`/campaigns/new?shop=${shop}`);
  r = await A.post('/campaigns', { name: 'Manual', shop_id: shop, sender_id: ids.emailSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { subject: 'M', body: 'manual', audience: 'all', skip_already: '1', action: 'preview' });
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${id}/activate`, { key, mode: 'manual', confirm: '1' });
  const n0 = smtp.state.mails.length;
  await worker.tick(); assert.equal(smtp.state.mails.length, n0); // manual: worker does not send
  r = await A.post(`/campaigns/${id}/send-next`, { count: '1' });
  assert.match(notice(r), /Sent 1 message/); assert.equal(smtp.state.mails.length, n0 + 1);
  r = await A.post(`/campaigns/${id}/cancel`, {});
  const c = await one("SELECT count(*) FILTER (WHERE status='cancelled')::int AS x FROM messages WHERE campaign_id=$1", [id]);
  assert.equal(c.x, 5);
  await A.post(`/campaigns/${id}/send-next`, { count: '5' });
  assert.equal(smtp.state.mails.length, n0 + 1);
});

test('connect WhatsApp sender, create template, webhook verification', async () => {
  await A.get('/senders/new/whatsapp');
  let r = await A.post('/senders/whatsapp', { label: 'GoSkate WA', phone_number_id: WA.pnid, waba_id: WA.waba, app_id: WA.appId, app_secret: WA.appSecret, token: 'wrong-token' });
  assert.match(errorOf(r), /Meta did not accept/);
  r = await A.post('/senders/whatsapp', { label: 'GoSkate WA', phone_number_id: WA.pnid, waba_id: WA.waba, app_id: WA.appId, app_secret: WA.appSecret, token: WA.token });
  ids.waSender = r.location.match(/senders\/(\d+)/)[1];
  assert.match(r.text, /250 different people per 24 hours/);
  assert.match(r.text, /promo_offer/); assert.match(r.text, /needs opt-out/);
  const hook = r.text.match(/(\/webhooks\/whatsapp\/[\w-]+)/)[1];
  ids.hook = hook;
  const keyTok = hook.split('/').pop();
  let v = await fetch(`${base}${hook}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`); assert.equal(v.status, 403);
  v = await fetch(`${base}${hook}?hub.mode=subscribe&hub.verify_token=${keyTok}&hub.challenge=42`); assert.equal(await v.text(), '42');
  await A.get(`/senders/${ids.waSender}/templates/new`);
  r = await A.post(`/senders/${ids.waSender}/templates`, { name: 'Bad Name', language: 'en', body: 'x', button: 'Stop promotions' });
  assert.match(errorOf(r), /lowercase/);
  r = await A.post(`/senders/${ids.waSender}/templates`, { name: 'nov_offer', language: 'ar', body: 'مرحبا {{1}}، خصم 20% هذا الأسبوع', footer: '', button: 'إيقاف العروض' }, [{ field: 'media', name: 'p.png', data: PNG, type: 'image/png' }]);
  assert.match(notice(r), /submitted/);
  const created = graph.state.created.at(-1);
  assert.equal(created.category, 'MARKETING');
  assert.deepEqual(created.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::handle'] } });
  assert.equal(created.components.at(-1).buttons[0].type, 'QUICK_REPLY');
});

test('WhatsApp campaign: template rules, limits, errors, opt-outs, webhooks', async () => {
  await A.get(`/campaigns/new?shop=${ids.shop}`);
  let r = await A.post('/campaigns', { name: 'WA promo', shop_id: ids.shop, sender_id: ids.waSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  // A template without opt-out cannot be activated.
  r = await A.post(`/campaigns/${id}/edit`, { template: 'no_optout|en', audience: 'all', skip_already: '1', action: 'preview' });
  assert.match(r.text, /has no opt-out/);
  r = await A.post(`/campaigns/${id}/edit`, { template: 'promo_offer|en', audience: 'all', skip_already: '1', action: 'save' });
  assert.match(r.text, /\{\{2\}\} in the body/);
  r = await A.post(`/campaigns/${id}/edit`, { template: 'promo_offer|en', 'src:body:1': 'first_name', 'val:body:1': '', 'src:body:2': 'shop', 'val:body:2': '', audience: 'all', skip_already: '1', action: 'preview' });
  assert.match(r.text, /needs an image/);
  r = await A.post(`/campaigns/${id}/edit`, { template: 'promo_offer|en', 'src:body:1': 'first_name', 'val:body:1': 'friend', 'src:body:2': 'shop', 'val:body:2': '', audience: 'all', skip_already: '1', action: 'preview' },
    [{ field: 'media', name: 'pic.png', data: PNG, type: 'image/png' }]);
  assert.match(r.text, /Hi Sara, 20% off at GoSkate Marina this week!/);
  // WhatsApp-eligible: Sara, Layla, Num Phone (+ Omar has phone & consent) ; Bad Phone invalid; No Consent; Dup; Empty consent
  assert.match(r.text, /<b>4<\/b><span>will be sent/);
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  r = await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  assert.match(notice(r), /4 messages queued/);

  // 1st send: throughput error 130429 with Meta's regain-access header → sender waits as instructed.
  graph.state.next.push({ code: 130429, message: 'Rate limit hit', headers: { 'X-Business-Use-Case-Usage': JSON.stringify({ [WA.waba]: [{ type: 'whatsapp', estimated_time_to_regain_access: 2 }] }) } });
  await worker.tick();
  let s = await one('SELECT extract(epoch from hold_until - now())::int AS secs, hold_reason FROM senders WHERE id=$1', [ids.waSender]);
  assert.ok(s.secs > 100 && s.secs <= 120, `held ${s.secs}s`); assert.match(s.hold_reason, /slow down/);
  assert.equal(graph.state.sent.length, 0);
  await db.q('UPDATE senders SET hold_until=NULL WHERE id=$1', [ids.waSender]);
  // Then: pair-rate (retry later), opted-out (131050), per-user marketing limit (131049, not retried), success.
  graph.state.next.push({ code: 131056, message: 'pair rate' }, { code: 131050, message: 'stopped marketing' }, { code: 131049, message: 'healthy ecosystem' });
  await worker.tick();
  assert.equal(graph.state.sent.length, 1);
  const tpl = graph.state.sent[0].template;
  assert.equal(tpl.name, 'promo_offer'); assert.equal(tpl.components[0].parameters[0].image.id, 'media1');
  assert.equal(graph.state.media, 1);
  const msgs = await db.rows('SELECT address, status, skip_reason, next_attempt_at FROM messages WHERE campaign_id=$1 ORDER BY id', [id]);
  const by = (st) => msgs.filter((m) => m.status === st);
  assert.equal(by('queued').length, 1); assert.ok(by('queued')[0].next_attempt_at);
  assert.equal(by('failed').length, 1); assert.equal(by('sent').length, 1);
  assert.equal(msgs.filter((m) => m.skip_reason === 'Opted out').length, 1);
  assert.ok(await one("SELECT 1 AS x FROM suppressions WHERE channel='whatsapp' AND address=$1", [msgs.find((m) => m.skip_reason === 'Opted out').address]));
  // Retry after the wait.
  await db.q("UPDATE messages SET next_attempt_at=now() WHERE campaign_id=$1 AND status='queued'", [id]);
  await worker.tick();
  assert.equal(graph.state.sent.length, 2);
  assert.equal((await one('SELECT status FROM campaigns WHERE id=$1', [id])).status, 'completed');

  // Webhook: bad signature rejected; signed delivery status + STOP reply processed.
  const sentMsg = await one("SELECT provider_id, address FROM messages WHERE campaign_id=$1 AND status='sent' ORDER BY id LIMIT 1", [id]);
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: WA.pnid },
    statuses: [{ id: sentMsg.provider_id, status: 'delivered' }, { id: sentMsg.provider_id, status: 'read' }],
    messages: [{ from: '971501234567', type: 'button', button: { text: 'Stop promotions', payload: 'Stop promotions' } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', WA.appSecret).update(payload).digest('hex');
  let w = await fetch(base + ids.hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: payload });
  assert.equal(w.status, 401);
  w = await fetch(base + ids.hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: payload });
  assert.equal(w.status, 200);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal((await one('SELECT status FROM messages WHERE provider_id=$1', [sentMsg.provider_id])).status, 'read');
  assert.ok(await one("SELECT 1 AS x FROM suppressions WHERE channel='whatsapp' AND address='971501234567'"));
  assert.equal(graph.state.sent.at(-1).type, 'text'); // opt-out confirmation reply
  // B can't see A's campaign
  assert.equal((await B.get(`/campaigns/${id}`)).status, 404);
  assert.equal((await B.get(`/campaigns/${id}/status.json`)).status, 404);
});

test('WhatsApp messaging limit (unique people per 24h) is enforced', async () => {
  await db.q("UPDATE senders SET info = info || '{\"limit\": 3, \"limit_raw\": \"TIER_3\"}'::jsonb, hold_until=NULL WHERE id=$1", [ids.waSender]);
  await A.get('/shops');
  let r = await A.post('/shops', { name: 'WA limit' });
  const shop = r.location.match(/\/shops\/(\d+)/)[1];
  const csv = 'Name,WhatsApp,Consent\n' + Array.from({ length: 4 }, (_, i) => `W${i},+97155000000${i},yes`).join('\n');
  r = await A.post(`/shops/${shop}/upload`, {}, [{ field: 'file', name: 'w.csv', data: Buffer.from(csv) }]);
  await A.post(`/uploads/${r.location.match(/uploads\/(\d+)/)[1]}/map`, { name: 'Name', whatsapp: 'WhatsApp', consent: 'Consent', country: 'AE' });
  await A.get(`/campaigns/new?shop=${shop}`);
  r = await A.post('/campaigns', { name: 'Limit', shop_id: shop, sender_id: ids.waSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { template: 'plain_offer|ar', audience: 'all', skip_already: '1', action: 'save' });
  r = await A.post(`/campaigns/${id}/edit`, { template: 'plain_offer|ar', 'src:body:1': 'name', 'val:body:1': '', audience: 'all', skip_already: '1', action: 'preview' });
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  const n0 = graph.state.sent.length;
  await worker.tick();
  // 2 unique people were already messaged in the last 24h, limit 3 → only 1 new person now.
  assert.equal(graph.state.sent.length, n0 + 1);
  const s = await one('SELECT hold_reason FROM senders WHERE id=$1', [ids.waSender]);
  assert.match(s.hold_reason, /messaging limit of 3 people/);
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='queued'", [id])).n, 3);
});

test('review fixes: unclear sends become "check manually", copies while queued, any opt-out button, lost-digit phones', async () => {
  // Email: connection dropped after the whole email was handed over → unknown, not resent.
  await db.q('UPDATE senders SET hold_until=NULL, daily_limit=500 WHERE id=$1', [ids.emailSender]);
  await A.get('/shops');
  let r = await A.post('/shops', { name: 'Review shop' });
  const shop = r.location.match(/\/shops\/(\d+)/)[1];
  const csv = 'Name,Email,WhatsApp,Consent\nR1,r1@example.com,+971551110001,yes\nR2,r2@example.com,+971551110002,yes\nR3,r3@example.com,9.71551E+11,yes\n';
  r = await A.post(`/shops/${shop}/upload`, {}, [{ field: 'file', name: 'r.csv', data: Buffer.from(csv) }]);
  await A.post(`/uploads/${r.location.match(/uploads\/(\d+)/)[1]}/map`, { name: 'Name', email: 'Email', whatsapp: 'WhatsApp', consent: 'Consent', country: 'AE' });
  assert.equal((await one("SELECT phone FROM contacts WHERE name='R3'")).phone, null); // lost digits → invalid, never a stranger's number
  await A.get(`/campaigns/new?shop=${shop}`);
  r = await A.post('/campaigns', { name: 'Ambiguous', shop_id: shop, sender_id: ids.emailSender });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { subject: 'Amb', body: 'unclear', audience: 'all', skip_already: '1', action: 'preview' });
  let key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  // A copy activated while the original is still queued must skip everyone.
  r = await A.post(`/campaigns/${id}/duplicate`, {});
  const copy = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.get(`/campaigns/${copy}/preview`);
  assert.match(r.text, /skipped: already received this message/); assert.doesNotMatch(r.text, /Activate campaign/);
  smtp.state.next.push({ at: 'data', drop: true });
  const n0 = smtp.state.mails.length;
  await worker.tick();
  await worker.tick();
  const st = await db.rows('SELECT address, status FROM messages WHERE campaign_id=$1 AND status<>$2 ORDER BY id', [id, 'skipped']);
  assert.deepEqual(st.map((x) => x.status), ['unknown', 'sent', 'sent']);
  assert.equal(smtp.state.mails.filter((m, i) => i >= n0 && m.to === st[0].address).length, 1); // handed over once only

  // WhatsApp: server error after sending → unknown; "Stop offers" button tap → opt-out.
  await db.q("UPDATE senders SET hold_until=NULL, info = info || '{\"limit\": null, \"limit_raw\": \"TIER_UNLIMITED\"}'::jsonb WHERE id=$1", [ids.waSender]);
  await A.get(`/campaigns/new?shop=${shop}`);
  r = await A.post('/campaigns', { name: 'WA amb', shop_id: shop, sender_id: ids.waSender });
  const wid = r.location.match(/campaigns\/(\d+)/)[1];
  await A.post(`/campaigns/${wid}/edit`, { template: 'plain_offer|ar', audience: 'all', skip_already: '1', action: 'save' });
  r = await A.post(`/campaigns/${wid}/edit`, { template: 'plain_offer|ar', 'src:body:1': 'name', 'val:body:1': '', audience: 'all', skip_already: '1', action: 'preview' });
  key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${wid}/activate`, { key, mode: 'auto', confirm: '1' });
  await db.q("UPDATE campaigns SET status='cancelled' WHERE status='active' AND id<>$1", [wid]); // isolate from earlier tests
  graph.state.next.push({ status: 500, code: 1, message: 'Internal error' });
  await worker.tick();
  const ws = await db.rows('SELECT status FROM messages WHERE campaign_id=$1 AND status<>$2 ORDER BY id', [wid, 'skipped']);
  assert.deepEqual(ws.map((x) => x.status), ['unknown', 'sent']);
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: WA.pnid }, messages: [{ from: '971551110002', type: 'button', button: { text: 'Stop offers', payload: 'Stop offers' } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', WA.appSecret).update(payload).digest('hex');
  await fetch(base + ids.hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: payload });
  await new Promise((x) => setTimeout(x, 300));
  assert.ok(await one("SELECT 1 AS x FROM suppressions WHERE channel='whatsapp' AND address='971551110002'"));
  // Spoofed X-Forwarded-For does not bypass the login limit.
  let last;
  for (let i = 0; i < 22; i++) {
    last = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` }, body: 'email=nobody@example.com&password=x' });
  }
  assert.equal(last.status, 429);
});

test('Gmail via "Continue with Google": connect, send, limits, unclear sends, revoked access', async () => {
  await db.q("UPDATE campaigns SET status='cancelled' WHERE status='active'");
  await A.get('/senders/new/email');
  assert.match(A.html, /Continue with Google/);
  // Start → redirect to Google with our client id, send-only scope and a signed state.
  let r = await A.req('GET', '/senders/google/start?label=Shop+Gmail&from_name=GoSkate+Dubai&reply_to=');
  assert.equal(r.status, 303);
  const loc = new URL(r.location);
  assert.equal(loc.origin, 'https://accounts.example.test');
  assert.equal(loc.searchParams.get('client_id'), 'gid.apps.googleusercontent.com');
  assert.match(loc.searchParams.get('scope'), /gmail\.send/);
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  const state = loc.searchParams.get('state');
  // A forged/other state is refused; B cannot use A's state.
  r = await A.get('/oauth/google/callback?code=good-code&state=bad');
  assert.match(r.text, /expired or did not match/);
  // (the nonce cookie was cleared, so start again)
  r = await A.req('GET', '/senders/google/start?label=Shop+Gmail&from_name=GoSkate+Dubai&reply_to=');
  const st2 = new URL(r.location).searchParams.get('state');
  assert.notEqual(st2, state);
  const bR = await B.get('/oauth/google/callback?code=good-code&state=' + encodeURIComponent(st2));
  assert.ok(bR.status === 200 || bR.status === 404);
  assert.ok(!(await one("SELECT 1 AS x FROM senders WHERE info->>'provider'='gmail_api'")));
  r = await A.get('/oauth/google/callback?code=good-code&state=' + encodeURIComponent(st2));
  assert.match(r.text, /connected and verified by Google/);
  const s = await one("SELECT * FROM senders WHERE info->>'provider'='gmail_api'");
  assert.equal(s.status, 'verified'); assert.equal(s.info.email, 'shop.gmail@gmail.com'); assert.equal(s.daily_limit, 500); assert.equal(s.info.from_name, 'GoSkate Dubai');
  assert.doesNotMatch(s.secrets, /rt-shop/); // refresh token stored encrypted

  // Campaign through Gmail API.
  await A.get('/shops');
  r = await A.post('/shops', { name: 'Gmail shop' });
  const shop = r.location.match(/\/shops\/(\d+)/)[1];
  const csv = 'Name,Email,Consent\n' + Array.from({ length: 5 }, (_, i) => `G${i},g${i}@example.com,yes`).join('\n');
  r = await A.post(`/shops/${shop}/upload`, {}, [{ field: 'file', name: 'g.csv', data: Buffer.from(csv) }]);
  await A.post(`/uploads/${r.location.match(/uploads\/(\d+)/)[1]}/map`, { name: 'Name', email: 'Email', consent: 'Consent', country: 'AE' });
  await A.get(`/campaigns/new?shop=${shop}`);
  r = await A.post('/campaigns', { name: 'Gmail API', shop_id: shop, sender_id: s.id });
  const id = r.location.match(/campaigns\/(\d+)/)[1];
  r = await A.post(`/campaigns/${id}/edit`, { subject: 'Hello {{first_name}}', body: 'Gmail API test', audience: 'all', skip_already: '1', action: 'preview' });
  // test email to self goes through the Gmail API too
  let t = await A.post(`/campaigns/${id}/test`, {});
  assert.match(t.location, /Test\+email\+sent|Test%20email/);
  r = await A.get(`/campaigns/${id}/preview`);
  const key = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${id}/activate`, { key, mode: 'auto', confirm: '1' });
  const g0 = google.state.sent.length;
  // 1st: Gmail sending limit with a retry time → sender waits until then; 2nd tick after hold: 500 → unknown; rest sent.
  const retry = new Date(Date.now() + 3 * 3600e3).toISOString();
  google.state.next.push({ status: 429, reason: 'rateLimitExceeded', message: `User-rate limit exceeded.  Retry after ${retry} (Mail sending)` });
  await worker.tick();
  let h = await one('SELECT extract(epoch from hold_until - now())::int AS secs, hold_reason FROM senders WHERE id=$1', [s.id]);
  assert.ok(h.secs > 3 * 3600 - 120 && h.secs <= 3 * 3600, `held ${h.secs}`);
  assert.equal(google.state.sent.length, g0);
  await db.q('UPDATE senders SET hold_until=NULL WHERE id=$1', [s.id]);
  google.state.next.push({ status: 500, reason: 'backendError', message: 'Backend Error' });
  await worker.tick();
  await worker.tick();
  const st = await db.rows("SELECT status FROM messages WHERE campaign_id=$1 ORDER BY id", [id]);
  assert.deepEqual(st.map((x) => x.status), ['unknown', 'sent', 'sent', 'sent', 'sent']);
  assert.equal(google.state.sent.length, g0 + 4);
  const mail = google.state.sent.at(-1);
  assert.match(mail, /From: GoSkate Dubai <shop\.gmail@gmail\.com>/); assert.match(mail, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  // Access revoked → sender marked broken, campaign paused (not failed).
  await A.get(`/campaigns/${id}`); r = await A.post(`/campaigns/${id}/duplicate`, {});
  const copy = r.location.match(/campaigns\/(\d+)/)[1];
  await A.post(`/campaigns/${copy}/edit`, { subject: 'Second', body: 'Another text', audience: 'all', skip_already: '1', action: 'preview' });
  r = await A.get(`/campaigns/${copy}/preview`);
  const key2 = r.text.match(/name="key" value="([^"]+)"/)[1];
  await A.post(`/campaigns/${copy}/activate`, { key: key2, mode: 'auto', confirm: '1' });
  google.state.next.push({ status: 401, reason: 'authError', message: 'Invalid Credentials' });
  await worker.tick();
  await worker.tick();
  assert.equal((await one('SELECT status FROM senders WHERE id=$1', [s.id])).status, 'error');
  assert.equal((await one('SELECT status FROM campaigns WHERE id=$1', [copy])).status, 'paused');
  assert.equal((await one("SELECT count(*)::int AS n FROM messages WHERE campaign_id=$1 AND status='failed'", [copy])).n, 0);
  // Reconnect with Google fixes it.
  r = await A.req('GET', `/senders/google/start?label=Shop+Gmail&from_name=GoSkate+Dubai`);
  r = await A.get('/oauth/google/callback?code=good-code&state=' + encodeURIComponent(new URL(r.location).searchParams.get('state')));
  assert.match(r.text, /connected again/);
  assert.equal((await one('SELECT status FROM senders WHERE id=$1', [s.id])).status, 'verified');
  assert.equal((await one("SELECT count(*)::int AS n FROM senders WHERE info->>'provider'='gmail_api'")).n, 1);
});

test('token problems pause campaigns instead of failing messages', async () => {
  const k = (await import('../src/providers/whatsapp.js')).classifyWaError({ code: 190, message: 'expired', status: 401 });
  assert.equal(k.action, 'sender_broken');
  const e = (await import('../src/providers/email.js')).classifyEmailError({ responseCode: 535, message: '535 5.7.8 bad', kind: 'auth' });
  assert.equal(e.action, 'sender_broken');
});

test('media is private to its owner and pages send security headers', async () => {
  const m = await one('SELECT id FROM media ORDER BY id LIMIT 1');
  assert.equal((await A.get(`/media/${m.id}`)).status, 200);
  assert.equal((await B.get(`/media/${m.id}`)).status, 404);
  const r = await fetch(base + '/login');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('cron endpoint needs the key', async () => {
  assert.equal((await fetch(base + '/cron/tick?key=wrong')).status, 403);
  const { config } = await import('../src/config.js');
  assert.equal((await fetch(base + '/cron/tick?key=' + config.cronKey)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
});

test('forgot password: reset with account email + sign-up code', async () => {
  const { config } = await import('../src/config.js');
  config.signupCode = 'owner-code-123';
  const C = new Browser();
  let r = await C.get('/forgot'); assert.match(r.text, /Reset your password/);
  r = await C.post('/forgot', { email: 'heba@example.com', code: 'wrong', password: 'brand-new-password' });
  assert.equal(r.status, 400); assert.match(r.text, /do not match/);
  r = await C.post('/forgot', { email: 'nobody@example.com', code: 'owner-code-123', password: 'brand-new-password' });
  assert.match(r.text, /do not match/);
  r = await C.post('/forgot', { email: 'HEBA@example.com', code: 'owner-code-123', password: 'brand-new-password' });
  assert.match(r.text, /Password changed/);
  // old sessions are logged out; new password works, old one does not
  assert.equal((await A.req('GET', '/shops')).status, 303);
  assert.equal((await C.post('/login', { email: 'heba@example.com', password: 'a-very-good-password' })).status, 401);
  r = await C.post('/login', { email: 'heba@example.com', password: 'brand-new-password' });
  assert.match(r.text, /Hello Heba/);
  config.signupCode = '';
});

test('account deletion removes all data', async () => {
  await B.get('/settings');
  const r = await B.post('/settings/delete', { password: 'another-good-password' });
  assert.match(r.location || '', /login/);
  assert.equal((await one("SELECT count(*)::int AS n FROM users WHERE email='other@example.com'")).n, 0);
});
