/**
 * The sending engine.
 *
 * A time-based trigger (installed by setup, owned by the OWNER) calls processQueue() every minute.
 * It does NOT sleep. Each run it sends at most ONE email per running campaign whose next_send_at is due,
 * then sets next_send_at = now + delay_minutes (+ a small random extra, so the timing does not look robotic).
 * When nothing is due it exits in milliseconds.
 *
 * Safe-sending rules (Settings > Safe sending), to protect each Gmail account's reputation:
 *  - at most N emails per Gmail account per day (default 40), counted across all shops and sends;
 *  - only between set hours, UAE time (default 9:00–21:00);
 *  - never faster than the chosen delay; each wait is 0–40% longer at random.
 */

function processQueue() {
  const props = PropertiesService.getScriptProperties();
  const owner = String(props.getProperty(PROP.OWNER_EMAIL) || '').toLowerCase();
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!owner || me !== owner) return; // only the owner's trigger may send
  props.setProperty(PROP.LAST_ENGINE_RUN, nowIso_());

  const nextDue = Number(props.getProperty(PROP.NEXT_DUE_AT) || 0);
  if (!nextDue || Date.now() < nextDue) return; // nothing to do yet

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // someone is importing/starting; try next minute
  try {
    const ss = SpreadsheetApp.openById(props.getProperty(PROP.SHEET_ID));
    runDueCampaigns_(ss, Date.now());
  } finally {
    lock.releaseLock();
  }
}

function runDueCampaigns_(ss, nowMs) {
  const campaigns = readTable_(ss, TABS.CAMPAIGNS);
  const due = campaigns.rows.filter(function (c) {
    return c.status === 'running' && (!c.next_send_at || new Date(c.next_send_at).getTime() <= nowMs);
  });
  if (due.length) {
    const ctx = {
      ss: ss,
      shops: indexBy_(readTable_(ss, TABS.SHOPS).rows, 'shop_id'),
      templates: indexBy_(readTable_(ss, TABS.TEMPLATES).rows, 'template_id'),
      contacts: indexBy_(readTable_(ss, TABS.CONTACTS).rows, 'contact_id'),
      log: readTable_(ss, TABS.LOG)
    };
    due.forEach(function (c) {
      try {
        stepCampaign_(ctx, c, nowMs);
      } catch (e) {
        c.status = 'paused';
        c.status_reason = 'Paused because of an unexpected error: ' + (e && e.message ? e.message : e);
      }
      recount_(c, ctx.log.rows);
      updateRow_(campaigns, c);
    });
  }
  recomputeNextDue_(campaigns.rows);
}

/** Sends the next email of one campaign (skipping anyone no longer eligible). */
function stepCampaign_(ctx, campaign, nowMs) {
  const shop = ctx.shops[campaign.shop_id];
  const template = ctx.templates[campaign.template_id];
  if (!shop) return pause_(campaign, 'The shop was removed from the Shops tab.');
  if (!template) return pause_(campaign, 'The template was removed from the Templates tab.');
  if (norm_(shop.sender_email) !== norm_(campaign.sender_email)) {
    return pause_(campaign, 'The shop\'s sender email was changed after this campaign started. Stop it and start a new campaign.');
  }
  const sender = senderCheck_(shop);
  if (!sender.ok) return pause_(campaign, sender.reason);

  const delayMs = cleanDelay_(campaign.delay_minutes) * 60000;
  const log = ctx.log;
  const pending = log.rows.filter(function (l) { return l.campaign_id === campaign.campaign_id && l.status === 'pending'; });

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const contact = ctx.contacts[item.contact_id];
    if (!contact) { finish_(log, item, 'skipped', 'Contact was deleted from the Contacts tab'); continue; }

    const check = eligibility_(contact, 'email');
    if (!check.ok) { finish_(log, item, 'skipped', check.reason); continue; }
    const email = norm_(contact.email);

    // Duplicate protection, checked again right before sending.
    const dup = log.rows.filter(function (l) {
      return l !== item && l.status === 'sent' && l.channel === 'email' && l.shop_id === campaign.shop_id &&
        norm_(l.email) === email &&
        (l.campaign_id === campaign.campaign_id ||
          (campaign.skip_previous_recipients === 'yes' && l.template_id === campaign.template_id));
    })[0];
    if (dup) {
      finish_(log, item, 'skipped', dup.campaign_id === campaign.campaign_id
        ? 'Already received this campaign'
        : 'Already received this message on ' + String(dup.sent_at).slice(0, 10));
      continue;
    }

    // Safe-sending rules, checked right before each email.
    const rules = sendingRules_();
    const senderAddr = norm_(shop.sender_email);
    if (!withinSendingHours_(nowMs, rules)) {
      campaign.next_send_at = new Date(nextWindowStart_(nowMs, rules)).toISOString();
      campaign.status_reason = 'Waiting for sending hours (' + hourLabel_(rules.startHour) + '–' + hourLabel_(rules.endHour) +
        ' UAE time). Continues automatically.';
      return;
    }
    const sentToday = sentTodayBy_(log.rows, senderAddr, nowMs);
    if (sentToday >= rules.dailyCap) {
      campaign.next_send_at = new Date(nextDayStart_(nowMs, rules)).toISOString();
      campaign.status_reason = 'Safety limit reached: ' + senderAddr + ' already sent ' + sentToday + ' emails today (limit ' +
        rules.dailyCap + '). Continues automatically tomorrow at ' + hourLabel_(rules.startHour) + '.';
      return;
    }

    const fields = templateFields_(contact, shop);
    const subject = renderText_(template.subject, fields);
    const body = renderText_(template.body, fields);
    item.attempts = String(Number(item.attempts || 0) + 1);
    try {
      sendGmail_({
        from: norm_(shop.sender_email), fromName: shop.sender_name || shop.shop_name, to: contact.email,
        replyTo: shop.reply_to, subject: subject, text: body, html: textToHtml_(body)
      });
      item.contact_name = contact.full_name || contact.first_name;
      item.email = email;
      finish_(log, item, 'sent', 'Sent from ' + norm_(shop.sender_email));
      campaign.next_send_at = new Date(nowMs + Math.round(delayMs * (1 + (campaign.random_extra === 'no' ? 0 : Math.random() * 0.4)))).toISOString();
      campaign.status_reason = '';
    } catch (e) {
      const kind = e.kind || 'FAIL';
      if (kind === 'AUTH') {
        item.attempts = String(Number(item.attempts) - 1); // not this contact's fault
        updateRow_(log, item);
        const check = senderCheck_(shop);
        return pause_(campaign, check.ok ? e.message + ' Owner: open Settings > Gmail accounts and click Reconnect.' : check.reason);
      } else if (kind === 'QUOTA') {
        item.attempts = String(Number(item.attempts) - 1);
        updateRow_(log, item);
        campaign.next_send_at = new Date(nowMs + 60 * 60000).toISOString();
        campaign.status_reason = 'Gmail daily sending limit reached for ' + norm_(shop.sender_email) +
          '. Sending continues automatically (checks again every hour).';
      } else if (kind === 'BAD_RECIPIENT' || Number(item.attempts) >= MAX_SEND_ATTEMPTS) {
        finish_(log, item, 'failed', e.message);
        campaign.next_send_at = new Date(nowMs + delayMs).toISOString();
      } else {
        item.reason = 'Attempt ' + item.attempts + ' failed (' + e.message + '). Will retry.';
        updateRow_(log, item);
        campaign.next_send_at = new Date(nowMs + delayMs).toISOString();
      }
    }
    return; // one email per run per campaign
  }

  // Nothing pending left.
  campaign.status = 'completed';
  campaign.status_reason = '';
  campaign.finished_at = new Date(nowMs).toISOString();
  campaign.next_send_at = '';
}

