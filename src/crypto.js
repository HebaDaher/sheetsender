// Encryption for stored credentials (AES-256-GCM), password hashing (scrypt) and signed links (HMAC-SHA256).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

export function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptJson(str) {
  if (!str) return null;
  const [v, iv, tag, data] = str.split(':');
  if (v !== 'v1') throw new Error('Unknown credential format');
  const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(pw, stored) {
  const [alg, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const got = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(key, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.macKey).update(body).digest('base64url').slice(0, 32);
  return `${body}.${mac}`;
}

export function verifySigned(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', config.macKey).update(body).digest('base64url').slice(0, 32);
  if (!safeEqual(mac, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 24) => crypto.randomBytes(n).toString('base64url');
export const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
