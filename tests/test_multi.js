// Many people, one app: workspaces, the update from the single-owner version, Mac pairing, WhatsApp Business API.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { makeEnv } = require('./harness');
const SRC = path.join(__dirname, '..', 'src');
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 5).join('\n    ')); process.exitCode = 1; }
}
function throwsMsg(fn, re) {
  let err; try { fn(); } catch (e) { err = e; }
  assert(err, 'expected an error matching ' + re);
  assert(re.test(err.message), 'error was: ' + err.message);
}
const wsOf = (E, email) => {
  const k = Object.keys(E.scriptProps).find(k => k.startsWith('W_') && JSON.parse(E.scriptProps[k]).owner === email);
  return k ? k.slice(2) : '';
};

/* ======================================================================= */
console.log('Update from the single-owner version (data, Gmail, Dad, running send all keep working)');
{
  const OLD = path.join(os.tmpdir(), 'sf-v1-src');
  let haveOld = true;
  try {
    fs.mkdirSync(OLD, { recursive: true });
    ['Code.gs', 'Senders.gs', 'Sending.gs'].forEach(f =>
      fs.writeFileSync(path.join(OLD, f), execSync('git show 02f2a48:src/' + f, { cwd: path.join(__dirname, '..') })));
  } catch (e) { haveOld = false; console.log('  (skipped: the old version is not in git here)'); }
  if (haveOld) {
    const E = makeEnv(OLD); let C = E.ctx; const G = E.google;
    // The family's app today: owner set up, Gmail connected, Dad imported people and started a send.
    E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret);
    E.connect('shop1@gmail.com'); C.assignShopSender('SHOP1', 'shop1@gmail.com');
    C.saveSendingRules({ dailyCap: 30, startHour: 9, endHour: 21 });
    E.as('dad@gmail.com');
    const people = []; for (let i = 0; i < 4; i++) people.push({ full_name: 'Old ' + i, email: 'old' + i + '@ex.com', phone: '05012300' + i + '0', consent_status: 'yes' });
    C.importContacts('SHOP1', people, {});
    const k = C.startCampaign({ shopId: 'SHOP1', subject: 'Hello {first_name}', body: 'Hello {first_name}, the shop is still available.', delayMinutes: 3, randomExtra: false });
    E.runTrigger(1);
    assert.strictEqual(E.sent.length, 1);

    // Publish the new version on top of the same Google data.
    C = E.loadCode(SRC);

    t('the owner\'s trigger keeps sending the running send without anyone opening the app', () => {
      E.runTrigger(6);
      assert.strictEqual(E.sent.length, 3, 'one every 3 minutes');
      assert(E.sent.every(m => m.account === 'shop1@gmail.com'));
      const ws = wsOf(E, 'owner@gmail.com');
      assert(ws, 'the original Sheet became the owner\'s workspace');
      assert.strictEqual(E.scriptProps.GMAIL_ACCOUNTS, undefined, 'settings moved into the workspace');
      assert(JSON.parse(E.scriptProps['ACCOUNTS@' + ws])['shop1@gmail.com'].status === 'connected');
      assert(E.scriptProps['LAST_RUN@' + ws]);
    });
    t('Dad opens the app: same shop, same people, same send — nothing to set up', () => {
      E.as('dad@gmail.com');
      const b = C.getBootstrap();
      assert.strictEqual(b.needsWorkspace, undefined);
      assert.strictEqual(b.isOwner, false);
      assert.strictEqual(b.workspace.name, 'My shops');
      assert.strictEqual(b.shops[0].senderOk, true);
      const d = C.getShopData('SHOP1');
      assert.strictEqual(d.contacts.length, 4);
      assert.strictEqual(d.campaigns[0].campaign_id, k.campaign_id);
      assert.strictEqual(d.engine.healthy, true);
    });
    t('the owner\'s Settings keep the Gmail account, rules and sign-in client (secret moves server-side)', () => {
      E.as('owner@gmail.com');
      const st = C.getSettings();
      assert.strictEqual(st.isAdmin, true);
      assert.strictEqual(st.accounts[0].email, 'shop1@gmail.com');
      assert.strictEqual(st.sendingRules.dailyCap, 30);
      assert.strictEqual(st.clientSecretSaved, true);
      assert.strictEqual(E.scriptProps.OAUTH_CLIENT_SECRET, G.client.secret);
      assert.deepStrictEqual(Array.from(st.members), ['dad@gmail.com']);
      assert.strictEqual(E.triggers.length, 1, 'no extra trigger');
    });
    t('the send finishes; nobody gets it twice', () => {
      E.runTrigger(10);
      assert.strictEqual(E.sent.length, 4);
      assert.strictEqual(new Set(E.sent.map(m => m.to)).size, 4);
      assert.strictEqual(E.tab('Campaigns').find(c => c.campaign_id === k.campaign_id).status, 'completed');
    });
    t('the Mac helper set up with the old installer still works for the owner\'s workspace', () => {
      const r = E.bridge({ token: 'test-token', action: 'poll', status: { wa: 'connected' } });
      assert(r.ok);
      E.as('dad@gmail.com');
      const h = C.getWhatsAppHelper();
      assert.strictEqual(h.online, true); assert.strictEqual(h.installed, true);
    });
  }
}

