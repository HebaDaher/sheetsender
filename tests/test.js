const assert = require('assert');
const path = require('path');
const { makeEnv } = require('./harness');
const SRC = require('path').join(__dirname, '..', 'src');
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}
function throwsMsg(fn, re) {
  let err; try { fn(); } catch (e) { err = e; }
  assert(err, 'expected an error matching ' + re);
  assert(re.test(err.message), 'error was: ' + err.message);
}
const arr = a => Array.from(a);
/** Workspace id of the person who owns it, and that workspace's settings. */
function wsOf(E, email) {
  const k = Object.keys(E.scriptProps).find(k => k.startsWith('W_') && JSON.parse(E.scriptProps[k]).owner === email);
  return k ? k.slice(2) : '';
}
function accountsOf(E, email) { return JSON.parse(E.scriptProps['ACCOUNTS@' + wsOf(E, email || 'owner@gmail.com')] || '{}'); }

const E = makeEnv(SRC);
const C = E.ctx;
const G = E.google;

console.log('Pure helpers');
t('phone normalization', () => {
  assert.strictEqual(C.normalizePhone_('0501234567', '971'), '971501234567');
  assert.strictEqual(C.normalizePhone_('+971 50 123 4567', '971'), '971501234567');
  assert.strictEqual(C.normalizePhone_('00971501234567', '971'), '971501234567');
  assert.strictEqual(C.normalizePhone_('501234567', '971'), '971501234567');
  assert.strictEqual(C.normalizePhone_('+44 7700 900123', '971'), '447700900123');
});
t('eligibility rules', () => {
  const base = { email: 'a@b.com', phone: '971501234567', consent_status: 'yes', opted_out: '' };
  assert(C.eligibility_(base, 'email').ok);
  assert.strictEqual(C.eligibility_({ ...base, opted_out: 'yes' }, 'email').reason, 'Opted out');
  assert.strictEqual(C.eligibility_({ ...base, consent_status: '' }, 'email').reason, 'No consent recorded');
  assert.strictEqual(C.eligibility_({ ...base, consent_status: 'no' }, 'email').reason, 'Did not give consent');
  assert(/unclear/.test(C.eligibility_({ ...base, consent_status: 'maybe' }, 'email').reason));
  assert(C.eligibility_({ ...base, consent_status: 'نعم' }, 'email').ok);
  assert.strictEqual(C.eligibility_({ ...base, phone: '' }, 'whatsapp').reason, 'No phone number');
});
t('template rendering + unknown fields', () => {
  const f = C.templateFields_({ full_name: 'Sara Ahmed' }, { shop_name: 'Shop A', sender_name: 'Adnan' });
  assert.strictEqual(C.renderText_('Hi {first_name} from {Shop_Name}', f), 'Hi Sara from Shop A');
  assert.deepStrictEqual(arr(C.unknownPlaceholders_('{first_name} {price}')), ['{price}']);
});
t('MIME email: UTF-8 subject/name, no header injection', () => {
  const mime = C.buildMime_({ from: 'a@gmail.com', fromName: 'محل البرشاء\r\nBcc: evil@x.com', to: 'b@x.com', subject: 'مرحبا {x}\nBcc: evil@x.com', text: 'نص' });
  assert(!/^Bcc:/mi.test(mime), 'no injected header');
  assert(/^Subject: =\?UTF-8\?B\?/m.test(mime));
  throwsMsg(() => C.buildMime_({ from: 'a@gmail.com', to: 'bad', subject: 's', text: 't' }), /Invalid email/);
});

console.log('Setup & access');
t('app refuses before setup', () => { E.as('dad@gmail.com'); throwsMsg(() => C.getBootstrap(), /not set up yet/); });
t('owner runs setup: creates the database Sheet, tabs, example, one trigger', () => {
  E.as('owner@gmail.com');
  const msg = C.setup();
  E.lastSetupMsg = C.setup();
  assert(/SHEET123/.test(msg));
  assert.deepStrictEqual(arr(E.ss.getSheets().map(s => s.name)), ['Shops', 'Contacts', 'Templates', 'Campaigns', 'Send Log']);
  assert.strictEqual(E.triggers.length, 1);
  assert.strictEqual(E.triggers[0].owner, 'owner@gmail.com');
  assert.strictEqual(E.tab('Shops')[0].sender_email, '');
});
t('nobody else can run setup (not from the web page, not as another account)', () => {
  E.as('dad@gmail.com'); throwsMsg(() => C.setup(), /must be run by the app administrator in the Apps Script editor/);
  E.users.active = E.users.effective = 'dad@gmail.com'; throwsMsg(() => C.setup(), /already done by owner@gmail.com/);
  E.as('owner@gmail.com'); C.addMember('dad@gmail.com'); // Dad helps in the owner's workspace
});
t('a stranger or a view-only person sees nobody else\'s data: they are offered their own workspace', () => {
  ['stranger@gmail.com', 'viewer@gmail.com'].forEach(who => {
    E.as(who);
    const b = C.getBootstrap();
    assert.strictEqual(b.needsWorkspace, true);
    assert(!b.shops && !b.sheetUrl, 'no data of anyone else');
    throwsMsg(() => C.getShopData('SHOP1'), /do not have a workspace yet/);
    throwsMsg(() => C.importContacts('SHOP1', [], {}), /do not have a workspace yet/);
  });
});
t('dad can open the app but not Settings or any Gmail action', () => {
  E.as('dad@gmail.com');
  const b = C.getBootstrap();
  assert.strictEqual(b.isOwner, false);
  assert.strictEqual(b.shops[0].senderOk, false);
  assert(/No Gmail account is chosen/.test(b.shops[0].senderProblem));
  ['getSettings', 'restartEngine'].forEach(fn => throwsMsg(() => C[fn](), /Only the owner of this workspace/));
  throwsMsg(() => C.saveOAuthClient(G.client.id, G.client.secret), /Only the owner of this workspace/);
  throwsMsg(() => C.startGmailConnect(''), /Only the owner of this workspace/);
  throwsMsg(() => C.assignShopSender('SHOP1', 'x@gmail.com'), /Only the owner of this workspace/);
  throwsMsg(() => C.testGmailAccount('x@gmail.com'), /Only the owner of this workspace/);
  throwsMsg(() => C.disconnectGmailAccount('x@gmail.com'), /Only the owner of this workspace/);
});
t('owner home screen says what setup is left', () => {
  E.as('owner@gmail.com');
  assert(/Client ID/.test(C.getBootstrap().settingsNeeded));
});

