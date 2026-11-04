// Connecting and verifying the email addresses and WhatsApp Business numbers that messages are sent FROM.
import { html, csrfField, fmtDate, badge, channelName, waLimitText } from '../html.js';
import { q, one, rows } from '../db.js';
import { config } from '../config.js';
import { owned, str } from './util.js';
import { encryptJson, decryptJson, senderCreds, randomCode, sha256, randomToken, sign, verifySigned, safeEqual } from '../crypto.js';
import { setCookie, parseCookies } from '../http.js';
import * as gmail from '../providers/gmail.js';
import { normalizeEmail, normalizePhone } from '../contacts.js';
import * as email from '../providers/email.js';
import * as wa from '../providers/whatsapp.js';
import { checkMedia } from './media.js';

export const webhookUrl = (user) => `${config.publicUrl}/webhooks/whatsapp/${user.webhook_key}`;

function senderLine(s) {
  return s.channel === 'email' ? `${s.info.from_name ? s.info.from_name + ' ' : ''}<${s.info.email}>` : `${s.info.verified_name || ''} +${String(s.info.display_phone || '').replace(/\D/g, '')}`;
}
export { senderLine };

async function sendCode(sender, secrets) {
  const code = randomCode();
  await q("UPDATE senders SET verify_code_hash=$2, verify_expires=now() + interval '30 minutes', verify_attempts=0 WHERE id=$1", [sender.id, sha256(`${sender.id}:${code}`)]);
  await email.sendPlain(secrets, sender.info, {
    to: sender.info.email, subject: `SheetSender verification code: ${code}`,
    text: `Your verification code is ${code}\n\nEnter it in SheetSender to confirm that you own ${sender.info.email} and want to send customer emails from it. The code expires in 30 minutes.\n\nIf you did not request this, you can ignore this email.`,
  });
}

