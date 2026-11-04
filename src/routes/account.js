// Home page, settings, opt-out list, password and account deletion.
import { html, csrfField, fmtDate, badge } from '../html.js';
import { q, one, rows } from '../db.js';
import { config } from '../config.js';
import { str } from './util.js';
import { checkPassword, hashPassword } from '../crypto.js';
import { passwordProblem, logout } from '../auth.js';
import { COUNTRIES, normalizeEmail, normalizePhone } from '../contacts.js';

const ZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Muscat', 'Africa/Cairo', 'Asia/Amman', 'Asia/Beirut', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Manila', 'Europe/London', 'UTC'];

export default function register(r) {
  r.get('/', async (ctx) => {
    const u = ctx.user;
    const shops = await one('SELECT count(*)::int AS n, count(current_upload_id)::int AS ready FROM shops WHERE user_id=$1', [u.id]);
    const senders = await one("SELECT count(*) FILTER (WHERE status='verified')::int AS ok, count(*)::int AS n FROM senders WHERE user_id=$1", [u.id]);
    const running = await rows(`SELECT c.id, c.name, c.status, c.channel, s.name AS shop,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('queued','sending'))::int AS queued,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('sent','delivered','read'))::int AS sent,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status='failed')::int AS failed
      FROM campaigns c JOIN shops s ON s.id=c.shop_id WHERE c.user_id=$1 AND c.status IN ('active','paused') ORDER BY c.activated_at DESC`, [u.id]);
    const step = (done, n, title, text, href, label) => html`<li class="${done ? 'done' : ''}"><div><b>${n}. ${title}</b><p>${text}</p></div><a class="button ${done ? '' : 'primary'}" href="${href}">${label}</a></li>`;
    ctx.page('Home', html`
      <h1>Hello ${u.name.split(' ')[0]}</h1>
      <ol class="checklist">
        ${step(shops.ready > 0, 1, 'Upload a customer file', shops.ready ? `${shops.ready} shop(s) with a customer list.` : 'Add a shop and upload its Excel file, then match the columns.', '/shops', shops.ready ? 'Manage shops' : 'Add a shop')}
        ${step(senders.ok > 0, 2, 'Connect where you send from', senders.ok ? `${senders.ok} verified sender(s).` : 'Connect your own Gmail address and/or WhatsApp Business number and verify it.', '/senders', senders.ok ? 'Manage senders' : 'Connect a sender')}
        ${step(false, 3, 'Create a campaign', 'Choose a shop and sender, write the message, preview it, then activate automatic sending.', '/campaigns/new', 'New campaign')}
      </ol>
      ${running.length ? html`<section class="card"><h2>Running now</h2><div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Shop</th><th>Status</th><th>Queued</th><th>Sent</th><th>Failed</th></tr></thead><tbody>
        ${running.map((c) => html`<tr><td><a href="/campaigns/${c.id}">${c.name}</a></td><td>${c.shop}</td><td>${badge(c.status)}</td><td>${c.queued}</td><td>${c.sent}</td><td>${c.failed}</td></tr>`)}</tbody></table></div></section>` : ''}`, { active: '/' });
  });

  r.get('/settings', async (ctx) => {
    const u = ctx.user;
    const hours = (sel) => Array.from({ length: 25 }, (_, h) => html`<option value="${h}" ${sel === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`);
    ctx.page('Settings', html`
      <h1>Settings</h1>
      <form method="post" action="/settings" class="card stack">${csrfField(ctx.csrf)}
        <h2>Sending rules</h2>
        <label>Your name<input name="name" value="${u.name}" maxlength="100" required></label>
        <label>Time zone<select name="timezone">${ZONES.map((z) => html`<option ${u.timezone === z ? 'selected' : ''}>${z}</option>`)}</select></label>
        <div class="row"><label>Send only from<select name="send_start">${hours(u.send_start)}</select></label><label>until<select name="send_end">${hours(u.send_end)}</select></label></div>
        <p class="muted">UAE rules (Cabinet Resolution 56 of 2024) allow marketing calls and marketing messages through phone and social-media apps only between 09:00 and 18:00. Campaigns wait outside these hours and continue automatically.</p>
        <label>Default country for phone numbers without a country code<select name="country">${Object.entries(COUNTRIES).map(([k, v]) => html`<option value="${k}" ${u.default_country === k ? 'selected' : ''}>${v.name} (+${v.cc})</option>`)}</select></label>
        <button class="primary">Save</button>
      </form>
      <section class="card"><h2>Keep campaigns running while nobody has the app open</h2>
        <p>Free hosting puts the app to sleep after 15 minutes without visitors. A free scheduler wakes it every minute so automatic campaigns keep sending (see SETUP.md, step 5). Use this address in cron-job.org:</p>
        <p><code class="copy">${config.publicUrl}/cron/tick?key=${config.cronKey}</code></p></section>
      <form method="post" action="/settings/password" class="card stack">${csrfField(ctx.csrf)}
        <h2>Change password</h2>
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password<input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
        <button>Change password</button></form>
      <details class="danger"><summary>Delete my account and all data</summary>
        <form method="post" action="/settings/delete" class="stack" data-confirm="Delete your account, all shops, customer lists, senders and campaigns permanently?">${csrfField(ctx.csrf)}
          <label>Type your password to confirm<input type="password" name="password" required></label><button class="danger">Delete everything</button></form></details>`, { active: '/settings' });
  });

  r.post('/settings', async (ctx) => {
    const b = ctx.body;
    const start = Math.min(Math.max(Number(b.send_start) || 0, 0), 24); const end = Math.min(Math.max(Number(b.send_end) || 0, 0), 24);
    if (start === end && !(start === 0)) return ctx.go('/settings', { err: 'The start and end hour cannot be the same.' });
    await q('UPDATE users SET name=$2, timezone=$3, send_start=$4, send_end=$5, default_country=$6 WHERE id=$1', [ctx.user.id, str(b.name, 100) || ctx.user.name,
      ZONES.includes(b.timezone) ? b.timezone : 'Asia/Dubai', start, end === 0 && start === 0 ? 24 : end, COUNTRIES[b.country] ? b.country : 'AE']);
    ctx.go('/settings', { ok: 'Saved.' });
  });

  r.post('/settings/password', async (ctx) => {
    const u = await one('SELECT password_hash FROM users WHERE id=$1', [ctx.user.id]);
    if (!(await checkPassword(String(ctx.body.current || ''), u.password_hash))) return ctx.go('/settings', { err: 'The current password is not correct.' });
    const p = passwordProblem(ctx.body.password); if (p) return ctx.go('/settings', { err: p });
    await q('UPDATE users SET password_hash=$2 WHERE id=$1', [ctx.user.id, await hashPassword(ctx.body.password)]);
    await q('DELETE FROM sessions WHERE user_id=$1', [ctx.user.id]);
    ctx.go('/login');
  });

  r.post('/settings/delete', async (ctx) => {
    const u = await one('SELECT password_hash FROM users WHERE id=$1', [ctx.user.id]);
    if (!(await checkPassword(String(ctx.body.password || ''), u.password_hash))) return ctx.go('/settings', { err: 'The password is not correct.' });
    await q('DELETE FROM users WHERE id=$1', [ctx.user.id]);
    await logout(ctx.req, ctx.res);
    ctx.go('/login');
  });

  // ---------- Opt-outs ----------
  r.get('/optouts', async (ctx) => {
    const list = await rows('SELECT * FROM suppressions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 2000', [ctx.user.id]);
    ctx.page('Opt-outs', html`
      <h1>Opt-outs</h1>
      <p class="lead">People here are never messaged again on that channel — even if they appear in a new file with "Yes" for consent. Email unsubscribes and WhatsApp STOP replies are added automatically.</p>
      <form method="post" action="/optouts" class="card row">${csrfField(ctx.csrf)}
        <select name="channel"><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select>
        <input name="address" placeholder="Email address or phone number" required><button>Add opt-out</button></form>
      <div class="tablewrap"><table><thead><tr><th>Channel</th><th>Address</th><th>Why</th><th>When</th><th></th></tr></thead><tbody>
        ${list.map((s) => html`<tr><td>${s.channel}</td><td>${s.channel === 'whatsapp' ? '+' + s.address : s.address}</td><td>${s.reason}</td><td>${fmtDate(s.created_at, ctx.user.timezone)}</td>
          <td><form method="post" action="/optouts/remove" data-confirm="Only remove this if the person clearly asked to receive your messages again. Remove?">${csrfField(ctx.csrf)}
            <input type="hidden" name="channel" value="${s.channel}"><input type="hidden" name="address" value="${s.address}"><button class="link">Remove</button></form></td></tr>`)}
      </tbody></table></div>`, { active: '/optouts' });
  });

  r.post('/optouts', async (ctx) => {
    const channel = ctx.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    const address = channel === 'email' ? normalizeEmail(ctx.body.address) : normalizePhone(ctx.body.address, ctx.user.default_country);
    if (!address) return ctx.go('/optouts', { err: 'That address is not valid.' });
    await q('INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ctx.user.id, channel, address, 'Added by you']);
    await q("UPDATE messages SET status='skipped', skip_reason='Opted out', updated_at=now() WHERE user_id=$1 AND channel=$2 AND address=$3 AND status='queued'", [ctx.user.id, channel, address]);
    ctx.go('/optouts', { ok: 'Added.' });
  });

  r.post('/optouts/remove', async (ctx) => {
    await q('DELETE FROM suppressions WHERE user_id=$1 AND channel=$2 AND address=$3', [ctx.user.id, str(ctx.body.channel, 20), str(ctx.body.address, 300)]);
    ctx.go('/optouts', { ok: 'Removed from the opt-out list.' });
  });
}
