// Upload history (lists): every uploaded file is kept, can be used again for a different message, several files at once.
const assert = require('assert');
const path = require('path');
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
const E = makeEnv(SRC); const C = E.ctx; const G = E.google;
E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret);
E.connect('shop1@gmail.com'); C.assignShopSender('SHOP1', 'shop1@gmail.com');
C.addMember('dad@gmail.com');
const SHOP2 = C.saveShop({ shop_name: 'Second shop' }).shop_id || E.tab('Shops').find(s => s.shop_name === 'Second shop').shop_id;
const person = (n, extra) => Object.assign({ full_name: 'P' + n, email: 'p' + n + '@ex.com', phone: '05099900' + String(n).padStart(2, '0'), consent_status: 'yes' }, extra || {});

console.log('Upload history (lists)');
let L1, L2;
t('each uploaded file becomes a list; upload parts of the same file join the same list', () => {
  E.as('dad@gmail.com');
  const a = C.importContacts('SHOP1', [person(1), person(2)], { fileName: 'June buyers.xlsx', first: true });
  assert(a.listId); L1 = a.listId;
  const b = C.importContacts('SHOP1', [person(3)], { fileName: 'June buyers.xlsx', listId: a.listId });
  assert.strictEqual(b.listId, a.listId);
  const c = C.importContacts('SHOP1', [person(3), person(4), person(5)], { fileName: 'July buyers.csv', first: true });
  L2 = c.listId; assert.notStrictEqual(L2, L1);
  assert.strictEqual(c.added, 2); assert.strictEqual(c.unchanged, 1, 'P3 is not added twice');
  const d = C.getShopData('SHOP1');
  const lists = d.lists;
  assert.strictEqual(lists.length, 2);
  const june = lists.find(l => l.list_id === L1), july = lists.find(l => l.list_id === L2);
  assert.strictEqual(june.people, 3); assert.strictEqual(july.people, 3);
  assert.strictEqual(june.rows, 3); assert.strictEqual(june.created_by, 'dad@gmail.com');
  const p3 = d.contacts.find(x => x.email === 'p3@ex.com');
  assert.deepStrictEqual(p3.lists.split(',').sort(), [L1, L2].sort(), 'P3 is in both files');
});
t('the same file uploaded again replaces that list\'s people (contacts are kept)', () => {
  E.as('dad@gmail.com');
  const r = C.importContacts('SHOP1', [person(1), person(6)], { fileName: 'june BUYERS.xlsx', first: true });
  assert.strictEqual(r.listId, L1); assert.strictEqual(r.reuploaded, true);
  const d = C.getShopData('SHOP1');
  assert.strictEqual(d.lists.find(l => l.list_id === L1).people, 2);
  assert(d.contacts.find(x => x.email === 'p2@ex.com'), 'P2 is still a contact');
  assert(!d.contacts.find(x => x.email === 'p2@ex.com').lists.includes(L1));
});
t('a re-upload in several parts: people leave the list only after the LAST part (a stopped upload keeps the old list)', () => {
  E.as('dad@gmail.com');
  const a = C.importContacts('SHOP1', [person(10), person(11)], { fileName: 'parts.csv', first: true });
  const r1 = C.importContacts('SHOP1', [person(10)], { fileName: 'parts.csv', first: true, part: 0, last: false });
  assert.strictEqual(r1.listId, a.listId);
  let d = C.getShopData('SHOP1');
  assert.strictEqual(d.lists.find(l => l.list_id === a.listId).people, 2, 'stopped after part 1: nobody taken out');
  const r2 = C.importContacts('SHOP1', [person(12)], { fileName: 'parts.csv', listId: r1.listId, uploadToken: r1.uploadToken, part: 1, last: true });
  assert.strictEqual(r2.leftList, 1);
  d = C.getShopData('SHOP1');
  const ids = Array.from(d.contacts.filter(c => (c.lists || '').split(',').includes(a.listId)).map(c => c.email)).sort();
  assert.deepStrictEqual(ids, ['p10@ex.com', 'p12@ex.com']);
  C.removeList('SHOP1', a.listId);
});
t('"keep both": the same file name can also be saved as a new list (the earlier one is kept)', () => {
  E.as('dad@gmail.com');
  const r = C.importContacts('SHOP1', [person(7)], { fileName: 'July buyers.csv', first: true, asNew: true });
  assert.notStrictEqual(r.listId, L2);
  const d = C.getShopData('SHOP1');
  assert.strictEqual(d.lists.find(l => l.list_id === r.listId).name, 'July buyers.csv (2)');
  assert.strictEqual(d.lists.find(l => l.list_id === L2).people, 3, 'earlier list unchanged');
  C.removeList('SHOP1', r.listId);
  C.markOptedOut(d.contacts.find(c => c.email === 'p7@ex.com').contact_id, 'test');
});
let firstK;
t('send an email to chosen files only; the plan says which files', () => {
  E.as('dad@gmail.com');
  const prev = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Message one', listIds: [L2] });
  assert.strictEqual(prev.totalContacts, 3); assert.strictEqual(prev.willSend, 3);
  assert.deepStrictEqual(Array.from(prev.audience), ['July buyers.csv']);
  firstK = C.startCampaign({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Message one', listIds: [L2], delayMinutes: 1, randomExtra: false, ignoreHours: true });
  assert.strictEqual(firstK.list_ids, L2);
  const everyone = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Message one' });
  assert.strictEqual(everyone.totalContacts, 10, 'no choice = everyone in the shop');
  const both = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'X', body: 'Y', listIds: [L1, L2] });
  assert.strictEqual(both.totalContacts, 5, 'P1,P6 + P3,P4,P5 (a person in both files counts once)');
});
t('the same file used again with a DIFFERENT message: everyone gets it; the SAME message is not sent twice', () => {
  E.as('dad@gmail.com');
  E.runTrigger(5);
  const again = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Message one', listIds: [L2] });
  assert.strictEqual(again.willSend, 0); assert(/Already received/.test(again.skipReasons[0].reason));
  const other = C.getCampaignPreview({ shopId: 'SHOP1', subject: 'Hi {first_name}', body: 'Message two (new offer)', listIds: [L2] });
  assert.strictEqual(other.willSend, 3);
  const d = C.getShopData('SHOP1');
  assert.deepStrictEqual(Array.from(d.lists.find(l => l.list_id === L2).campaigns), [firstK.campaign_id], 'history shows what was sent to the file');
});
t('WhatsApp (Mac job) uses the chosen files too', () => {
  E.as('dad@gmail.com');
  const job = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hello {first_name}', listIds: [L1] });
  assert.deepStrictEqual(Array.from(job.items.map(i => i.name)).sort(), ['P1', 'P6']);
  assert.deepStrictEqual(Array.from(job.list_names), ['June buyers.xlsx']);
});
t('rename and remove a file; removed files cannot be chosen; contacts stay', () => {
  E.as('dad@gmail.com');
  C.renameList('SHOP1', L1, '  =Summer   buyers  ');
  assert.strictEqual(C.getShopData('SHOP1').lists.find(l => l.list_id === L1).name, '=Summer buyers');
  assert(E.sheetOf('owner@gmail.com').getSheetByName('Lists').grid.find(r => r[0] === L1).includes('=Summer buyers'), 'kept as text (not a formula)');
  throwsMsg(() => C.renameList('SHOP1', L1, '   '), /Write a name/);
  throwsMsg(() => C.renameList(SHOP2, L1, 'x'), /not found/);
  C.removeList('SHOP1', L1);
  const d = C.getShopData('SHOP1');
  assert.strictEqual(d.lists.length, 1, JSON.stringify(Array.from(d.lists.map(l => l.name))));
  assert.strictEqual(d.contacts.length, 10);
  assert(d.contacts.every(c => !c.lists.includes(L1)));
  throwsMsg(() => C.getCampaignPreview({ shopId: 'SHOP1', subject: 'a', body: 'b', listIds: [L1] }), /were removed/);
  const r = C.importContacts('SHOP1', [person(1)], { fileName: 'June buyers.xlsx', first: true });
  assert.notStrictEqual(r.listId, L1, 'uploading the removed file again makes a new list');
});
t('a list id from another shop cannot be used', () => {
  E.as('dad@gmail.com');
  throwsMsg(() => C.getCampaignPreview({ shopId: SHOP2, subject: 'a', body: 'b', listIds: [L2] }), /were removed/);
});
t('contacts from before upload history: their file appears in the history once', () => {
  E.as('dad@gmail.com');
  const sh = E.sheetOf('owner@gmail.com').getSheetByName('Contacts');
  const before = E.tab('Contacts').length;
  C.importContacts(SHOP2, [person(40), person(41)], { fileName: 'old.xlsx', first: true });
  // Make them look like the old version: no lists column value, no list row.
  const lists = E.sheetOf('owner@gmail.com').getSheetByName('Lists');
  const lh = lists.grid[0]; const li = lists.grid.findIndex((r, i) => i > 0 && r[lh.indexOf('file_name')] === 'old.xlsx');
  lists.grid.splice(li, 1);
  const h = sh.grid[0];
  sh.grid.forEach((r, i) => { if (i > 0 && r[h.indexOf('shop_id')] === SHOP2) r[h.indexOf('lists')] = ''; });
  E.dropCache && E.dropCache();
  const d = C.getShopData(SHOP2);
  assert.strictEqual(d.lists.length, 1, JSON.stringify(Array.from(d.lists.map(l => l.name)))); assert.strictEqual(d.lists[0].file_name, 'old.xlsx'); assert.strictEqual(d.lists[0].people, 2);
  assert.strictEqual(C.getShopData(SHOP2).lists.length, 1, 'made only once');
  assert.strictEqual(E.tab('Contacts').length, before + 2);
});
console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