console.log('Google sign-in client');
t('client ID is validated; secret is kept server-side only (never in a page or a Sheet)', () => {
  E.as('owner@gmail.com');
  throwsMsg(() => C.saveOAuthClient('nonsense', 'x'), /Client ID/);
  throwsMsg(() => C.saveOAuthClient(G.client.id, ''), /Client secret/);
  C.saveOAuthClient(G.client.id, G.client.secret);
  assert.strictEqual(E.scriptProps.OAUTH_CLIENT_SECRET, G.client.secret);
  assert.strictEqual(Object.keys(E.scriptProps).filter(k => E.scriptProps[k].includes(G.client.secret)).join(), 'OAUTH_CLIENT_SECRET');
  const st = C.getSettings();
  assert(!JSON.stringify(st).includes(G.client.secret), 'secret never returned to the page');
  assert.strictEqual(st.clientSecretSaved, true);
  assert.strictEqual(st.redirectUri, G.redirect);
  assert.strictEqual(st.redirectUri, 'https://script.google.com/macros/s/DEPLOY123/exec', 'Google sends people back to the app itself');
  C.saveOAuthClient(G.client.id, ''); // blank keeps the saved secret
  assert.strictEqual(E.scriptProps.OAUTH_CLIENT_SECRET, G.client.secret);
});
t('a secret saved by the older version (admin\'s private store) moves to the server store by itself', () => {
  E.as('owner@gmail.com');
  delete E.scriptProps.OAUTH_CLIENT_SECRET; E.dropCache();
  E.userProps['owner@gmail.com'].OAUTH_CLIENT_SECRET = G.client.secret;
  assert.strictEqual(C.getSettings().clientSecretSaved, true);
  assert.strictEqual(E.scriptProps.OAUTH_CLIENT_SECRET, G.client.secret);
  assert.strictEqual(E.userProps['owner@gmail.com'].OAUTH_CLIENT_SECRET, undefined);
});

console.log('Sign in with Google (no warning screen: only the email is asked)');
t('right after setup, the administrator signs in with a one-time link (before the sign-in client exists)', () => {
  const tok = (E.lastSetupMsg.match(/\?first=([0-9a-f]{64})/) || [])[1];
  assert(tok, E.lastSetupMsg);
  assert.strictEqual(E.real.finishFirstLogin(tok).email, 'owner@gmail.com');
  throwsMsg(() => E.real.finishFirstLogin(tok), /already used or has expired/);
  throwsMsg(() => E.real.finishFirstLogin('0'.repeat(64)), /already used or has expired/);
});
t('"Sign in with Google" asks Google only for the email address', () => {
  const url = new URL(E.real.startLogin());
  const q = Object.fromEntries(url.searchParams);
  assert.strictEqual(q.scope, 'openid email', 'no Gmail, Drive or Sheets permission');
  assert.strictEqual(q.redirect_uri, G.redirect);
  assert.strictEqual(q.prompt, 'select_account', 'the person chooses the account (works with several in one browser)');
  assert.strictEqual(q.access_type, 'online');
});
t('signing in gives a session for exactly that Google account', () => {
  const r = E.login('sara.login@gmail.com');
  assert.strictEqual(r.result.email, 'sara.login@gmail.com');
  assert.strictEqual(C.getBootstrap().user, 'sara.login@gmail.com');
  assert(G.revoked.length > 0, 'the access token is not kept');
  throwsMsg(() => E.real.finishLogin(G.consent('x@gmail.com'), r.query.state, ''), /expired or was already used/);
  throwsMsg(() => E.real.finishLogin(G.consent('x@gmail.com'), 'forged', ''), /expired or was already used/);
  const u = new URL(E.real.startLogin()); throwsMsg(() => E.real.finishLogin('', u.searchParams.get('state'), 'access_denied'), /cancelled/);
});
t('a forged, changed or expired session is refused; the page cannot pick who it is', () => {
  const good = E.sessionFor('dad@gmail.com');
  const [a, b] = good.split('.');
  const forged = Buffer.from('owner@gmail.com').toString('base64url') + '.' + b + '.' + good.split('.')[2];
  [forged, a + '.' + (Number(b) + 1) + '.' + good.split('.')[2], 'x.y.z', '', null].forEach(tok => {
    throwsMsg(() => E.real.api(tok, 'getBootstrap', []), /SIGNED_OUT/);
  });
  const soon = E.real.makeSession_('dad@gmail.com'); E.advance(31 * 24 * 60);
  throwsMsg(() => E.real.api(soon, 'getBootstrap', []), /SIGNED_OUT/);
  E.advance(-31 * 24 * 60);
});
t('a crafted link cannot put code into the page (Google\'s return values are checked and escaped)', () => {
  const page = {}; const R = E.real; const orig = R.HtmlService.createTemplateFromFile;
  R.HtmlService.createTemplateFromFile = () => Object.assign(page, { evaluate() { return this; }, setTitle() { return this; }, addMetaTag() { return this; } });
  try {
    ['</script><script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'a'.repeat(600)].forEach(code => {
      R.doGet({ parameter: { state: 'abc-123', code } });
      assert.strictEqual(page.oauthJs, '""', 'refused: ' + code.slice(0, 20));
    });
    R.doGet({ parameter: { state: '<script>', code: 'x' } }); assert.strictEqual(page.oauthJs, '""');
    R.doGet({ parameter: { state: 'abc-123', code: '4/0AX4XfW-good_code.1~' } });
    assert(/4\/0AX4XfW-good_code\.1~/.test(page.oauthJs) && !/</.test(page.oauthJs));
    assert(!/<\/script/i.test(R.safeJs_('</script><b>')), 'escaped even if something got through');
  } finally { R.HtmlService.createTemplateFromFile = orig; }
});
t('anyone calling sign-in or the sender in a loop is slowed down (protects the daily limits)', () => {
  E.advance(2);
  for (let i = 0; i < 300; i++) E.real.startLogin();
  throwsMsg(() => E.real.startLogin(), /Too many tries/);
  E.advance(2);
  assert(E.real.startLogin(), 'fine again a minute later');
  const runs = () => Object.keys(E.scriptCache).filter(k => k === 'PQ_RAN').length;
  const before = E.scriptProps.LAST_RUN;
  E.real.processQueue(); const first = E.scriptProps.LAST_RUN;
  E.advance(0.2); for (let i = 0; i < 50; i++) E.real.processQueue();
  assert.strictEqual(E.scriptProps.LAST_RUN, first, 'extra calls within 50 seconds do nothing');
  assert(runs() === 1 && first !== before);
});
t('page actions only through the sign-in door; server-only functions cannot be called', () => {
  throwsMsg(() => E.real.getBootstrap(), /SIGNED_OUT/);         // a direct call has no session
  throwsMsg(() => E.real.getSettings(), /SIGNED_OUT/);
  const tok = E.sessionFor('owner@gmail.com');
  ['getAccessToken_', 'sendGmail_', 'setup', 'processQueue', 'makeSession_', 'api', 'ownerSecrets_'].forEach(fn => {
    throwsMsg(() => E.real.api(tok, fn, []), /Unknown action/);
  });
});

