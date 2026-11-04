// Photos and videos in WhatsApp messages: upload (in parts, checked), Mac sending (helper fetches through the bridge),
// WhatsApp Business API (photo/video templates), and who may use which file.
const assert = require('assert');
const crypto = require('crypto');
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
const E = makeEnv(SRC); const C = E.ctx; const G = E.google; const M = E.meta;
E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret);
C.addMember('dad@gmail.com');
E.as('sara@gmail.com'); C.createMyWorkspace('Sara Shops', 'Sara Bakery');

const jpg = (n) => { const b = crypto.randomBytes(n); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
const mp4 = (n) => { const b = crypto.randomBytes(n); b.write('ftyp', 4, 'latin1'); return b; };
/** Uploads like the page does: start, then 2 MB parts as base64. */
function upload(shopId, buf, mime, name) {
  const s = C.startMediaUpload(shopId, { name, mime, size: buf.length });
  let r;
  for (let off = 0; off < buf.length; off += s.chunk) r = C.uploadMediaChunk(s.uploadId, off, buf.subarray(off, off + s.chunk).toString('base64'));
  return r;
}

console.log('Uploading photos and videos');
let photo, video, photoBytes, videoBytes;
t('a photo uploads in one part; a 5 MB video in 2 MB parts; both are in the shop\'s list', () => {
  E.as('dad@gmail.com');
  photoBytes = jpg(300 * 1024);
  const r = upload('SHOP1', photoBytes, 'image/jpeg', 'Offer.jpg');
  assert.strictEqual(r.done, true); photo = r.media;
  assert.strictEqual(photo.kind, 'image'); assert.strictEqual(photo.size, photoBytes.length);
  videoBytes = mp4(5 * 1024 * 1024 + 123);
  video = upload('SHOP1', videoBytes, 'video/mp4', 'tour.mp4').media;
  assert.strictEqual(video.kind, 'video');
  const d = C.getShopData('SHOP1');
  assert.deepStrictEqual(Array.from(d.media.map(m => m.media_id)).sort(), [photo.media_id, video.media_id].sort());
  assert(!JSON.stringify(d.media).includes('drv'), 'no Drive address is sent to the page');
  const files = Object.values(E.drive.files).filter(f => !f.folder);
  assert.strictEqual(files.length, 2);
  assert(files.every(f => E.drive.files[f.parents[0]].folder), 'kept in the app\'s own folder');
  assert(files.some(f => f.bytes.equals(videoBytes)), 'video bytes intact');
});
t('WhatsApp limits and real file checks', () => {
  E.as('dad@gmail.com');
  throwsMsg(() => C.startMediaUpload('SHOP1', { name: 'x.gif', mime: 'image/gif', size: 100 }), /photo \(JPG or PNG\) or a video \(MP4\)/);
  throwsMsg(() => C.startMediaUpload('SHOP1', { name: 'big.jpg', mime: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }), /bigger than 5 MB/);
  throwsMsg(() => C.startMediaUpload('SHOP1', { name: 'big.mp4', mime: 'video/mp4', size: 16 * 1024 * 1024 + 1 }), /bigger than 16 MB/);
  throwsMsg(() => C.startMediaUpload('SHOP1', { name: 'e.jpg', mime: 'image/jpeg', size: 0 }), /empty/);
  const fake = Buffer.from('<html>not a picture</html>');
  throwsMsg(() => upload('SHOP1', fake, 'image/jpeg', 'evil.jpg'), /not really a JPG or PNG/);
  throwsMsg(() => C.startMediaUpload('NOPE', { name: 'a.jpg', mime: 'image/jpeg', size: 10 }), /not found/i);
});
t('an upload belongs to the person who started it (and to their workspace)', () => {
  E.as('dad@gmail.com');
  const s = C.startMediaUpload('SHOP1', { name: 'a.jpg', mime: 'image/jpeg', size: 1000 });
  E.as('sara@gmail.com');
  throwsMsg(() => C.uploadMediaChunk(s.uploadId, 0, jpg(1000).toString('base64')), /expired/);
  E.as('dad@gmail.com');
  throwsMsg(() => C.uploadMediaChunk(s.uploadId, 500, jpg(500).toString('base64')), /lost/);
  throwsMsg(() => C.uploadMediaChunk('MUnope', 0, 'AAAA'), /expired/);
});
t('a Drive problem in the middle is reported; the upload can be retried from the start', () => {
  E.as('dad@gmail.com');
  E.drive.failNextPut = 1;
  const s = C.startMediaUpload('SHOP1', { name: 'b.jpg', mime: 'image/jpeg', size: 1000 });
  throwsMsg(() => C.uploadMediaChunk(s.uploadId, 0, jpg(1000).toString('base64')), /did not finish|Try again/);
});

console.log('WhatsApp from a Mac with a photo or video');
let job, tok;
t('the send list says which file to send; text + photo is its own saved message', () => {
  E.as('owner@gmail.com');
  tok = C.createMacLink().command.match(/'([0-9a-f]{64})'$/)[1];
  E.as('dad@gmail.com');
  C.importContacts('SHOP1', [{ full_name: 'Mona Ali', phone: '0501231111', consent_status: 'yes' }, { full_name: 'Huda K', phone: '0501232222', consent_status: 'yes' }], { fileName: 'a.csv', first: true });
  const plain = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}, new photos!' });
  job = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}, new photos!', mediaId: photo.media_id });
  assert.notStrictEqual(job.template_id, plain.template_id);
  assert.strictEqual(plain.media, null);
  assert.deepStrictEqual(Object.keys(job.media).sort(), ['kind', 'md5', 'media_id', 'mime', 'name', 'size']);
  assert.strictEqual(job.media.md5, crypto.createHash('md5').update(photoBytes).digest('hex'));
  const tpl = E.tab('Templates').find(x => x.template_id === job.template_id);
  assert.strictEqual(tpl.media_id, photo.media_id); assert(/^📷 /.test(tpl.template_name));
  const again = C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}, new photos!', mediaId: photo.media_id });
  assert.strictEqual(again.template_id, job.template_id, 'same text + same photo = same message');
});
t('the Mac downloads the file in parts through the bridge; it matches exactly', () => {
  const parts = [];
  let off = 0;
  for (;;) {
    const r = E.bridge({ action: 'media', media_id: video.media_id, offset: off }, tok);
    assert(r.ok, r.error);
    const b = Buffer.from(r.data, 'base64'); parts.push(b); off += b.length;
    if (off >= r.size) break;
  }
  assert(Buffer.concat(parts).equals(videoBytes));
  assert.strictEqual(parts.length, 3);
});
t('another workspace\'s Mac cannot read this file; nobody else can send it', () => {
  E.as('sara@gmail.com');
  const saraTok = C.createMacLink().command.match(/'([0-9a-f]{64})'$/)[1];
  const r = E.bridge({ action: 'media', media_id: photo.media_id, offset: 0 }, saraTok);
  assert.strictEqual(r.ok, false); assert(/removed/.test(r.error));
  assert.strictEqual(E.bridge({ action: 'media', media_id: photo.media_id, offset: 0 }, 'wrong').error, 'not allowed');
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'x', mediaId: photo.media_id }), /removed|choose/i);
  throwsMsg(() => C.removeMedia('SHOP1', photo.media_id), /not found/);
  // Sara can edit her own Sheet: pointing her Media row at the owner's Drive file gives her nothing.
  const s = C.startMediaUpload(C.getBootstrap().shops[0].shop_id, { name: 'mine.jpg', mime: 'image/jpeg', size: 1000 });
  const mine = C.uploadMediaChunk(s.uploadId, 0, jpg(1000).toString('base64')).media;
  const ownerFile = Object.keys(E.drive.files).find(id => E.drive.files[id].bytes && E.drive.files[id].bytes.equals(photoBytes));
  const sh = E.sheetOf('sara@gmail.com').getSheetByName('Media'); const h = sh.grid[0];
  sh.grid.forEach((r, i) => { if (i > 0 && r[0] === mine.media_id) r[h.indexOf('drive_id')] = ownerFile; });
  const r2 = E.bridge({ action: 'media', media_id: mine.media_id, offset: 0 }, saraTok);
  assert.strictEqual(r2.ok, false, 'another workspace\'s file is never read');
  C.removeMedia(C.getBootstrap().shops[0].shop_id, mine.media_id);
  assert.strictEqual(E.drive.files[ownerFile].trashed, false, 'and never moved to the bin');
  E.as('dad@gmail.com');
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'x', mediaId: 'P0000nope' }), /removed/);
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'x'.repeat(1001), mediaId: photo.media_id }), /at most 1000 characters/);
});
t('after the Mac reports the photo message as sent, the same text + photo is skipped; the text alone is not', () => {
  E.as('dad@gmail.com');
  const res = { kind: 'shop-followups-whatsapp-results', job_id: job.job_id, shop_id: 'SHOP1', template_id: job.template_id, created_at: job.created_at,
    items: job.items.map(i => ({ contact_id: i.contact_id, phone: i.phone, status: 'sent', reason: '', at: '2026-11-02T12:00:00' })) };
  assert(E.bridge({ action: 'results', results: res }, tok).ok);
  C.getWhatsAppHelper();
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}, new photos!', mediaId: photo.media_id }), /Already received/);
  assert(C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi {first_name}, new photos!' }).items.length >= 2);
});

