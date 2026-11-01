// All settings come from environment variables set in the hosting dashboard (Render → Environment).
import crypto from 'node:crypto';

const env = process.env;
const secret = env.APP_SECRET || '';

function derive(label) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('sheetsender'), Buffer.from(label), 32));
}

const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');

export const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || '',
  databaseCa: env.DATABASE_CA_CERT ? env.DATABASE_CA_CERT.replace(/\\n/g, '\n') : undefined,
  publicUrl,
  secure: publicUrl.startsWith('https://'),
  signupCode: env.SIGNUP_CODE || '',
  graphVersion: env.GRAPH_API_VERSION || 'v26.0',
  graphBase: env.GRAPH_API_BASE || 'https://graph.facebook.com',
  // Test-only switches (never set these on the real host).
  disableBackgroundLoop: env.SHEETSENDER_NO_LOOP === '1',
  secretOk: secret.length >= 32,
  encKey: secret.length >= 32 ? derive('encrypt-credentials-v1') : null,
  macKey: secret.length >= 32 ? derive('sign-links-v1') : null,
};

config.cronKey = config.macKey ? crypto.createHmac('sha256', config.macKey).update('cron').digest('base64url').slice(0, 32) : '';

export function missingSettings() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.secretOk) missing.push('APP_SECRET');
  return missing;
}
