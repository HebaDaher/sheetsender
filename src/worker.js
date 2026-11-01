// Background sending. Runs every few seconds while the app is awake and on every /cron/tick call.
// Rules: one message per person per campaign, provider limits respected, slow-down/pause instructions obeyed,
// allowed hours respected, and a message that may already have gone out is never sent again automatically.
import { pool, q, one, rows } from './db.js';
import { decryptJson, sign } from './crypto.js';
import { config } from './config.js';
import * as email from './providers/email.js';
import * as wa from './providers/whatsapp.js';
import { buildEmail } from './mime.js';
import { emailHtml, emailText, fillPlaceholders } from './campaigns.js';

const SENT = "('sent','delivered','read','unknown')";

export function localHour(tz, d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
}
export function withinHours(user, d = new Date()) {
  if (user.send_start === 0 && user.send_end === 24) return true;
  const h = localHour(user.timezone, d);
  return user.send_start <= user.send_end ? h >= user.send_start && h < user.send_end : h >= user.send_start || h < user.send_end;
}

export function unsubscribeUrl(userId, channel, address, shopName) {
  return `${config.publicUrl}/u/${sign({ u: Number(userId), c: channel, a: address, s: shopName })}`;
}

async function holdSender(sender, seconds, reason, levelUp) {
  const level = levelUp ? sender.hold_level + 1 : sender.hold_level;
  await q('UPDATE senders SET hold_until=now() + make_interval(secs => $2), hold_reason=$3, hold_level=$4, updated_at=now() WHERE id=$1', [sender.id, Math.max(1, Math.round(seconds)), reason, level]);
}

function backoffSeconds(channel, level) {
  return channel === 'email' ? Math.min(15 * 60 * 2 ** level, 6 * 3600) : Math.min(4 ** (level + 1), 3600); // WhatsApp: Meta's 4^X guidance
}

async function pauseCampaign(id, reason) {
  await q("UPDATE campaigns SET status='paused', paused_reason=$2 WHERE id=$1 AND status='active'", [id, reason]);
}

async function release(ids) {
  if (ids.length) await q("UPDATE messages SET status='queued', attempts=GREATEST(attempts-1,0), updated_at=now() WHERE id = ANY($1::bigint[]) AND status='sending'", [ids]);
}

// How many more messages this sender may send now (provider daily limits).
async function capacity(sender, userId) {
  if (sender.channel === 'email') {
    if (!sender.daily_limit) return { left: Infinity };
    const r = await one(`SELECT count(*)::int AS n, min(sent_at) AS oldest FROM messages WHERE sender_id=$1 AND sent_at > now() - interval '24 hours' AND status IN ${SENT}`, [sender.id]);
    const left = sender.daily_limit - r.n;
    return { left, resumeAt: left <= 0 ? new Date(new Date(r.oldest).getTime() + 24 * 3600e3) : null, why: `Daily limit of ${sender.daily_limit} emails for this mailbox reached` };
  }
  // WhatsApp: unique people messaged in a moving 24 hours, shared by all numbers of the business portfolio.
  const limit = sender.info.limit === null || sender.info.limit === undefined ? 250 : sender.info.limit;
  if (limit === Infinity || sender.info.limit_raw === 'TIER_UNLIMITED') return { left: Infinity, recent: null };
  const recent = await rows(`SELECT address, min(sent_at) AS first FROM messages WHERE user_id=$1 AND channel='whatsapp' AND sent_at > now() - interval '24 hours' AND status IN ${SENT} GROUP BY address`, [userId]);
  const oldest = recent.reduce((m, r) => Math.min(m, new Date(r.first).getTime()), Date.now());
  return {
    left: limit - recent.length, recent: new Set(recent.map((r) => r.address)),
    resumeAt: new Date(oldest + 24 * 3600e3), why: `WhatsApp messaging limit of ${limit} people per 24 hours reached`,
  };
}

