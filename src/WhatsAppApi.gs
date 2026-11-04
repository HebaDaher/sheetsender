/**
 * WhatsApp Business API (Meta "WhatsApp Cloud API") — the paid option that sends even when every laptop is off.
 *
 *  - Each workspace owner connects their OWN Meta WhatsApp Business account in ⚙ Settings: Phone number ID,
 *    WhatsApp Business Account ID and a permanent access token (from a Meta "system user"). Meta bills them
 *    directly, per message; this app takes no money and adds no cost.
 *  - The access token is kept in the owner's private store (UserProperties), like Gmail tokens: never shown to a
 *    page, never written to a Sheet. Only the owner's own trigger and session can read it.
 *  - Meta allows business-started messages only with APPROVED message templates. The app lists the approved
 *    templates; for each {{1}} / {{name}} in a template the person chooses what goes in (first name, shop name, …).
 *  - A send is an ordinary "campaign" (channel whatsapp_api) handled by the same every-minute engine as email:
 *    one message per run, the chosen minutes apart, a daily limit, sending hours, start time, pause / resume / stop.
 *  - "Sent" means WhatsApp accepted the message. Whether it was delivered and read shows in Meta's WhatsApp Manager.
 */

const WA_API = {
  BASE: 'https://graph.facebook.com/v25.0/',  // Graph API v25.0 (Meta supports each version for about two years)
  TOKEN_KEY: 'WA_API_TOKEN_'
};
const WA_API_LIMITS = { minDelay: 1, maxCap: 1000 };

function waApiCfg_() { return wsJson_('WA_API', null); }
function waTokenKey_() { return WA_API.TOKEN_KEY + WS.id; }

function graph_(method, path, token, payload) {
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  try {
    const res = UrlFetchApp.fetch(WA_API.BASE + path, opts);
    return { code: res.getResponseCode(), body: parseJson_(res.getContentText()) };
  } catch (e) {
    return { code: 0, body: { error: { message: 'Could not reach Meta (' + (e && e.message ? e.message : e) + ')' } } };
  }
}

function graphError_(r) {
  const e = (r.body && r.body.error) || {};
  const details = (e.error_data && e.error_data.details) || '';
  return { code: Number(e.code) || 0, http: r.code, message: String(e.error_user_msg || e.message || ('HTTP ' + r.code)) + (details ? ' — ' + details : '') };
}

function placeholdersIn_(text) {
  const out = [];
  String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (m, k) { if (out.indexOf(k) === -1) out.push(k); return m; });
  return out;
}