function finish_(log, item, status, reason) {
  item.status = status;
  item.reason = reason;
  item.done_by = 'app';
  if (status === 'sent') item.sent_at = nowIso_();
  updateRow_(log, item);
}

function pause_(campaign, reason) {
  campaign.status = 'paused';
  campaign.status_reason = reason;
}

function indexBy_(rows, key) {
  const out = {};
  rows.forEach(function (r) { out[r[key]] = r; });
  return out;
}

function setNextDue_(ms) {
  const props = PropertiesService.getScriptProperties();
  const current = Number(props.getProperty(PROP.NEXT_DUE_AT) || 0);
  if (!current || ms < current) props.setProperty(PROP.NEXT_DUE_AT, String(ms));
}

/** NEXT_DUE_AT = earliest next_send_at of running campaigns (lets the trigger exit instantly when idle). */
function recomputeNextDue_(campaignRows) {
  let min = 0;
  campaignRows.forEach(function (c) {
    if (c.status !== 'running') return;
    const t = c.next_send_at ? new Date(c.next_send_at).getTime() : Date.now();
    if (!min || t < min) min = t;
  });
  const props = PropertiesService.getScriptProperties();
  if (min) props.setProperty(PROP.NEXT_DUE_AT, String(min));
  else props.deleteProperty(PROP.NEXT_DUE_AT);
}

/* ------------------------------------------------------------------ */
/* Safe-sending rules                                                   */
/* ------------------------------------------------------------------ */

const UAE_OFFSET_MS = 4 * 3600 * 1000; // UAE time is UTC+4 all year (no daylight saving)

function sendingRules_() {
  let r = {};
  try { r = JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP.SEND_RULES) || '{}'); } catch (e) { r = {}; }
  const cap = Number(r.dailyCap), start = Number(r.startHour), end = Number(r.endHour);
  return {
    dailyCap: cap >= 5 && cap <= 400 ? Math.round(cap) : DEFAULT_DAILY_CAP,
    startHour: start >= 0 && start <= 23 ? Math.round(start) : DEFAULT_START_HOUR,
    endHour: end >= 1 && end <= 24 && end > (start >= 0 ? start : DEFAULT_START_HOUR) ? Math.round(end) : DEFAULT_END_HOUR
  };
}

function uaeHour_(ms) { return new Date(ms + UAE_OFFSET_MS).getUTCHours(); }
function uaeDay_(ms) { return new Date(ms + UAE_OFFSET_MS).toISOString().slice(0, 10); }
function hourLabel_(h) { return (h === 24 ? '24' : String(h)) + ':00'; }

function withinSendingHours_(ms, rules) {
  const h = uaeHour_(ms);
  return h >= rules.startHour && h < rules.endHour;
}

/** Start of the next sending window (today if before it, otherwise tomorrow). */
function nextWindowStart_(ms, rules) {
  const local = new Date(ms + UAE_OFFSET_MS);
  const startToday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), rules.startHour) - UAE_OFFSET_MS;
  return ms < startToday ? startToday : startToday + 24 * 3600 * 1000;
}

function nextDayStart_(ms, rules) {
  const local = new Date(ms + UAE_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, rules.startHour) - UAE_OFFSET_MS;
}

/** Emails this Gmail account sent today (UAE date), across all shops and sends. Test emails are not counted. */
function sentTodayBy_(logRows, senderAddr, ms) {
  const today = uaeDay_(ms);
  let n = 0;
  logRows.forEach(function (l) {
    if (l.status === 'sent' && l.channel === 'email' && norm_(l.sender_email) === senderAddr && l.sent_at &&
      uaeDay_(new Date(l.sent_at).getTime()) === today) n++;
  });
  return n;
}