async function refreshWaLimit(sender, creds) {
  const checked = sender.info.limit_checked_at ? new Date(sender.info.limit_checked_at).getTime() : 0;
  if (Date.now() - checked < 6 * 3600e3) return;
  try {
    const r = await wa.graph(creds.token, 'GET', creds.phone_number_id, { query: { fields: 'whatsapp_business_manager_messaging_limit,quality_rating' } });
    sender.info.limit_raw = r.whatsapp_business_manager_messaging_limit || sender.info.limit_raw;
    sender.info.limit = wa.parseLimit(sender.info.limit_raw) ?? sender.info.limit;
    sender.info.quality = r.quality_rating || sender.info.quality;
  } catch {}
  sender.info.limit_checked_at = new Date().toISOString();
  await q('UPDATE senders SET info=$2 WHERE id=$1', [sender.id, { ...sender.info, limit: sender.info.limit === Infinity ? null : sender.info.limit }]);
}

async function loadMedia(ids, userId) {
  if (!ids?.length) return [];
  return rows('SELECT id, filename, mime, kind, data FROM media WHERE id = ANY($1::bigint[]) AND user_id=$2 ORDER BY id', [ids, userId]);
}

// Processes one campaign until the deadline, the limit, or a stop condition. Returns a status note.
export async function processCampaign(campaignId, { deadline, limit = Infinity, manual = false } = {}) {
  const c = await one('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
  if (!c || c.status !== 'active') return { note: 'Campaign is not active.' };
  const user = await one('SELECT * FROM users WHERE id=$1', [c.user_id]);
  const sender = c.sender_id ? await one('SELECT * FROM senders WHERE id=$1 AND user_id=$2', [c.sender_id, c.user_id]) : null;
  const shop = await one('SELECT name FROM shops WHERE id=$1', [c.shop_id]);
  if (!sender || sender.status !== 'verified' || sender.channel !== c.channel) {
    await pauseCampaign(c.id, 'The selected sender is missing or not verified. Reconnect it, then resume.');
    return { note: 'Sender not verified.' };
  }
  if (sender.hold_until && new Date(sender.hold_until) > new Date()) return { note: sender.hold_reason, waitUntil: sender.hold_until };
  if (!withinHours(user)) return { note: `Outside your allowed sending hours (${user.send_start}:00–${user.send_end}:00, ${user.timezone}). Sending continues automatically when they start.` };

  const creds = { ...decryptJson(sender.secrets), ...sender.info };
  if (c.channel === 'whatsapp') await refreshWaLimit(sender, creds);
  let cap = await capacity(sender, c.user_id);
  if (cap.left <= 0 && !(c.channel === 'whatsapp' && cap.recent)) {
    await holdSender(sender, (cap.resumeAt - Date.now()) / 1000, `${cap.why}. Resumes automatically at the time shown.`, false);
    return { note: cap.why };
  }

  const media = await loadMedia(c.media_ids, c.user_id);
  let session = null; let sentCount = 0; let note = null;

  try {
    if (c.channel === 'email') {
      try { session = await email.openSession(creds, sender.info); } catch (e) {
        const k = email.classifyEmailError(e);
        if (k.action === 'sender_broken') { await q("UPDATE senders SET status='error', last_error=$2 WHERE id=$1", [sender.id, k.text]); await q("UPDATE campaigns SET status='paused', paused_reason=$2 WHERE sender_id=$1 AND status='active'", [sender.id, k.text]); }
        else await holdSender(sender, backoffSeconds('email', sender.hold_level), `Could not connect to the email server: ${k.text}`, true);
        return { note: k.text };
      }
    } else if (c.template?.info?.headerFormat === 'IMAGE' || c.template?.info?.headerFormat === 'VIDEO') {
      const age = c.wa_media?.uploaded_at ? Date.now() - new Date(c.wa_media.uploaded_at).getTime() : Infinity;
      if (age > 25 * 24 * 3600e3) {
        if (!media[0]) { await pauseCampaign(c.id, 'This template needs an image or video, but none is attached. Edit is not possible after activation — duplicate the campaign with media.'); return { note: 'Missing media' }; }
        try {
          const id = await wa.uploadMedia(creds, media[0]);
          c.wa_media = { id, uploaded_at: new Date().toISOString() };
          await q('UPDATE campaigns SET wa_media=$2 WHERE id=$1', [c.id, c.wa_media]);
        } catch (e) {
          const k = wa.classifyWaError(e);
          if (k.action === 'hold_sender' || k.action === 'retry_message') { await holdSender(sender, k.seconds || backoffSeconds('whatsapp', sender.hold_level), `Uploading the image/video to WhatsApp failed temporarily: ${k.text}`, true); return { note: k.text }; }
          await pauseCampaign(c.id, `WhatsApp did not accept the image/video: ${k.text}`); return { note: k.text };
        }
      }
    }

    while (Date.now() < deadline && sentCount < limit) {
      const fresh = await one('SELECT status FROM campaigns WHERE id=$1', [c.id]);
      if (fresh.status !== 'active') { note = 'Campaign stopped.'; break; }
      const batchSize = Math.min(10, limit - sentCount);
      const batch = (await q(`UPDATE messages SET status='sending', attempts=attempts+1, updated_at=now()
        WHERE id IN (SELECT id FROM messages WHERE campaign_id=$1 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                     ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`, [c.id, batchSize])).rows.sort((a, b) => Number(a.id) - Number(b.id));
      if (!batch.length) break;

      let stop = false;
      for (let i = 0; i < batch.length; i++) {
        const m = batch[i];
        const rest = () => batch.slice(i + 1).map((x) => x.id);
        if (stop || Date.now() > deadline) { await release([m.id]); continue; }

        const opted = await one('SELECT 1 FROM suppressions WHERE user_id=$1 AND channel=$2 AND address=$3', [c.user_id, c.channel, m.address]);
        if (opted) { await q("UPDATE messages SET status='skipped', skip_reason='Opted out', updated_at=now() WHERE id=$1", [m.id]); continue; }

        // Daily limits (checked before every new person).
        if (c.channel === 'email' ? cap.left <= 0 : (cap.left <= 0 && !(cap.recent && cap.recent.has(m.address)))) {
          await release([m.id, ...rest()]);
          await holdSender(sender, Math.max(60, (cap.resumeAt - Date.now()) / 1000), `${cap.why}. Resumes automatically at the time shown.`, false);
          note = cap.why; stop = true; break;
        }

        try {
          let providerId;
          if (c.channel === 'email') {
            const unsub = unsubscribeUrl(c.user_id, 'email', m.address, shop.name);
            const body = fillPlaceholders(c.body, m.vars);
            const images = media.filter((x) => x.kind === 'image').map((x, n) => ({ ...x, cid: `img${n}@sheetsender` }));
            const built = buildEmail({
              fromName: sender.info.from_name, fromEmail: sender.info.email, replyTo: sender.info.reply_to, to: m.address, toName: m.recipient_name,
              subject: fillPlaceholders(c.subject, m.vars), text: emailText(body, { unsubscribeUrl: unsub, shopName: shop.name }),
              html: emailHtml(body, { images, unsubscribeUrl: unsub, shopName: shop.name }), inline: images, attachments: media.filter((x) => x.kind !== 'image'), unsubscribeUrl: unsub,
            });
            await session.send({ to: m.address, data: built.data });
            providerId = built.messageId;
          } else {
            const tpl = wa.buildTemplateMessage(c.template.info, m.vars, c.wa_media?.id);
            providerId = await wa.sendTemplate(creds, m.address, tpl);
          }
          await q("UPDATE messages SET status='sent', provider_id=$2, sent_at=now(), error=NULL, updated_at=now() WHERE id=$1", [m.id, providerId || null]);
          sentCount++;
          cap.left--; cap.recent?.add(m.address);
          if (sender.hold_level) { sender.hold_level = 0; await q('UPDATE senders SET hold_level=0, hold_reason=NULL WHERE id=$1', [sender.id]); }
        } catch (e) {
          const k = c.channel === 'email' ? email.classifyEmailError(e) : wa.classifyWaError(e);
          if (k.action === 'retry_message') {
            const wait = k.pairRate ? 4 ** Math.min(m.attempts, 6) : [60, 300, 900, 3600][Math.min(m.attempts - 1, 3)];
            if (m.attempts >= 5) await q("UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1", [m.id, `${k.text} (gave up after ${m.attempts} tries)`]);
            else await q("UPDATE messages SET status='queued', error=$2, next_attempt_at=now() + make_interval(secs => $3), updated_at=now() WHERE id=$1", [m.id, k.text, wait]);
            if (c.channel === 'email' && /connection|reach|closed|timed out/i.test(k.text)) { await release(rest()); stop = true; break; }
          } else if (k.action === 'fail_message') {
            await q("UPDATE messages SET status='failed', error=$2, updated_at=now() WHERE id=$1", [m.id, k.text]);
          } else if (k.action === 'opted_out') {
            await q("INSERT INTO suppressions (user_id, channel, address, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [c.user_id, c.channel, m.address, k.text]);
            await q("UPDATE messages SET status='skipped', skip_reason='Opted out', error=$2, updated_at=now() WHERE id=$1", [m.id, k.text]);
          } else {
            // Provider-level problem: put this message back untouched and stop.
            await q("UPDATE messages SET status='queued', attempts=GREATEST(attempts-1,0), updated_at=now() WHERE id=$1", [m.id]);
            await release(rest());
            if (k.action === 'hold_sender') {
              const secs = k.seconds || backoffSeconds(c.channel, sender.hold_level);
              await holdSender(sender, secs, `${k.text} Waiting as instructed, then continuing automatically.`, !k.seconds);
            } else if (k.action === 'pause_campaign') {
              if (k.seconds) await holdSender(sender, k.seconds, k.text, false);
              await pauseCampaign(c.id, k.text);
            } else if (k.action === 'sender_broken') {
              await q("UPDATE senders SET status='error', last_error=$2, updated_at=now() WHERE id=$1", [sender.id, k.text]);
              await q("UPDATE campaigns SET status='paused', paused_reason=$2 WHERE sender_id=$1 AND status='active'", [sender.id, k.text]);
            }
            note = k.text; stop = true; break;
          }
        }
      }
      if (stop) break;
    }
  } finally {
    if (session) await session.close();
  }
  await finishIfDone(c.id);
  return { sent: sentCount, note };
}

export async function finishIfDone(id) {
  await q(`UPDATE campaigns SET status='completed', finished_at=now() WHERE id=$1 AND status='active'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id=$1 AND status IN ('queued','sending'))`, [id]);
}

let running = false;
export async function tick({ budgetMs = 40000 } = {}) {
  if (running || !pool) return { skipped: true };
  running = true;
  const deadline = Date.now() + budgetMs;
  const out = [];
  try {
    await pool.withClient(async (lockConn) => {
      const got = (await lockConn.query('SELECT pg_try_advisory_lock(727001) AS ok')).rows[0].ok;
      if (!got) return;
      try {
        // A message stuck in "sending" (e.g. the server restarted mid-send) might have been delivered — never resend it automatically.
        await q(`UPDATE messages SET status='unknown', error='Sending was interrupted (server restart). It may or may not have arrived, so it was not sent again automatically.', updated_at=now()
                 WHERE status='sending' AND updated_at < now() - interval '10 minutes'`);
        const active = await rows("SELECT id FROM campaigns WHERE status='active' AND mode='auto' ORDER BY activated_at");
        for (const c of active) {
          if (Date.now() > deadline) break;
          try { out.push({ id: c.id, ...(await processCampaign(c.id, { deadline })) }); } catch (e) { console.error('campaign', c.id, e); }
        }
        const stale = await rows("SELECT id FROM campaigns WHERE status='active'");
        for (const c of stale) await finishIfDone(c.id);
      } finally {
        await lockConn.query('SELECT pg_advisory_unlock(727001)');
      }
    });
  } catch (e) {
    console.error('tick failed:', e.message);
  } finally { running = false; }
  return { campaigns: out };
}

let timer = null;
export function startLoop() {
  if (timer || config.disableBackgroundLoop) return;
  const loop = async () => { await tick(); timer = setTimeout(loop, 10000); timer.unref?.(); };
  timer = setTimeout(loop, 3000);
}
