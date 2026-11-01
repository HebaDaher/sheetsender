// Sign-up / sign-in, unsubscribe pages, WhatsApp webhooks, the scheduler endpoint and health check.
import { html, layout, csrfField } from '../html.js';
import { HttpError, rateLimit, clientIp, sendHtml, sendJson } from '../http.js';
import { q, one, rows } from '../db.js';
import { config } from '../config.js';
import { createUser, login, logout, verifyLogin, passwordProblem } from '../auth.js';
import { verifySigned, decryptJson, safeEqual } from '../crypto.js';
import { normalizeEmail } from '../contacts.js';
import * as wa from '../providers/whatsapp.js';
import { tick } from '../worker.js';

const authForm = (mode, err, vals = {}) => layout({
  title: mode === 'login' ? 'Log in' : 'Create account', error: err,
  body: html`<section class="card narrow">
  <h1>${mode === 'login' ? 'Log in to SheetSender' : 'Create your account'}</h1>
  <form method="post" action="/${mode}" class="stack">
    ${mode === 'signup' ? html`<label>Your name<input name="name" required maxlength="100" value="${vals.name || ''}" autocomplete="name"></label>` : ''}
    <label>Email<input type="email" name="email" required maxlength="254" value="${vals.email || ''}" autocomplete="email"></label>
    <label>Password<input type="password" name="password" required minlength="${mode === 'signup' ? 10 : 1}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
      ${mode === 'signup' ? html`<small>At least 10 characters.</small>` : ''}</label>
    ${mode === 'signup' && config.signupCode ? html`<label>Sign-up code<input name="code" required autocomplete="off"><small>Ask the owner of this app for the code.</small></label>` : ''}
    <button class="primary">${mode === 'login' ? 'Log in' : 'Create account'}</button>
  </form>
  <p class="muted">${mode === 'login' ? html`New here? <a href="/signup">Create an account</a>` : html`Already have an account? <a href="/login">Log in</a>`}</p>
  </section>`,
});