console.log('Connecting Gmail accounts (OAuth)');
t('consent URL asks only for openid, email and gmail.send, offline, with state', () => {
  E.as('owner@gmail.com');
  const url = new URL(C.startGmailConnect('shop1@gmail.com'));
  const q = Object.fromEntries(url.searchParams);
  assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepStrictEqual(q.scope.split(' '), ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send']);
  assert.strictEqual(q.access_type, 'offline');
  assert(/consent/.test(q.prompt));
  assert.strictEqual(q.redirect_uri, G.redirect);
  assert.strictEqual(q.login_hint, 'shop1@gmail.com');
  assert(q.state && q.state.length > 20);
});
t('connect shop1@gmail.com: token stored privately, status public, nothing secret in Sheet', () => {
  E.as('owner@gmail.com');
  const r = E.connect('shop1@gmail.com');
  assert(/Connected: shop1@gmail.com/.test(r.html), r.html);
  const tok = JSON.parse(E.userProps['owner@gmail.com'].GMAIL_TOKEN_shop1_gmail_com || E.userProps['owner@gmail.com']['GMAIL_TOKEN_shop1@gmail.com']);
  assert(tok.refresh_token.startsWith('rt_'));
  assert(!JSON.stringify(E.scriptProps).includes(tok.refresh_token), 'no token in script properties');
  assert.strictEqual(accountsOf(E)['shop1@gmail.com'].status, 'connected');
  assert(!JSON.stringify(C.getSettings()).includes('rt_'), 'no token sent to the page');
});
t('a used or unknown state is refused (no replay)', () => {
  E.as('owner@gmail.com');
  const url = new URL(C.startGmailConnect(''));
  const state = url.searchParams.get('state');
  assert.strictEqual(C.finishGmailConnect(G.consent('replay@gmail.com'), state, ''), 'replay@gmail.com');
  throwsMsg(() => C.finishGmailConnect(G.consent('replay@gmail.com'), state, ''), /expired or was already used/);
  throwsMsg(() => C.finishGmailConnect(G.consent('x@gmail.com'), 'forged', ''), /expired or was already used/);
  C.disconnectGmailAccount('replay@gmail.com');
});
t('Cancel on Google\'s page is explained', () => {
  E.as('owner@gmail.com');
  assert(/Cancel was clicked/.test(E.connect('x@gmail.com', { cancel: true }).html));
});
t('if "Send email" was not ticked, nothing is saved and the token is revoked', () => {
  E.as('owner@gmail.com');
  const before = G.revoked.length;
  const r = E.connect('noticks@gmail.com', { tickSend: false });
  assert(/was not ticked/.test(r.html));
  assert(!accountsOf(E)['noticks@gmail.com']);
  assert(G.revoked.length > before);
});
t('the callback only works for the owner\'s browser session', () => {
  E.as('owner@gmail.com');
  const r = E.connect('sneaky@gmail.com', { callbackAs: 'dad@gmail.com' });
  assert(/signed in as the owner of the workspace/.test(r.html), r.html);
  assert(!accountsOf(E)['sneaky@gmail.com']);
});
t('only the owner\'s code can read tokens (Dad\'s session and Dad-owned triggers cannot)', () => {
  E.as('dad@gmail.com');
  throwsMsg(() => C.getAccessToken_('shop1@gmail.com'), /Only the workspace owner account/);
  throwsMsg(() => C.sendGmail_({ from: 'shop1@gmail.com', to: 'a@b.com', subject: 's', text: 't' }), /Only the workspace owner account/);
});
t('connect a second account; assign senders per shop', () => {
  E.as('owner@gmail.com');
  E.connect('shop2@gmail.com');
  const sheet = E.ss.getSheetByName('Shops');
  sheet.grid.push(['SHOP2', 'Marina Shop', '', 'Marina Shop', 'dad@gmail.com', '971', 'yes', '']);
  sheet.grid.push(['SHOP3', 'Deira Shop', '', 'Deira', '', '971', 'yes', '']);
  C.assignShopSender('SHOP1', 'Shop1@Gmail.com');
  C.assignShopSender('SHOP2', 'shop2@gmail.com');
  throwsMsg(() => C.assignShopSender('SHOP3', 'notconnected@gmail.com'), /not a connected Gmail account/);
  const shops = E.tab('Shops');
  assert.strictEqual(shops.find(s => s.shop_id === 'SHOP1').sender_email, 'shop1@gmail.com');
  E.as('dad@gmail.com');
  const b = C.getBootstrap();
  assert.strictEqual(JSON.stringify(b.shops.map(s => [s.shop_id, s.senderOk])), JSON.stringify([['SHOP1', true], ['SHOP2', true], ['SHOP3', false]]));
});
t('Send test: email goes from the account to itself', () => {
  E.as('owner@gmail.com');
  const r = C.testGmailAccount('shop2@gmail.com');
  assert(/Test email sent/.test(r.message));
  const last = E.sent[E.sent.length - 1];
  assert.strictEqual(last.account, 'shop2@gmail.com');
  assert.strictEqual(last.to, 'shop2@gmail.com');
  assert(C.getSettings().accounts.find(a => a.email === 'shop2@gmail.com').last_test_at);
  E.sent.length = 0;
});

console.log('Import');
const rows = [
  { full_name: 'Sara Ahmed', email: 'Sara@Example.com', phone: '0501111111', consent_status: 'yes' },
  { full_name: 'Omar Khalid', email: 'omar@example.com', phone: '+971 50 222 2222', consent_status: 'Yes' },
  { full_name: 'No Consent', email: 'nc@example.com', phone: '0503333333', consent_status: '' },
  { full_name: 'Said No', email: 'no@example.com', consent_status: 'no' },
  { full_name: 'Opted Out', email: 'out@example.com', consent_status: 'yes', opted_out: 'yes' },
  { full_name: 'Bad Email', email: 'not-an-email', consent_status: 'yes' },
  { full_name: '=HYPERLINK("x")', email: 'formula@example.com', consent_status: 'yes' },
  { full_name: 'Phone Only', phone: '0504444444', consent_status: 'yes' },
  { full_name: 'Nothing', consent_status: 'yes' },
  { full_name: '', email: '', phone: '' },
  { full_name: 'Sara Duplicate Row', email: 'sara@example.com', consent_status: 'yes' }
];
t('import adds, validates and dedupes', () => {
  E.as('dad@gmail.com');
  const r = C.importContacts('SHOP1', rows, { fileName: 'shop1.xlsx', firstRowNumber: 2 });
  assert.strictEqual(r.added, 8);
  assert.strictEqual(r.rejected, 1);
  assert(r.problems.some(p => /Row 12: same person/.test(p)));
  const c = E.tab('Contacts');
  assert.strictEqual(c.find(x => x.email === 'sara@example.com').phone, '971501111111');
  assert.strictEqual(c.find(x => x.email === 'formula@example.com').full_name, '=HYPERLINK("x")');
});
t('re-import never clears an opt-out', () => {
  C.importContacts('SHOP1', [{ full_name: 'Opted Out', email: 'out@example.com', consent_status: 'yes', opted_out: '' }], {});
  assert.strictEqual(E.tab('Contacts').find(c => c.email === 'out@example.com').opted_out, 'yes');
});
t('large import grows the sheet beyond 1000 rows', () => {
  const big = [];
  for (let i = 0; i < 1100; i++) big.push({ full_name: 'P' + i, email: 'p' + i + '@bulk.com', consent_status: 'no' });
  C.importContacts('SHOP3', big.slice(0, 600), {}); C.importContacts('SHOP3', big.slice(600), {});
  assert.strictEqual(E.tab('Contacts').filter(c => c.shop_id === 'SHOP3').length, 1100);
});

console.log('Preview & start');
t('preview shows counts, reasons, the shop\'s connected sender', () => {
  const p = C.getCampaignPreview({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 5 });
  assert.strictEqual(p.willSend, 3);
  assert.strictEqual(p.willSkip, 5);
  assert.strictEqual(p.preview.from, 'shop1@gmail.com');
  assert(p.preview.body.startsWith('Hi Sara,'));
  assert.strictEqual(p.sender.ok, true);
});
t('cannot start a shop whose Gmail is not connected', () => {
  E.as('owner@gmail.com');
  const tpl = C.saveTemplate({ shop_id: 'SHOP3', template_name: 'Deira email', channel: 'email', subject: 'Hi', body: 'Hello' });
  C.importContacts('SHOP3', [{ full_name: 'Ok', email: 'ok@x.com', consent_status: 'yes' }], {});
  throwsMsg(() => C.startCampaign({ shopId: 'SHOP3', templateId: tpl.template_id }), /No Gmail account is chosen/);
});
let camp;
t('start queues everyone; clicking start sends nothing by itself', () => {
  E.as('dad@gmail.com');
  camp = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 5 });
  const log = E.tab('Send Log').filter(l => l.campaign_id === camp.campaign_id);
  assert.strictEqual(log.filter(l => l.status === 'pending').length, 3);
  assert.strictEqual(log[0].sender_email, 'shop1@gmail.com');
  assert.strictEqual(E.sent.length, 0);
});