export default function register(r) {
  r.get('/senders', async (ctx) => {
    const list = await rows('SELECT * FROM senders WHERE user_id=$1 ORDER BY channel, created_at', [ctx.user.id]);
    const card = (s) => html`<a class="card tile" href="/senders/${s.id}"><h2>${s.label} ${badge(s.status)}</h2>
      <p>${channelName(s.channel)} · ${senderLine(s)}</p>
      ${s.hold_until && new Date(s.hold_until) > new Date() ? html`<p class="warn">Waiting until ${fmtDate(s.hold_until, ctx.user.timezone)}: ${s.hold_reason}</p>` : ''}
      ${s.status === 'error' ? html`<p class="bad">${s.last_error}</p>` : ''}</a>`;
    ctx.page('Senders', html`
      <h1>Senders</h1>
      <p class="lead">These are <b>your</b> email address and WhatsApp Business number that messages are sent from. Details in the customer spreadsheet are never used as the sender.</p>
      ${list.length ? html`<div class="grid">${list.map(card)}</div>` : html`<p class="muted">No senders connected yet.</p>`}
      <div class="row"><a class="button primary" href="/senders/new/email">Connect an email address</a><a class="button primary" href="/senders/new/whatsapp">Connect a WhatsApp Business number</a></div>`, { active: '/senders' });
  });

  // ---------- Email ----------
  r.get('/senders/new/email', (ctx) => {
    const smtpForm = html`<form method="post" action="/senders/email" class="card stack">${csrfField(ctx.csrf)}
        <p class="muted">Needs outgoing email ports, which Render's free plan blocks.</p>
        <label>Name for this sender (only you see it)<input name="label" required maxlength="60"></label>
        <label>Email address to send from<input type="email" name="email" required></label>
        <label>Name customers will see<input name="from_name" maxlength="80"></label>
        <label>Password / app password<input type="password" name="password" required autocomplete="off"></label>
        <label>Reply-to address (optional)<input type="email" name="reply_to"></label>
        <label>Outgoing mail server (SMTP)<input name="host" required></label>
        <div class="row"><label>Port<input type="number" name="port" min="1" max="65535" value="465"></label>
        <label>Security<select name="security"><option value="ssl">SSL/TLS (usually port 465)</option><option value="starttls">STARTTLS (usually port 587)</option></select></label></div>
        <label>Sign-in username (if different from the email address)<input name="username"></label>
        <label>Your provider's daily sending limit<input type="number" name="daily_limit" min="1" max="100000" required></label>
        <button>Test and send verification code</button>
      </form>`;
    ctx.page('Connect email', html`
    <p class="crumbs"><a href="/senders">Senders</a> ›</p>
    <h1>Connect a Gmail address</h1>
    ${gmail.enabled() ? html`
    <form method="get" action="/senders/google/start" class="card stack">
      <p>Sign in on Google's page and allow SheetSender to <b>send email only</b> (it cannot read your inbox). Repeat for each Gmail address.</p>
      <label>Name for this sender (only you see it)<input name="label" required maxlength="60"></label>
      <label>Name customers will see<input name="from_name" maxlength="80"></label>
      <label>Reply-to address (optional)<input type="email" name="reply_to"></label>
      <button class="primary">Continue with Google</button>
      <p class="muted">If Google shows "Google hasn't verified this app", click <b>Advanced</b> → <b>Go to SheetSender</b>. That appears because this is your own private app.</p>
    </form>` : html`<section class="card attention"><p>Gmail connection is not switched on yet: the app owner must add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in the hosting settings (see SETUP.md, "Connect Gmail").</p></section>`}
    ${gmail.enabled() ? '' : html`<details><summary>Other email provider (not Gmail)</summary>${smtpForm}</details>`}`, { active: '/senders' });
  });

  r.get('/senders/google/start', (ctx) => {
    if (!gmail.enabled()) return ctx.go('/senders/new/email');
    const nonce = randomToken(16);
    setCookie(ctx.res, 'g_nonce', nonce, { maxAge: 900 });
    const state = sign({ u: Number(ctx.user.id), n: nonce, l: str(ctx.query.label, 60), f: str(ctx.query.from_name, 80), r: normalizeEmail(ctx.query.reply_to) || '', exp: Date.now() + 15 * 60000 });
    ctx.res.writeHead(303, { Location: gmail.authUrl(state) }); ctx.res.end();
  });

  r.get('/oauth/google/callback', async (ctx) => {
    const st = verifySigned(ctx.query.state || '');
    const cookieNonce = parseCookies(ctx.req.headers.cookie).g_nonce;
    setCookie(ctx.res, 'g_nonce', '', { maxAge: 0 });
    if (!st || Number(st.u) !== Number(ctx.user.id) || !cookieNonce || !safeEqual(cookieNonce, st.n)) return ctx.go('/senders/new/email', { err: 'The Google sign-in expired or did not match. Please try again.' });
    if (ctx.query.error) return ctx.go('/senders/new/email', { err: ctx.query.error === 'access_denied' ? 'Google sign-in was cancelled. Nothing was connected.' : `Google said: ${str(ctx.query.error, 100)}` });
    let got;
    try { got = await gmail.exchangeCode(str(ctx.query.code, 2000)); } catch (e) { return ctx.go('/senders/new/email', { err: e.message }); }
    const limit = /@(gmail|googlemail)\.com$/i.test(got.email) ? 500 : 2000;
    const existing = await one("SELECT * FROM senders WHERE user_id=$1 AND channel='email' AND lower(info->>'email')=$2", [ctx.user.id, got.email]);
    const info = { provider: 'gmail_api', email: got.email, from_name: st.f || existing?.info?.from_name || '', reply_to: st.r || existing?.info?.reply_to || null };
    if (existing) {
      await q("UPDATE senders SET secrets=$2, info=$3, status='verified', last_error=NULL, hold_until=NULL, hold_reason=NULL, hold_level=0, daily_limit=$4, updated_at=now() WHERE id=$1",
        [existing.id, encryptJson({ refresh_token: got.refreshToken }), info, limit]);
      return ctx.go(`/senders/${existing.id}`, { ok: `${got.email} is connected again. Resume any paused campaigns from the Campaigns page.` });
    }
    const s = await one(`INSERT INTO senders (user_id, channel, label, status, secrets, info, daily_limit) VALUES ($1,'email',$2,'verified',$3,$4,$5) RETURNING id`,
      [ctx.user.id, st.l || got.email, encryptJson({ refresh_token: got.refreshToken }), info, limit]);
    ctx.go(`/senders/${s.id}`, { ok: `${got.email} is connected and verified by Google. You can now choose it in a campaign.` });
  });

  r.post('/senders/email', async (ctx) => {
    const b = ctx.body;
    const addr = normalizeEmail(b.email);
    if (!addr) return ctx.go('/senders/new/email', { err: 'Enter a valid email address.' });
    const host = str(b.host, 200) || 'smtp.gmail.com';
    const port = b.host ? Math.min(Math.max(Number(b.port) || 465, 1), 65535) : 465;
    const secure = b.host ? b.security !== 'starttls' : true;
    const officialLimit = email.defaultDailyLimit(host, addr);
    let limit = officialLimit;
    if (!officialLimit) { limit = Number(b.daily_limit); if (!(limit > 0)) return ctx.go('/senders/new/email', { err: 'Enter your email provider\'s daily sending limit.' }); }
    const password = String(b.password || '').replace(/\s+/g, host === 'smtp.gmail.com' ? '' : ' ').trim();
    const info = { email: addr, from_name: str(b.from_name, 80), reply_to: normalizeEmail(b.reply_to) || null, host, port, secure, username: str(b.username, 200) || null };
    try { await email.testConnection({ password }, info); } catch (e) {
      const k = email.classifyEmailError(e);
      const hint = k.action === 'sender_broken' ? ' Check the email address and the app password (Gmail needs an App password, not your normal password).' : '';
      return ctx.go('/senders/new/email', { err: `Could not sign in to the email server: ${e.message}.${hint}` });
    }
    if (await one("SELECT 1 AS x FROM senders WHERE user_id=$1 AND channel='email' AND lower(info->>'email')=$2", [ctx.user.id, addr])) return ctx.go('/senders', { err: 'This email address is already connected. Open it to change its app password.' });
    const s = await one(`INSERT INTO senders (user_id, channel, label, status, secrets, info, daily_limit) VALUES ($1,'email',$2,'unverified',$3,$4,$5) RETURNING *`,
      [ctx.user.id, str(b.label, 60) || addr, encryptJson({ password }), info, limit]);
    try { await sendCode(s, { password }); } catch (e) { return ctx.go(`/senders/${s.id}`, { err: `Signed in, but the code email could not be sent: ${e.message}` }); }
    ctx.go(`/senders/${s.id}`, { ok: `Signed in successfully. We emailed a 6-digit code to ${addr} — enter it below.` });
  });

  r.post('/senders/:id/verify', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (s.status === 'verified') return ctx.go(`/senders/${s.id}`);
    if (!s.verify_code_hash || new Date(s.verify_expires) < new Date()) return ctx.go(`/senders/${s.id}`, { err: 'The code expired. Press "Send a new code".' });
    if (s.verify_attempts >= 5) return ctx.go(`/senders/${s.id}`, { err: 'Too many wrong codes. Press "Send a new code".' });
    const code = String(ctx.body.code || '').replace(/\D/g, '');
    if (sha256(`${s.id}:${code}`) !== s.verify_code_hash) {
      await q('UPDATE senders SET verify_attempts=verify_attempts+1 WHERE id=$1', [s.id]);
      return ctx.go(`/senders/${s.id}`, { err: 'That code is not correct.' });
    }
    await q("UPDATE senders SET status='verified', verify_code_hash=NULL, last_error=NULL, updated_at=now() WHERE id=$1", [s.id]);
    ctx.go(`/senders/${s.id}`, { ok: 'Email address verified. You can now choose it in a campaign.' });
  });

  r.post('/senders/:id/resend', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (s.channel !== 'email') return ctx.go(`/senders/${s.id}`);
    try { await sendCode(s, decryptJson(s.secrets)); } catch (e) { return ctx.go(`/senders/${s.id}`, { err: `Could not send the code: ${e.message}` }); }
    ctx.go(`/senders/${s.id}`, { ok: `A new code was sent to ${s.info.email}.` });
  });

  r.post('/senders/:id/password', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (s.channel !== 'email') return ctx.go(`/senders/${s.id}`);
    const password = String(ctx.body.password || '').replace(/\s+/g, s.info.host === 'smtp.gmail.com' ? '' : ' ').trim();
    try { await email.testConnection({ password }, s.info); } catch (e) { return ctx.go(`/senders/${s.id}`, { err: `Sign-in failed: ${e.message}` }); }
    await q("UPDATE senders SET secrets=$2, status=CASE WHEN status='error' THEN 'verified' ELSE status END, last_error=NULL, hold_until=NULL, hold_reason=NULL, updated_at=now() WHERE id=$1", [s.id, encryptJson({ password })]);
    ctx.go(`/senders/${s.id}`, { ok: 'Password updated and tested. Resume any paused campaigns from the Campaigns page.' });
  });

  // ---------- WhatsApp ----------
  r.get('/senders/new/whatsapp', (ctx) => ctx.page('Connect WhatsApp', html`
    <p class="crumbs"><a href="/senders">Senders</a> ›</p>
    <h1>Connect a WhatsApp Business number</h1>
    <section class="card note"><p>This uses Meta's official <b>WhatsApp Business Platform (Cloud API)</b>. Follow the guide <b>"Connect WhatsApp"</b> in the setup instructions (SETUP.md) to get these five values from <b>developers.facebook.com</b>. Messages are charged by Meta to the payment method on your WhatsApp Business account.</p></section>
    <form method="post" action="/senders/whatsapp" class="card stack">${csrfField(ctx.csrf)}
      <label>Name for this sender (only you see it)<input name="label" required maxlength="60"></label>
      <label>Phone number ID<input name="phone_number_id" required inputmode="numeric" pattern="[0-9]{5,30}"><small>WhatsApp → API Setup → "Phone number ID"</small></label>
      <label>WhatsApp Business Account ID<input name="waba_id" required inputmode="numeric" pattern="[0-9]{5,30}"><small>WhatsApp → API Setup → "WhatsApp Business Account ID"</small></label>
      <label>App ID<input name="app_id" required inputmode="numeric" pattern="[0-9]{5,30}"><small>App settings → Basic → "App ID"</small></label>
      <label>App secret<input type="password" name="app_secret" required autocomplete="off"><small>App settings → Basic → "App secret" → Show</small></label>
      <label>Permanent access token (System user)<textarea name="token" required rows="3" autocomplete="off"></textarea><small>Business settings → System users → Generate new token (permissions: whatsapp_business_messaging, whatsapp_business_management)</small></label>
      <button class="primary">Check and connect</button>
    </form>`, { active: '/senders' }));

  r.post('/senders/whatsapp', async (ctx) => {
    const b = ctx.body;
    const creds = { token: str(b.token, 2000).replace(/\s+/g, ''), phone_number_id: str(b.phone_number_id, 40), waba_id: str(b.waba_id, 40), app_id: str(b.app_id, 40), app_secret: str(b.app_secret, 200) };
    if (![creds.phone_number_id, creds.waba_id, creds.app_id].every((x) => /^\d{5,30}$/.test(x)) || !creds.token || !creds.app_secret) return ctx.go('/senders/new/whatsapp', { err: 'Fill in all five values (the IDs are numbers only).' });
    if (await one("SELECT 1 FROM senders WHERE user_id=$1 AND channel='whatsapp' AND info->>'phone_number_id'=$2", [ctx.user.id, creds.phone_number_id])) return ctx.go('/senders', { err: 'This WhatsApp number is already connected.' });
    let check;
    try { check = await wa.checkSender(creds); } catch (e) { return ctx.go('/senders/new/whatsapp', { err: `Meta did not accept these details: ${e.message}` }); }
    const info = { phone_number_id: creds.phone_number_id, waba_id: creds.waba_id, app_id: creds.app_id, ...check, limit: check.limit === Infinity ? null : check.limit, limit_checked_at: new Date().toISOString() };
    const s = await one(`INSERT INTO senders (user_id, channel, label, status, secrets, info) VALUES ($1,'whatsapp',$2,'verified',$3,$4) RETURNING id`,
      [ctx.user.id, str(b.label, 60) || check.display_phone, encryptJson({ token: creds.token, app_secret: creds.app_secret }), info]);
    ctx.go(`/senders/${s.id}`, { ok: `Connected ${check.verified_name || ''} ${check.display_phone}. Now finish the webhook step below so opt-outs and delivery reports reach the app.` });
  });

  r.post('/senders/:id/recheck', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (s.channel !== 'whatsapp') return ctx.go(`/senders/${s.id}`);
    const sec = decryptJson(s.secrets);
    const newToken = str(ctx.body.token, 2000).replace(/\s+/g, '');
    const creds = { ...s.info, ...sec, ...(newToken ? { token: newToken } : {}) };
    try {
      const check = await wa.checkSender(creds);
      const info = { ...s.info, ...check, limit: check.limit === Infinity ? null : check.limit, limit_checked_at: new Date().toISOString() };
      await q("UPDATE senders SET info=$2, secrets=$3, status='verified', last_error=NULL, hold_until=NULL, hold_reason=NULL, hold_level=0, updated_at=now() WHERE id=$1", [s.id, info, encryptJson({ token: creds.token, app_secret: sec.app_secret })]);
      ctx.go(`/senders/${s.id}`, { ok: 'Checked with Meta — everything works.' });
    } catch (e) {
      await q("UPDATE senders SET status='error', last_error=$2 WHERE id=$1", [s.id, e.message]);
      ctx.go(`/senders/${s.id}`, { err: `Meta reported a problem: ${e.message}` });
    }
  });

  r.post('/senders/:id/test', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (s.channel !== 'whatsapp') return ctx.go(`/senders/${s.id}`);
    const to = normalizePhone(ctx.body.to, ctx.user.default_country);
    if (!to) return ctx.go(`/senders/${s.id}`, { err: 'Enter your own WhatsApp number with country code.' });
    const [name, language] = String(ctx.body.template || 'hello_world|en_US').split('|');
    try {
      const creds = senderCreds(s);
      const tpl = (await wa.listTemplates(creds)).find((t) => t.name === name && t.language === language);
      if (!tpl) return ctx.go(`/senders/${s.id}`, { err: 'Template not found.' });
      const info = wa.analyzeTemplate(tpl);
      if (!info.supported) return ctx.go(`/senders/${s.id}`, { err: info.reason });
      if (info.headerFormat === 'IMAGE' || info.headerFormat === 'VIDEO') return ctx.go(`/senders/${s.id}`, { err: 'For the test, pick a template without an image or video.' });
      const values = Object.fromEntries(info.vars.map((v) => [v.component === 'button' ? `button:${v.index}:${v.name}` : `${v.component}:${v.name}`, 'Test']));
      await wa.sendTemplate(creds, to, wa.buildTemplateMessage(info, values));
      ctx.go(`/senders/${s.id}`, { ok: `Test sent to +${to}. Check your WhatsApp.` });
    } catch (e) { ctx.go(`/senders/${s.id}`, { err: `WhatsApp did not send the test: ${e.message}` }); }
  });

  r.get('/senders/:id', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    const holding = s.hold_until && new Date(s.hold_until) > new Date();
    let templates = [];
    if (s.channel === 'whatsapp' && s.status !== 'error') {
      try { templates = (await wa.listTemplates(senderCreds(s))).map(wa.analyzeTemplate); } catch (e) { templates = null; }
    }
    const sentToday = (await one("SELECT count(*)::int AS n FROM messages WHERE sender_id=$1 AND sent_at > now() - interval '24 hours'", [s.id])).n;
    ctx.page(s.label, html`
      <p class="crumbs"><a href="/senders">Senders</a> ›</p>
      <h1>${s.label} ${badge(s.status)}</h1>
      <p class="lead">${channelName(s.channel)} · ${senderLine(s)}</p>
      ${holding ? html`<p class="flash warn">Paused by the provider's instructions until ${fmtDate(s.hold_until, ctx.user.timezone)}: ${s.hold_reason}</p>` : ''}
      ${s.status === 'error' ? html`<p class="flash err">${s.last_error}</p>` : ''}
      ${s.channel === 'email' ? html`
        ${s.status === 'unverified' ? html`<section class="card"><h2>Enter the verification code</h2>
          <p>We sent a 6-digit code to <b>${s.info.email}</b>. It proves you own this address.</p>
          <form method="post" action="/senders/${s.id}/verify" class="row">${csrfField(ctx.csrf)}<input name="code" inputmode="numeric" maxlength="6" required placeholder="6-digit code"><button class="primary">Verify</button></form>
          <form method="post" action="/senders/${s.id}/resend">${csrfField(ctx.csrf)}<button class="link">Send a new code</button></form></section>` : ''}
        <section class="card"><h2>Details</h2><dl>
          <dt>Sends as</dt><dd>${senderLine(s)}</dd><dt>Connection</dt><dd>${s.info.provider === 'gmail_api' ? 'Gmail (connected with Google)' : `${s.info.host}:${s.info.port}`}</dd>
          <dt>Daily limit</dt><dd>${s.daily_limit} per 24 hours (sent in the last 24 hours: ${sentToday})</dd>
          ${s.info.reply_to ? html`<dt>Replies go to</dt><dd>${s.info.reply_to}</dd>` : ''}</dl></section>
${s.info.provider === 'gmail_api' ? html`<section class="card"><h2>Reconnect</h2><p>If Google access was removed or your Google password changed, sign in again.</p>
          <a class="button" href="/senders/google/start?label=${encodeURIComponent(s.label)}&from_name=${encodeURIComponent(s.info.from_name || '')}&reply_to=${encodeURIComponent(s.info.reply_to || '')}">Reconnect with Google</a></section>` : html`        <section class="card"><h2>Change the app password</h2>
          <form method="post" action="/senders/${s.id}/password" class="row">${csrfField(ctx.csrf)}<input type="password" name="password" required autocomplete="off" placeholder="New app password"><button>Test and save</button></form></section>`}`
      : html`
        <section class="card"><h2>Number</h2><dl>
          <dt>Display name</dt><dd>${s.info.verified_name}</dd><dt>Number</dt><dd>${s.info.display_phone}</dd>
          <dt>Quality rating</dt><dd>${s.info.quality || 'unknown'}</dd>
          <dt>Messaging limit</dt><dd>${waLimitText(s.info)} (shared by all numbers in your Meta business portfolio)</dd>
          <dt>Sent in last 24 hours</dt><dd>${sentToday}</dd></dl>
          <form method="post" action="/senders/${s.id}/recheck" class="stack">${csrfField(ctx.csrf)}
            <details><summary>Replace the access token</summary><textarea name="token" rows="2" placeholder="New permanent token (leave empty to keep the current one)"></textarea></details>
            <button>Check again with Meta</button></form></section>
        <section class="card ${s.info.webhook_ok ? '' : 'attention'}"><h2>Webhook (opt-outs and delivery reports) ${s.info.webhook_ok ? badge('verified') : badge('unverified')}</h2>
          <p>In <b>developers.facebook.com</b> → your app → <b>WhatsApp → Configuration</b> → Webhook → <b>Edit</b>, paste:</p>
          <dl><dt>Callback URL</dt><dd><code class="copy">${webhookUrl(ctx.user)}</code></dd><dt>Verify token</dt><dd><code class="copy">${ctx.user.webhook_key}</code></dd></dl>
          <p>Press <b>Verify and save</b>, then under <b>Webhook fields</b> switch on <b>messages</b>.</p>
          ${s.info.app_subscribed === false ? html`<p class="warn">The app could not subscribe itself to your WhatsApp Business Account. Make sure the token has the whatsapp_business_management permission, then press "Check again with Meta".</p>` : ''}</section>
        <section class="card"><h2>Send a test to your own WhatsApp</h2>
          <form method="post" action="/senders/${s.id}/test" class="row">${csrfField(ctx.csrf)}
            <input name="to" placeholder="Your WhatsApp number with country code" required>
            <select name="template">${(templates || []).filter((t) => t.supported && !['IMAGE', 'VIDEO'].includes(t.headerFormat)).map((t) => html`<option value="${t.name}|${t.language}">${t.name} (${t.language})</option>`)}</select>
            <button>Send test</button></form></section>
        <section class="card"><div class="row between"><h2>Message templates</h2><a class="button primary" href="/senders/${s.id}/templates/new">Create a template</a></div>
          <p class="muted">Campaigns can use templates marked "ready".</p>
          ${templates === null ? html`<p class="bad">Could not load templates from Meta.</p>` : html`<div class="tablewrap"><table><thead><tr><th>Name</th><th>Language</th><th>Category</th><th>Status</th><th>Opt-out</th><th>Usable here</th></tr></thead><tbody>
          ${templates.map((t) => html`<tr><td>${t.name}</td><td>${t.language}</td><td>${t.category}</td><td>${t.status}</td><td>${t.hasOptOut ? 'yes' : 'no'}</td>
            <td>${t.supported ? (t.hasOptOut ? html`<span class="badge green">ready</span>` : html`<span class="badge amber">needs opt-out</span>`) : html`<span class="muted">${t.reason}</span>`}</td></tr>`)}</tbody></table></div>`}</section>`}
      <details class="danger"><summary>Remove this sender</summary>
        <form method="post" action="/senders/${s.id}/delete" data-confirm="Remove this sender? Its saved password/token will be deleted.">${csrfField(ctx.csrf)}<button class="danger">Remove sender</button></form></details>`, { active: '/senders', wide: true });
  });

  r.get('/senders/:id/templates/new', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    ctx.page('New template', html`
      <p class="crumbs"><a href="/senders">Senders</a> › <a href="/senders/${s.id}">${s.label}</a> ›</p>
      <h1>Create a WhatsApp template</h1>
      <p class="lead">Meta reviews every template (usually within minutes, sometimes up to a day).</p>
      <form method="post" action="/senders/${s.id}/templates" enctype="multipart/form-data" class="card stack">${csrfField(ctx.csrf)}
        <label>Template name<input name="name" required pattern="[a-z0-9_]{1,100}"><small>Lowercase letters, numbers and _ only.</small></label>
        <label>Language<select name="language"><option value="en">English</option><option value="ar">Arabic</option><option value="en_US">English (US)</option><option value="en_GB">English (UK)</option></select></label>
        <label>Image or video at the top (optional)<input type="file" name="media" accept="image/jpeg,image/png,video/mp4"><small>JPG/PNG up to 5 MB or MP4 up to 16 MB. This is only Meta's review sample — you attach the real one in the campaign.</small></label>
        <label>Message text<textarea name="body" required rows="6" maxlength="1024" dir="auto"></textarea>
          <small>Write <b>{{1}}</b> where the customer's name should appear (optional).</small></label>
        <label>Footer (optional, max 60 characters)<input name="footer" maxlength="60" dir="auto"></label>
        <label>Opt-out button text<input name="button" maxlength="25" value="Stop promotions" dir="auto" required></label>
        <button class="primary">Submit to Meta for approval</button>
      </form>`, { active: '/senders' });
  });

  r.post('/senders/:id/templates', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    const back = `/senders/${s.id}/templates/new`;
    const name = str(ctx.body.name, 100);
    if (!/^[a-z0-9_]{1,100}$/.test(name)) return ctx.go(back, { err: 'The name may only contain lowercase letters, numbers and _.' });
    const bodyText = str(ctx.body.body, 1024);
    if (!bodyText) return ctx.go(back, { err: 'Write the message text.' });
    if (/\{\{(?!1\}\})[^}]*\}\}/.test(bodyText)) return ctx.go(back, { err: 'Only {{1}} (the customer name) can be used as a variable here.' });
    if (/^\s*\{\{1\}\}|\{\{1\}\}\s*$/.test(bodyText)) return ctx.go(back, { err: 'Meta does not allow the text to start or end with {{1}}. Add words before and after it.' });
    let media = null;
    const f = ctx.files.find((x) => x.field === 'media');
    if (f) { try { media = checkMedia(f, 'whatsapp'); } catch (e) { return ctx.go(back, { err: e.message }); } }
    const buttonText = str(ctx.body.button, 25) || 'Stop promotions';
    if (!wa.OPT_OUT_BUTTON.test(buttonText)) return ctx.go(back, { err: 'The button must clearly say it stops messages, like "Stop promotions".' });
    const language = ['en', 'ar', 'en_US', 'en_GB'].includes(ctx.body.language) ? ctx.body.language : 'en';
    try {
      const out = await wa.createTemplate(senderCreds(s), { name, language, bodyText, footerText: str(ctx.body.footer, 60), buttonText, media });
      ctx.go(`/senders/${s.id}`, { ok: `Template "${name}" submitted — Meta status: ${out.status || 'PENDING'}. Reload this page later to see when it is approved.` });
    } catch (e) { ctx.go(back, { err: `Meta did not accept the template: ${e.message}` }); }
  });

  r.post('/senders/:id/delete', async (ctx) => {
    const s = await owned('senders', ctx.params.id, ctx.user);
    if (await one("SELECT 1 FROM campaigns WHERE sender_id=$1 AND status IN ('active','paused')", [s.id])) return ctx.go(`/senders/${s.id}`, { err: 'A running or paused campaign uses this sender. Cancel it first.' });
    await q('DELETE FROM senders WHERE id=$1 AND user_id=$2', [s.id, ctx.user.id]);
    ctx.go('/senders', { ok: 'Sender removed.' });
  });
}