/** Turns one template from Meta into what the app needs (and says why it cannot be used, if so). */
function parseWaTemplate_(t) {
  const comps = t.components || [];
  const body = comps.filter(function (c) { return c.type === 'BODY'; })[0] || {};
  const header = comps.filter(function (c) { return c.type === 'HEADER'; })[0];
  const buttons = (comps.filter(function (c) { return c.type === 'BUTTONS'; })[0] || {}).buttons || [];
  const named = String(t.parameter_format || '').toUpperCase() === 'NAMED';
  let why = '', headerText = '', headerParams = [], headerMedia = '';
  if (header) {
    const format = String(header.format || '').toUpperCase();
    if (format === 'TEXT') { headerText = header.text || ''; headerParams = placeholdersIn_(headerText); }
    else if (format === 'IMAGE') headerMedia = 'image';    // the photo is chosen in the app when sending
    else if (format === 'VIDEO') headerMedia = 'video';
    else why = 'It has a document or location at the top, which this app cannot fill in (photos and videos are fine).';
  }
  buttons.forEach(function (b) {
    const type = String(b.type || '').toUpperCase();
    if ((type === 'URL' && /\{\{/.test(b.url || '')) || ['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM', 'SPM'].indexOf(type) !== -1) {
      why = why || 'It has a button that needs extra information, which this app cannot fill in.';
    }
  });
  if (String(t.category || '').toUpperCase() === 'AUTHENTICATION') why = why || 'Login-code templates are not for follow-ups.';
  const sortParams = function (list) {
    return named ? list : list.slice().sort(function (a, b) { return Number(a) - Number(b); });
  };
  return {
    name: String(t.name || ''), language: String(t.language || ''), category: String(t.category || ''),
    status: String(t.status || ''), body: String(body.text || '').slice(0, 1024), header: String(headerText).slice(0, 60),
    params: sortParams(placeholdersIn_(body.text)), header_params: sortParams(headerParams), named: named,
    header_media: headerMedia, ok: !why, why: why
  };
}

function fetchWaTemplates_(wabaId, token) {
  const out = [];
  let path = wabaId + '/message_templates?fields=name,language,status,category,components,parameter_format&limit=100';
  for (let page = 0; page < 5 && path; page++) {
    const r = graph_('get', path, token);
    if (r.code !== 200) {
      const e = graphError_(r);
      throw new Error('Meta did not give the list of message templates: ' + e.message +
        (e.code === 100 ? ' (check the WhatsApp Business Account ID)' : '') + '.');
    }
    (r.body.data || []).forEach(function (t) { out.push(parseWaTemplate_(t)); });
    const next = r.body.paging && r.body.paging.next;
    path = next ? String(next).replace(/^https:\/\/graph\.facebook\.com\/v[0-9.]+\//, '') : '';
  }
  return out;
}

/** The template list lives in the workspace's Sheet (tab "WhatsApp API templates"), so every member can see it. */
function saveWaTemplates_(ss, list) {
  const sheet = ss.getSheetByName(TABS.WA_TEMPLATES) || ensureTab_(ss, TABS.WA_TEMPLATES);
  const table = readTable_(ss, TABS.WA_TEMPLATES);
  const last = sheet.getLastRow();
  if (last > 1) {
    const blank = [];
    for (let i = 0; i < last - 1; i++) blank.push(table.headers.map(function () { return ''; }));
    sheet.getRange(2, 1, last - 1, table.headers.length).setValues(blank);
  }
  table.rows = [];
  const now = nowIso_();
  appendRows_(table, list.map(function (t) {
    return { name: t.name, language: t.language, category: t.category, status: t.status, updated_at: now,
      details: JSON.stringify({ body: t.body, header: t.header, params: t.params, header_params: t.header_params, named: t.named, ok: t.ok, why: t.why, header_media: t.header_media || '' }) };
  }));
}

function waTemplates_(ss) {
  if (!ss.getSheetByName(TABS.WA_TEMPLATES)) return [];
  return readTable_(ss, TABS.WA_TEMPLATES).rows.filter(function (r) { return r.name; }).map(function (r) {
    const d = parseJson_(r.details);
    return { name: r.name, language: r.language, category: r.category, status: r.status, body: d.body || '', header: d.header || '',
      params: d.params || [], header_params: d.header_params || [], named: !!d.named, ok: !!d.ok, why: d.why || '',
      header_media: d.header_media || '' };
  });
}

/** What pages may see. Never the token. */
function waApiPublic_(forOwner) {
  const cfg = waApiCfg_();
  if (!cfg) return { configured: false, owner: WS ? WS.owner : '' };
  const out = {
    configured: true, owner: WS.owner, status: cfg.status, last_error: cfg.last_error || '',
    display_phone: cfg.display_phone || '', verified_name: cfg.verified_name || '', quality: cfg.quality || '',
    templates_at: cfg.templates_at || '', connected_at: cfg.connected_at || ''
  };
  if (forOwner) { out.phone_number_id = cfg.phone_number_id; out.waba_id = cfg.waba_id; out.tokenSaved = !!cfg.token_saved; }
  return out;
}

function markWaApi_(status, error) {
  const cfg = waApiCfg_();
  if (!cfg) return;
  cfg.status = status;
  cfg.last_error = error || '';
  cfg.updated_at = nowIso_();
  wsSet_('WA_API', JSON.stringify(cfg));
}

/* ---------------- Settings (workspace owner) ---------------- */

/** Saves and checks the connection with Meta, then loads the approved templates. */
function saveWhatsAppApi(p) {
  const ctx = requireOwner_();
  p = p || {};
  const pnid = String(p.phoneNumberId || '').replace(/\s/g, '');
  const waba = String(p.wabaId || '').replace(/\s/g, '');
  if (!/^\d{5,25}$/.test(pnid)) throw new Error('The Phone number ID is a long number (digits only). Copy it from Meta: WhatsApp > API Setup.');
  if (!/^\d{5,25}$/.test(waba)) throw new Error('The WhatsApp Business Account ID is a long number (digits only). Copy it from Meta: WhatsApp > API Setup.');
  const store = ownerSecrets_();
  let token = String(p.token || '').trim();
  if (!token) token = store.getProperty(waTokenKey_()) || '';
  if (!token) throw new Error('Paste the access token too.');
  if (!/^[A-Za-z0-9_\-.|]{20,1000}$/.test(token)) throw new Error('That does not look like a Meta access token. Copy the whole token again.');

  const r = graph_('get', pnid + '?fields=display_phone_number,verified_name,quality_rating', token);
  if (r.code !== 200) {
    const e = graphError_(r);
    throw new Error('Meta did not accept these details: ' + e.message +
      (e.code === 190 ? ' (the access token is wrong or expired — make a permanent one, see the steps)' : '') +
      (e.code === 100 ? ' (check the Phone number ID)' : '') + '.');
  }
  const templates = fetchWaTemplates_(waba, token);
  store.setProperty(waTokenKey_(), token);
  const cfg = {
    phone_number_id: pnid, waba_id: waba, display_phone: String(r.body.display_phone_number || ''),
    verified_name: String(r.body.verified_name || ''), quality: String(r.body.quality_rating || ''),
    status: 'connected', last_error: '', connected_at: nowIso_(), connected_by: ctx.email, templates_at: nowIso_(), token_saved: true
  };
  withLock_(function () {
    wsSet_('WA_API', JSON.stringify(cfg));
    saveWaTemplates_(ctx.ss, templates);
  });
  ensureTrigger_();
  return waApiPublic_(true);
}

/** Reloads the templates from Meta (after a new one is approved). */
function refreshWhatsAppTemplates() {
  const ctx = requireOwner_();
  const cfg = waApiCfg_();
  if (!cfg) throw new Error('Connect the WhatsApp Business API first.');
  const token = ownerSecrets_().getProperty(waTokenKey_()) || '';
  if (!token) throw new Error('The access token is missing. Paste it again and click Save and test.');
  const templates = fetchWaTemplates_(cfg.waba_id, token);
  withLock_(function () {
    saveWaTemplates_(ctx.ss, templates);
    const c = waApiCfg_(); c.templates_at = nowIso_(); wsSet_('WA_API', JSON.stringify(c));
  });
  return { api: waApiPublic_(true), templates: waTemplates_(ctx.ss) };
}

/** Forgets the token and pauses running WhatsApp API sends. */
function disconnectWhatsAppApi() {
  const ctx = requireOwner_();
  ownerSecrets_().deleteProperty(waTokenKey_());
  return withLock_(function () {
    const cfg = waApiCfg_();
    if (cfg) { cfg.status = 'disconnected'; cfg.token_saved = false; cfg.last_error = 'Disconnected by ' + ctx.email; wsSet_('WA_API', JSON.stringify(cfg)); }
    const table = readTable_(ctx.ss, TABS.CAMPAIGNS);
    let paused = 0;
    table.rows.forEach(function (c) {
      if (c.status === 'running' && c.channel === 'whatsapp_api') {
        c.status = 'paused'; c.status_reason = 'WhatsApp Business API was disconnected. Reconnect it in Settings, then press Resume.';
        updateRow_(table, c); paused++;
      }
    });
    recomputeNextDue_(table.rows);
    return { ok: true, paused: paused };
  });
}

/* ---------------- Sending page (anyone in the workspace) ---------------- */

function getWhatsAppApiTemplates() {
  const ctx = requireUser_();
  return { api: waApiPublic_(false), templates: waTemplates_(ctx.ss) };
}

function cleanParamMap_(keys, map, where) {
  map = map || {};
  const out = {};
  keys.forEach(function (k) {
    const v = map[k];
    if (v === undefined || v === null || v === '') throw new Error('Choose what goes into {{' + k + '}} in the ' + where + '.');
    const s = String(v);
    if (s.indexOf('text:') === 0) {
      const t = s.slice(5).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      if (!t) throw new Error('Write the text for {{' + k + '}} in the ' + where + '.');
      if (t.length > 200) throw new Error('The text for {{' + k + '}} is too long (max 200 characters).');
      out[k] = 'text:' + t;
    } else if (PLACEHOLDERS.indexOf(s) !== -1) {
      out[k] = s;
    } else {
      throw new Error('Unknown choice for {{' + k + '}}.');
    }
  });
  return out;
}

/** WhatsApp refuses empty values and line breaks inside template values. */
function paramValue_(spec, fields) {
  const v = spec.indexOf('text:') === 0 ? spec.slice(5) : String(fields[spec] || '');
  return v.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 500) || '-';
}

function renderWaText_(text, mapping, fields) {
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (m, k) {
    return mapping[k] ? paramValue_(mapping[k], fields) : m;
  });
}

function waApiPlan_(ss, p) {
  const cfg = waApiCfg_();
  if (!cfg || cfg.status !== 'connected') {
    throw new Error(cfg
      ? 'The WhatsApp Business API connection needs attention (' + (cfg.last_error || cfg.status) + '). ' + WS.owner + ' must open ⚙ Settings > WhatsApp Business API.'
      : 'The WhatsApp Business API is not set up. ' + WS.owner + ' (the workspace owner) can connect it in ⚙ Settings > WhatsApp Business API.');
  }
  const shop = findShop_(ss, p.shopId);
  if (!isActive_(shop.active)) throw new Error('This shop is hidden. Show it again in Settings > Shops.');
  const tpl = waTemplates_(ss).filter(function (t) { return t.name === p.template && t.language === p.language && t.status === 'APPROVED'; })[0];
  if (!tpl) throw new Error('Choose an approved message template.');
  if (!tpl.ok) throw new Error('This template cannot be used here: ' + tpl.why);
  const mapping = cleanParamMap_(tpl.params, p.mapping, 'message');
  const headerMapping = cleanParamMap_(tpl.header_params, p.headerMapping, 'title');
  let media = null;
  if (tpl.header_media) {
    media = mediaFor_(ss, shop.shop_id, p.mediaId);
    if (!media) throw new Error('This template starts with a ' + (tpl.header_media === 'video' ? 'video' : 'photo') + '. Choose the ' + (tpl.header_media === 'video' ? 'video' : 'photo') + ' to send.');
    if (media.kind !== tpl.header_media) throw new Error('This template needs a ' + (tpl.header_media === 'video' ? 'video' : 'photo') + ', not a ' + (media.kind === 'video' ? 'video' : 'photo') + '.');
  }
  // The same template with another photo or video counts as a different message (for "skip people who already got it").
  const templateId = 'META:' + tpl.name + ':' + tpl.language + (media ? ':' + media.media_id : '');
  const previous = {};
  if (p.skipPrevious !== false) {
    readTable_(ss, TABS.LOG).rows.forEach(function (l) {
      if (l.shop_id === shop.shop_id && l.channel === 'whatsapp' && l.status === 'sent' && l.template_id === templateId) previous[l.phone] = l.sent_at;
    });
  }
  const seen = {}, reasons = {};
  const audience = cleanListChoice_(ss, shop.shop_id, p.listIds);
  const chosen = filterByLists_(readTable_(ss, TABS.CONTACTS).rows.filter(function (c) { return c.shop_id === shop.shop_id; }), audience);
  if (!chosen.length && audience.ids.length) throw new Error('The chosen files have nobody in them any more.');
  const plan = chosen.map(function (c) {
    const check = eligibility_(c, 'whatsapp');
    let reason = check.ok ? '' : check.reason;
    if (!reason && seen[c.phone]) reason = 'Same phone number appears twice';
    if (!reason && previous[c.phone]) reason = 'Already received this WhatsApp template on ' + String(previous[c.phone]).slice(0, 10);
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1; else seen[c.phone] = true;
    return { contact: c, status: reason ? 'skipped' : 'pending', reason: reason };
  });
  const pending = plan.filter(function (x) { return x.status === 'pending'; });
  const sample = pending[0] ? pending[0].contact : { first_name: 'Ahmed', full_name: 'Ahmed Ali', phone: '971501234567' };
  const f = templateFields_(sample, shop);
  return {
    shop: shop, cfg: cfg, tpl: tpl, mapping: mapping, headerMapping: headerMapping, templateId: templateId, plan: plan,
    audience: audience, media: media,
    summary: {
      audience: audience.names,
      totalContacts: plan.length, willSend: pending.length, willSkip: plan.length - pending.length,
      skipReasons: Object.keys(reasons).map(function (r) { return { reason: r, count: reasons[r] }; }).sort(function (a, b) { return b.count - a.count; }),
      from: cfg.display_phone, fromName: cfg.verified_name,
      media: media ? publicMedia_(media) : null,
      sample: { name: sample.full_name || sample.first_name || '', phone: sample.phone || '', header: renderWaText_(tpl.header, headerMapping, f), text: renderWaText_(tpl.body, mapping, f) }
    }
  };
}

function getWhatsAppApiPreview(params) {
  const ctx = requireUser_();
  params = params || {};
  const rules = whatsAppRules_(params, WA_API_LIMITS);
  const p = waApiPlan_(ctx.ss, params);
  const s = p.summary;
  s.rules = rules;
  s.estimatedDays = Math.max(1, Math.ceil(s.willSend / rules.dailyCap));
  const first = rules.startAt ? new Date(rules.startAt).getTime() : Date.now();
  if (!(uaeHour_(first) >= rules.startHour && uaeHour_(first) < rules.endHour)) s.waitsForHoursLabel = fmtUae_(nextWindowStart_(first, rules));
  return s;
}

function startWhatsAppApiCampaign(params) {
  const ctx = requireUser_();
  params = params || {};
  const rules = whatsAppRules_(params, WA_API_LIMITS);
  return withLock_(function () {
    const p = waApiPlan_(ctx.ss, params);
    if (!p.summary.willSend) {
      throw new Error('Nobody can receive this WhatsApp message. ' + p.summary.skipReasons.map(function (r) { return r.count + ' × ' + r.reason; }).join('; ') + '.');
    }
    const now = nowIso_();
    const startMs = rules.startAt ? new Date(rules.startAt).getTime() : 0;
    const sender = 'whatsapp:+' + String(p.cfg.display_phone || p.cfg.phone_number_id).replace(/\D/g, '');
    const campaign = {
      campaign_id: newId_('K'), shop_id: p.shop.shop_id,
      campaign_name: String(params.name || '').trim().slice(0, 100) ||
        ('WhatsApp: ' + p.tpl.name + ' — ' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'd MMM yyyy HH:mm')),
      template_id: p.templateId, sender_email: sender, delay_minutes: String(rules.delayMinutes),
      skip_previous_recipients: params.skipPrevious === false ? 'no' : 'yes', status: 'running',
      status_reason: startMs ? 'Scheduled: the first message goes out at ' + fmtUae_(startMs) + ' (UAE time).' : '',
      created_by: ctx.email, created_at: now, started_at: startMs ? new Date(startMs).toISOString() : now,
      next_send_at: startMs ? new Date(startMs).toISOString() : now, finished_at: '',
      total: String(p.plan.length), sent: '0', skipped: String(p.summary.willSkip), failed: '0', pending: String(p.summary.willSend),
      random_extra: rules.randomExtra ? 'yes' : 'no', ignore_hours: rules.startHour === 0 && rules.endHour === 24 ? 'yes' : 'no',
      list_ids: p.audience.ids.join(','), media_id: p.media ? p.media.media_id : '',
      channel: 'whatsapp_api', daily_cap: String(rules.dailyCap), start_hour: String(rules.startHour), end_hour: String(rules.endHour),
      wa_template: JSON.stringify({ name: p.tpl.name, language: p.tpl.language, named: p.tpl.named, params: p.tpl.params,
        header_params: p.tpl.header_params, mapping: p.mapping, header_mapping: p.headerMapping, body: p.tpl.body, header: p.tpl.header,
        header_media: p.tpl.header_media || '' })
    };
    const logRows = p.plan.map(function (item) {
      const c = item.contact;
      return {
        log_id: newId_('L'), campaign_id: campaign.campaign_id, shop_id: p.shop.shop_id, contact_id: c.contact_id,
        contact_name: c.full_name || c.first_name, email: c.email, phone: c.phone, template_id: p.templateId,
        channel: 'whatsapp', sender_email: sender, status: item.status, reason: item.reason,
        queued_at: now, sent_at: '', attempts: '0', done_by: item.status === 'skipped' ? 'app' : ''
      };
    });
    appendRows_(readTable_(ctx.ss, TABS.CAMPAIGNS), [campaign]);
    appendRows_(readTable_(ctx.ss, TABS.LOG), logRows);
    setNextDue_(startMs || Date.now());
    ensureTrigger_();
    return stripRow_(campaign);
  });
}

