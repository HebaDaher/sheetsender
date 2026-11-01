// Email sending through the user's own mailbox (SMTP). Gmail needs an "App password".
import { SmtpClient } from '../smtp.js';
import { buildEmail } from '../mime.js';
import { esc } from '../html.js';

export const PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465 },
};

// Official daily limits: Gmail 500/day for personal accounts, Google Workspace 2,000/day.
export function defaultDailyLimit(host, email) {
  if (/smtp\.gmail\.com/i.test(host)) return /@(gmail|googlemail)\.com$/i.test(email) ? 500 : 2000;
  return 0; // must be entered by the user for other providers
}

export async function openSession(secrets, info) {
  const client = new SmtpClient({ host: info.host, port: info.port, user: info.username || info.email, pass: secrets.password, secure: info.secure });
  await client.connect();
  return {
    async send({ to, data }) {
      try { await client.send(info.email, to, data); } catch (e) { await client.reset(); throw e; }
      return {};
    },
    close: () => client.quit(),
  };
}

export async function testConnection(secrets, info) {
  const s = await openSession(secrets, info);
  await s.close();
}

export async function sendPlain(secrets, info, { to, subject, text }) {
  const s = await openSession(secrets, info);
  try {
    const { data, messageId } = buildEmail({ fromName: info.from_name, fromEmail: info.email, to, subject, text, html: `<div dir="auto">${esc(text).replace(/\n/g, '<br>')}</div>` });
    await s.send({ to, data });
    return messageId;
  } finally { await s.close(); }
}

// Decide what to do after an SMTP error.
export function classifyEmailError(e) {
  const code = Number(e.responseCode || 0);
  const text = String(e.message || '');
  if (e.kind === 'auth' || [530, 534, 535].includes(code) || /5\.7\.(8|9|14)/.test(text)) {
    return { action: 'sender_broken', text: 'The email account rejected the sign-in. The app password may have been removed or the Google password changed. Reconnect this sender.' };
  }
  if (/5\.4\.5|daily.*(limit|quota)|quota exceeded|sending limit/i.test(text)) {
    return { action: 'hold_sender', seconds: 24 * 3600, text: 'The email provider says the daily sending limit was reached. Sending will continue automatically after 24 hours.' };
  }
  if (/5\.7\.1/.test(text) && /unsolicited|spam|abuse|block/i.test(text)) {
    return { action: 'pause_campaign', seconds: 24 * 3600, text: 'The email provider blocked sending because of possible spam. The campaign was paused. Check the Gmail account for a warning before resuming.' };
  }
  if ([421, 450, 451, 452, 454].includes(code) || /try again later|rate limit|too many/i.test(text)) {
    return { action: 'hold_sender', backoff: true, text: `The email provider asked to slow down (${text.slice(0, 120)}).` };
  }
  if (e.kind === 'recipient' || [550, 551, 553, 501].includes(code) || /5\.1\.\d/.test(text)) {
    return { action: 'fail_message', text: `The email address was rejected: ${text.slice(0, 200)}` };
  }
  if (code >= 500) return { action: 'fail_message', text: `The email provider refused this message: ${text.slice(0, 200)}` };
  return { action: 'retry_message', network: e.kind === 'network' || !code, text: `Temporary problem: ${text.slice(0, 200)}` };
}
