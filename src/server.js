// SheetSender web server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, missingSettings } from './config.js';
import { Router, HttpError, parseBody, securityHeaders, sendHtml, sendJson, redirect, clientIp, rateLimit } from './http.js';
import { layout, html } from './html.js';
import { initDb } from './db.js';
import { loadSession, csrfOk } from './auth.js';
import { startLoop } from './worker.js';
import registerPublic from './routes/public.js';
import registerShops from './routes/shops.js';
import registerSenders from './routes/senders.js';
import registerCampaigns from './routes/campaigns.js';
import registerAccount from './routes/account.js';
import registerMedia from './routes/media.js';

const router = new Router();
registerPublic(router); registerShops(router); registerSenders(router); registerCampaigns(router); registerAccount(router); registerMedia(router);

const STATIC = path.resolve(new URL('../public', import.meta.url).pathname);
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

// Paths that are allowed without sign-in / CSRF token (they authenticate in other ways).
const OPEN = [/^\/(login|signup|health|privacy)$/, /^\/u\//, /^\/webhooks\//, /^\/cron\//, /^\/static\//];
const NO_CSRF = [/^\/(login|signup)$/, /^\/u\//, /^\/webhooks\//];

function setupPage(missing) {
  const secret = crypto.randomBytes(32).toString('base64url');
  return layout({
    title: 'Finish setup', body: html`<section class="card"><h1>Almost there — finish the hosting setup</h1>
    <p>The app is running, but these settings are missing in your hosting dashboard (Render → your service → <b>Environment</b>):</p>
    <ul>${missing.map((m) => html`<li><code>${m}</code></li>`)}</ul>
    ${missing.includes('APP_SECRET') ? html`<p>Use this freshly generated value for <code>APP_SECRET</code> (copy all of it; it is shown only on this page and changes each time you reload):</p>
    <p><code class="secret">${secret}</code></p><p class="warn">Keep APP_SECRET private and never change it later — it locks your saved email and WhatsApp passwords.</p>` : ''}
    <p>After saving the settings, Render restarts the app automatically. Then reload this page.</p></section>`,
  });
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  if (pathname.startsWith('/static/')) {
    const file = path.resolve(STATIC, '.' + pathname.slice(7));
    if (!file.startsWith(STATIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    return res.end(fs.readFileSync(file));
  }
  const missing = missingSettings();
  if (missing.length) return sendHtml(res, 200, setupPage(missing));

  const found = router.match(req.method, pathname);
  if (!found) return sendHtml(res, 404, layout({ title: 'Not found', body: html`<section class="card"><h1>Page not found</h1><p><a href="/">Go to the start page</a></p></section>` }));

  const isOpen = OPEN.some((r) => r.test(pathname));
  const sess = await loadSession(req);
  if (!sess && !isOpen) return redirect(res, '/login');

  const ctx = {
    req, res, params: found.params, query: Object.fromEntries(url.searchParams), url,
    user: sess?.user || null, csrf: sess?.csrf || '', body: {}, files: [],
    page(title, body, opts = {}) {
      sendHtml(res, opts.status || 200, layout({ title, body, user: this.user, csrf: this.csrf, active: opts.active, wide: opts.wide,
        notice: opts.notice ?? this.query.ok, error: opts.error ?? this.query.err }));
    },
    go(to, { ok, err } = {}) {
      const u = new URL(to, 'http://x');
      if (ok) u.searchParams.set('ok', ok);
      if (err) u.searchParams.set('err', err);
      redirect(res, u.pathname + u.search);
    },
    json: (status, obj) => sendJson(res, status, obj),
  };

  if (req.method === 'POST') {
    if (!pathname.startsWith('/webhooks/') && !rateLimit('post:' + clientIp(req), 600, 60000)) throw new HttpError(429, 'Too many requests. Please wait a minute.');
    const big = /\/(upload|edit|templates)$/.test(pathname);
    const parsed = await parseBody(req, big ? 40 * 1024 * 1024 : 2 * 1024 * 1024);
    ctx.body = parsed.fields; ctx.files = parsed.files;
    if (!NO_CSRF.some((r) => r.test(pathname))) {
      if (!csrfOk(sess, ctx.body._csrf || req.headers['x-csrf-token'])) throw new HttpError(403, 'This form expired. Go back, reload the page and try again.');
    }
    const origin = req.headers.origin;
    if (origin && !/^\/(webhooks|u)\//.test(pathname) && origin !== 'null') {
      const allowed = new URL(config.publicUrl).host;
      if (new URL(origin).host !== allowed && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Request blocked (wrong origin).');
    }
  }

  for (const h of found.route.handlers) await h(ctx);
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const msg = status === 500 ? 'Something went wrong on our side. Please try again.' : e.message;
      if ((req.headers.accept || '').includes('application/json')) return sendJson(res, status, { error: msg });
      sendHtml(res, status, layout({ title: 'Problem', body: html`<section class="card"><h1>Sorry</h1><p>${msg}</p><p><a href="/">Go to the start page</a></p></section>` }));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = missingSettings();
  if (!missing.length) {
    await initDb();
    startLoop();
  } else console.warn('Missing settings:', missing.join(', '));
  createServer().listen(config.port, () => console.log(`SheetSender listening on port ${config.port} (${config.publicUrl})`));
}