/* ---------------- Engine (runs in the workspace owner's trigger) ---------------- */

const WA_ERR = {
  AUTH: [190, 10, 200, 131005],                                  // token expired / no permission
  ACCOUNT: [131042, 131031, 368, 131045, 133010, 131037, 133005], // payment, locked, blocked, number not registered…
  TEMPLATE: [132000, 132001, 132005, 132007, 132012, 132015, 132016, 132018, 132068, 132069],
  PERSON: [131026, 131030, 131049, 131050, 131021, 131051, 131047],
  SLOW: [130429, 131056, 4, 80007, 130472],
  SPAM: [131048]
};
const WA_ERR_TEXT = {
  131026: 'This number cannot receive the message (not on WhatsApp, old WhatsApp version, or it blocked you)',
  131030: 'In test mode Meta only sends to the numbers added under API Setup > "To"; add this number there, or add a real business number',
  131049: 'Meta did not deliver it, to limit how many marketing messages this person gets; try again in a few days',
  131050: 'This person has stopped marketing messages from your business',
  131021: 'This is your own business number',
  131047: 'More than 24 hours since this person last wrote; only a template can be sent'
};

function waApiToken_() { return ownerSecrets_().getProperty(waTokenKey_()) || ''; }

function buildWaPayload_(spec, to, fields, metaMediaId) {
  const toParams = function (keys, mapping) {
    return keys.map(function (k) {
      const p = { type: 'text', text: paramValue_(mapping[k] || 'text:-', fields) };
      if (spec.named) p.parameter_name = k;
      return p;
    });
  };
  const components = [];
  if (spec.header_media && metaMediaId) {
    const h = { type: spec.header_media };
    h[spec.header_media] = { id: metaMediaId };
    components.push({ type: 'header', parameters: [h] });
  }
  if ((spec.header_params || []).length) components.push({ type: 'header', parameters: toParams(spec.header_params, spec.header_mapping || {}) });
  if ((spec.params || []).length) components.push({ type: 'body', parameters: toParams(spec.params, spec.mapping || {}) });
  const template = { name: spec.name, language: { code: spec.language } };
  if (components.length) template.components = components;
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: 'template', template: template };
}

