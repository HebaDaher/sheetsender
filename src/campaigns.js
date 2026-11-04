// Who receives a campaign, what each person gets, and safe activation (no duplicates).
import { q, rows as dbRows, tx } from './db.js';
import { sha256 } from './crypto.js';
import { firstName } from './contacts.js';
import { esc } from './html.js';

// The key a template variable is saved under, e.g. "body:1" or "button:0:1".
export const varKey = (v) => (v.component === 'button' ? `button:${v.index}:${v.name}` : `${v.component}:${v.name}`);

// Counts per campaign, used by the home page and the campaign list (needs the campaign aliased as c).
export const COUNT_COLUMNS = `(SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('queued','sending'))::int AS queued,
  (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status IN ('sent','delivered','read'))::int AS sent,
  (SELECT count(*) FROM messages m WHERE m.campaign_id=c.id AND m.status='failed')::int AS failed`;

// Adds someone to the opt-out list and drops any message still waiting for them on that channel.
export async function addOptOut(userId, channel, address, reason) {
  await q('INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, channel, address, reason]);
  await q("UPDATE messages SET status='skipped', skip_reason='Opted out', updated_at=now() WHERE user_id=$1 AND channel=$2 AND address=$3 AND status='queued'", [userId, channel, address]);
}

export const SOURCES = [['name', 'Customer name'], ['first_name', 'First name'], ['shop', 'Shop name'], ['fixed', 'Fixed text (type below)']];

export function contentHash(c) {
  return sha256(JSON.stringify([c.channel, c.subject, c.body, c.template?.info?.name, c.template?.info?.language, c.template?.mapping, c.media_ids]));
}

// Placeholders for email: {{name}} {{first_name}} {{shop}} and any column title, e.g. {{Branch}}.
export function emailVars(contact, shopName) {
  const vars = { ...(contact.extra || {}) };
  vars.name = contact.name || ''; vars.first_name = firstName(contact.name); vars.shop = shopName;
  return vars;
}

export function fillPlaceholders(text, vars) {
  const lower = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => lower[k.toLowerCase()] ?? '');
}

export function waValues(campaign, contact, shopName) {
  const out = {};
  const info = campaign.template?.info; if (!info) return out;
  for (const v of info.vars) {
    const key = varKey(v);
    const m = campaign.template.mapping?.[key] || { source: 'fixed', value: '' };
    let val;
    if (m.source === 'name') val = contact.name;
    else if (m.source === 'first_name') val = firstName(contact.name);
    else if (m.source === 'shop') val = shopName;
    else if (m.source?.startsWith('column:')) val = contact.extra?.[m.source.slice(7)];
    else val = m.value;
    if (!String(val ?? '').trim()) val = m.fallback || (m.source === 'fixed' ? m.value : '') || (String(info.language).startsWith('ar') ? 'عميلنا العزيز' : 'there');
    out[key] = String(val).trim();
  }
  return out;
}

export function renderWaPreview(info, values) {
  const pick = (comp) => Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(comp + ':')).map(([k, v]) => [k.split(':').pop(), v]));
  return {
    header: info.headerFormat === 'TEXT' ? info.headerText.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => pick('header')[n] ?? '') : null,
    body: info.bodyText.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n) => pick('body')[n] ?? ''),
    footer: info.footerText, buttons: info.buttons,
  };
}

export function emailHtml(bodyText, { images = [], unsubscribeUrl, shopName }) {
  const linked = esc(bodyText).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
  const imgs = images.map((i) => `<p><img src="cid:${i.cid}" alt="" style="max-width:100%;height:auto;border-radius:6px"></p>`).join('');
  const foot = unsubscribeUrl ? `<p style="color:#777;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:12px">You are receiving this because you agreed to hear from ${esc(shopName)}. <a href="${esc(unsubscribeUrl)}">Unsubscribe</a></p>` : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222"><div dir="auto" style="max-width:600px">${linked}${imgs}${foot}</div></body></html>`;
}

export function emailText(bodyText, { unsubscribeUrl, shopName }) {
  return `${bodyText}\n\n--\nYou are receiving this because you agreed to hear from ${shopName}.\nUnsubscribe: ${unsubscribeUrl}\n`;
}

