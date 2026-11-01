// Builds a standards-compliant email (text + HTML, inline images, attachments, unsubscribe headers).
import crypto from 'node:crypto';

const b64lines = (buf) => Buffer.from(buf).toString('base64').replace(/.{1,76}/g, '$&\r\n');
const needsEnc = (s) => /[^\x20-\x7e]/.test(s);
export const encodeWord = (s) => (needsEnc(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);

function encodeHeaderPhrase(name) {
  if (!name) return '';
  if (needsEnc(name)) return encodeWord(name);
  return /[(),.:;<>@[\]\\"]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name;
}

export const formatAddress = (name, email) => (name ? `${encodeHeaderPhrase(name)} <${email}>` : `<${email}>`);

// Long subjects must be split into several encoded words of < 76 chars.
function encodeSubject(s) {
  if (!needsEnc(s)) return s.replace(/[\r\n]+/g, ' ');
  const words = []; let chunk = '';
  for (const ch of s.replace(/[\r\n]+/g, ' ')) {
    if (Buffer.byteLength(chunk + ch) > 42) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(encodeWord).join('\r\n ');
}

export function buildEmail({ fromName, fromEmail, to, toName, subject, text, html, inline = [], attachments = [], unsubscribeUrl, replyTo }) {
  const domain = fromEmail.split('@')[1] || 'localhost';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const boundary = () => '=_ss_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${formatAddress(toName, to)}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  if (replyTo) headers.push(`Reply-To: <${replyTo}>`);
  if (unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${unsubscribeUrl}>`);
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  const textPart = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(text)}`;
  const htmlPart = `Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(html)}`;

  let htmlBlock = htmlPart;
  if (inline.length) {
    const b = boundary();
    htmlBlock = `Content-Type: multipart/related; boundary="${b}"\r\n\r\n--${b}\r\n${htmlPart}` +
      inline.map((f) => `--${b}\r\nContent-Type: ${f.mime}; name="${encodeWord(f.filename)}"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${f.cid}>\r\nContent-Disposition: inline; filename="${encodeWord(f.filename)}"\r\n\r\n${b64lines(f.data)}`).join('') +
      `--${b}--\r\n`;
  }
  const alt = boundary();
  let bodyBlock = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart}--${alt}\r\n${htmlBlock}--${alt}--\r\n`;
  if (attachments.length) {
    const mix = boundary();
    bodyBlock = `Content-Type: multipart/mixed; boundary="${mix}"\r\n\r\n--${mix}\r\n${bodyBlock}` +
      attachments.map((f) => `--${mix}\r\nContent-Type: ${f.mime}; name="${encodeWord(f.filename)}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${encodeWord(f.filename)}"\r\n\r\n${b64lines(f.data)}`).join('') +
      `--${mix}--\r\n`;
  }
  return { messageId, data: headers.join('\r\n') + '\r\n' + bodyBlock };
}