console.log('Sending engine (Gmail API)');
t('sends from the shop\'s own Gmail account, one per delay', () => {
  E.runTrigger(1);
  assert.strictEqual(E.sent.length, 1);
  const m = E.sent[0];
  assert.strictEqual(m.account, 'shop1@gmail.com');
  assert(m.from.includes('<shop1@gmail.com>'));
  assert.strictEqual(m.fromName, 'Example Shop');
  assert.strictEqual(m.subject, 'Still interested in Example Shop?');
  assert(m.text.startsWith('Hi Sara,'));
  E.runTrigger(4); assert.strictEqual(E.sent.length, 1);
  E.runTrigger(1); assert.strictEqual(E.sent.length, 2);
});
t('an expired access token is refreshed automatically', () => {
  G.expireAccessTokens();
  const formula = E.tab('Contacts').find(c => c.email === 'formula@example.com');
  C.markOptedOut(formula.contact_id, 'asked'); // opt-out mid-campaign
  E.runTrigger(30);
  const c = E.tab('Campaigns').find(x => x.campaign_id === camp.campaign_id);
  assert.strictEqual(c.status, 'completed');
  assert.strictEqual(c.sent, '2');
  assert.strictEqual(E.sent.filter(s => s.to === 'formula@example.com').length, 0);
});
t('no duplicates: same message again skips everyone', () => {
  throwsMsg(() => C.startCampaign({ shopId: 'SHOP1', templateId: 'T1' }), /Nobody can receive.*Already received/);
});
t('another shop sends from its own account with Reply-To and UTF-8 subject', () => {
  E.as('owner@gmail.com');
  const tpl = C.saveTemplate({ shop_id: 'SHOP2', template_name: 'AR', channel: 'email', subject: 'عرض {shop_name}', body: 'مرحبا {first_name}' });
  C.importContacts('SHOP2', [{ full_name: 'ليلى', email: 'layla@x.com', consent_status: 'نعم' }], {});
  C.startCampaign({ shopId: 'SHOP2', templateId: tpl.template_id, delayMinutes: 1 });
  E.runTrigger(2);
  const m = E.sent.find(s => s.to === 'layla@x.com');
  assert.strictEqual(m.account, 'shop2@gmail.com');
  assert.strictEqual(m.subject, 'عرض Marina Shop');
  assert.strictEqual(m.text, 'مرحبا ليلى');
  assert.strictEqual(m.replyTo, 'dad@gmail.com');
});

console.log('Email written on the Send page');
t('a written email: each person gets their own name; saved as a new message when sending starts', () => {
  E.as('dad@gmail.com');
  C.importContacts('SHOP2', [{ full_name: 'Heba Daher', email: 'heba@x.com', consent_status: 'yes' }, { full_name: 'Adnan Daher', email: 'adnan@x.com', consent_status: 'yes' }], {});
  const params = { shopId: 'SHOP2', subject: 'News for {first_name}', body: 'Hello {first_name},\n\nThe shop is still available.', delayMinutes: 1 };
  const p = C.getCampaignPreview(params);
  assert.strictEqual(p.willSend, 3); // layla + heba + adnan
  assert(p.preview.samples.some(x => x.firstLine === 'Hello Heba,'));
  assert(p.preview.samples.some(x => x.firstLine === 'Hello Adnan,'));
  const before = E.tab('Templates').length;
  const k = C.startCampaign(params);
  assert.strictEqual(E.tab('Templates').length, before + 1, 'saved as a new message');
  const t = E.tab('Templates').find(x => x.template_id === k.template_id);
  assert.strictEqual(t.subject, 'News for {first_name}');
  E.runTrigger(4);
  const heba = E.sent.find(m => m.to === 'heba@x.com'), adnan = E.sent.find(m => m.to === 'adnan@x.com');
  assert.strictEqual(heba.subject, 'News for Heba');
  assert(heba.text.startsWith('Hello Heba,'));
  assert(adnan.text.startsWith('Hello Adnan,'));
  assert.strictEqual(heba.account, 'shop2@gmail.com');
});
t('the exact same written email again skips people who already got it; changed text does not', () => {
  const same = { shopId: 'SHOP2', subject: 'News for {first_name}', body: 'Hello {first_name},\n\nThe shop is still available.' };
  throwsMsg(() => C.startCampaign(same), /Already received this message/);
  const n = E.tab('Templates').length;
  const changed = C.getCampaignPreview({ shopId: 'SHOP2', subject: 'Update for {first_name}', body: 'Hi {first_name}, new price.' });
  assert.strictEqual(changed.willSend, 3);
  assert.strictEqual(E.tab('Templates').length, n, 'preview saves nothing');
});
t('a written email is checked before sending', () => {
  throwsMsg(() => C.getCampaignPreview({ shopId: 'SHOP2', subject: '', body: 'x' }), /Write a subject/);
  throwsMsg(() => C.getCampaignPreview({ shopId: 'SHOP2', subject: 's', body: '  ' }), /Write the message/);
  throwsMsg(() => C.getCampaignPreview({ shopId: 'SHOP2', subject: 's', body: 'Hi {name}' }), /not known: \{name\}/);
});

