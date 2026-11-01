// Loads settings from environment variables (and an optional .env file).
// Secrets are never hard-coded; see .env.example.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = process.env.ENV_FILE || path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;
export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  adminPassword: env.ADMIN_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  encryptionKey: env.ENCRYPTION_KEY || '',
  pollSeconds: Math.max(15, Number(env.POLL_SECONDS || 60)),
  google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
  microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '', tenant: env.MICROSOFT_TENANT || 'common' },
  meta: { apiVersion: env.META_API_VERSION || 'v23.0', appSecret: env.META_APP_SECRET || '', verifyToken: env.WHATSAPP_VERIFY_TOKEN || '' },
  gmailDailyLimit: Number(env.GMAIL_DAILY_LIMIT || 400),
  // Gmail allows 25 MB per message after encoding (~33% bigger). Keep raw attachments under this.
  emailAttachmentLimitBytes: Number(env.EMAIL_ATTACHMENT_LIMIT_MB || 18) * 1024 * 1024,
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 100) * 1024 * 1024,
};

export function checkConfig() {
  const problems = [];
  if (!config.adminPassword || config.adminPassword.length < 10) problems.push('ADMIN_PASSWORD must be set (at least 10 characters).');
  if (!config.sessionSecret || config.sessionSecret.length < 32) problems.push('SESSION_SECRET must be set (run: npm run gen-secrets).');
  if (!config.encryptionKey) problems.push('ENCRYPTION_KEY must be set (run: npm run gen-secrets).');
  return problems;
}

export const googleEnabled = () => !!(config.google.clientId && config.google.clientSecret);
export const microsoftEnabled = () => !!(config.microsoft.clientId && config.microsoft.clientSecret);
