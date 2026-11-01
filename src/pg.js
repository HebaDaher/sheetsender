// Minimal PostgreSQL client (no dependencies). Supports TLS, SCRAM-SHA-256 / MD5 / cleartext auth,
// parameterised queries (extended protocol, text format), simple multi-statement queries and a small pool.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Database error');
    this.code = fields.C; this.detail = fields.D; this.severity = fields.S; this.constraint = fields.n;
  }
}

export function parseUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || 'require';
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    ssl: sslmode !== 'disable',
  };
}

// ---------- value conversion ----------
function toText(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function parseArray(s, conv) {
  if (s === '{}') return [];
  const out = []; let i = 1; let cur = ''; let quoted = false; let inQ = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '\\') { cur += s[++i]; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch; continue;
    }
    if (ch === '"') { inQ = true; quoted = true; continue; }
    if (ch === ',' || ch === '}') { out.push(!quoted && cur === 'NULL' ? null : conv(cur)); cur = ''; quoted = false; continue; }
    cur += ch;
  }
  return out;
}

function parseTs(s) {
  // e.g. 2026-11-01 14:05:03.123+00  or 2026-11-01 14:05:03+04:30
  let t = s.replace(' ', 'T');
  t = t.replace(/([+-]\d\d)$/, '$1:00');
  return new Date(t);
}

const parsers = {
  16: (s) => s === 't', 20: Number, 21: Number, 23: Number, 26: Number, 700: Number, 701: Number, 1700: Number,
  114: JSON.parse, 3802: JSON.parse, 1114: (s) => parseTs(s + 'Z'), 1184: parseTs,
  17: (s) => Buffer.from(s.slice(2), 'hex'),
  1005: (s) => parseArray(s, Number), 1007: (s) => parseArray(s, Number), 1016: (s) => parseArray(s, Number),
  1009: (s) => parseArray(s, String), 1015: (s) => parseArray(s, String),
};

// ---------- message builders ----------
function msg(type, body) {
  const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), len, body]);
}
const cstr = (s) => Buffer.from(s + '\0', 'utf8');
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

class Connection {
  constructor(cfg) {
    this.cfg = cfg; this.buf = Buffer.alloc(0); this.queue = []; this.current = null;
    this.ready = false; this.dead = false; this.lastUsed = Date.now();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const fail = (e) => { this.dead = true; reject(e); };
      let sock = net.connect({ host: this.cfg.host, port: this.cfg.port });
      sock.setKeepAlive(true, 30000);
      sock.setTimeout(20000, () => sock.destroy(new Error('Database connection timed out')));
      const startup = () => {
        this.sock = sock;
        sock.setTimeout(0);
        sock.on('data', (d) => this.onData(d));
        sock.on('error', (e) => this.onDead(e));
        sock.on('close', () => this.onDead(new Error('Database connection closed')));
        this.authDone = { resolve, reject: fail };
        const params = Buffer.concat([cstr('user'), cstr(this.cfg.user), cstr('database'), cstr(this.cfg.database),
          cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
        const body = Buffer.concat([i32(196608), params]);
        sock.write(Buffer.concat([i32(body.length + 4), body]));
      };
      sock.once('error', fail);
      sock.once('connect', () => {
        if (!this.cfg.ssl) return startup();
        sock.write(Buffer.concat([i32(8), i32(80877103)]));
        sock.once('data', (d) => {
          if (d[0] !== 0x53) return fail(new Error('Database server does not support SSL'));
          sock.removeAllListeners('error');
          const opts = { socket: sock };
          if (!net.isIP(this.cfg.host)) opts.servername = this.cfg.host;
          if (this.cfg.ca) { opts.ca = this.cfg.ca; opts.rejectUnauthorized = true; } else opts.rejectUnauthorized = false;
          const t = tls.connect(opts, () => { sock = t; startup(); });
          t.once('error', fail);
        });
      });
    });
  }

