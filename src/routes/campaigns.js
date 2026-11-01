// Campaigns: choose shop + sender, write the message, preview, activate, track, pause/cancel.
import { html, csrfField, fmtDate, badge, plural } from '../html.js';
import { HttpError } from '../http.js';
import { q, one, rows } from '../db.js';
import { owned, str, list } from './util.js';
import { randomToken, decryptJson } from '../crypto.js';
import { checkMedia } from './media.js';
import { senderLine } from './senders.js';
import * as wa from '../providers/whatsapp.js';
import * as email from '../providers/email.js';
import { buildEmail } from '../mime.js';
import { computeRecipients, summarize, activateCampaign, campaignCounts, emailVars, waValues, renderWaPreview, fillPlaceholders, emailHtml, emailText, SOURCES } from '../campaigns.js';
import { processCampaign, withSendLock, withinHours, unsubscribeUrl } from '../worker.js';

const EDITABLE = (c) => c.status === 'draft';

async function loadMediaMeta(ids, userId) {
  if (!ids?.length) return [];
  return rows('SELECT id, filename, mime, kind, size FROM media WHERE id = ANY($1::bigint[]) AND user_id=$2 ORDER BY id', [ids, userId]);
}

// What is still missing before a campaign can be activated.
async function problems(c, user) {
  const out = [];
  const sender = c.sender_id ? await one('SELECT * FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, user.id]) : null;
  if (!sender) out.push('Choose a sender.');
  else if (sender.status !== 'verified') out.push(`The sender "${sender.label}" is not verified yet.`);
  else if (sender.channel !== c.channel) out.push('The sender does not match the channel.');
  const shop = await one('SELECT current_upload_id FROM shops WHERE id=$1 AND user_id=$2', [c.shop_id, user.id]);
  if (!shop?.current_upload_id) out.push('Upload the shop\'s customer file first.');
  if (c.channel === 'email') {
    if (!c.subject.trim()) out.push('Write an email subject.');
    if (!c.body.trim()) out.push('Write the email text.');
    const media = await loadMediaMeta(c.media_ids, user.id);
    const total = media.reduce((n, m) => n + m.size, 0);
    if (total > 18 * 1024 * 1024) out.push('Attachments are larger than 18 MB in total (email limit is about 25 MB after encoding). Remove some.');
  } else {
    const info = c.template?.info;
    if (!info) out.push('Choose an approved WhatsApp template.');
    else {
      if (!info.supported) out.push(info.reason);
      if (!info.hasOptOut) out.push('This template has no opt-out (no "Stop promotions" button or STOP instruction). Create one with "Create a template" on the sender page.');
      if (['IMAGE', 'VIDEO'].includes(info.headerFormat)) {
        const media = await loadMediaMeta(c.media_ids, user.id);
        if (!media.some((m) => m.kind === info.headerFormat.toLowerCase())) out.push(`This template needs ${info.headerFormat === 'IMAGE' ? 'an image (JPG/PNG)' : 'a video (MP4)'} — attach one.`);
      }
      for (const v of info.vars) {
        const key = v.component === 'button' ? `button:${v.index}:${v.name}` : `${v.component}:${v.name}`;
        const m = c.template.mapping?.[key];
        if (!m || (m.source === 'fixed' && !String(m.value || '').trim())) out.push(`Fill in the template variable {{${v.name}}} (${v.component}).`);
      }
    }
  }
  if (c.audience === 'selected' && !(c.selected_ids || []).length) out.push('Tick at least one person, or choose "Everyone eligible".');
  return { list: out, sender };
}

function progressBar(counts) {
  const done = counts.sentTotal + counts.failed + counts.unknown;
  const total = done + counts.queued + counts.sending;
  const pct = total ? Math.round((done / total) * 100) : 100;
  return html`<progress class="bar" max="100" value="${pct}" data-progress>${pct}%</progress>`;
}

export default function register(r) {
  r.get('/campaigns', async (ctx) => {
    const list2 = await rows(`SELECT c.*, s.name AS shop_name,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('sent','delivered','read'))::int AS sent,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('queued','sending'))::int AS queued,
      (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status='failed')::int AS failed
      FROM campaigns c JOIN shops s ON s.id=c.shop_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 200`, [ctx.user.id]);
    ctx.page('Campaigns', html`
      <div class="row between"><h1>Campaigns</h1><a class="button primary" href="/campaigns/new">New campaign</a></div>
      ${list2.length ? html`<div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Shop</th><th>Channel</th><th>Status</th><th>Queued</th><th>Sent</th><th>Failed</th><th>Created</th></tr></thead><tbody>
        ${list2.map((c) => html`<tr><td><a href="/campaigns/${c.id}${EDITABLE(c) ? '/edit' : ''}">${c.name}</a></td><td>${c.shop_name}</td><td>${c.channel === 'email' ? 'Email' : 'WhatsApp'}</td>
          <td>${badge(c.status)}</td><td>${c.queued}</td><td>${c.sent}</td><td>${c.failed}</td><td>${fmtDate(c.created_at, ctx.user.timezone)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No campaigns yet.</p>`}`, { active: '/campaigns', wide: true });
  });

  r.get('/campaigns/new', async (ctx) => {
    const shops = await rows('SELECT id, name, current_upload_id FROM shops WHERE user_id=$1 ORDER BY lower(name)', [ctx.user.id]);
    const senders = await rows("SELECT * FROM senders WHERE user_id=$1 AND status='verified' ORDER BY channel, label", [ctx.user.id]);
    const ready = shops.filter((s) => s.current_upload_id);
    if (!ready.length) return ctx.page('New campaign', html`<h1>New campaign</h1><section class="card"><p>First add a shop and upload its customer file.</p><a class="button primary" href="/shops">Go to Shops & files</a></section>`, { active: '/campaigns' });
    if (!senders.length) return ctx.page('New campaign', html`<h1>New campaign</h1><section class="card"><p>First connect and verify the email address or WhatsApp number you will send from.</p><a class="button primary" href="/senders">Go to Senders</a></section>`, { active: '/campaigns' });
    ctx.page('New campaign', html`
      <p class="crumbs"><a href="/campaigns">Campaigns</a> ›</p>
      <h1>New campaign</h1>
      <form method="post" action="/campaigns" class="card stack">${csrfField(ctx.csrf)}
        <label>Campaign name (only you see it)<input name="name" required maxlength="100" placeholder="November offer"></label>
        <label>1. Shop (whose customer file to use)<select name="shop_id" required>${ready.map((s) => html`<option value="${s.id}" ${String(ctx.query.shop) === String(s.id) ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label>2. Send from<select name="sender_id" required>${senders.map((s) => html`<option value="${s.id}">${s.channel === 'email' ? 'Email' : 'WhatsApp'} — ${s.label} (${senderLine(s)})</option>`)}</select>
          <small>The channel (email or WhatsApp) follows the sender you choose.</small></label>
        <button class="primary">Continue</button>
      </form>`, { active: '/campaigns' });
  });

  r.post('/campaigns', async (ctx) => {
    const shop = await owned('shops', ctx.body.shop_id, ctx.user);
    const sender = await owned('senders', ctx.body.sender_id, ctx.user);
    if (sender.status !== 'verified') return ctx.go('/campaigns/new', { err: 'That sender is not verified yet.' });
    const c = await one(`INSERT INTO campaigns (user_id, shop_id, sender_id, channel, name, activation_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.user.id, shop.id, sender.id, sender.channel, str(ctx.body.name, 100) || 'Campaign', randomToken(18)]);
    ctx.go(`/campaigns/${c.id}/edit`);
  });

  r.get('/campaigns/:id/edit', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (!EDITABLE(c)) return ctx.go(`/campaigns/${c.id}`);
    const shop = await owned('shops', c.shop_id, ctx.user);
    const sender = c.sender_id ? await one('SELECT * FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, ctx.user.id]) : null;
    const up = shop.current_upload_id ? await one('SELECT headers FROM uploads WHERE id=$1', [shop.current_upload_id]) : { headers: [] };
    const contacts = shop.current_upload_id ? await rows('SELECT id, row_number, name, email, phone, consent_email, consent_whatsapp FROM contacts WHERE upload_id=$1 ORDER BY row_number LIMIT 2000', [shop.current_upload_id]) : [];
    const media = await loadMediaMeta(c.media_ids, ctx.user.id);
    const selected = new Set((c.selected_ids || []).map(String));
    let templates = []; let tplErr = null;
    if (c.channel === 'whatsapp' && sender) {
      try { templates = (await wa.listTemplates({ ...sender.info, ...decryptJson(sender.secrets) })).map(wa.analyzeTemplate).filter((t) => t.status === 'APPROVED'); } catch (e) { tplErr = e.message; }
    }
    const info = c.template?.info;
    const sourceOptions = (cur) => html`${SOURCES.map(([k, l]) => html`<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`)}
      <optgroup label="A column from the file">${up.headers.map((h) => html`<option value="column:${h}" ${cur === 'column:' + h ? 'selected' : ''}>${h}</option>`)}</optgroup>`;
    const eligibleFor = (x) => (c.channel === 'email' ? x.email && x.consent_email : x.phone && x.consent_whatsapp);

    ctx.page(`Edit ${c.name}`, html`
      <p class="crumbs"><a href="/campaigns">Campaigns</a> ›</p>
      <h1>${c.name}</h1>
      <p class="lead">${shop.name} · ${c.channel === 'email' ? 'Email' : 'WhatsApp'} from ${sender ? senderLine(sender) : 'no sender'}</p>
      <ol class="steps"><li class="done">Shop & sender</li><li class="on">Message & recipients</li><li>Preview & activate</li><li>Track</li></ol>
      <form method="post" action="/campaigns/${c.id}/edit" enctype="multipart/form-data" class="stack">${csrfField(ctx.csrf)}
      <section class="card stack"><h2>Message</h2>
      ${c.channel === 'email' ? html`
        <label>Subject<input name="subject" maxlength="200" value="${c.subject}" dir="auto" required></label>
        <label>Text<textarea name="body" rows="10" maxlength="20000" dir="auto" required>${c.body}</textarea></label>
        <p class="muted">Personalise with <code>{{first_name}}</code>, <code>{{name}}</code>, <code>{{shop}}</code> or any column title in double braces, e.g. ${up.headers.slice(0, 4).map((h) => html`<code>{{${h}}}</code> `)}. An unsubscribe link is added automatically at the bottom.</p>
        <label>Add images (shown in the email) or videos (attached)<input type="file" name="media" multiple accept="image/jpeg,image/png,video/mp4"></label>`
      : html`
        ${tplErr ? html`<p class="flash err">Could not load templates from Meta: ${tplErr}</p>` : ''}
        <label>Approved template<select name="template" data-autosubmit>
          <option value="">— choose —</option>
          ${templates.map((t) => html`<option value="${t.name}|${t.language}" ${info && info.name === t.name && info.language === t.language ? 'selected' : ''} ${t.supported ? '' : 'disabled'}>${t.name} (${t.language}, ${t.category.toLowerCase()})${t.supported ? (t.hasOptOut ? '' : ' — no opt-out') : ' — not supported'}</option>`)}
        </select><small>WhatsApp requires an approved template for messages you start. Need a new one? <a href="/senders/${sender?.id}/templates/new">Create a template</a>.</small></label>
        <noscript><button name="action" value="save">Load template</button></noscript>
        ${info ? html`
          <div class="wa-preview"><b>${info.headerText || ''}</b>${info.headerFormat === 'IMAGE' || info.headerFormat === 'VIDEO' ? html`<div class="muted">[${info.headerFormat.toLowerCase()}]</div>` : ''}
            <p dir="auto">${info.bodyText}</p>${info.footerText ? html`<small>${info.footerText}</small>` : ''}
            ${info.buttons.map((b) => html`<div class="wa-btn">${b.text}</div>`)}</div>
          ${!info.hasOptOut ? html`<p class="flash err">This template has no opt-out button or STOP instruction, so it cannot be used. Pick or create one with a "Stop promotions" button.</p>` : ''}
          ${info.vars.map((v) => {
            const key = v.component === 'button' ? `button:${v.index}:${v.name}` : `${v.component}:${v.name}`;
            const m = c.template.mapping?.[key] || { source: v.component === 'body' && v.name === '1' ? 'first_name' : 'fixed', value: '' };
            return html`<fieldset class="var"><legend>{{${v.name}}} in the ${v.component}</legend>
              <select name="src:${key}">${v.fixedOnly ? html`<option value="fixed">Fixed text</option>` : sourceOptions(m.source)}</select>
              <input name="val:${key}" value="${m.value || ''}" placeholder="${v.fixedOnly ? 'Text added to the end of the link' : 'Fixed text, or a fallback when the cell is empty'}" dir="auto"></fieldset>`;
          })}
          ${['IMAGE', 'VIDEO'].includes(info.headerFormat) ? html`<label>${info.headerFormat === 'IMAGE' ? 'Image (JPG/PNG, up to 5 MB)' : 'Video (MP4, up to 16 MB)'}<input type="file" name="media" accept="${info.headerFormat === 'IMAGE' ? 'image/jpeg,image/png' : 'video/mp4'}"></label>` : ''}` : ''}`}
      ${media.length ? html`<div class="media-list">${media.map((m) => html`<figure>${m.kind === 'image' ? html`<img src="/media/${m.id}" alt="">` : html`<video src="/media/${m.id}" controls preload="metadata"></video>`}
        <figcaption>${m.filename} <label class="inline"><input type="checkbox" name="remove_media[]" value="${m.id}"> remove</label></figcaption></figure>`)}</div>` : ''}
      </section>

      <section class="card stack"><h2>Recipients</h2>
        <label class="inline"><input type="radio" name="audience" value="all" ${c.audience === 'all' ? 'checked' : ''}> Everyone in the file who can receive it (has agreed and has valid details)</label>
        <label class="inline"><input type="radio" name="audience" value="selected" ${c.audience === 'selected' ? 'checked' : ''}> Only the people I tick below</label>
        <label class="inline"><input type="checkbox" name="skip_already" value="1" ${c.skip_already_received ? 'checked' : ''}> Skip people who already received this exact message (recommended)</label>
        <details ${c.audience === 'selected' ? 'open' : ''}><summary>Choose people (${contacts.length})</summary>
          <p><label class="inline"><input type="checkbox" data-select-all="pick"> Tick all who can receive it</label></p>
          <div class="tablewrap tall"><table><thead><tr><th></th><th>Row</th><th>Name</th><th>${c.channel === 'email' ? 'Email' : 'WhatsApp'}</th><th>Can receive</th></tr></thead><tbody>
          ${contacts.map((x) => html`<tr><td><input type="checkbox" name="pick[]" value="${x.id}" ${selected.has(String(x.id)) ? 'checked' : ''} ${eligibleFor(x) ? 'data-eligible' : ''}></td>
            <td>${x.row_number}</td><td>${x.name}</td><td>${c.channel === 'email' ? x.email || '—' : (x.phone ? '+' + x.phone : '—')}</td><td>${eligibleFor(x) ? 'yes' : html`<span class="muted">no</span>`}</td></tr>`)}
          </tbody></table></div>
          ${contacts.length >= 2000 ? html`<p class="muted">Only the first 2,000 rows can be ticked here. To send to everyone, choose "Everyone in the file".</p>` : ''}
        </details>
      </section>
      <div class="row"><button name="action" value="save">Save</button><button class="primary" name="action" value="preview">Save and preview</button></div>
      </form>
      <form method="post" action="/campaigns/${c.id}/delete" data-confirm="Delete this draft?">${csrfField(ctx.csrf)}<button class="link">Delete draft</button></form>`, { active: '/campaigns', wide: true });
  });

  r.post('/campaigns/:id/edit', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (!EDITABLE(c)) throw new HttpError(409, 'This campaign is already active and can no longer be changed.');
    const b = ctx.body;
    const upd = { audience: b.audience === 'selected' ? 'selected' : 'all', skip: b.skip_already === '1' };
    let mediaIds = (c.media_ids || []).map(Number).filter((id) => !list(b.remove_media).map(Number).includes(id));
    let error = null;
    for (const f of ctx.files.filter((x) => x.field === 'media')) {
      try {
        const m = checkMedia(f);
        if (c.channel === 'whatsapp') mediaIds = []; // a template header has exactly one image/video
        const row = await one('INSERT INTO media (user_id, filename, mime, kind, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [ctx.user.id, m.filename, m.mime, m.kind, m.data.length, m.data]);
        mediaIds.push(Number(row.id));
      } catch (e) { error = e.message; }
    }
    if (mediaIds.length > 10) { mediaIds = mediaIds.slice(0, 10); error = 'Up to 10 files can be attached.'; }
    let template = c.template;
    if (c.channel === 'whatsapp') {
      const pick = str(b.template, 600);
      if (!pick) template = null;
      else {
        const [name, language] = pick.split('|');
        if (!template || template.info.name !== name || template.info.language !== language) {
          const sender = await owned('senders', c.sender_id, ctx.user);
          const t = (await wa.listTemplates({ ...sender.info, ...decryptJson(sender.secrets) })).find((x) => x.name === name && x.language === language);
          template = t ? { info: wa.analyzeTemplate(t), mapping: {} } : null;
          if (!t) error = 'That template was not found any more.';
        } else {
          const mapping = {};
          for (const v of template.info.vars) {
            const key = v.component === 'button' ? `button:${v.index}:${v.name}` : `${v.component}:${v.name}`;
            const src = str(b[`src:${key}`], 300) || 'fixed';
            mapping[key] = { source: v.fixedOnly ? 'fixed' : src, value: str(b[`val:${key}`], 1000), fallback: src === 'fixed' ? '' : str(b[`val:${key}`], 1000) };
          }
          template = { ...template, mapping };
        }
      }
    }
    const shop = await owned('shops', c.shop_id, ctx.user);
    const validIds = new Set((await rows('SELECT id FROM contacts WHERE upload_id=$1', [shop.current_upload_id || 0])).map((x) => String(x.id)));
    const picks = list(b.pick).filter((id) => validIds.has(String(id))).map(Number);
    await q(`UPDATE campaigns SET subject=$3, body=$4, template=$5, media_ids=$6, audience=$7, selected_ids=$8, skip_already_received=$9 WHERE id=$1 AND user_id=$2 AND status='draft'`,
      [c.id, ctx.user.id, str(b.subject, 200), str(b.body, 20000), template, JSON.stringify(mediaIds), upd.audience, JSON.stringify(picks), upd.skip]);
    if (error) return ctx.go(`/campaigns/${c.id}/edit`, { err: error });
    if (b.action === 'preview') return ctx.go(`/campaigns/${c.id}/preview`);
    ctx.go(`/campaigns/${c.id}/edit`, { ok: 'Saved.' });
  });

  r.get('/campaigns/:id/preview', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (!EDITABLE(c)) return ctx.go(`/campaigns/${c.id}`);
    const shop = await owned('shops', c.shop_id, ctx.user);
    const { list: probs, sender } = await problems(c, ctx.user);
    const { list: recips } = await computeRecipients(c, { userId: ctx.user.id });
    const sum = summarize(recips);
    const first = recips.find((x) => !x.reason) || recips[0];
    const media = await loadMediaMeta(c.media_ids, ctx.user.id);
    let previewBlock = '';
    if (first) {
      if (c.channel === 'email') {
        const vars = emailVars(first.contact, shop.name);
        previewBlock = html`<div class="email-preview"><div class="muted">From: ${sender ? senderLine(sender) : ''}<br>To: ${first.address || first.rawAddr}<br>Subject: <b>${fillPlaceholders(c.subject, vars)}</b></div>
          <div class="email-body" dir="auto">${fillPlaceholders(c.body, vars)}</div>
          ${media.filter((m) => m.kind === 'image').map((m) => html`<img src="/media/${m.id}" alt="">`)}
          ${media.filter((m) => m.kind === 'video').map((m) => html`<p class="muted">📎 ${m.filename}</p>`)}
          <p class="muted small">You are receiving this because you agreed to hear from ${shop.name}. <u>Unsubscribe</u></p></div>`;
      } else if (c.template?.info) {
        const p = renderWaPreview(c.template.info, waValues(c, first.contact, shop.name));
        const m = media[0];
        previewBlock = html`<div class="wa-preview">${m ? (m.kind === 'image' ? html`<img src="/media/${m.id}" alt="">` : html`<video src="/media/${m.id}" controls preload="metadata"></video>`) : ''}
          ${p.header ? html`<b dir="auto">${p.header}</b>` : ''}<p dir="auto">${p.body}</p>${p.footer ? html`<small>${p.footer}</small>` : ''}${p.buttons.map((x) => html`<div class="wa-btn">${x.text}</div>`)}</div>`;
      }
    }
    const user = ctx.user;
    ctx.page(`Preview ${c.name}`, html`
      <p class="crumbs"><a href="/campaigns">Campaigns</a> › <a href="/campaigns/${c.id}/edit">${c.name}</a> ›</p>
      <h1>Preview: ${c.name}</h1>
      <ol class="steps"><li class="done">Shop & sender</li><li class="done">Message & recipients</li><li class="on">Preview & activate</li><li>Track</li></ol>
      ${probs.length ? html`<section class="card attention"><h2>Fix these first</h2><ul>${probs.map((p) => html`<li>${p}</li>`)}</ul><a class="button" href="/campaigns/${c.id}/edit">Back to editing</a></section>` : ''}
      <div class="two">
        <section class="card"><h2>What ${first ? (first.contact.name || 'the first person') : 'people'} will receive</h2>${previewBlock || html`<p class="muted">Nobody to preview.</p>`}
          ${!probs.length ? html`<form method="post" action="/campaigns/${c.id}/test" class="row">${csrfField(ctx.csrf)}
            ${c.channel === 'whatsapp' ? html`<input name="to" placeholder="Your WhatsApp number" required>` : ''}
            <button>Send this test to ${c.channel === 'email' ? 'my own address' : 'my number'}</button></form>` : ''}</section>
        <section class="card"><h2>Who receives it</h2>
          <div class="stats"><div><b>${sum.eligible}</b><span>will be sent</span></div>
          ${Object.entries(sum.reasons).map(([k, n]) => html`<div><b>${n}</b><span>skipped: ${k.toLowerCase()}</span></div>`)}</div>
          <p class="muted">Sending from ${sender ? senderLine(sender) : '—'}. ${c.channel === 'email' ? `Limit: ${sender?.daily_limit || '—'} emails per 24 hours.` : `WhatsApp limit: ${sender?.info?.limit_raw === 'TIER_UNLIMITED' ? 'unlimited' : (sender?.info?.limit ?? 250) + ' different people per 24 hours'}.`}
            Allowed hours: ${user.send_start}:00–${user.send_end}:00 (${user.timezone}) — change in Settings. ${withinHours(user) ? '' : 'It is outside those hours now, so sending will start when they begin.'}</p>
        </section>
      </div>
      ${!probs.length && sum.eligible ? html`
      <form method="post" action="/campaigns/${c.id}/activate" class="card stack" data-once>${csrfField(ctx.csrf)}
        <input type="hidden" name="key" value="${c.activation_key}">
        <h2>Activate</h2>
        <label class="inline"><input type="radio" name="mode" value="auto" checked> <span><b>Automatic sending</b> — the app sends to all ${sum.eligible} people by itself, within the provider's limits and your allowed hours. You can close the browser.</span></label>
        <label class="inline"><input type="radio" name="mode" value="manual"> <span><b>Manual</b> — nothing is sent until you press "Send next" on the progress page.</span></label>
        <label class="inline"><input type="checkbox" name="confirm" value="1" required> <span>I confirm these ${sum.eligible} people agreed to receive messages from ${shop.name}${c.channel === 'whatsapp' ? ' on WhatsApp' : ' by email'}.</span></label>
        <button class="primary big">Activate campaign</button>
        <p class="muted">Activating twice is impossible — each person is queued once per campaign.</p>
      </form>` : ''}
      <section class="card"><h2>Everyone in the file (${recips.length})</h2><div class="tablewrap tall"><table><thead><tr><th>Row</th><th>Name</th><th>Address</th><th>Result</th></tr></thead><tbody>
        ${recips.slice(0, 1000).map((x) => html`<tr><td>${x.contact.row_number}</td><td>${x.contact.name}</td><td>${x.address ? (c.channel === 'whatsapp' ? '+' + x.address : x.address) : x.rawAddr || '—'}</td><td>${x.reason ? html`<span class="muted">skip: ${x.reason}</span>` : html`<span class="badge green">will send</span>`}</td></tr>`)}
      </tbody></table></div></section>`, { active: '/campaigns', wide: true });
  });

  r.post('/campaigns/:id/test', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    const back = `/campaigns/${c.id}/preview`;
    const shop = await owned('shops', c.shop_id, ctx.user);
    const sender = await owned('senders', c.sender_id, ctx.user);
    const { list: recips } = await computeRecipients(c, { userId: ctx.user.id });
    const first = recips.find((x) => !x.reason) || recips[0];
    if (!first) return ctx.go(back, { err: 'No customer rows to build the test from.' });
    const creds = { ...sender.info, ...decryptJson(sender.secrets) };
    try {
      if (c.channel === 'email') {
        const vars = emailVars(first.contact, shop.name);
        const mediaFull = c.media_ids?.length ? await rows('SELECT filename, mime, kind, data FROM media WHERE id = ANY($1::bigint[]) AND user_id=$2 ORDER BY id', [c.media_ids, ctx.user.id]) : [];
        const images = mediaFull.filter((m) => m.kind === 'image').map((m, i) => ({ ...m, cid: `img${i}@sheetsender` }));
        const body = fillPlaceholders(c.body, vars);
        const unsub = unsubscribeUrl(ctx.user.id, 'email', sender.info.email, shop.name);
        const built = buildEmail({ fromName: sender.info.from_name, fromEmail: sender.info.email, to: sender.info.email, subject: '[TEST] ' + fillPlaceholders(c.subject, vars),
          text: emailText(body, { unsubscribeUrl: unsub, shopName: shop.name }), html: emailHtml(body, { images, unsubscribeUrl: unsub, shopName: shop.name }), inline: images, attachments: mediaFull.filter((m) => m.kind !== 'image') });
        const s = await email.openSession(creds, sender.info);
        try { await s.send({ to: sender.info.email, data: built.data }); } finally { await s.close(); }
        return ctx.go(back, { ok: `Test email sent to ${sender.info.email} (the "unsubscribe" link in a test only affects your own address).` });
      }
      const { normalizePhone } = await import('../contacts.js');
      const to = normalizePhone(ctx.body.to, ctx.user.default_country);
      if (!to) return ctx.go(back, { err: 'Enter your WhatsApp number with country code.' });
      let mediaId;
      if (['IMAGE', 'VIDEO'].includes(c.template.info.headerFormat)) {
        const m = await one('SELECT filename, mime, data FROM media WHERE id = ANY($1::bigint[]) AND user_id=$2 ORDER BY id LIMIT 1', [c.media_ids, ctx.user.id]);
        mediaId = await wa.uploadMedia(creds, m);
      }
      await wa.sendTemplate(creds, to, wa.buildTemplateMessage(c.template.info, waValues(c, first.contact, shop.name), mediaId));
      ctx.go(back, { ok: `Test sent to +${to}.` });
    } catch (e) { ctx.go(back, { err: `The test was not sent: ${e.message}` }); }
  });

  r.post('/campaigns/:id/activate', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (c.status !== 'draft') return ctx.go(`/campaigns/${c.id}`, { ok: 'This campaign is already active — it was not activated a second time.' });
    if (ctx.body.key !== c.activation_key) return ctx.go(`/campaigns/${c.id}/preview`, { err: 'This page was out of date. Check the preview again.' });
    if (ctx.body.confirm !== '1') return ctx.go(`/campaigns/${c.id}/preview`, { err: 'Tick the box to confirm these people agreed to receive your messages.' });
    const { list: probs } = await problems(c, ctx.user);
    if (probs.length) return ctx.go(`/campaigns/${c.id}/preview`, { err: probs[0] });
    try {
      const out = await activateCampaign(ctx.user.id, c.id, ctx.body.mode === 'manual' ? 'manual' : 'auto');
      if (out.already) return ctx.go(`/campaigns/${c.id}`, { ok: 'This campaign is already active — it was not activated a second time.' });
      ctx.go(`/campaigns/${c.id}`, { ok: `Activated. ${plural(out.queued, 'message')} queued.` });
    } catch (e) { ctx.go(`/campaigns/${c.id}/preview`, { err: e.message }); }
  });

  async function statusData(c, user) {
    const counts = await campaignCounts(c.id);
    const sender = c.sender_id ? await one('SELECT label, hold_until, hold_reason, status FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, user.id]) : null;
    let waiting = null;
    if (c.status === 'active') {
      if (sender?.hold_until && new Date(sender.hold_until) > new Date()) waiting = `Waiting until ${fmtDate(sender.hold_until, user.timezone)} — ${sender.hold_reason}`;
      else if (!withinHours(user)) waiting = `Outside your allowed sending hours (${user.send_start}:00–${user.send_end}:00). Sending resumes automatically.`;
      else if (counts.queued && c.mode === 'manual') waiting = 'Manual mode — press "Send next" to send.';
      else if (counts.queued) {
        const next = await one("SELECT min(next_attempt_at) AS t FROM messages WHERE campaign_id=$1 AND status='queued'", [c.id]);
        if (next?.t && new Date(next.t) > new Date()) waiting = `Some messages will be retried at ${fmtDate(next.t, user.timezone)}.`;
      }
    }
    return { status: c.status, counts, waiting, paused_reason: c.paused_reason };
  }

  r.get('/campaigns/:id/status.json', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    ctx.json(200, await statusData(c, ctx.user));
  });

  r.get('/campaigns/:id', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (EDITABLE(c)) return ctx.go(`/campaigns/${c.id}/edit`);
    const shop = await owned('shops', c.shop_id, ctx.user);
    const sender = c.sender_id ? await one('SELECT * FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, ctx.user.id]) : null;
    const d = await statusData(c, ctx.user);
    const filter = ['queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'unknown', 'cancelled'].includes(ctx.query.show) ? ctx.query.show : null;
    const msgs = await rows(`SELECT * FROM messages WHERE campaign_id=$1 ${filter ? 'AND status=$2' : ''} ORDER BY (status IN ('failed','unknown')) DESC, id LIMIT 500`, filter ? [c.id, filter] : [c.id]);
    const n = d.counts;
    const tile = (key, label, value) => html`<a href="?show=${key}" class="${filter === key ? 'on' : ''}"><b data-count="${key}">${value}</b><span>${label}</span></a>`;
    ctx.page(c.name, html`
      <p class="crumbs"><a href="/campaigns">Campaigns</a> ›</p>
      <div class="row between"><h1>${c.name} <span data-status>${badge(c.status)}</span></h1>
        <form method="post" action="/campaigns/${c.id}/duplicate">${csrfField(ctx.csrf)}<button class="link">Copy to a new draft</button></form></div>
      <p class="lead">${shop.name} · ${c.channel === 'email' ? 'Email' : 'WhatsApp'} from ${sender ? senderLine(sender) : '(sender removed)'} · ${c.mode === 'auto' ? 'automatic sending' : 'manual sending'} · activated ${fmtDate(c.activated_at, ctx.user.timezone)}</p>
      <section class="card" data-poll="/campaigns/${c.id}/status.json" data-poll-status="${c.status}">
        ${progressBar(n)}
        <div class="stats links">${tile('queued', 'queued', n.queued + n.sending)}${tile('sent', 'sent', n.sentTotal)}${c.channel === 'whatsapp' ? [tile('delivered', 'delivered', n.delivered + n.read), tile('read', 'read', n.read)] : ''}
          ${tile('failed', 'failed', n.failed)}${tile('skipped', 'skipped', n.skipped)}${n.unknown ? tile('unknown', 'check manually', n.unknown) : ''}${n.cancelled ? tile('cancelled', 'cancelled', n.cancelled) : ''}</div>
        <p class="note" data-waiting ${d.waiting ? '' : 'hidden'}>${d.waiting || ''}</p>
        ${c.status === 'paused' && c.paused_reason ? html`<p class="flash warn">Paused: ${c.paused_reason}</p>` : ''}
        <div class="row">
          ${c.status === 'active' ? html`<form method="post" action="/campaigns/${c.id}/pause">${csrfField(ctx.csrf)}<button>Pause</button></form>` : ''}
          ${c.status === 'paused' ? html`<form method="post" action="/campaigns/${c.id}/resume">${csrfField(ctx.csrf)}<button class="primary">Resume</button></form>` : ''}
          ${c.status === 'active' && c.mode === 'manual' ? html`<form method="post" action="/campaigns/${c.id}/send-next" class="row" data-once>${csrfField(ctx.csrf)}
              <select name="count"><option>1</option><option selected>10</option><option>50</option></select><button class="primary">Send next</button></form>
            <form method="post" action="/campaigns/${c.id}/mode">${csrfField(ctx.csrf)}<button>Switch to automatic</button></form>` : ''}
          ${['active', 'paused'].includes(c.status) ? html`<form method="post" action="/campaigns/${c.id}/cancel" data-confirm="Cancel this campaign? Messages not sent yet will not be sent.">${csrfField(ctx.csrf)}<button class="danger">Cancel campaign</button></form>` : ''}
        </div>
      </section>
      <section class="card"><h2>${filter ? `Messages: ${filter}` : 'Messages'} ${filter ? html`<a class="small" href="/campaigns/${c.id}">show all</a>` : ''}</h2>
        <div class="tablewrap tall"><table><thead><tr><th>Row</th><th>Name</th><th>To</th><th>Status</th><th>Details</th><th></th></tr></thead><tbody>
        ${msgs.map((m) => html`<tr><td>${m.row_number}</td><td>${m.recipient_name}</td><td>${c.channel === 'whatsapp' && m.address ? '+' + m.address : m.address}</td><td>${badge(m.status)}</td>
          <td class="small">${m.skip_reason || m.error || (m.sent_at ? fmtDate(m.sent_at, ctx.user.timezone) : '')}</td>
          <td>${['failed', 'unknown'].includes(m.status) && ['active', 'paused'].includes(c.status) ? html`<form method="post" action="/campaigns/${c.id}/retry/${m.id}" data-confirm="${m.status === 'unknown' ? 'This message may already have arrived. Send it again anyway?' : 'Try sending this message again?'}">${csrfField(ctx.csrf)}<button class="link">Retry</button></form>` : ''}</td></tr>`)}
        </tbody></table></div>${msgs.length >= 500 ? html`<p class="muted">Showing 500 messages. Click a number above to filter.</p>` : ''}</section>`, { active: '/campaigns', wide: true });
  });

  r.post('/campaigns/:id/pause', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    await q("UPDATE campaigns SET status='paused', paused_reason='Paused by you.' WHERE id=$1 AND status='active'", [c.id]);
    ctx.go(`/campaigns/${c.id}`, { ok: 'Paused. A message that was already being sent finishes; nothing else is sent until you resume.' });
  });

  r.post('/campaigns/:id/resume', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    const sender = c.sender_id ? await one('SELECT status FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, ctx.user.id]) : null;
    if (sender?.status !== 'verified') return ctx.go(`/campaigns/${c.id}`, { err: 'The sender needs attention first (Senders page).' });
    await q("UPDATE campaigns SET status='active', paused_reason=NULL WHERE id=$1 AND status='paused'", [c.id]);
    ctx.go(`/campaigns/${c.id}`, { ok: 'Resumed.' });
  });

  r.post('/campaigns/:id/cancel', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    await q("UPDATE campaigns SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('active','paused')", [c.id]);
    await q("UPDATE messages SET status='cancelled', updated_at=now() WHERE campaign_id=$1 AND status='queued'", [c.id]);
    ctx.go(`/campaigns/${c.id}`, { ok: 'Cancelled. Messages that were not sent yet will not be sent.' });
  });

  r.post('/campaigns/:id/mode', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    await q("UPDATE campaigns SET mode='auto' WHERE id=$1 AND status='active'", [c.id]);
    ctx.go(`/campaigns/${c.id}`, { ok: 'Automatic sending is on.' });
  });

  r.post('/campaigns/:id/send-next', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (c.status !== 'active') return ctx.go(`/campaigns/${c.id}`, { err: 'The campaign is not active.' });
    const count = Math.min(Math.max(Number(ctx.body.count) || 1, 1), 50);
    const out = await withSendLock(() => processCampaign(c.id, { deadline: Date.now() + 25000, limit: count, manual: true }));
    if (out.busy) return ctx.go(`/campaigns/${c.id}`, { err: 'The app is sending another campaign right now. Try again in a few seconds.' });
    ctx.go(`/campaigns/${c.id}`, out.sent ? { ok: `Sent ${plural(out.sent, 'message')}.${out.note ? ' ' + out.note : ''}` } : { err: out.note || 'Nothing was sent.' });
  });

  r.post('/campaigns/:id/retry/:mid', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    await q("UPDATE messages SET status='queued', attempts=0, next_attempt_at=NULL, error=NULL, updated_at=now() WHERE id=$1 AND campaign_id=$2 AND status IN ('failed','unknown')", [ctx.params.mid, c.id]);
    ctx.go(`/campaigns/${c.id}`, { ok: 'Queued again.' });
  });

  r.post('/campaigns/:id/duplicate', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    const n = await one(`INSERT INTO campaigns (user_id, shop_id, sender_id, channel, name, subject, body, template, media_ids, audience, selected_ids, skip_already_received, activation_key)
      SELECT user_id, shop_id, sender_id, channel, name || ' (copy)', subject, body, template, media_ids, audience, selected_ids, true, $3 FROM campaigns WHERE id=$1 AND user_id=$2 RETURNING id`, [c.id, ctx.user.id, randomToken(18)]);
    ctx.go(`/campaigns/${n.id}/edit`, { ok: 'Copied. People who already received the same message will be skipped.' });
  });

  r.post('/campaigns/:id/delete', async (ctx) => {
    const c = await owned('campaigns', ctx.params.id, ctx.user);
    if (c.status !== 'draft') return ctx.go(`/campaigns/${c.id}`, { err: 'Only drafts can be deleted.' });
    await q("DELETE FROM campaigns WHERE id=$1 AND user_id=$2 AND status='draft'", [c.id, ctx.user.id]);
    ctx.go('/campaigns', { ok: 'Draft deleted.' });
  });
}
