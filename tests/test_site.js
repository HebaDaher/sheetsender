// "Your own website": Google sends people back to https://<site>/oauth/, which passes them on to the app.
const assert = require('assert');
const path = require('path');
const { makeEnv } = require('./harness');
const SRC = path.join(__dirname, '..', 'src');
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 5).join('\n    ')); process.exitCode = 1; }
}
function throwsMsg(fn, re) { let err; try { fn(); } catch (e) { err = e; } assert(err, 'expected ' + re); assert(re.test(err.message), 'error was: ' + err.message); }
const E = makeEnv(SRC); const C = E.ctx; const G = E.google;
E.as('owner@gmail.com'); C.setup(); C.saveOAuthClient(G.client.id, G.client.secret); C.addMember('dad@gmail.com');
const APP = 'https://script.google.com/macros/s/DEPLOY123/exec';
E.sites = {};
console.log('Your own website for Google verification');
t('only the administrator can switch it on', () => {
  E.as('dad@gmail.com'); throwsMsg(() => C.saveWebsite('shopeleader.ae'), /administrator|Only/i);
});
t('refused while the website is not online, or is not this app\'s return page (sign-in never breaks)', () => {
  E.as('owner@gmail.com');
  throwsMsg(() => C.saveWebsite('shopeleader.ae'), /cannot be opened yet/);
  E.sites['https://shopeleader.ae/oauth/'] = '<html>hello</html>';
  throwsMsg(() => C.saveWebsite('shopeleader.ae'), /not the app's return page/);
  E.sites['https://shopeleader.ae/oauth/'] = '<html><!-- sf-oauth-forwarder --><script>var APP="https://script.google.com/macros/s/OTHER/exec"</script></html>';
  throwsMsg(() => C.saveWebsite('shopeleader.ae'), /not the app's return page/);
  throwsMsg(() => C.saveWebsite('not a domain'), /only the website name/);
  assert(C.startLogin().includes(encodeURIComponent(APP)), 'still the app link');
});
t('switched on: Google is told to return to https://shopeleader.ae/oauth/, and sign-in completes with it', () => {
  E.as('owner@gmail.com');
  E.sites['https://shopeleader.ae/oauth/'] = '<html><!-- sf-oauth-forwarder --><script>var APP="' + APP + '"</script></html>';
  const r = C.saveWebsite('https://ShopeLeader.ae/anything');
  assert.strictEqual(r.site, 'shopeleader.ae'); assert.strictEqual(r.redirectUri, 'https://shopeleader.ae/oauth/');
  const url = C.startLogin();
  assert(url.includes('redirect_uri=' + encodeURIComponent('https://shopeleader.ae/oauth/')), url);
  G.redirects.push('https://shopeleader.ae/oauth/');
  const st = decodeURIComponent(url.match(/state=([^&]+)/)[1]);
  const code = G.consent('newperson@gmail.com');
  const done = C.finishLogin(code, st);
  assert.strictEqual(done.email, 'newperson@gmail.com');
  assert.strictEqual(C.getSettings().website, 'shopeleader.ae');
});
t('Gmail connect uses the same return address', () => {
  E.as('owner@gmail.com');
  const u = C.startGmailConnect('');
  assert(String(u.url || u).includes(encodeURIComponent('https://shopeleader.ae/oauth/')));
});
t('switching it off goes back to the app link', () => {
  E.as('owner@gmail.com');
  assert.strictEqual(C.saveWebsite('').redirectUri, APP);
  assert(C.startLogin().includes(encodeURIComponent(APP)));
});
console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some FAILED' : ''));