  onDead(err) {
    if (this.dead) return; this.dead = true;
    const e = err || new Error('Database connection lost');
    if (this.current) { this.current.reject(e); this.current = null; }
    for (const q of this.queue) q.reject(e);
    this.queue = [];
    if (this.authDone) { this.authDone.reject(e); this.authDone = null; }
    this.onClose?.();
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.sock.destroy(e); return; }
    }
  }

  handle(type, body) {
    if (type === 'R') return this.handleAuth(body);
    if (type === 'E') {
      const fields = {}; let p = 0;
      while (p < body.length && body[p] !== 0) { const code = String.fromCharCode(body[p]); const end = body.indexOf(0, p + 1); fields[code] = body.toString('utf8', p + 1, end); p = end + 1; }
      const err = new PgError(fields);
      if (this.authDone) { const a = this.authDone; this.authDone = null; this.sock.destroy(); return a.reject(err); }
      if (this.current) this.current.error = err;
      return;
    }
    if (type === 'Z') {
      if (this.authDone) { const a = this.authDone; this.authDone = null; this.ready = true; return a.resolve(this); }
      const cur = this.current; this.current = null;
      if (cur) { if (cur.error) cur.reject(cur.error); else cur.resolve(cur.result); }
      return this.next();
    }
    const cur = this.current; if (!cur) return;
    if (type === 'T') {
      const n = body.readInt16BE(0); let p = 2; const fields = [];
      for (let i = 0; i < n; i++) { const end = body.indexOf(0, p); const name = body.toString('utf8', p, end); p = end + 1; const oid = body.readInt32BE(p + 6); p += 18; fields.push({ name, oid }); }
      cur.fields = fields; return;
    }
    if (type === 'D') {
      const n = body.readInt16BE(0); let p = 2; const row = {};
      for (let i = 0; i < n; i++) {
        const len = body.readInt32BE(p); p += 4; const f = cur.fields[i];
        if (len === -1) { row[f.name] = null; continue; }
        const s = body.toString('utf8', p, p + len); p += len;
        const conv = parsers[f.oid]; row[f.name] = conv ? conv(s) : s;
      }
      cur.result.rows.push(row); return;
    }
    if (type === 'C') { const tag = body.toString('utf8', 0, body.length - 1); const m = tag.match(/(\d+)$/); cur.result.rowCount += m ? Number(m[1]) : 0; return; }
  }

  handleAuth(body) {
    const code = body.readInt32BE(0);
    const { user, password } = this.cfg;
    if (code === 0) return;
    if (code === 3) return this.sock.write(msg('p', cstr(password)));
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(password + user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      return this.sock.write(msg('p', cstr('md5' + outer)));
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Unsupported database authentication');
      this.nonce = crypto.randomBytes(18).toString('base64');
      this.firstBare = 'n=*,r=' + this.nonce;
      const resp = Buffer.from('n,,' + this.firstBare);
      return this.sock.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), i32(resp.length), resp])));
    }
    if (code === 11) {
      const serverFirst = body.toString('utf8', 4);
      const a = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      if (!a.r.startsWith(this.nonce)) throw new Error('Database authentication failed (nonce)');
      const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = 'c=biws,r=' + a.r;
      const authMessage = `${this.firstBare},${serverFirst},${finalNoProof}`;
      const sig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.alloc(32); for (let i = 0; i < 32; i++) proof[i] = clientKey[i] ^ sig[i];
      const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
      this.expectServerSig = crypto.createHmac('sha256', serverKey).update(authMessage).digest('base64');
      return this.sock.write(msg('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)));
    }
    if (code === 12) {
      const v = body.toString('utf8', 4).split(',').find((x) => x.startsWith('v='))?.slice(2);
      if (v !== this.expectServerSig) throw new Error('Database server signature mismatch');
      return;
    }
    throw new Error('Unsupported database authentication method ' + code);
  }

  next() {
    if (this.current || !this.queue.length || this.dead) return;
    this.current = this.queue.shift();
    this.lastUsed = Date.now();
    this.sock.write(this.current.packet);
  }

  query(text, params = []) {
    if (this.dead) return Promise.reject(new Error('Database connection lost'));
    let packet;
    if (params === null) {
      packet = msg('Q', cstr(text));
    } else {
      const vals = params.map(toText);
      const parts = [cstr(''), cstr(''), i16(0), i16(vals.length)];
      for (const v of vals) { if (v === null) parts.push(i32(-1)); else { const b = Buffer.from(v, 'utf8'); parts.push(i32(b.length), b); } }
      parts.push(i16(1), i16(0));
      packet = Buffer.concat([
        msg('P', Buffer.concat([cstr(''), cstr(text), i16(0)])),
        msg('B', Buffer.concat(parts)),
        msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
        msg('E', Buffer.concat([cstr(''), i32(0)])),
        msg('S', Buffer.alloc(0)),
      ]);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ packet, resolve, reject, fields: [], result: { rows: [], rowCount: 0 } });
      this.next();
    });
  }

  close() { if (!this.dead) { try { this.sock.end(msg('X', Buffer.alloc(0))); } catch {} } this.dead = true; }
}

export class Pool {
  constructor(url, { max = 4, ca } = {}) {
    this.cfg = { ...parseUrl(url), ca }; this.max = max; this.all = new Set(); this.idle = []; this.waiting = [];
    this.timer = setInterval(() => this.reap(), 30000); this.timer.unref?.();
  }

  reap() {
    const now = Date.now();
    this.idle = this.idle.filter((c) => { if (now - c.lastUsed > 60000 && !c.dead) { c.close(); this.all.delete(c); return false; } return !c.dead; });
  }

  async acquire() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.all.delete(c); }
    if (this.all.size < this.max) {
      const c = new Connection(this.cfg); this.all.add(c);
      c.onClose = () => { this.all.delete(c); this.idle = this.idle.filter((x) => x !== c); this.drain(); };
      try { return await c.connect(); } catch (e) { this.all.delete(c); throw e; }
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  release(c) {
    if (c.dead) { this.all.delete(c); return this.drain(); }
    const w = this.waiting.shift();
    if (w) return w.resolve(c);
    c.lastUsed = Date.now(); this.idle.push(c);
  }

  drain() {
    if (!this.waiting.length || this.all.size >= this.max) return;
    const w = this.waiting.shift();
    this.acquire().then(w.resolve, w.reject);
  }

  async query(text, params = []) {
    const c = await this.acquire();
    try { return await c.query(text, params); } finally { this.release(c); }
  }

  // Runs fn(client) inside BEGIN/COMMIT on one connection.
  async tx(fn) {
    const c = await this.acquire();
    const client = { query: (t, p = []) => c.query(t, p) };
    try {
      await c.query('BEGIN', null);
      const out = await fn(client);
      await c.query('COMMIT', null);
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK', null); } catch {}
      throw e;
    } finally { this.release(c); }
  }

  async withClient(fn) {
    const c = await this.acquire();
    try { return await fn({ query: (t, p = []) => c.query(t, p) }); } finally { this.release(c); }
  }

  end() { clearInterval(this.timer); for (const c of this.all) c.close(); this.all.clear(); this.idle = []; }
}
