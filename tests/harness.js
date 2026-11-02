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
    redirect: 'https://hebadaher.github.io/sheetsender/callback.html',
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
  function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function resp(code, obj) { const t = JSON.stringify(obj); return { getResponseCode: () => code, getContentText: () => t }; }
  function newAccess(email) { const t = 'at_' + (++google.n); google.access[t] = { email, exp: clock + 3600e3 }; return t; }

  const UrlFetchApp = {
    fetch(url, opts = {}) {
      fetchLog.push({ url, opts, as: users.effective });
      const p = opts.payload || {};
      if (url === 'https://oauth2.googleapis.com/token') {
        if (p.client_id !== google.client.id || p.client_secret !== google.client.secret) return resp(401, { error: 'invalid_client' });
        if (p.grant_type === 'authorization_code') {
          const c = google.codes[p.code];
          if (!c) return resp(400, { error: 'invalid_grant' });
          if (p.redirect_uri !== google.redirect) return resp(400, { error: 'redirect_uri_mismatch', error_description: 'Bad redirect' });
          delete google.codes[p.code];
          const rt = 'rt_' + (++google.n);
          google.refresh[rt] = c.email;
          const id = 'h.' + b64url(JSON.stringify({ email: c.email, email_verified: true })) + '.sig';
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
        if (typeof val === 'string' && /rt_|at_|GOCSPX/.test(val)) throw new Error('SECRET WRITTEN TO SHEET: ' + val);
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
  let ss = null;
  function makeSpreadsheet(owner) {
    return {
      sheets: [new Sheet('Sheet1')],
      editors: [owner, 'dad@gmail.com'],
      viewers: ['viewer@gmail.com'],
      getId() { return 'SHEET123'; },
      getUrl() { return 'https://docs.google.com/spreadsheets/d/SHEET123'; },
      getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
      insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; },
      getSheets() { return this.sheets.slice(); },
      deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); },
      getEditors() { return this.editors.map(e => ({ getEmail: () => e })); },
      setSpreadsheetTimeZone() {}
    };
  }

  const store = (bucket, key) => { bucket[key] = bucket[key] || {}; const b = bucket[key]; return {
    getProperty: k => (k in b ? b[k] : null), setProperty: (k, v) => { b[k] = String(v); }, deleteProperty: k => { delete b[k]; },
    get: k => (k in b ? b[k] : null), put: (k, v) => { b[k] = String(v); }, remove: k => { delete b[k]; } }; };

  const ctx = {
    Date: FakeDate, console, JSON, Math: Object.assign(Object.create(Math), { random: () => (globalThis.__rand !== undefined ? globalThis.__rand : 0) }), Object, Array, String, Number, RegExp, Error, Promise,
    SpreadsheetApp: {
      create: () => { ss = makeSpreadsheet(users.effective); return ss; },
      openById: (id) => {
        if (!ss || id !== 'SHEET123') throw new Error('Not found');
        if (ss.editors.indexOf(users.effective) === -1 && ss.viewers.indexOf(users.effective) === -1) throw new Error('No access');
        return ss;
      },
      getActiveSpreadsheet: () => null
    },
    PropertiesService: {
      getScriptProperties: () => store({ s: scriptProps }, 's'),
      getUserProperties: () => store(userProps, users.effective)
    },
    CacheService: { getUserCache: () => store(userCache, users.effective) },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => users.effective }),
      getActiveUser: () => ({ getEmail: () => users.active })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => { uuid++; return ('00000000' + uuid.toString(16)).slice(-8) + '-aaaa-bbbb-cccc-ddddeeeeffff'; },
      formatDate: (d) => new RealDate(d.getTime()).toISOString().slice(0, 16),
      Charset: { UTF_8: 'UTF-8' },
      base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, text) => Array.from(require('crypto').createHash('sha256').update(String(text), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b))
    },
    UrlFetchApp,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; }, getContent() { return t; } }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => google.execUrl }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: fn => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => { const t = { fn, m, owner: users.effective, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }) })
    },
    HtmlService: {
      createHtmlOutputFromFile: n => ({ getContent: () => fs.readFileSync(path.join(srcDir, n + '.html'), 'utf8') }),
      createHtmlOutput: html => ({ html, setTitle() { return this; }, getContent() { return html; } }),
      createTemplateFromFile: n => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, page: n }) })
    },
    Logger: { log: () => {} }
  };
  vm.createContext(ctx);
  const code = ['Code.gs', 'Senders.gs', 'Sending.gs'].map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n') +
    (process.env.SF_NO_BRIDGE ? '' : "\nconst BRIDGE_TOKEN_SHA256 = '" + require('crypto').createHash('sha256').update('test-token').digest('hex') + "';\n");
  vm.runInContext(code, ctx, { filename: 'project.js' });

  const env = {
    ctx, google, scriptProps, userProps, userCache, triggers, sent, fetchLog, users,
    get ss() { return ss; },
    as(email) { users.active = email; users.effective = email; },
    advance(min) { clock += min * 60000; },
    /** Helper on the Mac calling the bridge deployment (runs as the owner, nobody signed in). */
    bridge(body) {
      const a = users.active, e = users.effective;
      users.effective = 'owner@gmail.com'; users.active = '';
      try { return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
      finally { users.active = a; users.effective = e; }
    },
    realClock() { clock = RealDate.now(); setInterval(() => { clock = RealDate.now(); }, 200).unref(); },
    setClock(iso) { clock = Date.parse(iso); },
    now() { return clock; },
    runTrigger(minutes) {
      const a = users.active, e = users.effective;
      for (let i = 0; i < minutes; i++) {
        clock += 60000;
        users.effective = triggers[0] ? triggers[0].owner : 'nobody';
        users.active = users.effective;
        ctx.processQueue();
      }
      users.active = a; users.effective = e;
    },
    /** Full browser flow: owner clicks Connect, signs in at Google as `email`, clicks Allow; Google redirects back. */
    connect(email, opts = {}) {
      const url = new URL(ctx.startGmailConnect(opts.hint || ''));
      const q = Object.fromEntries(url.searchParams);
      const code = opts.cancel ? null : google.consent(email, opts);
      const cbUser = opts.callbackAs || users.active;
      const a = users.active, e = users.effective; users.active = users.effective = cbUser;
      let html;
      try {
        const email = opts.cancel ? ctx.finishGmailConnect('', q.state, 'access_denied') : ctx.finishGmailConnect(code, opts.state || q.state, '');
        html = 'Connected: ' + email;
      } catch (err) { html = err.message; }
      users.active = a; users.effective = e;
      return { query: q, html };
    },
    tab(name) {
      const s = ss.getSheetByName(name);
      const [h, ...rows] = s.grid;
      return rows.filter(r => r && r.some(v => v !== '' && v !== undefined)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
    }
  };
  return env;
}
module.exports = { makeEnv };