console.log('WhatsApp Business API with a photo or video template');
t('a photo template needs a photo (not a video); preview shows the file', () => {
  E.as('owner@gmail.com');
  C.saveWhatsAppApi({ phoneNumberId: M.pnid, wabaId: M.waba, token: M.token });
  E.as('dad@gmail.com');
  const base = { shopId: 'SHOP1', template: 'with_image', language: 'en_US', mapping: { 1: 'first_name' }, delayMinutes: 1, dailyCap: 100, startHour: 0, endHour: 24 };
  throwsMsg(() => C.getWhatsAppApiPreview(base), /Choose the photo/);
  throwsMsg(() => C.getWhatsAppApiPreview(Object.assign({ mediaId: video.media_id }, base)), /needs a photo, not a video/);
  const p = C.getWhatsAppApiPreview(Object.assign({ mediaId: photo.media_id }, base));
  assert.strictEqual(p.media.name, 'Offer.jpg'); assert(p.willSend >= 2);
});
let k;
t('the first message uploads the photo to Meta (once); every message carries it in the header', () => {
  E.as('dad@gmail.com');
  k = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'with_image', language: 'en_US', mapping: { 1: 'first_name' }, mediaId: photo.media_id,
    delayMinutes: 1, randomExtra: false, dailyCap: 100, startHour: 0, endHour: 24 });
  assert.strictEqual(k.media_id, photo.media_id);
  const before = M.sent.length;
  E.runTrigger(3);
  assert.strictEqual(M.mediaUploads, 1);
  const up = Object.values(M.media)[0];
  assert(up.bytes.equals(photoBytes)); assert.strictEqual(up.type, 'image/jpeg');
  assert(!JSON.stringify(E.tab('Media', E.sheetOf('owner@gmail.com'))).includes(M.token), 'no token in the Sheet');
  const sent = M.sent.slice(before);
  assert(sent.length >= 2);
  sent.forEach(s => assert.deepStrictEqual(s.body.template.components[0], { type: 'header', parameters: [{ type: 'image', image: { id: 'mm1' } }] }));
  assert.strictEqual(M.mediaUploads, 1, 'not uploaded again for each person');
});
t('the photo of a running send cannot be removed; Meta losing an old copy -> uploaded again once; a file Meta cannot use -> paused', () => {
  E.as('dad@gmail.com');
  const k2 = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'with_video', language: 'en_US', mapping: { 1: 'first_name' }, mediaId: video.media_id,
    delayMinutes: 1, randomExtra: false, dailyCap: 100, startHour: 0, endHour: 24, skipPrevious: false });
  throwsMsg(() => C.removeMedia('SHOP1', video.media_id), /still running/);
  const n = M.mediaUploads;
  E.runTrigger(1);
  assert.strictEqual(M.mediaUploads, n + 1, 'video uploaded to Meta for the first message');
  E.advance(120); // two hours later Meta has lost it
  M.nextErrors.push({ code: 131053, message: 'Media upload error' });
  E.runTrigger(3);
  assert.strictEqual(M.mediaUploads, n + 2, 'uploaded again once');
  assert.strictEqual(M.sent[M.sent.length - 1].body.template.components[0].parameters[0].type, 'video');
  // Right after an upload, the same error means Meta cannot use this file: pause, never loop.
  try { C.stopCampaign(k2.campaign_id); } catch (e) { /* already finished */ }
  const k3 = C.startWhatsAppApiCampaign({ shopId: 'SHOP1', template: 'with_video', language: 'en_US', mapping: { 1: 'first_name' }, mediaId: video.media_id,
    delayMinutes: 1, randomExtra: false, dailyCap: 100, startHour: 0, endHour: 24, skipPrevious: false, name: 'k3' });
  M.nextErrors.push({ code: 131053, message: 'Media upload error' });
  const uploads = M.mediaUploads;
  E.runTrigger(1);
  const c3 = E.tab('Campaigns').find(c => c.campaign_id === k3.campaign_id);
  assert.strictEqual(c3.status, 'paused');
  assert(/cannot use this video/.test(c3.status_reason), c3.status_reason);
  E.runTrigger(5);
  assert.strictEqual(M.mediaUploads, uploads, 'no endless re-uploads');
  C.stopCampaign(k3.campaign_id);
});
t('removing a photo: gone from the list, the file goes to the Drive bin, old sends keep their history', () => {
  E.as('dad@gmail.com');
  assert.strictEqual(E.tab('Campaigns').find(c => c.campaign_id === k.campaign_id).status, 'completed');
  C.removeMedia('SHOP1', photo.media_id);
  assert(!C.getShopData('SHOP1').media.some(m => m.media_id === photo.media_id));
  assert(Object.values(E.drive.files).some(f => f.trashed && f.bytes && f.bytes.equals(photoBytes)));
  throwsMsg(() => C.getWhatsAppJob({ shopId: 'SHOP1', body: 'Hi', mediaId: photo.media_id }), /removed/);
  throwsMsg(() => C.saveTemplate({ shop_id: 'SHOP1', template_name: 'x', channel: 'whatsapp', body: 'Hi', media_id: photo.media_id }), /removed/);
});
t('if the app\'s Drive folder was deleted, a new one is made', () => {
  E.as('dad@gmail.com');
  Object.values(E.drive.files).forEach(f => { if (f.folder) f.trashed = true; });
  assert.strictEqual(upload('SHOP1', jpg(1000), 'image/jpeg', 'new.jpg').done, true);
});
console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
