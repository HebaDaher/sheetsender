// Accounts, sign-in sessions and CSRF protection.
import { q, one } from './db.js';
import { hashPassword, checkPassword, randomToken, sha256, safeEqual } from './crypto.js';
import { parseCookies, setCookie } from './http.js';

const SESSION_DAYS = 14;

export async function createUser({ email, name, password }) {
  const hash = await hashPassword(password);
  return one('INSERT INTO users (email, name, password_hash, webhook_key) VALUES ($1,$2,$3,$4) RETURNING *', [email.trim(), name.trim(), hash, randomToken(18)]);
}

export async function login(res, userId) {
  const token = randomToken(32);
  await q("INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES ($1,$2,$3, now() + interval '14 days')", [sha256(token), userId, randomToken(24)]);
  setCookie(res, 'ss', token, { maxAge: SESSION_DAYS * 86400 });
  await q('DELETE FROM sessions WHERE expires_at < now()');
}

export async function logout(req, res) {
  const token = parseCookies(req.headers.cookie).ss;
  if (token) await q('DELETE FROM sessions WHERE id=$1', [sha256(token)]);
  setCookie(res, 'ss', '', { maxAge: 0 });
}

export async function loadSession(req) {
  const token = parseCookies(req.headers.cookie).ss;
  if (!token) return null;
  const s = await one(`SELECT s.csrf, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at > now()`, [sha256(token)]);
  if (!s) return null;
  const { csrf, password_hash, ...user } = s;
  return { user, csrf };
}

export async function verifyLogin(email, password) {
  const u = await one('SELECT * FROM users WHERE lower(email)=lower($1)', [email.trim()]);
  if (!u) { await hashPassword('timing-equaliser'); return { error: 'Wrong email or password.' }; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: 'Too many wrong passwords. Try again in 15 minutes.' };
  if (!(await checkPassword(password, u.password_hash))) {
    await q("UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id=$1", [u.id]);
    return { error: 'Wrong email or password.' };
  }
  await q('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  return { user: u };
}

export const csrfOk = (sess, token) => !!sess && safeEqual(sess.csrf, token || '');

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use a password of at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}
