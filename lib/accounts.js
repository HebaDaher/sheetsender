// Connected accounts: Google (Gmail + Sheets), Microsoft (OneDrive Excel), WhatsApp Cloud API.
// OAuth tokens are stored encrypted; access tokens are refreshed automatically.
import { config } from './config.js';
import { one, all, run, raiseAlert, resolveAlert, logActivity } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { request, ProviderError } from './http.js';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/spreadsheets'];
export const MS_SCOPES = ['offline_access', 'User.Read', 'Files.ReadWrite'];

export function getAccount(id) {
  const a = one('SELECT * FROM accounts WHERE id = ?', id);
  if (a) a.info = JSON.parse(a.info || '{}');
  return a;
}
export function listAccounts() {
  return all('SELECT id, provider, label, identifier, info, status, last_error, tested_at, checked_at, created_at FROM accounts ORDER BY provider, id')
    .map((a) => ({ ...a, info: JSON.parse(a.info || '{}') }));
}

export function saveAccount({ id, provider, label, identifier, secret, info = {} }) {
  if (id) {
    run("UPDATE accounts SET label=?, identifier=?, secret=?, info=?, status='connected', last_error=NULL, updated_at=datetime('now') WHERE id=?",
      label, identifier, encryptJson(secret), JSON.stringify(info), id);
    resolveAlert(`account:${id}`);
    // Jobs that were waiting for this account to be reconnected can continue.
    run("UPDATE jobs SET status='pending', next_attempt_at=? WHERE status='blocked' AND error_kind='account'", Date.now());
    return id;
  }
  const ex = identifier ? one('SELECT id FROM accounts WHERE provider=? AND identifier=?', provider, identifier) : null;
  if (ex) return saveAccount({ id: ex.id, provider, label, identifier, secret, info });
  return Number(run('INSERT INTO accounts (provider, label, identifier, secret, info) VALUES (?,?,?,?,?)', provider, label, identifier, encryptJson(secret), JSON.stringify(info)).lastInsertRowid);
}

export function markAccountProblem(id, message) {
  const a = getAccount(id);
  if (!a) return;
  run("UPDATE accounts SET status='needs_attention', last_error=?, updated_at=datetime('now') WHERE id=?", message, id);
  raiseAlert(`account:${id}`, `${providerName(a.provider)} account "${a.label}" needs attention: ${message}. Open Connections and click Reconnect.`, { account_id: id });
  logActivity({ event: 'account_error', result: 'needs_attention', detail: `${a.label}: ${message}` });
}
export function markAccountHealthy(id) {
  run("UPDATE accounts SET status='connected', last_error=NULL, checked_at=datetime('now') WHERE id=? AND status != 'disconnected'", id);
  resolveAlert(`account:${id}`);
}
export const providerName = (p) => ({ google: 'Google', microsoft: 'Microsoft', whatsapp: 'WhatsApp' }[p] || p);

// Is this account usable for real sends? (connected and passed a test)
export function accountReady(id) {
  const a = id ? getAccount(id) : null;
  return !!(a && a.status === 'connected' && a.tested_at);
}

// ---------- token handling ----------
const refreshing = new Map();
export async function getAccessToken(accountId) {
  const a = getAccount(accountId);
  if (!a || a.status === 'disconnected') throw new ProviderError('Account is not connected', { kind: 'auth' });
  const s = decryptJson(a.secret);
  if (a.provider === 'whatsapp') return s.access_token;
  if (s.access_token && s.expires_at && s.expires_at - Date.now() > 120000) return s.access_token;
  if (refreshing.has(accountId)) return refreshing.get(accountId);
  const p = (async () => {
    let tok;
    if (a.provider === 'google') {
      tok = await request('Google', 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: s.refresh_token, grant_type: 'refresh_token' }),
      });
    } else {
      tok = await request('Microsoft', `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, refresh_token: s.refresh_token, grant_type: 'refresh_token', scope: MS_SCOPES.join(' ') }),
      });
    }
    const next = { ...s, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000 };
    if (tok.refresh_token) next.refresh_token = tok.refresh_token; // Microsoft rotates refresh tokens
    run("UPDATE accounts SET secret=?, updated_at=datetime('now') WHERE id=?", encryptJson(next), accountId);
    return next.access_token;
  })();
  refreshing.set(accountId, p);
  try { return await p; }
  catch (e) { if (e.kind === 'auth' || e.status === 400) { e.kind = 'auth'; markAccountProblem(accountId, 'Sign-in expired or access was removed'); } throw e; }
  finally { refreshing.delete(accountId); }
}

// ---------- OAuth URLs and code exchange ----------
export function googleAuthUrl(state) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: `${config.baseUrl}/oauth/google/callback`, response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  }).toString();
  return u.toString();
}
export async function googleExchange(code) {
  const tok = await request('Google', 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.baseUrl}/oauth/google/callback`, grant_type: 'authorization_code' }),
  });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  const granted = String(tok.scope || '');
  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https') && !granted.includes(s));
  if (missing.length) throw new Error('Please tick ALL permission boxes on the Google screen (Gmail send and Google Sheets). Missing: ' + missing.map((s) => s.split('/').pop()).join(', '));
  const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
  return { email: payload.email, secret: { refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 } };
}

export function microsoftAuthUrl(state) {
  const u = new URL(`https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: config.microsoft.clientId, response_type: 'code', redirect_uri: `${config.baseUrl}/oauth/microsoft/callback`,
    response_mode: 'query', scope: MS_SCOPES.join(' '), state, prompt: 'select_account',
  }).toString();
  return u.toString();
}
export async function microsoftExchange(code) {
  const tok = await request('Microsoft', `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, code, redirect_uri: `${config.baseUrl}/oauth/microsoft/callback`, grant_type: 'authorization_code', scope: MS_SCOPES.join(' ') }),
  });
  const me = await request('Microsoft', 'https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${tok.access_token}` } });
  return { email: me.mail || me.userPrincipalName, secret: { refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 } };
}

// ---------- health checks (also used by the "Test" button) ----------
export async function testAccount(id) {
  const a = getAccount(id);
  if (!a) throw new Error('Account not found');
  try {
    let detail;
    if (a.provider === 'google') {
      const t = await getAccessToken(id);
      const info = await request('Google', `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(t)}`);
      const scopes = String(info.scope || '');
      if (!scopes.includes('gmail.send') || !scopes.includes('spreadsheets')) throw new ProviderError('Missing Gmail or Sheets permission — reconnect and tick all boxes', { kind: 'auth' });
      detail = `Signed in as ${a.identifier}. Gmail send + Google Sheets permissions OK.`;
    } else if (a.provider === 'microsoft') {
      const t = await getAccessToken(id);
      const d = await request('Microsoft', 'https://graph.microsoft.com/v1.0/me/drive?$select=driveType,owner', { headers: { authorization: `Bearer ${t}` } });
      detail = `Signed in as ${a.identifier}. OneDrive (${d.driveType}) reachable.`;
    } else {
      const { waTest } = await import('./whatsapp.js');
      detail = await waTest(a);
    }
    run("UPDATE accounts SET tested_at=datetime('now') WHERE id=?", id);
    markAccountHealthy(id);
    return detail;
  } catch (e) {
    if (e.kind === 'auth' || e.status === 401 || e.status === 403 || e.code === 190) markAccountProblem(id, e.message);
    throw e;
  }
}