export default function register(r) {
  r.get('/health', (ctx) => ctx.json(200, { ok: true }));

  r.get('/login', (ctx) => { if (ctx.user) return ctx.go('/'); sendHtml(ctx.res, 200, authForm('login', ctx.query.err)); });
  r.post('/login', async (ctx) => {
    if (!rateLimit('login:' + clientIp(ctx.req), 20, 15 * 60000)) return sendHtml(ctx.res, 429, authForm('login', 'Too many attempts. Wait 15 minutes.'));
    const { email = '', password = '' } = ctx.body;
    const r2 = await verifyLogin(String(email), String(password));
    if (r2.error) return sendHtml(ctx.res, 401, authForm('login', r2.error, { email }));
    await login(ctx.res, r2.user.id);
    ctx.go('/');
  });

  r.get('/signup', (ctx) => { if (ctx.user) return ctx.go('/'); sendHtml(ctx.res, 200, authForm('signup')); });
  r.post('/signup', async (ctx) => {
    if (!rateLimit('signup:' + clientIp(ctx.req), 10, 60 * 60000)) return sendHtml(ctx.res, 429, authForm('signup', 'Too many attempts. Try again later.'));
    const name = String(ctx.body.name || '').trim(); const email = normalizeEmail(ctx.body.email); const password = String(ctx.body.password || '');
    const vals = { name, email: ctx.body.email };
    if (config.signupCode && !safeEqual(String(ctx.body.code || '').trim(), config.signupCode)) return sendHtml(ctx.res, 400, authForm('signup', 'The sign-up code is not correct.', vals));
    if (!name) return sendHtml(ctx.res, 400, authForm('signup', 'Please enter your name.', vals));
    if (!email) return sendHtml(ctx.res, 400, authForm('signup', 'Please enter a valid email address.', vals));
    const pwErr = passwordProblem(password); if (pwErr) return sendHtml(ctx.res, 400, authForm('signup', pwErr, vals));
    if (await one('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email])) return sendHtml(ctx.res, 400, authForm('signup', 'An account with this email already exists. Log in instead.', vals));
    const u = await createUser({ email, name, password });
    await login(ctx.res, u.id);
    ctx.go('/', { ok: 'Welcome! Follow the three steps below to send your first campaign.' });
  });

  r.post('/logout', async (ctx) => { await logout(ctx.req, ctx.res); ctx.go('/login'); });

  r.get('/privacy', (ctx) => ctx.page('Privacy', html`<section class="card"><h1>Privacy</h1>
    <p>This app stores the customer lists you upload, your sender connection details (encrypted) and a record of the messages sent, so that you can see progress and so nobody is messaged twice.</p>
    <p>Each account can only see its own shops, files, contacts and campaigns. You can delete a shop (and its contacts) or your whole account at any time from <b>Settings</b>.</p>
    <p>People who unsubscribe or reply STOP are added to the opt-out list and are never messaged again on that channel by that account.</p></section>`));

  // ----- Unsubscribe (email) -----
  const unsubPage = (title, body) => layout({ title, body: html`<section class="card narrow">${body}</section>` });
  r.get('/u/:token', async (ctx) => {
    const p = verifySigned(ctx.params.token);
    if (!p) return sendHtml(ctx.res, 400, unsubPage('Unsubscribe', html`<h1>This link is not valid</h1><p>Please use the link from the latest email.</p>`));
    const done = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND channel=$2 AND address=$3', [p.u, p.c, p.a]);
    if (done) return sendHtml(ctx.res, 200, unsubPage('Unsubscribed', html`<h1>You are unsubscribed</h1><p><b>${p.a}</b> will not receive more messages from ${p.s}.</p>`));
    sendHtml(ctx.res, 200, unsubPage('Unsubscribe', html`<h1>Unsubscribe</h1><p>Stop all emails from <b>${p.s}</b> to <b>${p.a}</b>?</p>
      <form method="post" action="/u/${ctx.params.token}"><button class="primary">Yes, unsubscribe me</button></form>`));
  });
  r.post('/u/:token', async (ctx) => {
    const p = verifySigned(ctx.params.token);
    if (!p) throw new HttpError(400, 'This link is not valid.');
    await q('INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [p.u, p.c, p.a, `Unsubscribed via email link (${p.s})`]);
    await q("UPDATE messages SET status='skipped', skip_reason='Opted out', updated_at=now() WHERE user_id=$1 AND channel=$2 AND address=$3 AND status='queued'", [p.u, p.c, p.a]);
    sendHtml(ctx.res, 200, unsubPage('Unsubscribed', html`<h1>You are unsubscribed</h1><p><b>${p.a}</b> will not receive more messages from ${p.s}.</p>`));
  });

  // ----- WhatsApp webhooks -----
  r.get('/webhooks/whatsapp/:key', async (ctx) => {
    const u = await one('SELECT id FROM users WHERE webhook_key=$1', [ctx.params.key]);
    if (!u || ctx.query['hub.mode'] !== 'subscribe' || !safeEqual(ctx.query['hub.verify_token'], ctx.params.key)) { ctx.res.writeHead(403); return ctx.res.end(); }
    await q("UPDATE senders SET info = info || '{\"webhook_ok\": true}'::jsonb WHERE user_id=$1 AND channel='whatsapp'", [u.id]);
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain' }); ctx.res.end(String(ctx.query['hub.challenge'] || ''));
  });

  r.post('/webhooks/whatsapp/:key', async (ctx) => {
    const u = await one('SELECT id FROM users WHERE webhook_key=$1', [ctx.params.key]);
    if (!u) { ctx.res.writeHead(404); return ctx.res.end(); }
    const senders = await rows("SELECT * FROM senders WHERE user_id=$1 AND channel='whatsapp'", [u.id]);
    const sig = ctx.req.headers['x-hub-signature-256'];
    const valid = senders.find((s) => { try { return wa.verifySignature(ctx.req.rawBody, sig, decryptJson(s.secrets).app_secret); } catch { return false; } });
    if (!valid) { ctx.res.writeHead(401); return ctx.res.end(); }
    ctx.res.writeHead(200); ctx.res.end('ok'); // answer Meta quickly, then process
    await q("UPDATE senders SET info = info || '{\"webhook_ok\": true}'::jsonb WHERE user_id=$1 AND channel='whatsapp' AND NOT (info ? 'webhook_ok')", [u.id]);
    try { await handleWebhook(u.id, senders, ctx.body); } catch (e) { console.error('webhook', e); }
  });

  // ----- Scheduler (cron-job.org calls this every minute so campaigns keep running) -----
  r.get('/cron/tick', async (ctx) => {
    if (!config.cronKey || !safeEqual(ctx.query.key || '', config.cronKey)) { ctx.res.writeHead(403); return ctx.res.end('forbidden'); }
    sendJson(ctx.res, 200, { ok: true, at: new Date().toISOString() });
    tick().catch((e) => console.error('tick', e));
  });
}

const RANK = { queued: 0, sending: 1, unknown: 1, sent: 2, delivered: 3, read: 4 };

export async function handleWebhook(userId, senders, payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const sender = senders.find((s) => String(s.info.phone_number_id) === String(v.metadata?.phone_number_id));
      for (const st of v.statuses || []) {
        const m = await one('SELECT id, status, address FROM messages WHERE provider_id=$1 AND user_id=$2', [st.id, userId]);
        if (!m) continue;
        if (st.status === 'failed') {
          const err = st.errors?.[0] || {};
          const k = wa.classifyWaError({ code: err.code, message: err.message || err.title || 'Failed', title: err.title, details: err.error_data?.details });
          if (k.action === 'opted_out') await q('INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, 'whatsapp', m.address, k.text]);
          if (!['read'].includes(m.status)) await q("UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1", [m.id, k.text]);
          if (Number(err.code) === 131048 && sender) {
            await q("UPDATE senders SET hold_until=now() + interval '24 hours', hold_reason=$2 WHERE id=$1", [sender.id, k.text]);
            await q("UPDATE campaigns SET status='paused', paused_reason=$2 WHERE sender_id=$1 AND status='active'", [sender.id, k.text]);
          }
        } else if (RANK[st.status] !== undefined && RANK[st.status] > (RANK[m.status] ?? -1)) {
          await q('UPDATE messages SET status=$2, updated_at=now() WHERE id=$1', [m.id, st.status]);
        }
      }
      for (const msg of v.messages || []) {
        const text = msg.text?.body ?? msg.button?.text ?? msg.button?.payload ?? msg.interactive?.button_reply?.title ?? '';
        if (!wa.STOP_WORDS.test(text) && !/^(STOP|MARKETING_OPT_OUT)$/i.test(msg.button?.payload || '')) continue;
        const from = String(msg.from || '').replace(/\D/g, '');
        await q('INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, 'whatsapp', from, `Replied "${String(text).slice(0, 40)}" on WhatsApp`]);
        await q("UPDATE messages SET status='skipped', skip_reason='Opted out', updated_at=now() WHERE user_id=$1 AND channel='whatsapp' AND address=$2 AND status='queued'", [userId, from]);
        if (sender) {
          try {
            const creds = { ...decryptJson(sender.secrets), ...sender.info };
            await wa.sendText(creds, from, 'You have been unsubscribed and will not receive more promotional messages from us. / تم إلغاء اشتراكك ولن تصلك رسائل ترويجية منا بعد الآن.');
          } catch (e) { console.warn('opt-out confirmation not sent:', e.message); }
        }
      }
    }
  }
}