t('saved messages: delete hides it from the lists, keeps history; same text again brings it back', () => {
  E.as('dad@gmail.com');
  const t = C.saveTemplate({ shop_id: 'SHOP2', template_name: 'Temp msg', channel: 'email', subject: 'Temp {first_name}', body: 'Hello {first_name}, temporary message text here.' });
  assert(C.getShopData('SHOP2').templates.some(x => x.template_id === t.template_id));
  C.deleteTemplate(t.template_id, 'SHOP2');
  assert(!C.getShopData('SHOP2').templates.some(x => x.template_id === t.template_id), 'hidden from the lists');
  assert.strictEqual(E.tab('Templates').find(x => x.template_id === t.template_id).active, 'deleted', 'kept for history');
  throwsMsg(() => C.deleteTemplate(t.template_id, 'SHOP1'), /another shop/);
  const k = C.startCampaign({ shopId: 'SHOP2', subject: 'Temp {first_name}', body: 'Hello {first_name}, temporary message text here.', delayMinutes: 1 });
  assert.strictEqual(k.template_id, t.template_id, 'same text re-uses the saved message');
  assert(C.getShopData('SHOP2').templates.some(x => x.template_id === t.template_id), 'and it is back in the list');
  C.stopCampaign(k.campaign_id);
  const u = C.saveTemplate({ template_id: t.template_id, shop_id: 'SHOP2', template_name: 'Temp msg', channel: 'email', subject: 'Edited {first_name}', body: 'Edited text for {first_name} here.' });
  assert.strictEqual(E.tab('Templates').find(x => x.template_id === u.template_id).subject, 'Edited {first_name}', 'edit saves in place');
});
console.log('Expiry, disconnect, reconnect, errors');
let c2;
t('permission revoked/expired at Google → send pauses with reconnect steps; nobody marked failed', () => {
  E.as('dad@gmail.com');
  const extra = []; for (let i = 0; i < 4; i++) extra.push({ full_name: 'Guest ' + i, email: 'g' + i + '@ex.com', consent_status: 'yes' });
  C.importContacts('SHOP1', extra, {});
  c2 = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 1 });
  E.runTrigger(1);
  const before = E.sent.length;
  G.expireAll('shop1@gmail.com'); G.expireAccessTokens();
  E.runTrigger(3);
  assert.strictEqual(E.sent.length, before);
  const c = E.tab('Campaigns').find(x => x.campaign_id === c2.campaign_id);
  assert.strictEqual(c.status, 'paused');
  assert(/needs to be reconnected/.test(c.status_reason) && /Reconnect/.test(c.status_reason), c.status_reason);
  assert.strictEqual(E.tab('Send Log').filter(l => l.campaign_id === c2.campaign_id && l.status === 'failed').length, 0);
  assert.strictEqual(accountsOf(E)['shop1@gmail.com'].status, 'needs_reconnect');
  throwsMsg(() => C.resumeCampaign(c2.campaign_id), /needs to be reconnected/);
  throwsMsg(() => C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', skipPrevious: false }), /needs to be reconnected/);
});
t('reconnect the same account → resume finishes the send', () => {
  E.as('owner@gmail.com');
  const r = E.connect('shop1@gmail.com', { hint: 'shop1@gmail.com' });
  assert(/Connected: shop1@gmail.com/.test(r.html));
  assert.strictEqual(r.query.login_hint, 'shop1@gmail.com');
  E.as('dad@gmail.com');
  C.resumeCampaign(c2.campaign_id);
  E.runTrigger(5);
  assert.strictEqual(E.tab('Campaigns').find(x => x.campaign_id === c2.campaign_id).status, 'completed');
  assert.strictEqual(E.sent.filter(s => /^g\d@ex.com$/.test(s.to)).length, 4);
});
t('disconnect revokes the token at Google, deletes it, pauses running sends', () => {
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Late', email: 'late@ex.com', consent_status: 'yes' }, { full_name: 'Late2', email: 'late2@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 10 });
  E.runTrigger(1);
  E.as('owner@gmail.com');
  const tok = JSON.parse(E.userProps['owner@gmail.com']['GMAIL_TOKEN_shop1@gmail.com']).refresh_token;
  const r = C.disconnectGmailAccount('shop1@gmail.com');
  assert.strictEqual(r.paused, 1);
  assert(G.revoked.includes(tok));
  assert.strictEqual(E.userProps['owner@gmail.com']['GMAIL_TOKEN_shop1@gmail.com'], undefined);
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  assert.strictEqual(c.status, 'paused');
  assert(/disconnected/.test(c.status_reason));
  const n = E.sent.length; E.runTrigger(30); assert.strictEqual(E.sent.length, n);
  assert(/was disconnected/.test(C.getBootstrap().shops[0].senderProblem));
  E.connect('shop1@gmail.com');
  C.resumeCampaign(k.campaign_id);
  E.runTrigger(15);
  assert.strictEqual(E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id).status, 'completed');
});
t('Gmail daily limit → people wait, retried hourly', () => {
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Q', email: 'q@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 1 });
  G.nextSendError = { code: 403, body: { error: { code: 403, message: 'Daily user sending limit exceeded.', errors: [{ reason: 'dailyLimitExceeded' }] } } };
  E.runTrigger(2);
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  assert(/daily sending limit/.test(c.status_reason));
  assert.strictEqual(E.tab('Send Log').find(l => l.campaign_id === k.campaign_id && l.email === 'q@ex.com').status, 'pending');
  E.runTrigger(65);
  assert.strictEqual(E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id).status, 'completed');
});
t('Gmail rejects an address → that person failed, the send continues', () => {
  C.importContacts('SHOP1', [{ full_name: 'Bounce', email: 'bounce@ex.com', consent_status: 'yes' }, { full_name: 'After', email: 'after@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 1 });
  G.nextSendError = { code: 400, body: { error: { code: 400, message: 'Invalid To header', errors: [{ reason: 'invalidArgument' }] } } };
  E.runTrigger(5);
  const log = E.tab('Send Log').filter(l => l.campaign_id === k.campaign_id);
  assert.strictEqual(log.find(l => l.email === 'bounce@ex.com').status, 'failed');
  assert.strictEqual(log.find(l => l.email === 'after@ex.com').status, 'sent');
});
t('pause / resume / stop', () => {
  C.importContacts('SHOP1', [1, 2, 3].map(i => ({ full_name: 'S' + i, email: 's' + i + '@ex.com', consent_status: 'yes' })), {});
  const k = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1', delayMinutes: 2 });
  E.runTrigger(1); const n = E.sent.length;
  C.pauseCampaign(k.campaign_id); E.runTrigger(20); assert.strictEqual(E.sent.length, n);
  C.resumeCampaign(k.campaign_id); E.runTrigger(1); assert.strictEqual(E.sent.length, n + 1);
  C.stopCampaign(k.campaign_id);
  // bounce@ (failed in an earlier send) is retried here too, so 4 queued: 2 sent, 2 cancelled
  assert.strictEqual(E.tab('Send Log').filter(l => l.campaign_id === k.campaign_id && l.status === 'cancelled').length, 2);
  E.runTrigger(30); assert.strictEqual(E.sent.length, n + 1);
});
t('a trigger owned by anyone but the owner never sends', () => {
  E.triggers[0].owner = 'dad@gmail.com';
  C.importContacts('SHOP1', [{ full_name: 'Z', email: 'z@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', templateId: 'T1' });
  const n = E.sent.length; E.runTrigger(5); assert.strictEqual(E.sent.length, n);
  E.triggers[0].owner = 'owner@gmail.com';
  C.stopCampaign(k.campaign_id);
});
t('owner can restart the sender (trigger stays owned by the owner)', () => {
  E.as('owner@gmail.com');
  C.restartEngine();
  assert.strictEqual(E.triggers.length, 1);
  assert.strictEqual(E.triggers[0].owner, 'owner@gmail.com');
});

console.log('WhatsApp, page, privacy');
t('WhatsApp open is logged; ineligible refused', () => {
  E.as('dad@gmail.com');
  const c = E.tab('Contacts');
  assert(C.logWhatsAppOpened(c.find(x => x.email === 'omar@example.com').contact_id, 'T2').at);
  throwsMsg(() => C.logWhatsAppOpened(c.find(x => x.email === 'nc@example.com').contact_id, 'T2'), /No consent recorded/);
});
t('automatic WhatsApp: send list has only eligible people with their own name', () => {
  E.as('dad@gmail.com');
  const job = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hello {first_name}, the shop is still available.' });
  assert.strictEqual(job.kind, 'shop-followups-whatsapp-job');
  const omar = job.items.find(i => i.phone === '971502222222');
  assert(omar && omar.text === 'Hello Omar, the shop is still available.', JSON.stringify(omar));
  assert(!job.items.some(i => i.phone === '971503333333'), 'no-consent person excluded');
  assert(job.skipped.some(x => x.reason === 'No consent recorded'));
  assert.strictEqual(job.rules.delayMinutes, 5);
  assert.strictEqual(job.rules.dailyCap, 30);
  assert(E.tab('Templates').some(t => t.channel === 'whatsapp' && t.body === 'Hello {first_name}, the shop is still available.'), 'message saved');
  global.__job = job;
});
t('automatic WhatsApp: results upload is recorded once; next list skips them', () => {
  const job = global.__job;
  const results = { kind: 'shop-followups-whatsapp-results', job_id: job.job_id, shop_id: job.shop_id, template_id: job.template_id, created_at: job.created_at,
    items: [{ contact_id: job.items[0].contact_id, status: 'sent', at: '2026-11-02T10:00:00' }, { contact_id: job.items[1].contact_id, status: 'failed', reason: 'This number is not on WhatsApp' }] };
  const n = C.importWhatsAppResults(results);
  assert.strictEqual(n.sent, 1); assert.strictEqual(n.failed, 1);
  const again = C.importWhatsAppResults(results);
  assert.strictEqual(again.sent + again.failed, 0); assert.strictEqual(again.already, 2);
  const next = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hello {first_name}, the shop is still available.' });
  assert(!next.items.some(i => i.contact_id === job.items[0].contact_id), 'sent person skipped next time');
  assert(next.items.some(i => i.contact_id === job.items[1].contact_id), 'failed person can be tried again');
  throwsMsg(() => C.importWhatsAppResults({ hello: 1 }), /not a WhatsApp results file/);
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {price}' }), /not known/);
});
t('WhatsApp helper bridge: wrong or missing token refused', () => {
  assert.strictEqual(E.bridge({ token: 'nope', action: 'poll' }).error, 'not allowed');
  assert.strictEqual(E.bridge({ token: 'nope-but-long-enough-to-look-like-a-token', action: 'poll' }).error, 'not allowed');
  assert.strictEqual(E.bridge({ action: 'poll' }).error, 'not allowed');
});
t('WhatsApp helper: offline helper → Start is refused with a clear message', () => {
  E.as('dad@gmail.com');
  const h = C.getWhatsAppHelper();
  assert.strictEqual(h.online, false); assert.strictEqual(h.installed, true);
  throwsMsg(() => C.startWhatsAppAuto({ shopId: 'SHOP1', body: 'Hi {first_name}' }), /not running/);
});
t('WhatsApp helper: poll → online + status; Start → command; job fetched; results recorded; ack clears', () => {
  let r = E.bridge({ token: 'test-token', action: 'poll', status: { wa: 'connected', version: 2, sent_today: 0 } });
  assert(r.ok && r.commands.length === 0);
  E.as('dad@gmail.com');
  const h = C.getWhatsAppHelper();
  assert.strictEqual(h.online, true); assert.strictEqual(h.wa, 'connected');
  const st = C.startWhatsAppAuto({ shopId: 'SHOP1', body: 'Bridge hello {first_name}', delayMinutes: 6, randomExtra: false, dailyCap: 25, startHour: 9, endHour: 21 });
  assert(st.people > 0);
  r = E.bridge({ token: 'test-token', action: 'poll', status: { wa: 'connected' } });
  assert.strictEqual(r.commands.length, 1); assert.strictEqual(r.commands[0].type, 'start');
  const job = E.bridge({ token: 'test-token', action: 'job', command_id: r.commands[0].id }).job;
  assert.strictEqual(job.items.length, st.people);
  assert(job.items[0].text.startsWith('Bridge hello '));
  assert.strictEqual(job.rules.delayMinutes, 6); assert.strictEqual(job.rules.randomExtra, false);
  assert.strictEqual(E.bridge({ token: 'test-token', action: 'ack', ids: [r.commands[0].id] }).ok, true);
  assert.strictEqual(E.bridge({ token: 'test-token', action: 'poll', status: {} }).commands.length, 0);
  const res = { kind: 'shop-followups-whatsapp-results', job_id: job.job_id, shop_id: job.shop_id, template_id: job.template_id, created_at: job.created_at,
    items: [{ contact_id: job.items[0].contact_id, phone: job.items[0].phone, status: 'sent', at: '2026-11-02T12:00:00' }] };
  const saved = E.bridge({ token: 'test-token', action: 'results', results: res }).saved;
  assert.strictEqual(saved.sent, 1);
  assert.strictEqual(E.bridge({ token: 'test-token', action: 'results', results: res }).saved.already, 1);
  assert(E.tab('Send Log').some(l => l.channel === 'whatsapp' && l.contact_id === job.items[0].contact_id && l.done_by === 'WhatsApp Sender (Mac)'));
  // stop + open commands, a second start replaces a waiting one
  C.stopWhatsAppAuto(); C.openWhatsAppOnMac();
  assert.deepStrictEqual(Array.from(C.getWhatsAppHelper().pending.map(p => p.type)), ['stop', 'open']);
  E.bridge({ token: 'test-token', action: 'ack', ids: E.bridge({ token: 'test-token', action: 'poll', status: {} }).commands.map(c => c.id) });
  // running job reported → Start refused
  E.bridge({ token: 'test-token', action: 'poll', status: { wa: 'connected', job: { state: 'running', shop_name: 'Example Shop' } } });
  throwsMsg(() => C.startWhatsAppAuto({ shopId: 'SHOP1', body: 'Hi {first_name}' }), /already running/);
  // helper goes quiet → offline after 45 s
  E.advance(1);
  assert.strictEqual(C.getWhatsAppHelper().online, false);
});
t('doGet serves the app; include only serves app files', () => {
  assert.strictEqual(C.doGet({ parameter: {} }).page, 'Index');
  assert(C.include('SheetJS').includes('make_xlsx_lib'));
  throwsMsg(() => C.include('Code'), /Unknown file/);
});
t('no token or secret anywhere in the Sheet; no Gmail token in script properties', () => {
  const sheetText = JSON.stringify(E.ss.sheets.map(s => s.grid));
  assert(!/\brt_\d|\bat_\d|GOCSPX/.test(sheetText));
  const props = Object.assign({}, E.scriptProps); delete props.OAUTH_CLIENT_SECRET;
  assert(!/\brt_\d|\bat_\d|GOCSPX/.test(JSON.stringify(props)));
});
t('the app never uses GmailApp', () => {
  const src = ['Code.gs', 'Workspaces.gs', 'Senders.gs', 'Sending.gs', 'WhatsAppApi.gs'].map(f => require('fs').readFileSync(path.join(SRC, f), 'utf8')).join('');
  assert(!/GmailApp\./.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});

console.log('Safe sending (spam / account protection) — fresh simulation');
{
const E = makeEnv(SRC); const C = E.ctx; const G = E.google;
E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret); C.addMember('dad@gmail.com');
E.connect('shop1@gmail.com'); C.assignShopSender('SHOP1', 'shop1@gmail.com');
E.ss.getSheetByName('Shops').grid[1][4] = 'dad@gmail.com'; // reply_to for SHOP1
C.testGmailAccount('shop1@gmail.com');
E.as('dad@gmail.com');
C.importContacts('SHOP1', [{ full_name: 'Heba Daher', email: 'heba@x.com', consent_status: 'yes' }], {});
C.startCampaign({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Hello {first_name}, the shop is still available. Would you like to visit?', delayMinutes: 3 });
E.runTrigger(2);

t('emails carry Date, Message-ID and an Unsubscribe header (to the reply-to address)', () => {
  const m = E.sent.find(x => x.to === 'heba@x.com');
  assert(/^\w{3}, \d{2} \w{3} \d{4}/.test(m.dateHdr), m.dateHdr);
  assert(/^<.+@gmail\.com>$/.test(m.msgId), m.msgId);
  assert.strictEqual(m.listUnsub, '<mailto:dad@gmail.com?subject=Unsubscribe%20heba%40x.com>');
  const test = E.sent.find(x => /test email/.test(x.subject));
  assert.strictEqual(test.listUnsub, '', 'no unsubscribe on test emails');
});
t('only the owner can change the rules; values are checked', () => {
  E.as('dad@gmail.com');
  throwsMsg(() => C.saveSendingRules({ dailyCap: 30, startHour: 9, endHour: 21 }), /Only the owner of this workspace/);
  E.as('owner@gmail.com');
  throwsMsg(() => C.saveSendingRules({ dailyCap: 1000, startHour: 9, endHour: 21 }), /between 5 and 400/);
  throwsMsg(() => C.saveSendingRules({ dailyCap: 30, startHour: 20, endHour: 10 }), /end is after the start/);
  const r = C.saveSendingRules({ dailyCap: '3x', startHour: 9, endHour: 21 }.dailyCap ? { dailyCap: 6, startHour: 9, endHour: 21 } : {});
  assert.strictEqual(r.dailyCap, 6);
  assert.strictEqual(C.getSettings().sendingRules.dailyCap, 6);
});
t('daily safety limit per Gmail account: stops at the limit, continues next morning by itself', () => {
  E.setClock('2026-11-03T06:00:00Z'); // 10:00 UAE, a new day
  E.as('dad@gmail.com');
  const many = []; for (let i = 0; i < 9; i++) many.push({ full_name: 'Cap ' + i, email: 'cap' + i + '@ex.com', consent_status: 'yes' });
  C.importContacts('SHOP1', many, {});
  const k = C.startCampaign({ shopId: 'SHOP1', subject: 'Hello {first_name}', body: 'Hello {first_name}, the shop is still available. Let me know if you want to visit.', delayMinutes: 3 });
  const before = E.sent.length;
  E.runTrigger(60);
  assert.strictEqual(E.sent.length - before, 6, 'exactly the daily limit');
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  assert(/Safety limit reached/.test(c.status_reason), c.status_reason);
  assert.strictEqual(c.status, 'running');
  assert.strictEqual(c.next_send_at, '2026-11-04T05:00:00.000Z', '9:00 UAE next day');
  const p = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'x {first_name}', body: 'Hi {first_name}, another message for you about the shop.', skipPrevious: false });
  assert(p.estimatedDays >= 2 && /at most 6 emails/.test(p.dailyLimitNote));
  E.setClock('2026-11-04T04:58:00Z');
  E.runTrigger(1); assert.strictEqual(E.sent.length - before, 6, 'not before 9:00');
  E.runTrigger(15);
  assert.strictEqual(E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id).status, 'completed');
  assert.strictEqual(E.sent.length - before, 10); // 9 new people + Heba (new email for her too)
  E.as('owner@gmail.com'); C.saveSendingRules({ dailyCap: 40, startHour: 9, endHour: 21 });
});
t('no emails outside sending hours (e.g. 23:00 UAE); continues at 9:00', () => {
  E.setClock('2026-11-04T19:00:00Z'); // 23:00 UAE
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Night', email: 'night@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', subject: 'Evening {first_name}', body: 'Hello {first_name}, the shop is still available if you are interested.' });
  const before = E.sent.length;
  E.runTrigger(120);
  assert.strictEqual(E.sent.length, before);
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  assert(/Waiting for sending hours \(9:00–21:00/.test(c.status_reason), c.status_reason);
  assert.strictEqual(c.next_send_at, '2026-11-05T05:00:00.000Z');
  E.setClock('2026-11-05T05:00:30Z');
  E.runTrigger(2);
  assert.strictEqual(E.sent.length, before + 1);
});
t('scheduled start: nothing goes out before the chosen time; custom minutes; random extra off = exact', () => {
  E.setClock('2026-11-06T06:00:00Z'); // 10:00 UAE
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Sched One', email: 's1@ex.com', consent_status: 'yes' }, { full_name: 'Sched Two', email: 's2@ex.com', consent_status: 'yes' }], {});
  const params = { shopId: 'SHOP1', subject: 'Plan {first_name}', body: 'Hello {first_name}, a scheduled note about the shop for you.',
    delayMinutes: 8, randomExtra: false, startAt: '2026-11-06T09:00:00Z' }; // 13:00 UAE
  const pv = C.getCampaignPreview(params);
  assert.strictEqual(pv.startAtLabel, '6 Nov 13:00');
  assert.strictEqual(pv.randomExtra, false);
  globalThis.__rand = 0.999;
  const k = C.startCampaign(params);
  assert(/Scheduled: the first email goes out at 6 Nov 13:00/.test(k.status_reason));
  const mine = () => E.sent.filter(m => /^Plan /.test(m.subject));
  E.runTrigger(170); // until 12:50 UAE
  assert.strictEqual(mine().length, 0, 'nothing before the start time');
  E.runTrigger(12);
  assert.strictEqual(mine().length, 1, 'first email at the start time');
  assert(Date.parse(mine()[0].at) >= Date.parse('2026-11-06T09:00:00Z'));
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  const gap = (Date.parse(c.next_send_at) - Date.parse(mine()[0].at)) / 60000;
  assert.strictEqual(gap, 8, 'exactly 8 minutes when random extra is off');
  assert.strictEqual(c.status_reason, '', 'scheduled note cleared after the first email');
  globalThis.__rand = undefined;
  E.runTrigger(30);
  const plan = mine().map(m => Date.parse(m.at));
  assert(plan.length >= 3, 'keeps sending after the start');
  for (let i = 1; i < plan.length; i++) assert(plan[i] - plan[i - 1] >= 8 * 60000, 'at least 8 minutes apart');
});
t('schedule checks: past start time and out-of-range values are refused', () => {
  throwsMsg(() => C.startCampaign({ shopId: 'SHOP1', subject: 'x {first_name}', body: 'Hello {first_name}, some text about the shop here.', startAt: '2026-01-01T00:00:00Z' }), /in the past/);
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}', delayMinutes: 2 }), /from 3 to 120/);
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}', dailyCap: 100 }), /from 1 to 60/);
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}', startHour: 20, endHour: 9 }), /end is after the start/);
});
t('WhatsApp send list carries the chosen schedule', () => {
  C.importContacts('SHOP1', [{ full_name: 'Phone Person', phone: '0501231234', consent_status: 'yes' }], {});
  const job = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}', delayMinutes: 12, randomExtra: false, dailyCap: 15, startHour: 10, endHour: 18, startAt: '2026-11-07T06:30:00Z' });
  assert.strictEqual(JSON.stringify(job.rules), JSON.stringify({ delayMinutes: 12, dailyCap: 15, startHour: 10, endHour: 18, randomExtra: false, startAt: '2026-11-07T06:30:00.000Z' }));
});
t('old Campaigns tab without the new column still works (column is added by itself)', () => {
  const sh = E.ss.getSheetByName('Campaigns');
  const col = sh.grid[0].indexOf('random_extra');
  sh.grid.forEach(r => r.splice(col, 1));
  assert(!sh.grid[0].includes('random_extra'));
  C.getShopData('SHOP1');
  assert(E.ss.getSheetByName('Campaigns').grid[0].includes('random_extra'));
});
t('at night: preview says when it will really start; "Send now anyway" sends right away', () => {
  E.setClock('2026-11-07T20:43:00Z'); // 00:43 UAE
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Night Owl', email: 'owl@ex.com', consent_status: 'yes' }], {});
  const base = { shopId: 'SHOP1', subject: 'Late {first_name}', body: 'Hello {first_name}, a late note about the shop for you.', delayMinutes: 5 };
  const pv = C.getCampaignPreview(base);
  assert.strictEqual(pv.waitsForHoursLabel, '8 Nov 09:00');
  const pv2 = C.getCampaignPreview(Object.assign({ ignoreHours: true }, base));
  assert.strictEqual(pv2.waitsForHoursLabel, undefined);
  const k = C.startCampaign(Object.assign({ ignoreHours: true }, base));
  const n = E.sent.length;
  E.runTrigger(2);
  assert(E.sent.length > n, 'sent at 00:45 because hours were switched off for this send');
  assert.strictEqual(E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id).ignore_hours, 'yes');
  C.stopCampaign(k.campaign_id);
  E.setClock('2026-11-08T06:00:00Z'); // back to daytime (10:00 UAE) for the next tests
});
t('WhatsApp "Send now anyway" = no hours limit in the send list', () => {
  const r = C.whatsAppRules_({ startHour: 9, endHour: 21, ignoreHours: true });
  assert.strictEqual(r.startHour, 0); assert.strictEqual(r.endHour, 24);
  assert.strictEqual(C.whatsAppRules_({ startHour: 9, endHour: 21 }).startHour, 9);
});
t('random spacing is never shorter than the chosen wait (up to 40% longer)', () => {
  globalThis.__rand = 0.999;
  C.importContacts('SHOP1', [{ full_name: 'J1', email: 'j1@ex.com', consent_status: 'yes' }, { full_name: 'J2', email: 'j2@ex.com', consent_status: 'yes' }], {});
  const k = C.startCampaign({ shopId: 'SHOP1', subject: 'Spacing {first_name}', body: 'Hello {first_name}, checking spacing between emails today.', delayMinutes: 5 });
  E.runTrigger(1);
  const c = E.tab('Campaigns').find(x => x.campaign_id === k.campaign_id);
  const gap = (Date.parse(c.next_send_at) - E.now()) / 60000;
  assert(gap >= 5 && gap <= 7.01, 'gap ' + gap);
  globalThis.__rand = undefined;
  E.runTrigger(10);
});
}

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
