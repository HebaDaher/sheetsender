// HTML helpers: auto-escaping template tag and the page layout.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));

function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const fmtDate = (d, tz = 'Asia/Dubai') => (d ? new Date(d).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) : '');
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const NAV = [
  ['/', 'Home'], ['/shops', 'Shops & files'], ['/senders', 'Senders'], ['/campaigns', 'Campaigns'], ['/optouts', 'Opt-outs'], ['/settings', 'Settings'],
];

export function layout({ title, user, csrf, body, active, notice, error, wide }) {
  return '<!doctype html>' + html`<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · SheetSender</title>
<link rel="icon" href="/static/favicon.svg"><link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="logo">S</span> SheetSender</a>
  ${user ? html`<nav>${NAV.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button class="link">Log out</button></form></nav>` : ''}
</header>
<main class="${wide ? 'wide' : ''}">
  ${notice ? html`<div class="flash ok" role="status">${notice}</div>` : ''}
  ${error ? html`<div class="flash err" role="alert">${error}</div>` : ''}
  ${body}
</main>
<footer class="foot">SheetSender · sends only to people who agreed · <a href="/privacy">Privacy</a></footer>
</body></html>`.s;
}

export const channelName = (ch) => (ch === 'email' ? 'Email' : 'WhatsApp');
export const showAddress = (ch, addr) => (ch === 'whatsapp' && addr ? '+' + addr : addr);
export const waLimitText = (info) => (info?.limit_raw === 'TIER_UNLIMITED' ? 'unlimited' : `${info?.limit ?? 250} different people per 24 hours`);
export const countryOptions = (countries, selected) => Object.entries(countries).map(([k, v]) => html`<option value="${k}" ${selected === k ? 'selected' : ''}>${v.name} (+${v.cc})</option>`);

export const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

export function badge(status) {
  const map = {
    draft: 'grey', active: 'green', paused: 'amber', completed: 'blue', cancelled: 'grey', verified: 'green', unverified: 'amber', error: 'red',
    queued: 'grey', sending: 'amber', sent: 'green', delivered: 'green', read: 'green', failed: 'red', skipped: 'grey', unknown: 'amber',
  };
  return html`<span class="badge ${map[status] || 'grey'}">${status}</span>`;
}
