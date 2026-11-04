// Serves the real Index.html (templates resolved like HtmlService does) with google.script.run
// bridged to the simulated backend, so the UI can be clicked through in a real browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./harness');
const SRC = require('path').join(__dirname, '..', 'src');
const E = makeEnv(SRC);
E.as('owner@gmail.com');
E.ctx.setup();
if (!process.env.FRESH) {
  E.ctx.saveOAuthClient(E.google.client.id, E.google.client.secret);
  E.connect('shop1@gmail.com');
  E.ctx.assignShopSender('SHOP1', 'shop1@gmail.com');
}
const FIRST = '';
// The page signs in like a real visitor would. Older tests start already signed in as WEBUSER (the server puts that
// person's session in the page); LOGIN_FLOW=1 starts signed out so a test can click "Sign in with Google".
if (!process.env.FRESH) { E.as('owner@gmail.com'); E.ctx.addMember('dad@gmail.com'); }
let forced = process.env.LOGIN_FLOW ? '' : (process.env.WEBUSER || 'dad@gmail.com');
E.as(process.env.WEBUSER || 'dad@gmail.com');
if (process.env.REAL_CLOCK) E.realClock();

const shim = `<script>
window.google = { script: { get run() { return makeRunner(); } } };
function makeRunner() {
  var ok = function(){}, fail = function(){};
  var r = new Proxy({}, { get: function(_, name) {
    if (name === 'withSuccessHandler') return function(f){ ok = f; return r; };
    if (name === 'withFailureHandler') return function(f){ fail = f; return r; };
    return function() {
      var args = Array.prototype.slice.call(arguments);
      fetch('/rpc/' + name, { method: 'POST', body: JSON.stringify(args) }).then(function(res){ return res.json(); })
        .then(function(j){ setTimeout(function(){ j.error ? fail(new Error(j.error)) : ok(j.result); }, 50); });
    };
  }});
  return r;
}
</script>`;

function renderIndex(query) {
  let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (m, n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'));

  // like doGet: Google sends people back to the app's own link with ?code=&state=
  const q = new URLSearchParams(query || '');
  // the real doGet decides what goes into the page (same checks and escaping)
  const t = {}; E.real.HtmlService = E.real.HtmlService; // (template object filled like HtmlService does)
  const fake = { evaluate() { return this; }, setTitle() { return this; }, addMetaTag() { return this; } };
  const orig = E.real.HtmlService.createTemplateFromFile;
  E.real.HtmlService.createTemplateFromFile = () => fake;
  try { E.real.doGet({ parameter: Object.fromEntries(q) }); } finally { E.real.HtmlService.createTemplateFromFile = orig; }
  html = html.replace(/<\?!=\s*firstJs\s*\?>/, fake.firstJs).replace(/<\?!=\s*oauthJs\s*\?>/, fake.oauthJs);
  void t;
  if (/<\?/.test(html.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('unresolved template tag');
  const inject = forced ? '<script>try{localStorage.setItem("sf_session",' + JSON.stringify(E.sessionFor(forced)) + ')}catch(e){}</script>' : '';
  forced = forced && process.env.LOGIN_FLOW ? '' : forced;
  return html.replace('<head>', '<head>' + shim + inject);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/rpc/')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const fn = req.url.slice(5);
      let out;
      try {
        if (fn.endsWith('_') || typeof E.ctx[fn] !== 'function') throw new Error('Not callable: ' + fn);
        out = { result: JSON.parse(JSON.stringify(E.ctx[fn](...JSON.parse(body)) ?? null)) };
      } catch (e) { out = { error: e.message }; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.url === '/bridge' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(E.bridge(JSON.parse(body)))); });
    return;
  }
  if (req.url.startsWith('/as/')) { forced = decodeURIComponent(req.url.slice(4)); E.as(forced); res.end('"ok"'); return; }
  if (req.url.startsWith('/consent?')) { // fake Google: returns a one-time code for that account
    const q = new URL('http://x' + req.url).searchParams;
    res.end(JSON.stringify(E.google.consent(q.get('email')))); return;
  }
  if (req.url.startsWith('/pages/')) { // the GitHub Pages files (callback.html, style.css)
    const f = path.join(process.env.PAGES || path.join(__dirname, 'pages'), path.basename(req.url.split('?')[0]));
    res.setHeader('content-type', f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(f)); return;
  }
  if (req.url.startsWith('/google?')) { // simulate the person signing in at Google and clicking Allow
    const q = new URL('http://x' + req.url).searchParams;
    const code = E.google.consent(q.get('email'));
    const page = E.ctx.doGet({ parameter: { state: q.get('state'), code } });
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page.html); return;
  }
  if (req.url === '/tick') { // simulate N minutes of the owner's trigger
    E.runTrigger(Number(process.env.TICK || 6)); res.end(JSON.stringify({ sent: E.sent.length })); return;
  }
  if (req.url === '/meta') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sent: E.meta.sent, sheets: Object.keys(E.sheetsById) })); return; }
  if (req.url.startsWith('/tab?')) { // any workspace's tab: /tab?owner=sara@gmail.com&name=Send%20Log
    const q = new URL('http://x' + req.url).searchParams;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(E.tab(q.get('name'), E.sheetOf(q.get('owner'))))); return;
  }
  if (req.url === '/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sent: E.sent, log: E.tab('Send Log'), contacts: E.tab('Contacts') })); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderIndex(req.url.split('?')[1] || ''));
}).listen(8765, () => console.log('listening 8765'));