/* ======================================================================= */
console.log('Anyone can use the link: their own private workspace');
const E = makeEnv(SRC); const C = E.ctx; const G = E.google; const M = E.meta;
E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret);
E.connect('shop1@gmail.com'); C.assignShopSender('SHOP1', 'shop1@gmail.com');
E.as('dad@gmail.com');
C.importContacts('SHOP1', [{ full_name: 'Owner Customer', email: 'oc@ex.com', phone: '0501110000', consent_status: 'yes' }], {});

t('a new person sees "create your workspace" (no data of anybody)', () => {
  E.as('sara@gmail.com');
  const b = C.getBootstrap();
  assert.strictEqual(b.needsWorkspace, true);
  assert.strictEqual(b.user, 'sara@gmail.com');
});
t('creating it makes a new Google Sheet in THEIR Drive, with their first shop', () => {
  E.as('sara@gmail.com');
  throwsMsg(() => C.createMyWorkspace('Sara Shops', ''), /first shop/);
  C.createMyWorkspace('Sara Shops', 'Sara Bakery');
  const book = E.sheetOf('sara@gmail.com');
  assert(book && book.id !== 'SHEET123');
  assert.deepStrictEqual(Array.from(book.editors), ['sara@gmail.com']);
  const b = C.getBootstrap();
  assert.strictEqual(b.isOwner, true); assert.strictEqual(b.isAdmin, false);
  assert.strictEqual(b.workspace.name, 'Sara Shops');
  assert.deepStrictEqual(Array.from(b.shops.map(s => s.shop_name)), ['Sara Bakery']);
  assert(/connect at least one Gmail/.test(b.settingsNeeded), b.settingsNeeded);
  assert.strictEqual(b.engine.healthy, true, 'no scary "sender never ran" notice on a new workspace');
  throwsMsg(() => C.createMyWorkspace('Again', 'X'), /already have your own workspace/);
});
t('they never see anyone else\'s people, even with the same shop id', () => {
  E.as('sara@gmail.com');
  const d = C.getShopData('SHOP1');
  assert.strictEqual(d.shop.shop_name, 'Sara Bakery');
  assert.strictEqual(d.contacts.length, 0);
  C.importContacts('SHOP1', [{ full_name: 'Sara Customer', email: 'sc@ex.com', phone: '0502220000', consent_status: 'yes' },
    { full_name: 'Sara Two', email: 'sc2@ex.com', phone: '0502220001', consent_status: 'yes' }], {});
  E.as('dad@gmail.com');
  assert.deepStrictEqual(Array.from(C.getShopData('SHOP1').contacts.map(c => c.full_name)), ['Owner Customer']);
  assert.strictEqual(E.tab('Contacts').length, 1, 'the owner\'s Sheet has only the owner\'s people');
});
t('Settings: their own Gmail accounts, shops and people; the Google sign-in client stays the admin\'s', () => {
  E.as('sara@gmail.com');
  const st = C.getSettings();
  assert.strictEqual(st.isAdmin, false);
  assert.strictEqual(st.clientId, '', 'client id not needed on their page');
  assert.strictEqual(st.clientReady, true);
  assert.strictEqual(st.accounts.length, 0, 'the owner\'s Gmail accounts are not visible');
  throwsMsg(() => C.saveOAuthClient(G.client.id, 'GOCSPX-other_secret_1'), /Only the app administrator/);
  throwsMsg(() => C.assignShopSender('SHOP1', 'shop1@gmail.com'), /not a connected Gmail account/);
});
t('they connect their own Gmail: token in THEIR private store, status only in their workspace', () => {
  E.as('sara@gmail.com');
  const r = E.connect('sara.shop@gmail.com');
  assert(/Connected: sara.shop@gmail.com/.test(r.html), r.html);
  assert(E.userProps['sara@gmail.com']['GMAIL_TOKEN_sara.shop@gmail.com']);
  assert(!E.userProps['owner@gmail.com']['GMAIL_TOKEN_sara.shop@gmail.com']);
  const sws = wsOf(E, 'sara@gmail.com'), ows = wsOf(E, 'owner@gmail.com');
  assert(JSON.parse(E.scriptProps['ACCOUNTS@' + sws])['sara.shop@gmail.com']);
  assert(!JSON.parse(E.scriptProps['ACCOUNTS@' + ows])['sara.shop@gmail.com']);
  assert.strictEqual(E.triggers.filter(t => t.owner === 'sara@gmail.com').length, 1, 'their own every-minute trigger');
  C.assignShopSender('SHOP1', 'sara.shop@gmail.com');
  E.as('owner@gmail.com');
  throwsMsg(() => C.assignShopSender('SHOP1', 'sara.shop@gmail.com'), /not a connected Gmail account/);
});
t('their emails go out from their Gmail by their own trigger; each trigger only touches its own workspace', () => {
  E.as('sara@gmail.com');
  C.startCampaign({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Hello {first_name}, fresh bread today at the bakery.', delayMinutes: 3, randomExtra: false });
  E.as('dad@gmail.com');
  C.startCampaign({ shopId: 'SHOP1', subject: 'Hello {first_name}', body: 'Hello {first_name}, the shop is still available.', delayMinutes: 3 });
  E.runTrigger(8);
  const sara = E.sent.filter(m => m.account === 'sara.shop@gmail.com').map(m => m.to).sort();
  const own = E.sent.filter(m => m.account === 'shop1@gmail.com').map(m => m.to);
  assert.deepStrictEqual(sara, ['sc2@ex.com', 'sc@ex.com']);
  assert.deepStrictEqual(own, ['oc@ex.com']);
  const sends = E.fetchLog.filter(f => /gmail\/v1/.test(f.url));
  assert(sends.length >= 3 && sends.every(f => ['sara@gmail.com', 'owner@gmail.com'].indexOf(f.as) !== -1), 'only owners\' triggers send');
  E.as('sara@gmail.com');
  assert.strictEqual(C.getBootstrap().engine.healthy, true);
});
t('adding a person (like Dad) to a workspace; they can use it but not change settings', () => {
  E.as('sara@gmail.com');
  throwsMsg(() => C.addMember('not-an-email'), /Google \(Gmail\) address/);
  throwsMsg(() => C.addMember('someone@nogoogle.com'), /must be a Google account/);
  assert.deepStrictEqual(Array.from(C.addMember('Ali@Gmail.com')), ['ali@gmail.com']);
  E.as('ali@gmail.com');
  const b = C.getBootstrap();
  assert.strictEqual(b.workspace.name, 'Sara Shops'); assert.strictEqual(b.isOwner, false);
  assert.strictEqual(C.getShopData('SHOP1').contacts.length, 2);
  throwsMsg(() => C.getSettings(), /Only the owner of this workspace \(sara@gmail.com\)/);
  throwsMsg(() => C.saveShop({ shop_name: 'X' }), /Only the owner/);
});
t('someone in two workspaces can switch between them', () => {
  E.as('sara@gmail.com'); C.addMember('dad@gmail.com');
  E.as('dad@gmail.com');
  let b = C.getBootstrap();
  assert.strictEqual(b.workspaces.length, 2);
  const other = b.workspaces.find(w => w.id !== b.workspace.id);
  b = C.switchWorkspace(other.id);
  assert.strictEqual(b.workspace.id, other.id);
  assert.strictEqual(C.getBootstrap().workspace.id, other.id, 'remembered');
  throwsMsg(() => C.switchWorkspace('W_NOPE'), /do not have access/);
  C.switchWorkspace(b.workspaces.find(w => w.name === 'My shops').id);
});
t('family added the old way (Sheet editor) keep the family workspace first, even if someone else adds them before their first visit', () => {
  E.ss.editors.push('mom@gmail.com');
  E.as('sara@gmail.com'); C.addMember('mom@gmail.com');
  E.as('mom@gmail.com');
  const b = C.getBootstrap();
  assert.deepStrictEqual(Array.from(b.workspaces.map(w => w.owner)), ['owner@gmail.com', 'sara@gmail.com']);
  assert.strictEqual(b.workspace.name, 'My shops');
  assert.strictEqual(b.ownsWorkspace, false);
});
t('removing a person takes their access away', () => {
  E.as('sara@gmail.com');
  assert.deepStrictEqual(Array.from(C.removeMember('ali@gmail.com')), ['dad@gmail.com', 'mom@gmail.com']);
  throwsMsg(() => C.removeMember('sara@gmail.com'), /cannot be removed/);
  E.as('ali@gmail.com');
  assert.strictEqual(C.getBootstrap().needsWorkspace, true);
});
t('shops are added, renamed and hidden in the app (no Sheet editing)', () => {
  E.as('sara@gmail.com');
  const s2 = C.saveShop({ shop_name: 'Sara Cafe', sender_name: 'Sara', reply_to: 'sara@gmail.com', country_code: '+971' });
  assert(s2.shop_id && s2.shop_id !== 'SHOP1');
  throwsMsg(() => C.saveShop({ shop_name: 'sara cafe' }), /already a shop called/);
  throwsMsg(() => C.saveShop({ shop_name: 'Bad', reply_to: 'nope' }), /reply-to/);
  C.saveShop({ shop_id: s2.shop_id, shop_name: 'Sara Café', sender_name: 'Sara', country_code: '971' });
  assert(C.getBootstrap().shops.some(s => s.shop_name === 'Sara Café'));
  C.saveShop({ shop_id: s2.shop_id, shop_name: 'Sara Café', active: false });
  assert(!C.getBootstrap().shops.some(s => s.shop_name === 'Sara Café'), 'hidden from the home page');
  assert(C.getSettings().shops.some(s => s.shop_name === 'Sara Café' && !s.active), 'still listed in Settings');
});
t('renaming a workspace; owners only', () => {
  E.as('sara@gmail.com'); assert.strictEqual(C.renameWorkspace('Sara & Co'), 'Sara & Co');
  E.as('dad@gmail.com'); C.switchWorkspace(C.getBootstrap().workspaces.find(w => w.owner === 'sara@gmail.com').id);
  throwsMsg(() => C.renameWorkspace('Mine now'), /Only the owner/);
  C.switchWorkspace(C.getBootstrap().workspaces.find(w => w.owner === 'owner@gmail.com').id);
});
t('a workspace whose Sheet was deleted explains what to do', () => {
  E.as('tom@gmail.com'); C.createMyWorkspace('Tom', 'Tom Shop');
  E.sheetOf('tom@gmail.com').trashed = true;
  throwsMsg(() => C.getBootstrap(), /trash of your Google Drive/);
  E.sheetOf('tom@gmail.com').trashed = false;
  assert.strictEqual(C.getBootstrap().workspace.name, 'Tom');
});

/* ======================================================================= */
console.log('WhatsApp from another person\'s Mac (pairing + relay)');
t('"Set up a Mac" gives a one-line command with this workspace\'s own secret', () => {
  E.as('sara@gmail.com');
  let h = C.getWhatsAppHelper();
  assert.strictEqual(h.installed, false); assert.strictEqual(h.canLink, true);
  throwsMsg(() => C.startWhatsAppAuto({ shopId: 'SHOP1', body: 'Hi {first_name}' }), /No Mac is set up/);
  const r = C.createMacLink();
  const m = r.command.match(/^curl -fsSL https:\/\/hebadaher\.github\.io\/sheetsender\/mac\/install\.sh \| bash -s -- '(https:[^']+)' '([0-9a-f]{64})'$/);
  assert(m, r.command);
  assert.strictEqual(m[1], 'https://script.google.com/macros/s/AKfycbBRIDGE123/exec');
  global.SARA_TOKEN = m[2];
  assert(!JSON.stringify(E.scriptProps).includes(m[2]), 'only the fingerprint is kept');
  h = C.getWhatsAppHelper();
  assert.strictEqual(h.installed, true); assert.strictEqual(h.online, false);
});
t('the Mac with that secret reaches only that workspace', () => {
  const r = E.bridge({ action: 'poll', status: { wa: 'connected', version: 2 } }, SARA_TOKEN);
  assert(r.ok);
  E.as('sara@gmail.com'); assert.strictEqual(C.getWhatsAppHelper().online, true);
  E.as('dad@gmail.com'); assert.strictEqual(C.getWhatsAppHelper().wa, undefined, 'the owner\'s workspace does not see Sara\'s Mac');
});
t('Start → the Mac fetches the ready list → results come back into Sara\'s Send Log (not the owner\'s)', () => {
  E.as('ali@gmail.com');
  E.as('sara@gmail.com');
  const st = C.startWhatsAppAuto({ shopId: 'SHOP1', body: 'Hello {first_name} from the bakery', delayMinutes: 5, dailyCap: 20 });
  assert.strictEqual(st.people, 2);
  const cmds = E.bridge({ action: 'poll', status: { wa: 'connected' } }, SARA_TOKEN).commands;
  assert.strictEqual(cmds.length, 1);
  const job = E.bridge({ action: 'job', command_id: cmds[0].id }, SARA_TOKEN).job;
  assert.strictEqual(job.items.length, 2);
  assert(job.items.every(i => /^Hello Sara/.test(i.text)));
  assert.strictEqual(E.bridge({ action: 'job', command_id: cmds[0].id }, 'test-token').ok, false, 'another Mac cannot fetch it');
  E.bridge({ action: 'ack', ids: [cmds[0].id] }, SARA_TOKEN);
  const res = { kind: 'shop-followups-whatsapp-results', job_id: job.job_id, shop_id: job.shop_id, template_id: job.template_id, created_at: job.created_at,
    items: job.items.map(i => ({ contact_id: i.contact_id, phone: i.phone, status: 'sent', at: '2026-11-02T12:00:00' })) };
  const out = E.bridge({ action: 'results', results: res }, SARA_TOKEN);
  assert(out.ok && out.saved.relayed);
  assert(Object.keys(E.scriptProps).some(k => k.startsWith('WAR@')), 'waiting in the relay');
  E.runTrigger(1); // Sara's trigger saves them
  assert(!Object.keys(E.scriptProps).some(k => k.startsWith('WAR@')));
  const log = E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.channel === 'whatsapp' && l.status === 'sent');
  assert.strictEqual(log.length, 2);
  assert(!E.tab('Send Log').some(l => /Sara/.test(l.contact_name)), 'nothing in the owner\'s Sheet');
  E.bridge({ action: 'results', results: res }, SARA_TOKEN);
  E.as('sara@gmail.com'); C.getWhatsAppHelper(); // the page also saves waiting results
  assert.strictEqual(E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.channel === 'whatsapp' && l.status === 'sent').length, 2, 'not counted twice');
});
t('setting up a new Mac disconnects the old one', () => {
  E.as('sara@gmail.com');
  C.createMacLink();
  assert.strictEqual(E.bridge({ action: 'poll', status: {} }, SARA_TOKEN).error, 'not allowed');
});
t('a big results batch is split safely and saved in full', () => {
  E.as('sara@gmail.com');
  const tok = C.createMacLink().command.match(/'([0-9a-f]{64})'$/)[1];
  const bulk = C.saveShop({ shop_name: 'Bulk Shop' });
  const many = []; for (let i = 0; i < 120; i++) many.push({ full_name: 'Bulk ' + i, phone: '05099' + String(i).padStart(5, '0'), consent_status: 'yes' });
  C.importContacts(bulk.shop_id, many, {});
  const job = C.getWhatsAppJob({ shopId: bulk.shop_id, body: 'Bulk hello {first_name}' });
  const res = { kind: 'shop-followups-whatsapp-results', job_id: job.job_id, shop_id: job.shop_id, template_id: job.template_id, created_at: job.created_at,
    items: job.items.map(i => ({ contact_id: i.contact_id, phone: i.phone, status: 'failed', reason: 'x'.repeat(150), at: '2026-11-02T12:00:00' })) };
  assert(E.bridge({ action: 'results', results: res }, tok).ok);
  const keys = Object.keys(E.scriptProps).filter(k => k.startsWith('WAR@'));
  assert(keys.length > 1 && keys.every(k => E.scriptProps[k].length < 9000));
  C.getWhatsAppHelper();
  assert.strictEqual(E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.reason === 'x'.repeat(150)).length, job.items.length);
});