// Computes, for every contact in the shop's current file, whether they will be sent the campaign and why not.
export async function computeRecipients(campaign, { userId, db = null }) {
  const rows = async (t, p) => (db ? (await db.query(t, p)).rows : dbRows(t, p));
  const one = async (t, p) => (await rows(t, p))[0] || null;
  const shop = await one('SELECT * FROM shops WHERE id=$1 AND user_id=$2', [campaign.shop_id, userId]);
  if (!shop?.current_upload_id) return { shop, list: [] };
  const contacts = await rows('SELECT * FROM contacts WHERE upload_id=$1 AND user_id=$2 ORDER BY row_number', [shop.current_upload_id, userId]);
  const channel = campaign.channel;
  const supp = new Set((await rows('SELECT address FROM suppressions WHERE user_id=$1 AND channel=$2', [userId, channel])).map((r) => r.address));
  const hash = contentHash(campaign);
  const already = campaign.skip_already_received
    ? new Set((await rows(`SELECT DISTINCT address FROM messages WHERE user_id=$1 AND channel=$2 AND content_hash=$3 AND status IN ('queued','sending','sent','delivered','read','unknown') AND campaign_id<>$4`, [userId, channel, hash, campaign.id])).map((r) => r.address))
    : new Set();
  const selected = campaign.audience === 'selected' ? new Set((campaign.selected_ids || []).map(Number)) : null;
  const seen = new Set();
  const list = [];
  for (const c of contacts) {
    if (selected && !selected.has(Number(c.id))) continue;
    const isEmail = channel === 'email';
    const address = isEmail ? c.email : c.phone;
    const rawAddr = isEmail ? c.email_raw : c.phone_raw;
    let reason = null;
    if (!rawAddr) reason = isEmail ? 'No email address' : 'No phone / WhatsApp number';
    else if (!address) reason = isEmail ? 'Invalid email address' : 'Invalid phone number';
    else if (!(isEmail ? c.consent_email : c.consent_whatsapp)) reason = 'No consent';
    else if (supp.has(address)) reason = 'Opted out';
    else if (seen.has(address)) reason = 'Duplicate in file';
    else if (already.has(address)) reason = 'Already received this message';
    if (address && !reason) seen.add(address);
    list.push({ contact: c, address: address || '', rawAddr, reason });
  }
  return { shop, list, hash };
}

export function summarize(list) {
  const s = { total: list.length, eligible: 0, reasons: {} };
  for (const r of list) { if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1; else s.eligible++; }
  return s;
}

// Turns a draft into an active campaign exactly once (protected by the row lock + status check).
export async function activateCampaign(userId, campaignId, mode) {
  return tx(async (db) => {
    const c = (await db.query('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE', [campaignId, userId])).rows[0];
    if (!c) throw new Error('Campaign not found');
    if (c.status !== 'draft') return { already: true, campaign: c };
    const { shop, list, hash } = await computeRecipients(c, { userId, db });
    const eligible = list.filter((r) => !r.reason);
    if (!eligible.length) throw new Error('Nobody in this file can receive this campaign. Check the reasons in the preview.');
    const recs = list.map((r) => ({
      contact_id: r.contact.id, row_number: r.contact.row_number, recipient_name: r.contact.name || '', address: r.address || r.rawAddr || '',
      dedupe_key: r.reason ? `row:${r.contact.row_number}` : r.address, status: r.reason ? 'skipped' : 'queued', skip_reason: r.reason,
      vars: r.reason ? {} : (c.channel === 'email' ? emailVars(r.contact, shop.name) : waValues(c, r.contact, shop.name)),
    }));
    for (let i = 0; i < recs.length; i += 500) {
      const chunk = recs.slice(i, i + 500);
      await db.query(`INSERT INTO messages (campaign_id, user_id, sender_id, channel, contact_id, row_number, recipient_name, address, dedupe_key, status, skip_reason, vars, content_hash)
        SELECT $1, $2, $3, $4, x.contact_id, x.row_number, x.recipient_name, x.address, x.dedupe_key, x.status, x.skip_reason, x.vars, $5
        FROM jsonb_to_recordset($6::jsonb) AS x(contact_id bigint, row_number int, recipient_name text, address text, dedupe_key text, status text, skip_reason text, vars jsonb)
        ON CONFLICT (campaign_id, dedupe_key) DO NOTHING`, [c.id, userId, c.sender_id, c.channel, hash, JSON.stringify(chunk)]);
    }
    const upd = await db.query(`UPDATE campaigns SET status='active', mode=$3, content_hash=$4, activated_at=now(), paused_reason=NULL WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING *`, [c.id, userId, mode, hash]);
    return { already: false, campaign: upd.rows[0], queued: eligible.length };
  });
}

export async function campaignCounts(campaignId) {
  const r = await dbRows('SELECT status, count(*)::int AS n FROM messages WHERE campaign_id=$1 GROUP BY status', [campaignId]);
  const c = { queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, unknown: 0 };
  for (const x of r) c[x.status] = x.n;
  c.sentTotal = c.sent + c.delivered + c.read;
  return c;
}
