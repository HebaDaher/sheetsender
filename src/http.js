// Tiny HTTP toolkit: routing, body parsing (forms, JSON, file uploads), cookies and security headers.
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, path, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.re);
      if (m) { try { return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; } catch { return null; } }
    }
    return null;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseMultipart(buf, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new HttpError(400, 'Bad upload');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; const files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.subarray(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next === -1) break;
    const data = buf.subarray(headEnd + 4, next - 2);
    const name = (head.match(/name="([^"]*)"/i) || [])[1];
    const filename = (head.match(/filename="([^"]*)"/i) || [])[1];
    const type = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream';
    if (name != null) {
      if (filename !== undefined) { if (filename) files.push({ field: name, filename: filename.split(/[\\/]/).pop(), mime: type.trim(), data: Buffer.from(data) }); }
      else addField(fields, name, data.toString('utf8'));
    }
    pos = next;
  }
  return { fields, files };
}

function addField(obj, k, v) {
  if (k.endsWith('[]')) { k = k.slice(0, -2); (obj[k] ||= []).push(v); return; }
  if (k in obj) obj[k] = [].concat(obj[k], v); else obj[k] = v;
}

export async function parseBody(req, limit = 1024 * 1024) {
  const type = req.headers['content-type'] || '';
  const raw = await readBody(req, limit);
  req.rawBody = raw;
  if (type.startsWith('multipart/form-data')) return parseMultipart(raw, type);
  if (type.startsWith('application/json')) {
    try { return { fields: raw.length ? JSON.parse(raw.toString('utf8')) : {}, files: [] }; } catch { throw new HttpError(400, 'Bad JSON'); }
  }
  const fields = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) addField(fields, k, v);
  return { fields, files: [] };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (config.secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
}

export function securityHeaders(res) {
  // form-action also allows Google's sign-in page, because "Continue with Google" redirects there.
  res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self' ${new URL(config.googleAuthUrl).origin}; base-uri 'none'; object-src 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
export function redirect(res, to) { res.writeHead(303, { Location: to }); res.end(); }

// Simple in-memory rate limiter (per key).
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n += 1;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.n <= max;
}

export function clientIp(req) {
  // The hosting proxy appends the real client address as the LAST entry; earlier entries can be faked by the client.
  return (req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '';
}