function stepWaApi_(ctx, campaign, nowMs) {
  const shop = ctx.shops[campaign.shop_id];
  if (!shop) return pause_(campaign, 'The shop was removed from the Shops tab.');
  const cfg = waApiCfg_();
  if (!cfg || cfg.status !== 'connected') {
    return pause_(campaign, 'WhatsApp Business API is not connected' + (cfg && cfg.last_error ? ' (' + cfg.last_error + ')' : '') +
      '. ' + WS.owner + ' must reconnect it in ⚙ Settings, then press Resume.');
  }
  const spec = parseJson_(campaign.wa_template);
  if (!spec.name) return pause_(campaign, 'This send has no WhatsApp template saved. Stop it and start a new one.');
  const delayMs = cleanDelay_(campaign.delay_minutes) * 60000;
  const log = ctx.log;
  const pending = log.rows.filter(function (l) { return l.campaign_id === campaign.campaign_id && l.status === 'pending'; });
  const rules = {
    dailyCap: Math.max(1, Math.min(WA_API_LIMITS.maxCap, Number(campaign.daily_cap) || 250)),
    startHour: campaign.ignore_hours === 'yes' ? 0 : (campaign.start_hour === '' ? 9 : Number(campaign.start_hour)),
    endHour: campaign.ignore_hours === 'yes' ? 24 : (campaign.end_hour === '' ? 21 : Number(campaign.end_hour))
  };

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const contact = ctx.contacts[item.contact_id];
    if (!contact) { finish_(log, item, 'skipped', 'Contact was deleted from the Contacts tab'); continue; }
    const check = eligibility_(contact, 'whatsapp');
    if (!check.ok) { finish_(log, item, 'skipped', check.reason); continue; }
    const dup = log.rows.filter(function (l) {
      return l !== item && l.status === 'sent' && l.channel === 'whatsapp' && l.shop_id === campaign.shop_id && l.phone === contact.phone &&
        (l.campaign_id === campaign.campaign_id || (campaign.skip_previous_recipients === 'yes' && l.template_id === campaign.template_id));
    })[0];
    if (dup) { finish_(log, item, 'skipped', dup.campaign_id === campaign.campaign_id ? 'Already received this send' : 'Already received this WhatsApp template'); continue; }

    if (!withinSendingHours_(nowMs, rules)) {
      campaign.next_send_at = new Date(nextWindowStart_(nowMs, rules)).toISOString();
      campaign.status_reason = 'Waiting for sending hours (' + hourLabel_(rules.startHour) + '–' + hourLabel_(rules.endHour) + ' UAE time). Continues automatically.';
      return;
    }
    const today = uaeDay_(nowMs);
    const sentToday = log.rows.filter(function (l) {
      return l.status === 'sent' && l.channel === 'whatsapp' && l.sender_email === campaign.sender_email && l.sent_at && uaeDay_(new Date(l.sent_at).getTime()) === today;
    }).length;
    if (sentToday >= rules.dailyCap) {
      campaign.next_send_at = new Date(nextDayStart_(nowMs, rules)).toISOString();
      campaign.status_reason = 'Daily limit reached: ' + sentToday + ' WhatsApp messages sent today (limit ' + rules.dailyCap +
        '). Continues automatically tomorrow at ' + hourLabel_(rules.startHour) + '.';
      return;
    }
    let token = '';
    try { token = waApiToken_(); } catch (e) { token = ''; }
    if (!token) {
      markWaApi_('needs_reconnect', 'The access token is missing');
      return pause_(campaign, 'The WhatsApp Business API access token is missing. ' + WS.owner + ' must paste it again in ⚙ Settings, then press Resume.');
    }

    let metaMedia = '';
    if (spec.header_media) {
      try {
        metaMedia = metaMediaId_(ctx.ss, campaign.media_id, cfg, token);
      } catch (e) {
        const g = e.graph || {};
        if (g.http === 401 || WA_ERR.AUTH.indexOf(g.code) !== -1) markWaApi_('needs_reconnect', g.message || e.message);
        return pause_(campaign, (e && e.message ? e.message : String(e)) + ' Fix it, then press Resume.');
      }
    }
    const fields = templateFields_(contact, shop);
    item.attempts = String(Number(item.attempts || 0) + 1);
    const r = graph_('post', cfg.phone_number_id + '/messages', token, buildWaPayload_(spec, contact.phone, fields, metaMedia));
    const nextMs = nowMs + Math.round(delayMs * (1 + (campaign.random_extra === 'no' ? 0 : Math.random() * 0.4)));
    if (r.code === 200 && r.body && r.body.messages && r.body.messages.length) {
      item.contact_name = contact.full_name || contact.first_name;
      item.phone = contact.phone;
      finish_(log, item, 'sent', 'Accepted by WhatsApp (delivery shows in WhatsApp Manager)');
      campaign.next_send_at = new Date(nextMs).toISOString();
      campaign.status_reason = '';
      return;
    }
    const e = graphError_(r);
    const has = function (list) { return list.indexOf(e.code) !== -1; };
    if (r.code === 401 || has(WA_ERR.AUTH)) {
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      markWaApi_('needs_reconnect', e.message);
      return pause_(campaign, 'Meta refused the access token (' + e.message + '). ' + WS.owner + ' must paste a new permanent token in ⚙ Settings > WhatsApp Business API, then press Resume.');
    }
    if (has(WA_ERR.ACCOUNT)) {
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      return pause_(campaign, 'Meta stopped sending from this WhatsApp Business account: ' + e.message +
        (e.code === 131042 ? ' — add or fix the payment method in Meta Business Settings (WhatsApp Manager > Billing).' : '') + ' Fix it in Meta, then press Resume.');
    }
    if (has(WA_ERR.TEMPLATE)) {
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      return pause_(campaign, 'Problem with the WhatsApp template "' + spec.name + '": ' + e.message + '. Check it in WhatsApp Manager (it may be paused or changed); then stop this send and start a new one.');
    }
    if (has(WA_ERR.SPAM)) {
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      return pause_(campaign, 'Meta limited this number because people blocked or reported the messages (' + e.message + '). Paused to protect the number. Wait a day, then press Resume.');
    }
    if (metaMedia && (e.code === 131052 || e.code === 131053)) { // Meta lost the photo/video: upload it again, once
      if (forgetMetaMedia_(ctx.ss, campaign.media_id, 3600000) === 'recent') {
        item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
        return pause_(campaign, 'Meta cannot use this ' + (spec.header_media === 'video' ? 'video' : 'photo') + ' (' + e.message + '). ' +
          (spec.header_media === 'video' ? 'Use an MP4 video made with a phone (H.264), under 16 MB' : 'Use a JPG or PNG photo under 5 MB') + '. Stop this send and start a new one with another file.');
      }
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      campaign.next_send_at = new Date(nowMs + 60000).toISOString();
      campaign.status_reason = 'Meta could not use the ' + (spec.header_media === 'video' ? 'video' : 'photo') + ' (' + e.message + '). Uploading it again.';
      return;
    }
    if (has(WA_ERR.PERSON) || (e.code === 100 && /phone|recipient|\bto\b/i.test(e.message))) {
      finish_(log, item, 'failed', WA_ERR_TEXT[e.code] || e.message);
      campaign.next_send_at = new Date(nextMs).toISOString();
      return;
    }
    if (has(WA_ERR.SLOW)) {
      item.attempts = String(Number(item.attempts) - 1); updateRow_(log, item);
      campaign.next_send_at = new Date(nowMs + 15 * 60000).toISOString();
      campaign.status_reason = 'Meta asked to slow down (' + e.message + '). Trying again in 15 minutes.';
      return;
    }
    if (Number(item.attempts) >= MAX_SEND_ATTEMPTS) {
      finish_(log, item, 'failed', e.message);
    } else {
      item.reason = 'Attempt ' + item.attempts + ' failed (' + e.message + '). Will retry.';
      updateRow_(log, item);
    }
    campaign.next_send_at = new Date(nowMs + delayMs).toISOString();
    return;
  }
  campaign.status = 'completed';
  campaign.status_reason = '';
  campaign.finished_at = new Date(nowMs).toISOString();
  campaign.next_send_at = '';
}
