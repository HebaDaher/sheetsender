// Minimal SMTP client (no dependencies): implicit TLS (port 465) or STARTTLS (587), AUTH PLAIN/LOGIN.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

export class SmtpError extends Error {
  constructor(message, code, kind) { super(message); this.responseCode = code; this.kind = kind; }
}

export class SmtpClient {
  constructor({ host, port, user, pass, secure, timeout = 30000 }) {
    this.host = host; this.port = Number(port); this.secure = secure ?? Number(port) === 465; this.user = user; this.pass = pass; this.timeout = timeout;
    this.buf = ''; this.waiters = []; this.lines = [];
  }

  attach(sock) {
    this.sock = sock;
    sock.setTimeout(this.timeout, () => sock.destroy(new SmtpError('The email server did not answer in time.', 0, 'network')));
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (e) => this.fail(e.kind ? e : new SmtpError(`Could not reach the email server (${e.code || e.message}).`, 0, 'network')));
    sock.on('close', () => this.fail(new SmtpError('The email server closed the connection.', 0, 'network')));
  }

  fail(e) { this.closed = true; const w = this.waiters.splice(0); w.forEach((x) => x.reject(e)); this.err = e; }

  onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const code = Number(line.slice(0, 3)); const text = this.lines.map((l) => l.slice(4)).join('\n'); this.lines = [];
        const w = this.waiters.shift(); if (w) w.resolve({ code, text });
      }
    }
  }

  read() { if (this.err) return Promise.reject(this.err); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }

  async cmd(line, expect, kind = 'command') {
    if (line !== null) this.sock.write(line + '\r\n');
    const r = await this.read();
    const ok = Array.isArray(expect) ? expect.includes(r.code) : r.code === expect;
    if (!ok) throw new SmtpError(`${r.code} ${r.text}`, r.code, kind);
    return r;
  }

  async connect() {
    const secure = this.secure;
    await new Promise((resolve, reject) => {
      const s = secure ? tls.connect({ host: this.host, port: this.port, servername: this.host }) : net.connect({ host: this.host, port: this.port });
      s.once(secure ? 'secureConnect' : 'connect', resolve);
      s.once('error', (e) => reject(new SmtpError(`Could not reach the email server ${this.host}:${this.port} (${e.code || e.message}).`, 0, 'network')));
      this.attach(s);
    });
    await this.cmd(null, 220);
    const name = os.hostname().includes('.') ? os.hostname() : 'sheetsender.local';
    let ehlo = await this.cmd(`EHLO ${name}`, 250);
    if (!secure) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError('This email server does not offer an encrypted connection on this port. Use port 465 or 587.', 0, 'config');
      await this.cmd('STARTTLS', 220);
      const old = this.sock; old.removeAllListeners('data'); old.removeAllListeners('close'); old.removeAllListeners('error'); old.setTimeout(0);
      await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: old, servername: this.host }, resolve);
        t.once('error', (e) => reject(new SmtpError(`Encryption with the email server failed (${e.message}).`, 0, 'network')));
        this.attach(t);
      });
      ehlo = await this.cmd(`EHLO ${name}`, 250);
    }
    const auth = (ehlo.text.match(/AUTH[ =]([^\n]*)/i) || [])[1] || 'PLAIN LOGIN';
    if (/PLAIN/i.test(auth)) {
      await this.cmd('AUTH PLAIN ' + Buffer.from(`\0${this.user}\0${this.pass}`).toString('base64'), 235, 'auth');
    } else {
      await this.cmd('AUTH LOGIN', 334, 'auth');
      await this.cmd(Buffer.from(this.user).toString('base64'), 334, 'auth');
      await this.cmd(Buffer.from(this.pass).toString('base64'), 235, 'auth');
    }
    return this;
  }

  async send(from, to, data) {
    await this.cmd(`MAIL FROM:<${from}>`, 250, 'sender');
    await this.cmd(`RCPT TO:<${to}>`, [250, 251], 'recipient');
    await this.cmd('DATA', 354);
    const body = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.sock.write(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n');
    const r = await this.cmd(null, 250, 'data');
    return { response: r.text };
  }

  async reset() { try { await this.cmd('RSET', 250); } catch {} }

  async quit() {
    try { if (!this.closed) { this.sock.write('QUIT\r\n'); this.sock.end(); } } catch {}
    this.closed = true;
  }
}
