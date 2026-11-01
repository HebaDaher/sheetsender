// Gmail API sending (users.messages.send, media upload endpoint — up to 35 MB per request).
import fs from 'node:fs';
import { getAccessToken } from './accounts.js';
import { request } from './http.js';
import { mediaPath, downloadLink } from './media.js';
import { config } from './config.js';

const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');

// Splits selected media into real attachments and download links, respecting the size limit.
export function planAttachments(items) {
  const attach = [], links = [];
  let total = 0;
  for (const m of items) {
    if (m.kind === 'link') { links.push({ title: m.title, url: m.url }); continue; }
    if (total + m.size <= config.emailAttachmentLimitBytes) { attach.push(m); total += m.size; }
    else links.push({ title: m.filename, url: downloadLink(m), auto: true });
  }
  return { attach, links };
}

export function buildMime({ fromName, fromEmail, to, subject, text, unsubscribeUrl, shopName, attach, links }) {
  const boundary = 'mix_' + Math.random().toString(36).slice(2);
  const alt = 'alt_' + Math.random().toString(36).slice(2);
  let plain = text;
  if (links.length) plain += '\n\n' + links.map((l) => `${l.title}: ${l.url}`).join('\n');
  plain += `\n\n—\n${shopName}\nTo stop receiving these emails: ${unsubscribeUrl}`;
  let html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${linkify(escapeHtml(text)).replace(/\n/g, '<br>')}`;
  if (links.length) html += '<p>' + links.map((l) => `📎 <a href="${escapeHtml(l.url)}">${escapeHtml(l.title)}</a>`).join('<br>') + '</p>';
  html += `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 8px"><p style="font-size:12px;color:#777">${escapeHtml(shopName)} · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#777">Unsubscribe</a></p></div>`;

  const headers = [
    `From: ${encWord(fromName)} <${fromEmail}>`, `To: ${to}`, `Subject: ${encWord(subject)}`, 'MIME-Version: 1.0',
    `List-Unsubscribe: <${unsubscribeUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
    `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(Buffer.from(plain).toString('base64'))}` +
    `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(Buffer.from(html).toString('base64'))}--${alt}--\r\n`,
  ];
  for (const m of attach) {
    const name = m.filename;
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    parts.push(`--${boundary}\r\nContent-Type: ${m.mime}; name="${asciiName}"\r\nContent-Disposition: attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(fs.readFileSync(mediaPath(m)).toString('base64'))}`);
  }
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('') + `--${boundary}--\r\n`;
}

export async function sendEmail(accountId, fromEmail, mime) {
  const t = await getAccessToken(accountId);
  const r = await request('Gmail', 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media', {
    method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'message/rfc822' }, body: mime, timeout: 120000,
  });
  return r.id;
}