/* ======================================================================= */
console.log('WhatsApp Business API (paid; sends with every laptop off)');
const okMap = { 1: 'first_name', 2: 'shop_name' };
t('only the workspace owner connects it; wrong details are explained; token never leaves the server', () => {
  E.as('dad@gmail.com'); C.switchWorkspace(C.getBootstrap().workspaces.find(w => w.owner === 'sara@gmail.com').id);
  throwsMsg(() => C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: M.token }), /Only the owner/);
  assert.strictEqual(C.getShopData('SHOP1').waApi.configured, false);
  E.as('sara@gmail.com');
  throwsMsg(() => C.saveWhatsAppApi({ phoneNumberId: 'abc', wabaId: M.waba, token: M.token }), /digits only/);
  throwsMsg(() => C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: 'EAAGwrong_token_value_123456789' }), /access token is wrong or expired/);
  throwsMsg(() => C.saveWhatsAppApi({ phoneNumberId: '999999', wabaId: M.waba, token: M.token }), /Meta did not accept/);
  throwsMsg(() => C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: '999999', token: M.token }), /Business Account ID/);
  const api = C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: M.token });
  assert.strictEqual(api.status, 'connected'); assert.strictEqual(api.display_phone, '+971 50 000 0000'); assert.strictEqual(api.tokenSaved, true);
  assert.strictEqual(E.userProps['sara@gmail.com']['WA_API_TOKEN_' + wsOf(E, 'sara@gmail.com')], M.token);
  assert(!JSON.stringify(E.scriptProps).includes(M.token), 'not in shared settings');
  assert(!JSON.stringify(E.sheetOf('sara@gmail.com').sheets.map(s => s.grid)).includes(M.token), 'not in the Sheet');
  assert(!JSON.stringify(C.getSettings()).includes(M.token), 'not sent to the page');
  // saving again without the token keeps it
  assert.strictEqual(C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: '' }).status, 'connected');
});
t('approved templates are listed for everyone in the workspace (with what cannot be used, and why)', () => {
  E.as('dad@gmail.com');
  const r = C.getWhatsAppApiTemplates();
  assert.strictEqual(r.api.configured, true);
  assert.strictEqual(r.api.phone_number_id, undefined, 'IDs only on the owner\'s Settings page');
  const by = n => r.templates.find(x => x.name === n);
  assert.deepStrictEqual(Array.from(by('shop_followup').params), ['1', '2']);
  assert.strictEqual(by('named_hello').named, true); assert.deepStrictEqual(Array.from(by('named_hello').header_params), ['shop']);
  assert.strictEqual(by('with_image').ok, false); assert(/picture/.test(by('with_image').why));
  assert.strictEqual(by('waiting_one').status, 'PENDING');
});
t('preview: every {{n}} must be chosen; shows exactly what a person receives', () => {
  E.as('dad@gmail.com');
  const base = { shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', delayMinutes: 2, dailyCap: 100, startHour: 0, endHour: 24 };
  throwsMsg(() => C.getWhatsAppApiPreview(Object.assign({ mapping: { 1: 'first_name' } }, base)), /\{\{2\}\}/);
  throwsMsg(() => C.getWhatsAppApiPreview(Object.assign({ mapping: { 1: 'first_name', 2: 'text:' } }, base)), /Write the text/);
  throwsMsg(() => C.getWhatsAppApiPreview(Object.assign({}, base, { mapping: { 1: 'first_name' }, template: 'with_image' })), /approved message template|cannot be used/);
  const p = C.getWhatsAppApiPreview(Object.assign({ mapping: okMap }, base));
  assert(p.willSend >= 2);
  assert(/^Hello \w+, this is about Sara Bakery\. Are you still interested\?$/.test(p.sample.text), p.sample.text);
  assert.strictEqual(p.from, '+971 50 000 0000');
  const p2 = C.getWhatsAppApiPreview(Object.assign({}, base, { mapping: { 1: 'first_name', 2: 'text:our  shop\nnear you' } }));
  assert(/about our shop near you\./.test(p2.sample.text), 'no line breaks inside a value');
});
t('a member starts it; the OWNER\'s trigger sends through Meta — one at a time, the chosen minutes apart', () => {
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Api One', phone: '0507770001', consent_status: 'yes' }, { full_name: 'Api Two', phone: '0507770002', consent_status: 'yes' },
    { full_name: 'No Consent', phone: '0507770003', consent_status: 'no' }], {});
  const k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap, delayMinutes: 2,
    randomExtra: false, dailyCap: 500, startHour: 0, endHour: 24, name: 'API test' });
  assert.strictEqual(k.channel, 'whatsapp_api');
  assert(Number(k.pending) >= 4); assert(Number(k.skipped) >= 1);
  const before = M.sent.length;
  E.runTrigger(1);
  assert.strictEqual(M.sent.length - before, 1);
  const first = M.sent[M.sent.length - 1];
  assert.strictEqual(first.as, 'sara@gmail.com', 'sent by the owner\'s trigger (dad\'s session never holds the token)');
  assert.strictEqual(first.body.type, 'template');
  assert.strictEqual(first.body.template.name, 'shop_followup'); assert.strictEqual(first.body.template.language.code, 'en_US');
  const params = first.body.template.components[0].parameters;
  assert.strictEqual(params[1].text, 'Sara Bakery'); assert.strictEqual(params[0].parameter_name, undefined);
  E.runTrigger(1); assert.strictEqual(M.sent.length - before, 1, 'waits the chosen 2 minutes');
  E.runTrigger(1); assert.strictEqual(M.sent.length - before, 2);
  E.runTrigger(30);
  const camp = E.tab('Campaigns', E.sheetOf('sara@gmail.com')).find(c => c.campaign_id === k.campaign_id);
  assert.strictEqual(camp.status, 'completed');
  assert.strictEqual(new Set(M.sent.slice(before).map(s => s.to)).size, M.sent.length - before, 'nobody twice');
  assert(!M.sent.some(s => s.to === '971507770003'), 'no consent → never sent');
  const log = E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.campaign_id === k.campaign_id && l.status === 'sent');
  assert(log.every(l => l.channel === 'whatsapp' && l.template_id === 'META:shop_followup:en_US'));
  E.as('dad@gmail.com');
  assert(C.getShopData('SHOP1').contacts.find(c => c.full_name === 'Api One').lastWhatsAppAt, 'shows on the WhatsApp tab');
});
t('the same template again skips people who already got it; named templates send their names', () => {
  E.as('dad@gmail.com');
  throwsMsg(() => C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap, startHour: 0, endHour: 24 }), /Nobody can receive/);
  const k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'named_hello', language: 'ar', mapping: { first_name: 'first_name' },
    headerMapping: { shop: 'shop_name' }, delayMinutes: 1, startHour: 0, endHour: 24 });
  const before = M.sent.length;
  E.runTrigger(1);
  const b = M.sent[before].body.template;
  assert.strictEqual(b.components[0].type, 'header'); assert.strictEqual(b.components[0].parameters[0].parameter_name, 'shop');
  assert.strictEqual(b.components[0].parameters[0].text, 'Sara Bakery');
  assert.strictEqual(b.components[1].parameters[0].parameter_name, 'first_name');
  C.stopCampaign(k.campaign_id);
});
t('Meta errors: a bad number fails only that person; a slow-down waits; payment/token problems pause with clear steps', () => {
  E.as('sara@gmail.com');
  const more = []; for (let i = 0; i < 6; i++) more.push({ full_name: 'Err ' + i, phone: '05088800' + i + '0', consent_status: 'yes' });
  C.importContacts('SHOP1', more, {});
  const k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap, delayMinutes: 1, randomExtra: false, startHour: 0, endHour: 24, skipPrevious: true });
  const camp = () => E.tab('Campaigns', E.sheetOf('sara@gmail.com')).find(c => c.campaign_id === k.campaign_id);
  const rows = () => E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.campaign_id === k.campaign_id);
  M.nextErrors.push({ code: 131030, message: 'Recipient phone number not in allowed list' });
  E.runTrigger(1);
  assert.strictEqual(rows().filter(r => r.status === 'failed').length, 1);
  assert(/test mode/.test(rows().find(r => r.status === 'failed').reason));
  assert.strictEqual(camp().status, 'running');
  M.nextErrors.push({ code: 130429, http: 429, message: 'Rate limit hit' });
  E.runTrigger(2);
  assert(/slow down/.test(camp().status_reason));
  const n = M.sent.length; E.runTrigger(10); assert.strictEqual(M.sent.length, n, 'waits 15 minutes'); E.runTrigger(6); assert(M.sent.length > n);
  M.nextErrors.push({ code: 131042, message: 'Business eligibility payment issue' });
  E.runTrigger(2);
  assert.strictEqual(camp().status, 'paused'); assert(/payment method/.test(camp().status_reason));
  assert.strictEqual(rows().filter(r => r.status === 'failed').length, 1, 'nobody blamed for an account problem');
  E.as('dad@gmail.com'); C.resumeCampaign(k.campaign_id);
  M.nextErrors.push({ code: 190, http: 401, message: 'Session has expired' });
  E.runTrigger(1);
  assert.strictEqual(camp().status, 'paused'); assert(/paste a new permanent token/.test(camp().status_reason));
  assert.strictEqual(C.getShopData('SHOP1').waApi.status, 'needs_reconnect');
  throwsMsg(() => C.resumeCampaign(k.campaign_id), /must reconnect it/);
  E.as('sara@gmail.com');
  C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: '' });
  C.resumeCampaign(k.campaign_id);
  E.runTrigger(10);
  assert.strictEqual(camp().status, 'completed');
});
t('daily limit and sending hours are respected', () => {
  E.setClock('2026-11-10T06:00:00Z'); // 10:00 UAE
  E.as('sara@gmail.com');
  const more = []; for (let i = 0; i < 5; i++) more.push({ full_name: 'Cap ' + i, phone: '05066600' + i + '0', consent_status: 'yes' });
  C.importContacts('SHOP1', more, {});
  const k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'named_hello', language: 'ar', mapping: { first_name: 'full_name' }, headerMapping: { shop: 'text:News' },
    delayMinutes: 1, randomExtra: false, dailyCap: 2, startHour: 9, endHour: 21, skipPrevious: false });
  const camp = () => E.tab('Campaigns', E.sheetOf('sara@gmail.com')).find(c => c.campaign_id === k.campaign_id);
  const sentToday = () => E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.status === 'sent' && l.channel === 'whatsapp' && l.sent_at.startsWith('2026-11-10')).length;
  E.runTrigger(20);
  assert.strictEqual(sentToday(), 2);
  assert(/Daily limit reached/.test(camp().status_reason), camp().status_reason);
  assert.strictEqual(camp().next_send_at, '2026-11-11T05:00:00.000Z');
  E.setClock('2026-11-10T19:00:00Z'); E.runTrigger(60); // night: nothing
  assert.strictEqual(E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.campaign_id === k.campaign_id && l.status === 'sent').length, 2);
  E.setClock('2026-11-11T05:00:30Z'); E.runTrigger(3);
  assert.strictEqual(E.tab('Send Log', E.sheetOf('sara@gmail.com')).filter(l => l.campaign_id === k.campaign_id && l.status === 'sent').length, 4);
  C.stopCampaign(k.campaign_id);
});
t('disconnect forgets the token and pauses running WhatsApp API sends', () => {
  E.as('sara@gmail.com');
  const more = [{ full_name: 'Disc', phone: '0505550000', consent_status: 'yes' }];
  C.importContacts('SHOP1', more, {});
  const k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap, startAt: new Date(E.now() + 3600e3).toISOString(), startHour: 0, endHour: 24 });
  const r = C.disconnectWhatsAppApi();
  assert.strictEqual(r.paused, 1);
  assert.strictEqual(E.userProps['sara@gmail.com']['WA_API_TOKEN_' + wsOf(E, 'sara@gmail.com')], undefined);
  assert.strictEqual(E.tab('Campaigns', E.sheetOf('sara@gmail.com')).find(c => c.campaign_id === k.campaign_id).status, 'paused');
  throwsMsg(() => C.getWhatsAppApiPreview({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap }), /needs attention/);
});
t('another workspace cannot use Sara\'s WhatsApp Business API', () => {
  E.as('owner@gmail.com');
  assert.strictEqual(C.getShopData('SHOP1').waApi.configured, false);
  throwsMsg(() => C.getWhatsAppApiPreview({ shopId: 'SHOP1', template: 'shop_followup', language: 'en_US', mapping: okMap }), /not set up/);
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
