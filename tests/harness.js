// Fakes of the Google services the app uses, so Code.gs + Senders.gs + Sending.gs run in Node.
// Includes a fake Google OAuth server and Gmail API, and per-user private storage (UserProperties / UserCache).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeEnv(srcDir) {
  let clock = Date.parse('2026-11-02T08:00:00Z');
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
  }

  const users = { effective: 'owner@gmail.com', active: 'owner@gmail.com' };
  const scriptProps = {};
  const userProps = {};   // email -> {}
  const userCache = {};   // email -> {}
  const triggers = [];
  const sent = [];        // emails accepted by the fake Gmail API
  const fetchLog = [];
  let uuid = 0;

  /* ---------- fake Google OAuth + Gmail ---------- */
  const google = {
    client: { id: '123456789-abcdef.apps.googleusercontent.com', secret: 'GOCSPX-test_secret_123' },
    redirect: 'https://script.google.com/macros/s/DEPLOY123/exec',                  // the app's own link (APP_URL)
    redirects: ['https://script.google.com/macros/s/DEPLOY123/exec', 'https://hebadaher.github.io/sheetsender/callback.html'], // registered in Cloud
    execUrl: 'https://script.google.com/macros/s/DEPLOY123/exec',
    codes: {},          // code -> {email, scopes}
    refresh: {},        // refresh token -> email (valid)
    access: {},         // access token -> {email, exp}
    revoked: [],
    nextSendError: null, // {code, body}
    n: 0,
    consent(email, opts = {}) {
      const code = 'code_' + (++this.n);
      const scopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
      if (opts.tickSend !== false) scopes.push('https://www.googleapis.com/auth/gmail.send');
      this.codes[code] = { email, scopes };
      return code;
    },
    expireAll(email) { Object.keys(this.refresh).forEach(t => { if (this.refresh[t] === email) delete this.refresh[t]; }); },
    expireAccessTokens() { Object.keys(this.access).forEach(t => { this.access[t].exp = 0; }); }
  };
  /* ---------- fake Meta WhatsApp Cloud API (Graph v25.0) ---------- */
  const meta = {
    token: 'EAAGtest_token_abcdefghijklmnopqrstuvwxyz0123',
    pnid: '1112223334445', waba: '5556667778889',
    display: '+971 50 000 0000', name: 'Heba Shops',
    templates: [
      { name: 'shop_followup', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'BODY', text: 'Hello {{1}}, this is about {{2}}. Are you still interested?' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }] },
      { name: 'named_hello', language: 'ar', status: 'APPROVED', category: 'UTILITY', parameter_format: 'NAMED',
        components: [{ type: 'HEADER', format: 'TEXT', text: 'News from {{shop}}' }, { type: 'BODY', text: 'Hi {{first_name}}!' }] },
      { name: 'with_image', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Look {{1}}' }] },
      { name: 'with_video', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Watch {{1}}' }] },
      { name: 'with_document', language: 'en_US', status: 'APPROVED', category: 'UTILITY',
        components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Your file {{1}}' }] },
      { name: 'waiting_one', language: 'en_US', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] }
    ],
    sent: [], nextErrors: [], calls: 0, media: {}, mediaUploads: 0
  };
  /* ---------- fake Google Drive (only what the app uses: its folder, resumable uploads, reading, bin) ---------- */
  const drive = { files: {}, sessions: {}, n: 0, failNextPut: 0 };
  const toBuf = (p) => Buffer.isBuffer(p) ? p : Buffer.from(Array.isArray(p) ? p.map(b => b & 0xff) : (p && p.bytes ? p.bytes : Buffer.from(String(p || ''))));
  function driveApi(url, opts) {
    const auth = ((opts.headers || {}).Authorization || '').replace('Bearer ', '');
    if (auth !== 'ya29.' + ADMIN) return resp(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    const m = (opts.method || 'get').toLowerCase();
    const [base, query] = url.split('?');
    if (url.indexOf('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=') === 0) {
      const s = drive.sessions[url];
      if (!s || m !== 'put') return resp(404, { error: { message: 'Not found' } });
      if (drive.failNextPut) { drive.failNextPut--; return resp(503, { error: { message: 'Backend Error' } }); }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(opts.headers['Content-Range'] || '');
      const buf = toBuf(opts.payload);
      if (!range || Number(range[1]) !== s.got.length || Number(range[2]) - Number(range[1]) + 1 !== buf.length || Number(range[3]) !== s.size) return resp(400, { error: { message: 'bad range' } });
      s.got = Buffer.concat([s.got, buf]);
      if (s.got.length < s.size) return resp(308, {}, { Range: 'bytes=0-' + (s.got.length - 1) });
      const id = 'drv' + (++drive.n);
      drive.files[id] = { name: s.meta.name, parents: s.meta.parents, mime: s.meta.mimeType, bytes: s.got, trashed: false };
      delete drive.sessions[url];
      return resp(200, { id, size: String(s.size), md5Checksum: require('crypto').createHash('md5').update(s.got).digest('hex'), mimeType: s.meta.mimeType });
    }
    if (base === 'https://www.googleapis.com/upload/drive/v3/files' && /uploadType=resumable/.test(query) && m === 'post') {
      const meta = JSON.parse(opts.payload);
      const parent = drive.files[(meta.parents || [])[0]];
      if (!parent || parent.trashed || !parent.folder) return resp(404, { error: { message: 'File not found: ' + (meta.parents || [])[0] } });
      const loc = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U' + (++drive.n);
      drive.sessions[loc] = { meta, size: Number(opts.headers['X-Upload-Content-Length']), got: Buffer.alloc(0) };
      return resp(200, {}, { Location: loc });
    }
    if (base === 'https://www.googleapis.com/drive/v3/files' && m === 'post') {
      const meta = JSON.parse(opts.payload); const id = 'fld' + (++drive.n);
      drive.files[id] = { name: meta.name, folder: meta.mimeType === 'application/vnd.google-apps.folder', trashed: false };
      return resp(200, { id });
    }
    const fm = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)$/.exec(base);
    if (fm) {
      const f = drive.files[decodeURIComponent(fm[1])];
      if (!f || (f.trashed && m !== 'get')) return resp(404, { error: { message: 'File not found' } });
      if (f.trashed && /alt=media/.test(query)) return resp(404, { error: { message: 'File not found' } });
      if (m === 'patch') { Object.assign(f, JSON.parse(opts.payload)); return resp(200, { id: fm[1] }); }
      if (m === 'get' && /fields=/.test(query) && !/alt=media/.test(query)) {
        return resp(200, { id: fm[1], name: f.name, mimeType: f.mime, size: String(f.bytes ? f.bytes.length : 0), trashed: !!f.trashed,
          md5Checksum: f.bytes ? require('crypto').createHash('md5').update(f.bytes).digest('hex') : undefined });
      }
      if (m === 'get' && /alt=media/.test(query)) {
        const r = /^bytes=(\d+)-(\d+)$/.exec((opts.headers || {}).Range || '');
        if (r) return bin(206, f.bytes.subarray(Number(r[1]), Number(r[2]) + 1), f.mime);
        return bin(200, f.bytes, f.mime);
      }
    }
    return resp(400, { error: { message: 'unexpected drive call ' + m + ' ' + url } });
  }
  function graph(url, opts) {
    meta.calls++;
    const auth = ((opts.headers || {}).Authorization || '').replace('Bearer ', '');
    if (auth !== meta.token) return resp(401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } });
    const rest = url.slice('https://graph.facebook.com/v25.0/'.length);
    const [pathPart] = rest.split('?');
    if ((opts.method || 'get') === 'get' && pathPart === meta.pnid) return resp(200, { display_phone_number: meta.display, verified_name: meta.name, quality_rating: 'GREEN', id: meta.pnid });
    if ((opts.method || 'get') === 'get' && pathPart === meta.waba + '/message_templates') return resp(200, { data: meta.templates, paging: {} });
    if (opts.method === 'post' && pathPart === meta.pnid + '/media') {
      const p = opts.payload || {};
      if (p.messaging_product !== 'whatsapp' || !p.file || !p.file.bytes) return resp(400, { error: { message: 'Param file must be a file', code: 100 } });
      if (p.type !== p.file.type) return resp(400, { error: { message: 'type mismatch', code: 100 } });
      const id = 'mm' + (++meta.mediaUploads);
      meta.media[id] = { bytes: p.file.bytes, type: p.type, name: p.file.name };
      return resp(200, { id });
    }
    if (opts.method === 'post' && pathPart === meta.pnid + '/messages') {
      if (meta.nextErrors.length) { const e = meta.nextErrors.shift(); return resp(e.http || 400, { error: { message: e.message || 'err', code: e.code } }); }
      const body = JSON.parse(opts.payload);
      meta.sent.push({ to: body.to, body, at: new RealDate(clock).toISOString(), as: users.effective });
      return resp(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: 'wamid.' + meta.sent.length }] });
    }
    return resp(400, { error: { message: 'Unsupported get request. Object with ID does not exist', code: 100 } });
  }

  function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function resp(code, obj, headers, raw) { const t = raw !== undefined ? raw : JSON.stringify(obj); return { getResponseCode: () => code, getContentText: () => t, getHeaders: () => headers || {} }; }
  function newBlob(bytes, type, name) {
    const b = { bytes: toBuf(bytes), type: type || '', name: name || '' };
    b.setContentType = (t) => { b.type = t; return b; }; b.setName = (n) => { b.name = n; return b; };
    b.getBytes = () => Array.from(b.bytes).map(x => (x > 127 ? x - 256 : x)); b.getDataAsString = () => b.bytes.toString('utf8');
    return b;
  }
  function bin(code, buf, type) {
    return { getResponseCode: () => code, getContentText: () => buf.toString('latin1'), getHeaders: () => ({}),
      getContent: () => Array.from(buf).map(x => (x > 127 ? x - 256 : x)), getBlob: () => newBlob(buf, type) };
  }
  function newAccess(email) { const t = 'at_' + (++google.n); google.access[t] = { email, exp: clock + 3600e3 }; return t; }

  const UrlFetchApp = {
    fetch(url, opts = {}) {
      fetchLog.push({ url, opts, as: users.effective });
      if (url.indexOf('https://graph.facebook.com/v25.0/') === 0) return graph(url, opts);
      if (url.indexOf('https://www.googleapis.com/') === 0) return driveApi(url, opts);
      if (env.sites && url in env.sites) return resp(200, {}, {}, env.sites[url]);
      if (env.sites && /^https:\/\/[a-z0-9.-]+\.ae\//.test(url)) throw new Error('DNS error: ' + url);
      const p = opts.payload || {};
      if (url === 'https://oauth2.googleapis.com/token') {
        if (p.client_id !== google.client.id || p.client_secret !== google.client.secret) return resp(401, { error: 'invalid_client' });
        if (p.grant_type === 'authorization_code') {
          const c = google.codes[p.code];
          if (!c) return resp(400, { error: 'invalid_grant' });
          if (google.redirects.indexOf(p.redirect_uri) === -1) return resp(400, { error: 'redirect_uri_mismatch', error_description: 'Bad redirect' });
          delete google.codes[p.code];
          const rt = 'rt_' + (++google.n);
          google.refresh[rt] = c.email;
          const id = 'h.' + b64url(JSON.stringify({ email: c.email, email_verified: true, aud: google.client.id, iss: 'https://accounts.google.com' })) + '.sig';
          return resp(200, { access_token: newAccess(c.email), expires_in: 3599, refresh_token: rt, scope: c.scopes.join(' '), id_token: id, token_type: 'Bearer' });
        }
        if (p.grant_type === 'refresh_token') {
          const email = google.refresh[p.refresh_token];
          if (!email) return resp(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          return resp(200, { access_token: newAccess(email), expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.send' });
        }
      }
      if (url === 'https://oauth2.googleapis.com/revoke') {
        google.revoked.push(p.token); delete google.refresh[p.token]; return resp(200, {});
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
        const auth = (opts.headers || {}).Authorization || '';
        const at = google.access[auth.replace('Bearer ', '')];
        if (!at || at.exp < clock) return resp(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
        if (google.nextSendError) { const e = google.nextSendError; google.nextSendError = null; return resp(e.code, e.body); }
        const raw = Buffer.from(JSON.parse(opts.payload).raw, 'base64url').toString('utf8');
        const header = n => ((raw.match(new RegExp('^' + n + ': (.*)$', 'mi')) || [])[1] || '');
        const decodeWord = v => v.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (m, b) => Buffer.from(b, 'base64').toString('utf8'));
        const parts = raw.split(/\r\n\r\n/);
        const textB64 = (parts[2] || '').split('\r\n--')[0];
        const msg = {
          listUnsub: header('List-Unsubscribe'), dateHdr: header('Date'), msgId: header('Message-ID'),
          account: at.email, from: header('From'), to: header('To').replace(/[<>]/g, ''), replyTo: header('Reply-To').replace(/[<>]/g, ''),
          subject: decodeWord(header('Subject')), fromName: decodeWord(header('From').split(' <')[0]),
          text: Buffer.from(textB64.replace(/\r\n/g, ''), 'base64').toString('utf8'), raw,
          at: new RealDate(clock).toISOString()
        };
        sent.push(msg);
        return resp(200, { id: 'msg' + sent.length });
      }
      throw new Error('Unexpected fetch ' + url);
    }
  };

  /* ---------- fake Sheets ---------- */
  class Range {
    constructor(sheet, r, c, nr, nc) {
      if (r < 1 || c < 1 || r + nr - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      Object.assign(this, { sheet, r, c, nr, nc });
    }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) { const v = (this.sheet.grid[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error('Wrong number of rows/cols in setValues');
      vals.forEach((row, i) => row.forEach((v, j) => {
        const g = this.sheet.grid;
        while (g.length < this.r + i) g.push([]);
        let val = v;
        if (typeof val === 'string' && val.startsWith('=')) throw new Error('FORMULA WRITTEN: ' + val);
        if (typeof val === 'string' && val.startsWith("'")) val = val.slice(1);
        if (typeof val === 'string' && /\b(rt|at)_\d|GOCSPX|EAAGtest/.test(val)) throw new Error('SECRET WRITTEN TO SHEET: ' + val);
        g[this.r - 1 + i][this.c - 1 + j] = val;
      }));
      return this;
    }
    setNumberFormat() { return this; } setFontWeight() { return this; } setBackground() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.grid = []; this.maxRows = 1000; }
    getLastRow() { for (let i = this.grid.length - 1; i >= 0; i--) if ((this.grid[i] || []).some(v => v !== '' && v !== undefined)) return i + 1; return 0; }
    getLastColumn() { return Math.max(0, ...this.grid.map(r => { let n = 0; (r || []).forEach((v, i) => { if (v !== '' && v !== undefined) n = i + 1; }); return n; })); }
    getMaxRows() { return this.maxRows; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
    insertRowsAfter(after, n) { this.maxRows += n; }
    setFrozenRows() {}
  }
  let ss = null;            // the first Sheet made (the administrator's), shared with Dad like before
  const sheetsById = {};
  function makeSpreadsheet(owner) {
    const first = !ss;
    const id = first ? 'SHEET123' : 'SHEET' + (Object.keys(sheetsById).length + 123);
    const book = {
      id, owner,
      sheets: [new Sheet('Sheet1')],
      editors: first ? [owner, 'dad@gmail.com'] : [owner],
      viewers: first ? ['viewer@gmail.com'] : [],
      addEditor(e) { if (!/@/.test(e) || /nogoogle/.test(e)) throw new Error('Invalid email: ' + e); if (this.editors.indexOf(e) === -1) this.editors.push(e); return this; },
      removeEditor(e) { this.editors = this.editors.filter(x => x !== e); return this; },
      getId() { return id; },
      getUrl() { return 'https://docs.google.com/spreadsheets/d/' + id; },
      getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
      insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; },
      getSheets() { return this.sheets.slice(); },
      deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); },
      getEditors() { return this.editors.map(e => ({ getEmail: () => e })); },
      setSpreadsheetTimeZone() {}
    };
    sheetsById[id] = book;
    if (first) ss = book;
    return book;
  }

  const expiry = new Map(); // cache entries expire like Google's (seconds, on the simulated clock)
  const store = (bucket, key) => { bucket[key] = bucket[key] || {}; const b = bucket[key]; return {
    getProperty: k => (k in b ? b[k] : null), setProperty: (k, v) => { b[k] = String(v); }, deleteProperty: k => { delete b[k]; },
    get: k => { const ex = expiry.get(b); if (ex && ex[k] && ex[k] <= clock) { delete b[k]; delete ex[k]; } return k in b ? b[k] : null; },
    put: (k, v, ttl) => { b[k] = String(v); if (!expiry.has(b)) expiry.set(b, {}); expiry.get(b)[k] = clock + 1000 * (ttl || 600); },
    remove: k => { delete b[k]; }, getKeys: () => Object.keys(b) }; };
  const scriptCache = {};

  const ctx = {
    Date: FakeDate, console, JSON, Math: Object.assign(Object.create(Math), { random: () => (globalThis.__rand !== undefined ? globalThis.__rand : 0) }), Object, Array, String, Number, RegExp, Error, Promise,
    SpreadsheetApp: {
      create: () => makeSpreadsheet(users.effective),
      openById: (id) => {
        const book = sheetsById[id];
        if (!book || book.trashed) throw new Error('Not found');
        if (book.failOnce) { book.failOnce = false; throw new Error('Service Spreadsheets failed while accessing document'); }
        if (book.editors.indexOf(users.effective) === -1 && book.viewers.indexOf(users.effective) === -1) throw new Error('No access');
        return book;
      },
      getActiveSpreadsheet: () => null
    },
    PropertiesService: {
      getScriptProperties: () => store({ s: scriptProps }, 's'),
      getUserProperties: () => store(userProps, users.effective)
    },
    CacheService: { getUserCache: () => store(userCache, users.effective), getScriptCache: () => store({ c: scriptCache }, 'c') },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => users.effective }),
      getActiveUser: () => ({ getEmail: () => users.active })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => { uuid++; return ('00000000' + uuid.toString(16)).slice(-8) + '-aaaa-bbbb-cccc-ddddeeeeffff'; },
      formatDate: (d) => new RealDate(d.getTime()).toISOString().slice(0, 16),
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: (s) => (Array.isArray(s) ? toBuf(s) : Buffer.from(String(s), 'utf8')).toString('base64'),
      base64EncodeWebSafe: (s) => (Array.isArray(s) ? Buffer.from(s.map(b => b & 0xff)) : Buffer.from(String(s), 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      computeHmacSha256Signature: (v, k) => Array.from(require('crypto').createHmac('sha256', String(k)).update(String(v), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes, type, name) => newBlob(bytes, type, name),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')).map(x => (x > 127 ? x - 256 : x)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, text) => Array.from(require('crypto').createHash('sha256').update(String(text), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b))
    },
    UrlFetchApp,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; }, getContent() { return t; } }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => google.execUrl }),
      getOAuthToken: () => 'ya29.' + users.effective,
      getProjectTriggers: () => triggers.filter(t => t.owner === users.effective), // like Google: only your own triggers
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: fn => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => { const t = { fn, m, owner: users.effective, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }) })
    },
    HtmlService: {
      createHtmlOutputFromFile: n => ({ getContent: () => fs.readFileSync(path.join(srcDir, n + '.html'), 'utf8') }),
      createHtmlOutput: html => ({ html, setTitle() { return this; }, getContent() { return html; } }),
      createTemplateFromFile: n => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode(m) { this.xframe = m; return this; }, page: n }) }),
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }
    },
    Logger: { log: () => {} }
  };
  const services = Object.assign({}, ctx);
  function compile(dir) {
    const files = ['Code.gs', 'Workspaces.gs', 'Senders.gs', 'Sending.gs', 'WhatsAppApi.gs', 'Lists.gs', 'Media.gs', 'Site.gs'].filter(f => fs.existsSync(path.join(dir, f)));
    return files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') +
      (fs.existsSync(path.join(dir, 'Workspaces.gs')) ? "\nconst APP_URL = 'https://script.google.com/macros/s/DEPLOY123/exec';\n" : '') +
      (process.env.SF_NO_BRIDGE ? '' : "\nconst BRIDGE_TOKEN_SHA256 = '" + require('crypto').createHash('sha256').update('test-token').digest('hex') + "';\n" +
        (fs.existsSync(path.join(dir, 'Workspaces.gs')) ? "const BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbBRIDGE123/exec';\n" : ''));
  }
  vm.createContext(ctx);
  const code = compile(srcDir);
  vm.runInContext(code, ctx, { filename: 'project.js' });
  void compile;

  // Pages talk to the app only through api(session, name, args), running as the administrator. `env.ctx` behaves like
  // the old direct calls: page actions go through api() with the current person's session; the rest are called as is.
  let real = ctx;
  let session = '';
  const ADMIN = 'owner@gmail.com';
  const isNew = () => typeof real.api === 'function';
  const proxy = new Proxy({}, {
    get(_, name) {
      if (isNew() && typeof name === 'string' && Object.prototype.hasOwnProperty.call(real.apiActions_(), name)) {
        return (...args) => real.api(session, name, args);
      }
      return real[name];
    },
    set(_, name, v) { real[name] = v; return true; }
  });
  const env = {
    get ctx() { return proxy; },
    get real() { return real; },
    get session() { return session; },
    /** Same Google account data (Sheets, properties, triggers…), different code: like publishing an update. */
    loadCode(dir) {
      const c2 = Object.assign({}, services);
      vm.createContext(c2);
      vm.runInContext(compile(dir), c2, { filename: 'project-' + path.basename(dir) + '.js' });
      real = c2;
      env.as(users.active || ADMIN);
      return proxy;
    },
    google, meta, drive, scriptProps, userProps, userCache, scriptCache, triggers, sent, fetchLog, users, sheetsById,
    get ss() { return ss; },
    sheetOf(email) {
      const k = Object.keys(scriptProps).filter(k => k.startsWith('W_') && JSON.parse(scriptProps[k]).owner === email && !JSON.parse(scriptProps[k]).broken).pop();
      return k ? sheetsById[JSON.parse(scriptProps[k]).sheet_id] : Object.values(sheetsById).filter(b => b.owner === email).pop();
    },
    sessionFor(email) { return real.makeSession_(email); },
    /** After changing script properties directly in a test (the app reads them through the script cache). */
    dropCache() { Object.keys(scriptCache).forEach(k => { if (k.startsWith('P|')) delete scriptCache[k]; }); },
    /** Who is using the page. New version: a signed-in session (the app itself runs as the administrator). */
    as(email) {
      if (isNew()) {
        users.effective = ADMIN; users.active = email === ADMIN ? ADMIN : '';
        session = email ? real.makeSession_(email) : '';
      } else { users.active = email; users.effective = email; }
      env.who = email;
    },
    advance(min) { clock += min * 60000; },
    /** Helper on the Mac calling the bridge deployment (runs as the owner, nobody signed in). */
    bridge(body, token) {
      if (token) body = Object.assign({}, body, { token });
      const a = users.active, e = users.effective;
      users.effective = ADMIN; users.active = '';
      try { return JSON.parse(real.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
      finally { users.active = a; users.effective = e; }
    },
    realClock() { clock = RealDate.now(); setInterval(() => { clock = RealDate.now(); }, 200).unref(); },
    setClock(iso) { clock = Date.parse(iso); },
    /** Full "Sign in with Google": the page asks for the link, Google sends back a code, the page finishes. */
    login(email) {
      const url = new URL(real.startLogin());
      const q = Object.fromEntries(url.searchParams);
      const r = real.finishLogin(google.consent(email), q.state, '');
      session = r.session; users.effective = ADMIN; users.active = ''; env.who = email;
      return { query: q, result: r };
    },
    now() { return clock; },
    runTrigger(minutes) {
      const a = users.active, e = users.effective;
      for (let i = 0; i < minutes; i++) {
        clock += 60000;
        triggers.slice().forEach(t => { users.effective = users.active = t.owner; real.processQueue(); });
      }
      users.active = a; users.effective = e;
    },
    /** Full browser flow: owner clicks Connect, signs in at Google as `email`, clicks Allow; Google redirects back. */
    connect(email, opts = {}) {
      const url = new URL(env.ctx.startGmailConnect(opts.hint || ''));
      const q = Object.fromEntries(url.searchParams);
      const code = opts.cancel ? null : google.consent(email, opts);
      const before = env.who;
      if (opts.callbackAs) env.as(opts.callbackAs);
      let html;
      try {
        const email = opts.cancel ? env.ctx.finishGmailConnect('', q.state, 'access_denied') : env.ctx.finishGmailConnect(code, opts.state || q.state, '');
        html = 'Connected: ' + email;
      } catch (err) { html = err.message; }
      if (opts.callbackAs) env.as(before);
      return { query: q, html };
    },
    tab(name, book) {
      const s = (book || ss).getSheetByName(name);
      if (!s) return [];
      const [h, ...rows] = s.grid;
      return rows.filter(r => r && r.some(v => v !== '' && v !== undefined)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
    }
  };
  return env;
}
module.exports = { makeEnv };
