// Gmail sending through Google's official Gmail API (HTTPS). Used because free hosting blocks email (SMTP) ports.
// Each Gmail account is connected once with "Sign in with Google"; the app only asks for permission to SEND email.
import { config } from '../config.js';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const enabled = () => !!(config.googleClientId && config.googleClientSecret);
export const redirectUri = () => `${config.publicUrl}/oauth/google/callback`;

export class GmailError extends Error {
  constructor(message, { status = 0, reason = '', retryAt = null, ambiguous = false, notSent = false } = {}) {
    super(message); this.gmail = true; this.status = status; this.reason = reason; this.retryAt = retryAt; this.ambiguous = ambiguous; this.notSent = notSent;
  }
}

export function authUrl(state) {
  const u = new URL(config.googleAuthUrl);
  u.search = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: `openid email ${SCOPE}`, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false', state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(config.googleTokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }), signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new GmailError(`Could not reach Google (${e.cause?.code || e.message})`, { notSent: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const broken = data.error === 'invalid_grant' || data.error === 'unauthorized_client' || data.error === 'invalid_client';
    throw new GmailError(`Google sign-in problem: ${data.error_description || data.error || res.status}`, { status: broken ? 401 : res.status, reason: data.error || '', notSent: true });
  }
  return data;
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new GmailError('Google did not give long-term access. Remove "SheetSender" at myaccount.google.com/permissions and connect again.');
  if (!String(t.scope || '').split(' ').includes(SCOPE)) throw new GmailError('Permission to send email was not given. Connect again and tick the box "Send email on your behalf".');
  // The ID token comes straight from Google's token endpoint over HTTPS, so its contents can be read directly.
  let email = null;
  try {
    const p = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString('utf8'));
    if (p.email && p.email_verified !== false) email = String(p.email).toLowerCase();
  } catch {}
  if (!email) throw new GmailError('Google did not tell us the email address. Please try again.');
  return { refreshToken: t.refresh_token, email };
}

const cache = new Map(); // refresh token → { token, exp }
async function accessToken(refreshToken) {
  const c = cache.get(refreshToken);
  if (c && c.exp > Date.now() + 60000) return c.token;
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  cache.set(refreshToken, { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3000) * 1000 });
  return t.access_token;
}

export async function checkAccess(refreshToken) { await accessToken(refreshToken); }

// Sends a complete MIME message. Returns Gmail's message id.
export async function sendRaw(refreshToken, mime) {
  const token = await accessToken(refreshToken);
  let res;
  try {
    res = await fetch(`${config.gmailApiBase}/gmail/v1/users/me/messages/send`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }), signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    const code = e.cause?.code;
    const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    throw new GmailError(`Could not reach Gmail (${code || e.message})`, { notSent, ambiguous: !notSent });
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data.id;
  const err = data.error || {};
  const reason = err.errors?.[0]?.reason || err.status || '';
  const msg = err.message || `Gmail error ${res.status}`;
  const m = msg.match(/Retry after (\d{4}-\d\d-\d\dT[\d:.]+Z)/i);
  const ra = Number(res.headers.get('retry-after'));
  const retryAt = m ? new Date(m[1]) : ra > 0 ? new Date(Date.now() + ra * 1000) : null;
  if (res.status === 401) cache.delete(refreshToken);
  throw new GmailError(msg, { status: res.status, reason, retryAt, ambiguous: res.status >= 500 });
}

// What to do after a Gmail API error.
export function classifyGmailError(e) {
  const t = String(e.message || '').slice(0, 200);
  const secs = e.retryAt ? Math.max(60, (e.retryAt.getTime() - Date.now()) / 1000) : null;
  if (e.status === 401 || e.reason === 'invalid_grant' || /insufficient|permission/i.test(e.reason || '')) {
    return { action: 'sender_broken', text: 'Google no longer allows this app to send from this Gmail (access was removed or the password changed). Open the sender and press "Reconnect with Google".' };
  }
  if (e.status === 429 || /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded/i.test(e.reason) || /limit exceeded/i.test(t)) {
    if (/sending limit|daily/i.test(t) || /dailyLimitExceeded/.test(e.reason)) return { action: 'hold_sender', seconds: secs || 24 * 3600, text: 'Gmail says this account reached its daily sending limit. Sending continues automatically when Google allows it.' };
    return { action: 'hold_sender', seconds: secs, backoff: !secs, text: `Gmail asked to slow down (${t}).` };
  }
  if (e.status === 400) return { action: 'fail_message', text: `Gmail refused this message: ${t}` };
  if (e.status === 403) return { action: 'pause_campaign', text: `Gmail blocked sending from this account: ${t}. The campaign was paused — check the Gmail inbox for a warning from Google.` };
  return { action: 'retry_message', network: true, text: `Temporary Gmail problem: ${t}` };
}
