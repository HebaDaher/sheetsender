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
E.as(process.env.WEBUSER || 'dad@gmail.com');

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

function renderIndex() {
  let html = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (m, n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'));
  if (/<\?/.test(html.replace(/<script>[\s\S]*?<\/script>/g, ''))) throw new Error('unresolved template tag');
  return html.replace('<head>', '<head>' + shim);
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
  if (req.url.startsWith('/as/')) { E.as(decodeURIComponent(req.url.slice(4))); res.end('"ok"'); return; }
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
  if (req.url === '/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sent: E.sent, log: E.tab('Send Log'), contacts: E.tab('Contacts') })); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderIndex());
}).listen(8765, () => console.log('listening 8765'));
