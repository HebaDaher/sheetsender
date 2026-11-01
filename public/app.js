// SheetSender dashboard (plain JavaScript, no build step).
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
let META = null;

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'sheetsender' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, bad = false, ms = 5000) {
  const t = document.createElement('div');
  t.className = 't' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), bad ? Math.max(ms, 9000) : ms);
}
// Runs an async action with a busy button and shows errors as a toast.
async function act(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Working…'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  return { el: bg, close };
}
const fmtDate = (s) => { if (!s) return '—'; const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(); };
const ago = (s) => { if (!s) return 'never'; const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z'); const m = Math.round((Date.now() - d) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : d.toLocaleDateString(); };
const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function acctBadge(a, name) {
  if (!a) return `<span class="badge">${name}: not selected</span>`;
  if (a.status === 'connected' && a.tested) return `<span class="badge ok">${name} ✓</span>`;
  if (a.status === 'connected') return `<span class="badge warn">${name}: not tested</span>`;
  return `<span class="badge bad">${name}: ${a.status === 'disconnected' ? 'disconnected' : 'needs attention'}</span>`;
}
function sheetBadge(sh) {
  if (!sh.provider) return '<span class="badge">Not connected</span>';
  if (sh.status === 'error') return `<span class="badge bad">Error</span>`;
  if (!sh.tab) return '<span class="badge warn">Choose tab</span>';
  return `<span class="badge ok">${sh.provider === 'google' ? 'Google Sheet' : sh.provider === 'microsoft' ? 'OneDrive Excel' : 'Demo sheet'} ✓</span>`;
}

// ---------- auth ----------
function showLogin() {
  $('#topbar').hidden = true;
  app.innerHTML = `<div class="card login"><h1>Sign in</h1><p class="muted">SheetSender dashboard</p>
    <form id="lf"><div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
    <button class="big" style="width:100%;justify-content:center">Sign in</button></form></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    await act(e.submitter, async () => { await api('POST', '/api/login', { password: $('#pw').value }); start(); });
  });
}
$('#logoutBtn').addEventListener('click', async () => { await api('POST', '/api/logout'); showLogin(); });
$('#menuBtn').addEventListener('click', () => $('#nav').classList.toggle('open'));

// ---------- router ----------
const pages = {};
async function render() {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const page = parts[0] || 'shops';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page === 'shop' ? 'shops' : page)));
  $('#nav').classList.remove('open');
  const params = new URLSearchParams(query || '');
  const fn = pages[page] || pages.shops;
  app.innerHTML = '<p class="muted center">Loading…</p>';
  try { await fn(parts[1], params); } catch (e) { app.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

async function start() {
  const me = await api('GET', '/api/me');
  if (!me.authed) return showLogin();
  $('#topbar').hidden = false;
  META = META || await api('GET', '/api/meta');
  render();
}

// Shop picker used on Templates / Attachments / Automation pages.
async function pickShop(id, page) {
  const { shops } = await api('GET', '/api/overview');
  if (!shops.length) { app.innerHTML = `<div class="card center"><h2>No shops yet</h2><p class="muted">Create your first shop on the dashboard.</p><a class="btn" href="#/">Go to Shops</a></div>`; return null; }
  let chosen = shops.find((s) => String(s.id) === String(id)) || shops.find((s) => String(s.id) === store.get('lastShop')) || shops[0];
  store.set('lastShop', chosen.id);
  const html = `<div class="field" style="max-width:380px"><label for="shopPick">Shop</label><select id="shopPick">${shops.map((s) => `<option value="${s.id}" ${s.id === chosen.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`;
  return { shop: chosen, shops, html, bind: () => $('#shopPick').addEventListener('change', (e) => { location.hash = `#/${page}/${e.target.value}`; }) };
}

// ---------- Dashboard ----------
pages.shops = async () => {
  const d = await api('GET', '/api/overview');
  const running = d.shops.filter((s) => s.status === 'active').length;
  app.innerHTML = `
  <div class="page-head"><div><h1>Shops</h1><p class="muted">${d.shops.length} shop(s) · ${running} running</p></div>
    <div class="row"><button class="${d.global_paused ? '' : 'danger'}" id="gp">${d.global_paused ? '▶ Resume all shops' : '⏸ Pause all shops'}</button><button id="addShop">+ Add New Shop</button></div></div>
  ${d.global_paused ? '<div class="notice warn"><b>All sending is paused.</b> No shop will send anything until you click "Resume all shops". Each shop keeps its own Start/Pause setting.</div>' : ''}
  ${d.worker_online ? '' : `<div class="notice bad"><b>The background service is not running.</b> Nothing will be sent until it is started on the server (see SETUP.md, step 8). Last seen: ${d.worker_last_seen ? new Date(d.worker_last_seen).toLocaleString() : 'never'}.</div>`}
  ${!d.owner.email && !d.owner.phone ? '<div class="notice">First step: add your own email and WhatsApp number on <a href="#/connections">Connections</a>. Test mode sends only to you.</div>' : ''}
  ${d.alerts.map((a) => `<div class="notice bad"><div>⚠ ${esc(a.message)}</div><div class="row"><span class="small">${fmtDate(a.created_at)}</span><button class="small ghost" data-dismiss="${a.id}">Dismiss</button></div></div>`).join('')}
  <div class="grid">${d.shops.map(shopCard).join('') || `<div class="card center"><h2>Create your first shop</h2><p class="muted">Each shop has its own spreadsheet, messages, attachments and rules.</p><button id="addShop2">+ Add New Shop</button></div>`}</div>`;
  $('#gp').onclick = (e) => act(e.currentTarget, async () => {
    if (!d.global_paused && !confirm('Pause sending for ALL shops?')) return;
    await api('POST', '/api/global-pause', { paused: !d.global_paused }); render();
  });
  const add = () => addShopModal();
  $('#addShop').onclick = add; if ($('#addShop2')) $('#addShop2').onclick = add;
  $$('[data-dismiss]').forEach((b) => (b.onclick = () => act(b, async () => { await api('POST', `/api/alerts/${b.dataset.dismiss}/dismiss`); render(); })));
  $$('[data-start]').forEach((b) => (b.onclick = () => startModal(Number(b.dataset.start), d.shops.find((s) => s.id === Number(b.dataset.start)))));
  $$('[data-pause]').forEach((b) => (b.onclick = () => act(b, async () => { await api('POST', `/api/shops/${b.dataset.pause}/pause`); toast('Shop paused. Other shops keep running.'); render(); })));
};

function shopCard(s) {
  const run = s.status === 'active';
  const ch = s.channels === 'both' ? 'Email + WhatsApp' : s.channels === 'email' ? 'Email only' : 'WhatsApp only';
  const last = s.last ? `${s.last.event === 'simulated' ? 'Simulated' : s.last.event[0].toUpperCase() + s.last.event.slice(1)} ${s.last.channel ? '(' + s.last.channel + ')' : ''} · ${ago(s.last.ts)}` : 'No messages yet';
  return `<div class="card shop-card">
    <div class="title"><h2>${esc(s.name)}</h2><div class="row" style="gap:6px">${s.mode === 'live' ? '<span class="badge live">LIVE</span>' : '<span class="badge info">TEST MODE</span>'}
      ${run ? '<span class="badge ok"><span class="dot ok"></span> Running</span>' : '<span class="badge"><span class="dot"></span> Paused</span>'}</div></div>
    <dl class="kv">
      <dt>Spreadsheet</dt><dd>${sheetBadge(s.sheet)} ${s.sheet.title ? `<span class="small muted">${esc(s.sheet.title)}${s.sheet.tab ? ' › ' + esc(s.sheet.tab) : ''}</span>` : ''}</dd>
      <dt>Accounts</dt><dd>${s.channels !== 'whatsapp' ? acctBadge(s.gmail, 'Gmail') : ''} ${s.channels !== 'email' ? acctBadge(s.whatsapp, 'WhatsApp') : ''}</dd>
      <dt>Sends</dt><dd>${ch}</dd>
      <dt>Last checked</dt><dd>${ago(s.sheet.last_polled_at)}</dd>
      <dt>Recent</dt><dd class="small">${esc(last)}</dd>
    </dl>
    ${s.sheet.error ? `<div class="notice ${s.sheet.status === 'error' ? 'bad' : 'warn'} small">${esc(s.sheet.error)}</div>` : ''}
    ${s.simulated ? `<div class="notice warn small">${s.simulated} simulated message(s) — nothing was really sent for those.</div>` : ''}
    <div class="stats"><div><b>${s.contacts}</b><span>Contacts</span></div><div><b>${s.counts.sent}</b><span>Sent</span></div><div><b>${s.counts.pending}</b><span>Pending</span></div><div><b style="color:${s.counts.failed ? 'var(--bad)' : 'inherit'}">${s.counts.failed}</b><span>Need action</span></div></div>
    <div class="actions"><a class="btn secondary" href="#/shop/${s.id}">⚙ Settings</a>${run ? `<button class="danger" data-pause="${s.id}">⏸ Pause</button>` : `<button data-start="${s.id}">▶ Start</button>`}</div>
  </div>`;
}

function addShopModal() {
  const m = modal(`<h2>Add a new shop</h2><form id="asf"><div class="field"><label for="sn">Business name</label><input id="sn" type="text" required maxlength="100" placeholder="e.g. Sunrise Bakery"><div class="hint">This name appears in every email and identifies the business to customers.</div></div>
    <div class="row"><button>Create shop</button><button type="button" class="ghost" data-close>Cancel</button></div></form>`);
  $('#sn', m.el).focus();
  $('#asf', m.el).addEventListener('submit', (e) => { e.preventDefault(); act(e.submitter, async () => { const r = await api('POST', '/api/shops', { name: $('#sn', m.el).value }); m.close(); location.hash = `#/shop/${r.id}`; }); });
}

async function startModal(id) {
  const s = await api('GET', `/api/shops/${id}`);
  const liveOk = !s.readiness.length;
  const m = modal(`<h2>Start "${esc(s.name)}"</h2>
    <label class="inline"><input type="radio" name="mode" value="test" ${!liveOk || s.mode === 'test' ? 'checked' : ''}> <span><b>Test mode</b> — every message goes only to YOUR email / WhatsApp, never to contacts.</span></label><br>
    <label class="inline"><input type="radio" name="mode" value="live" ${liveOk ? '' : 'disabled'} ${liveOk && s.mode === 'live' ? 'checked' : ''}> <span><b>Live</b> — messages go to the real contacts in the sheet.</span></label>
    ${liveOk ? '' : `<div class="notice warn small"><b>Live is locked until:</b>\n• ${s.readiness.map(esc).join('\n• ')}</div>`}
    <div class="field" style="margin-top:10px"><label class="inline"><input type="checkbox" id="incl"> Also message rows that are already in the sheet</label>
    <div class="hint">Leave this unticked (recommended): only rows added from now on will be messaged. Rows already handled are never messaged twice either way.</div></div>
    <div class="row"><button id="go">▶ Start</button><button class="ghost" data-close>Cancel</button></div>`);
  $('#go', m.el).onclick = (e) => act(e.currentTarget, async () => {
    const mode = $('input[name=mode]:checked', m.el).value;
    const incl = $('#incl', m.el).checked;
    if (incl && mode === 'live' && !confirm('This will message EVERY eligible contact already in the sheet. Continue?')) return;
    await api('POST', `/api/shops/${id}/start`, { mode, include_existing: incl });
    m.close(); toast(mode === 'live' ? 'Live! New rows will be messaged automatically.' : 'Test mode started. Messages go only to you.'); render();
  });
}

// ---------- Shop settings ----------
pages.shop = async (id) => {
  const [s, accounts] = await Promise.all([api('GET', `/api/shops/${id}`), api('GET', '/api/accounts')]);
  store.set('lastShop', s.id);
  const g = accounts.filter((a) => a.provider === 'google' && a.status !== 'disconnected');
  const ms = accounts.filter((a) => a.provider === 'microsoft' && a.status !== 'disconnected');
  const w = accounts.filter((a) => a.provider === 'whatsapp' && a.status !== 'disconnected');
  const opt = (list, sel, none = '— none —') => `<option value="">${none}</option>` + list.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.label)}${a.status !== 'connected' ? ' (needs attention)' : ''}</option>`).join('');
  const sheetConnected = !!s.sheet_provider;
  const steps = [
    ['Connect the spreadsheet and choose the tab', sheetConnected && s.sheet.tab],
    ['Match your columns', !!(s.column_map.email || s.column_map.phone || s.column_map.whatsapp)],
    ['Choose Gmail / WhatsApp accounts', (s.channels === 'whatsapp' || s.gmail_account_id) && (s.channels === 'email' || s.whatsapp_account_id)],
    ['Write your messages and send a test to yourself', s.channels === 'both' ? s.settings.tested?.email && s.settings.tested?.whatsapp : s.settings.tested?.[s.channels]],
    ['Start in Test mode, then go Live', s.mode === 'live' && s.status === 'active'],
  ];
  app.innerHTML = `
  <div class="page-head"><div><h1>${esc(s.name)}</h1><p class="muted">${s.mode === 'live' ? '<span class="badge live">LIVE</span>' : '<span class="badge info">TEST MODE</span>'} ${s.status === 'active' ? '<span class="badge ok">Running</span>' : '<span class="badge">Paused</span>'}</p></div>
   <div class="row"><a class="btn secondary" href="#/">← All shops</a>${s.status === 'active' ? '<button class="danger" id="pauseBtn">⏸ Pause</button>' : '<button id="startBtn">▶ Start</button>'}</div></div>

  <div class="card"><h2>Setup checklist</h2><ol class="steps">${steps.map(([t, done]) => `<li class="${done ? 'done' : ''}">${t}</li>`).join('')}</ol>
   <div class="row" style="margin-top:8px"><a class="btn secondary small" href="#/templates/${s.id}">Message Templates</a><a class="btn secondary small" href="#/attachments/${s.id}">Attachments</a><a class="btn secondary small" href="#/automation/${s.id}">Automation Settings</a><a class="btn secondary small" href="#/activity?shop=${s.id}">Activity Log</a></div></div>

  <div class="card"><h2>1. Spreadsheet</h2>
   ${sheetConnected ? `
    <p>${sheetBadge(s.sheet)} <b>${esc(s.sheet.title || '')}</b> ${s.sheet_ref.url || s.sheet_ref.webUrl ? `<a href="${esc(s.sheet_ref.webUrl || s.sheet_ref.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</p>
    ${s.sheet.file_mode ? '<div class="notice small">This Excel file is on a <b>personal OneDrive</b>. Microsoft only allows whole-file updates there, so status columns are written by re-saving the file a few seconds after each check. If you have the file open in Excel at that moment, the update simply waits for the next check — nothing is lost.</div>' : ''}
    ${s.sheet.error ? `<div class="notice bad">${esc(s.sheet.error)}</div>` : ''}
    <div class="row"><div class="grow"><label for="tab">Sheet tab</label><select id="tab"><option>${esc(s.sheet.tab || 'Loading…')}</option></select></div>
     <div style="width:130px"><label for="hr">Header row</label><input id="hr" type="number" min="1" max="50" value="${s.header_row}"></div>
     <div style="align-self:flex-end"><button class="secondary" id="saveTab">Use this tab</button></div></div>
    <div class="hint">The header row is the row with your column titles (usually row 1). Every row below it is one contact.</div>
    <div id="preview" style="margin-top:14px"></div>
    <div class="row" style="margin-top:12px"><button class="secondary small" id="checkNow">↻ Check sheet now</button><button class="danger small" id="discSheet">Disconnect spreadsheet</button></div>`
    : `<div class="field"><label>Where is the spreadsheet?</label>
       <label class="inline"><input type="radio" name="prov" value="google" checked> Google Sheets</label>
       <label class="inline"><input type="radio" name="prov" value="microsoft"> Excel on OneDrive</label>
       <label class="inline"><input type="radio" name="prov" value="demo"> Demo sheet (try the app first)</label></div>
     <div id="provFields"></div>
     <div class="notice small"><b>Excel file on your computer?</b> The server can't see files on your computer. Move the file into your <b>OneDrive</b> folder (it stays on your computer and syncs automatically), then choose "Excel on OneDrive" and paste its share link.</div>`}
  </div>

  <div class="card"><h2>2. Match your columns</h2>
   <p class="muted small">Tell the app which of your columns holds each detail. Contacts are read straight from the sheet — nothing has to be typed again.</p>
   <div id="mapBox" class="muted">${sheetConnected && s.sheet.tab ? 'Loading columns…' : 'Connect the spreadsheet first.'}</div></div>

  <div class="card"><h2>3. Accounts used by this shop</h2>
   <div class="two"><div class="field"><label for="gAcc">Gmail account (sends emails)</label><select id="gAcc">${opt(g, s.gmail_account_id)}</select>${g.length ? '' : '<div class="hint">No Google account yet — <a href="#/connections">connect one</a>.</div>'}</div>
   <div class="field"><label for="wAcc">WhatsApp Business account</label><select id="wAcc">${opt(w, s.whatsapp_account_id)}</select>${w.length ? '' : '<div class="hint">No WhatsApp account yet — <a href="#/connections">connect one</a>.</div>'}</div></div>
   <div class="hint">All shops can share the same accounts. Every message still shows this shop's name.</div></div>

  <div class="card"><h2>4. Go live</h2>
   ${s.readiness.length ? `<div class="notice warn"><b>Before going live:</b>\n• ${s.readiness.map(esc).join('\n• ')}</div>` : '<div class="notice ok">Everything is ready for live sending.</div>'}
   <div class="row">${s.status === 'active' ? '<button class="danger" id="pauseBtn2">⏸ Pause this shop</button>' : '<button id="startBtn2">▶ Start…</button>'}</div></div>

  <div class="card"><h2>Shop details</h2>
   <div class="row"><div class="grow"><label for="nm">Business name</label><input id="nm" type="text" value="${esc(s.name)}"></div><div style="align-self:flex-end"><button class="secondary" id="saveName">Save name</button></div></div>
   <div class="row" style="margin-top:16px"><button class="danger small" id="delShop">Delete this shop</button><span class="small muted">Deletes its settings, templates, files and history. The spreadsheet itself is not touched.</span></div></div>`;

  // --- events ---
  const startB = () => startModal(s.id);
  const pauseB = (e) => act(e.currentTarget, async () => { await api('POST', `/api/shops/${s.id}/pause`); toast('Shop paused'); render(); });
  ['#startBtn', '#startBtn2'].forEach((x) => $(x) && ($(x).onclick = startB));
  ['#pauseBtn', '#pauseBtn2'].forEach((x) => $(x) && ($(x).onclick = pauseB));
  $('#saveName').onclick = (e) => act(e.currentTarget, async () => { await api('PATCH', `/api/shops/${s.id}`, { name: $('#nm').value }); toast('Saved'); render(); });
  $('#delShop').onclick = (e) => { if (prompt(`Type the shop name to delete it:\n${s.name}`) === s.name) act(e.currentTarget, async () => { await api('DELETE', `/api/shops/${s.id}`); location.hash = '#/'; }); };
  $('#gAcc').onchange = (e) => act(null, async () => { await api('PATCH', `/api/shops/${s.id}`, { gmail_account_id: e.target.value || null }); toast('Gmail account saved'); });
  $('#wAcc').onchange = (e) => act(null, async () => { await api('PATCH', `/api/shops/${s.id}`, { whatsapp_account_id: e.target.value || null }); toast('WhatsApp account saved'); });

  if (!sheetConnected) {
    const renderProv = () => {
      const p = $('input[name=prov]:checked').value;
      const list = p === 'google' ? g : ms;
      $('#provFields').innerHTML = p === 'demo'
        ? `<p class="muted small">A small built-in sheet you can add rows to from this page. Perfect for trying everything before connecting your real file. Messages from a demo sheet can only run in Test mode.</p><button id="conn">Use demo sheet</button>`
        : `<div class="field"><label for="acc">${p === 'google' ? 'Google' : 'Microsoft'} account that can open the file</label><select id="acc">${opt(list, list[0]?.id, '— choose —')}</select>
           ${list.length ? '' : `<div class="hint">No ${p === 'google' ? 'Google' : 'Microsoft'} account connected — <a href="#/connections">connect one on Connections</a> first.</div>`}</div>
           <div class="field"><label for="url">${p === 'google' ? 'Google Sheet link' : 'OneDrive share link to the Excel file'}</label><input id="url" type="url" placeholder="${p === 'google' ? 'https://docs.google.com/spreadsheets/d/…' : 'https://1drv.ms/x/… or https://…sharepoint.com/…'}">
           <div class="hint">${p === 'google' ? 'Open the sheet in your browser and copy the address bar.' : 'In OneDrive, right-click the .xlsx file → Share → Copy link.'}</div></div><button id="conn">Connect spreadsheet</button>`;
      $('#conn').onclick = (e) => act(e.currentTarget, async () => {
        const r = await api('POST', `/api/shops/${s.id}/sheet`, { provider: p, account_id: $('#acc')?.value, url: $('#url')?.value });
        toast(`Connected "${r.title}"${r.warning ? '\n' + r.warning : ''}`); render();
      });
    };
    $$('input[name=prov]').forEach((r) => (r.onchange = renderProv));
    renderProv();
    return;
  }

  $('#discSheet').onclick = (e) => { if (confirm('Disconnect this spreadsheet? The shop will be paused. Message history is kept.')) act(e.currentTarget, async () => { await api('POST', `/api/shops/${s.id}/sheet/disconnect`); render(); }); };
  $('#checkNow').onclick = (e) => act(e.currentTarget, async () => {
    const r = await api('POST', `/api/shops/${s.id}/check-now`);
    toast(r.ok === false ? r.error : `Checked. ${r.created ? r.created + ' new row(s) queued.' : 'No new rows.'}${r.writeError ? '\n' + r.writeError : ''}`, r.ok === false);
    loadPreview();
  });
  api('GET', `/api/shops/${s.id}/sheet/tabs`).then((r) => {
    $('#tab').innerHTML = r.tabs.map((t) => `<option ${t === s.sheet.tab ? 'selected' : ''}>${esc(t)}</option>`).join('') + (s.sheet.tab ? '' : '<option value="" selected>— choose —</option>');
  }).catch((e) => toast(e.message, true));
  $('#saveTab').onclick = (e) => act(e.currentTarget, async () => {
    if (!$('#tab').value) throw new Error('Choose a tab');
    const r = await api('POST', `/api/shops/${s.id}/sheet/tab`, { tab: $('#tab').value, header_row: $('#hr').value });
    if (r.warning) toast(r.warning, true); else toast('Tab saved. Columns detected.');
    render();
  });

  async function loadPreview() {
    try {
      const p = await api('GET', `/api/shops/${s.id}/sheet/preview`);
      const hs = p.headers;
      $('#preview').innerHTML = !hs.length ? '' : `<h3>Latest rows <span class="muted small">(${p.total} contact row(s))</span></h3>
        <div class="table-wrap"><table><thead><tr><th>#</th>${hs.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${p.rows.map((r, i) => `<tr><td class="muted">${p.first_row_number + i}</td>${hs.map((_, c) => `<td class="wrap">${esc(r[c] || '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${hs.length + 1}" class="muted">No contact rows yet</td></tr>`}</tbody></table></div>
        ${s.sheet_provider === 'demo' ? `<h3>Add a test row to the demo sheet</h3><form id="demoAdd" class="row">${hs.filter((h) => !META.status_fields.some((f) => f.label === h || s.column_map[f.key] === h)).map((h) => `<input type="text" name="${esc(h)}" placeholder="${esc(h)}" style="flex:1;min-width:150px">`).join('')}<button>Add row</button></form>
          <div class="hint">When the shop is running, the background service picks the new row up within a minute (or click "Check sheet now").</div>` : ''}`;
      const f = $('#demoAdd');
      if (f) f.addEventListener('submit', (e) => { e.preventDefault(); act(e.submitter, async () => { const values = Object.fromEntries(new FormData(f)); await api('POST', `/api/shops/${s.id}/demo-rows`, { values }); toast('Row added'); loadPreview(); }); });
      renderMap(hs);
    } catch (e) { $('#preview').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; $('#mapBox').textContent = 'Fix the spreadsheet connection first.'; }
  }
  function renderMap(hs) {
    if (!hs.length) { $('#mapBox').innerHTML = '<div class="notice warn">The header row is empty. Put your column titles in that row.</div>'; return; }
    const sel = (key) => `<select data-map="${key}"><option value="">— not in my sheet —</option>${hs.filter(Boolean).map((h) => `<option ${s.column_map[key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
    $('#mapBox').className = '';
    $('#mapBox').innerHTML = `<div class="two">${META.fields.map((f) => `<div class="field"><label>${f.label}</label>${sel(f.key)}</div>`).join('')}</div>
      <h3>Status columns the app fills in</h3><p class="muted small">If a column doesn't exist yet, it is added at the end of your header row automatically.</p>
      <div class="two">${META.status_fields.map((f) => `<div class="field"><label>${f.label}</label><input type="text" data-map="${f.key}" value="${esc(s.column_map[f.key] || f.label)}"></div>`).join('')}</div>
      <button id="saveMap">Save column matching</button>`;
    $('#saveMap').onclick = (e) => act(e.currentTarget, async () => {
      const column_map = Object.fromEntries($$('[data-map]').map((x) => [x.dataset.map, x.value]));
      await api('PATCH', `/api/shops/${s.id}`, { column_map }); toast('Column matching saved'); render();
    });
  }
  loadPreview();
};

// ---------- Connections ----------
pages.connections = async (_, params) => {
  const [accounts, st] = await Promise.all([api('GET', '/api/accounts'), api('GET', '/api/settings')]);
  if (params.get('ok')) toast(params.get('ok'));
  if (params.get('error')) toast(params.get('error'), true);
  if (params.get('ok') || params.get('error')) history.replaceState(null, '', '#/connections');
  const card = (a) => `<div class="list-item"><div><b>${esc(a.label)}</b> ${a.status === 'connected' ? (a.tested_at ? '<span class="badge ok">Connected ✓</span>' : '<span class="badge warn">Connected — not tested</span>') : a.status === 'disconnected' ? '<span class="badge">Disconnected</span>' : '<span class="badge bad">Needs attention</span>'}
      ${a.info?.display_phone_number ? `<div class="small muted">${esc(a.info.verified_name || '')} · ${esc(a.info.display_phone_number)} · quality ${esc(a.info.quality_rating || 'n/a')}</div>` : ''}
      ${a.last_error ? `<div class="small" style="color:var(--bad)">${esc(a.last_error)}</div>` : ''}
      <div class="small muted">Used by: ${a.used_by.length ? a.used_by.map((u) => esc(u.name)).join(', ') : 'no shops'}${a.tested_at ? ' · last test ' + ago(a.tested_at) : ''}</div></div>
    <div class="row">${a.status !== 'disconnected' ? `<button class="secondary small" data-test="${a.id}">Test</button>` : ''}
      ${a.provider === 'whatsapp' ? `<button class="secondary small" data-wa-edit="${a.id}">${a.status === 'disconnected' ? 'Reconnect' : 'Update token'}</button>` : `<a class="btn secondary small" href="/oauth/${a.provider}/start?reconnect=${a.id}">Reconnect</a>`}
      ${a.status !== 'disconnected' ? `<button class="danger small" data-disc="${a.id}">Disconnect</button>` : `<button class="danger small" data-del="${a.id}">Remove</button>`}</div></div>`;
  const by = (p) => accounts.filter((a) => a.provider === p);
  app.innerHTML = `<div class="page-head"><div><h1>Connections</h1><p class="muted">Accounts are connected securely with official sign-in. Passwords are never asked for or stored.</p></div></div>
  <div class="card"><h2>Your test contact</h2><p class="muted small">Test mode and "Send test" only ever message these — your own email and WhatsApp number.</p>
   <div class="two"><div class="field"><label for="oe">Your email</label><input id="oe" type="email" value="${esc(st.owner_email)}" placeholder="you@gmail.com"></div>
   <div class="field"><label for="op">Your WhatsApp number</label><input id="op" type="tel" value="${esc(st.owner_phone)}" placeholder="+971501234567"></div></div>
   <button id="saveOwner">Save</button><div class="hint">Alerts about broken connections are also emailed to this address.</div></div>

  <div class="card"><h2>Google — Gmail + Google Sheets</h2>
   ${st.google_enabled ? '' : '<div class="notice warn">Google sign-in is not set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Follow SETUP.md → Step 3.</div>'}
   ${by('google').map(card).join('') || '<p class="muted">No Google account connected.</p>'}
   ${st.google_enabled ? '<a class="btn" href="/oauth/google/start">+ Connect Google account</a><div class="hint">On the Google screen, tick <b>every</b> box (send email and Google Sheets).</div>' : ''}</div>

  <div class="card"><h2>Microsoft — Excel on OneDrive</h2>
   ${st.microsoft_enabled ? '' : '<div class="notice warn">Microsoft sign-in is not set up on the server yet (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET). Only needed if you use Excel files. Follow SETUP.md → Step 4.</div>'}
   ${by('microsoft').map(card).join('') || '<p class="muted">No Microsoft account connected.</p>'}
   ${st.microsoft_enabled ? '<a class="btn" href="/oauth/microsoft/start">+ Connect Microsoft account</a>' : ''}</div>

  <div class="card"><h2>WhatsApp Business (official Meta Cloud API)</h2>
   ${by('whatsapp').map(card).join('') || '<p class="muted">No WhatsApp account connected.</p>'}
   <button id="waAdd">+ Connect WhatsApp Business account</button>
   <h3>Delivery updates (webhook)</h3>
   ${st.whatsapp_webhook_ready ? '<p class="small">Paste these in Meta → your app → WhatsApp → Configuration → Webhook, then subscribe to <b>messages</b>:</p>' : '<div class="notice warn small">Set META_APP_SECRET and WHATSAPP_VERIFY_TOKEN on the server to receive "Delivered" updates and STOP replies (SETUP.md → Step 5).</div>'}
   <p class="small">Callback URL: <span class="mono">${esc(st.webhook_url)}</span><br>Verify token: the WHATSAPP_VERIFY_TOKEN value from your server's .env file.</p></div>`;

  $('#saveOwner').onclick = (e) => act(e.currentTarget, async () => { await api('PUT', '/api/settings', { owner_email: $('#oe').value, owner_phone: $('#op').value }); toast('Saved'); render(); });
  $$('[data-test]').forEach((b) => (b.onclick = () => act(b, async () => { const r = await api('POST', `/api/accounts/${b.dataset.test}/test`); toast(r.message); render(); })));
  $$('[data-disc]').forEach((b) => (b.onclick = () => { if (confirm('Disconnect this account? Shops using it will stop sending on that channel until you reconnect.')) act(b, async () => { await api('POST', `/api/accounts/${b.dataset.disc}/disconnect`); render(); }); }));
  $$('[data-del]').forEach((b) => (b.onclick = () => act(b, async () => { await api('DELETE', `/api/accounts/${b.dataset.del}`); render(); })));
  const waForm = (a) => {
    const m = modal(`<h2>${a ? 'Update' : 'Connect'} WhatsApp Business</h2>
      <p class="small muted">From <b>developers.facebook.com → your app → WhatsApp → API Setup</b>, and a permanent token from <b>Business Settings → System users</b> (SETUP.md → Step 5).</p>
      <form id="waf"><div class="field"><label>Name (for you)</label><input name="label" type="text" value="${esc(a?.label || '')}" placeholder="e.g. Main WhatsApp"></div>
      <div class="field"><label>Phone number ID</label><input name="phone_number_id" type="text" inputmode="numeric" required value="${esc(a?.info?.phone_number_id || '')}"></div>
      <div class="field"><label>WhatsApp Business Account ID</label><input name="waba_id" type="text" inputmode="numeric" required value="${esc(a?.info?.waba_id || '')}"></div>
      <div class="field"><label>Permanent access token (System User)</label><input name="access_token" type="password" required autocomplete="off"><div class="hint">Stored encrypted. Never use a temporary 24-hour token — it stops working tomorrow.</div></div>
      <div class="row"><button>Connect & test</button><button type="button" class="ghost" data-close>Cancel</button></div></form>`);
    $('#waf', m.el).addEventListener('submit', (e) => { e.preventDefault(); act(e.submitter, async () => { const r = await api('POST', '/api/accounts/whatsapp', { ...Object.fromEntries(new FormData(e.target)), id: a?.id }); m.close(); toast(r.message); render(); }); });
  };
  $('#waAdd').onclick = () => waForm(null);
  $$('[data-wa-edit]').forEach((b) => (b.onclick = () => waForm(accounts.find((a) => a.id === Number(b.dataset.waEdit)))));
};

// ---------- Message Templates ----------
const VARS = ['{{name}}', '{{first_name}}', '{{company}}', '{{business_name}}', '{{email}}', '{{phone}}', '{{media_links}}', '{{column:Your Column}}'];
pages.templates = async (id, params) => {
  const pick = await pickShop(id, 'templates'); if (!pick) return;
  const s = await api('GET', `/api/shops/${pick.shop.id}`);
  const t = await api('GET', `/api/shops/${s.id}/templates`);
  const tab = params.get('tab') || (t.channels.includes('email') ? 'email' : 'whatsapp');
  app.innerHTML = `<div class="page-head"><div><h1>Message Templates</h1><p class="muted">Each shop has its own messages.</p></div></div>
   ${pick.html}
   <div class="tabs"><button data-tab="email" class="${tab === 'email' ? 'active' : ''}">✉ Email ${t.tested.email ? '✓' : ''}</button><button data-tab="whatsapp" class="${tab === 'whatsapp' ? 'active' : ''}">💬 WhatsApp ${t.tested.whatsapp ? '✓' : ''}</button></div>
   ${!t.channels.includes(tab) ? `<div class="notice">This shop currently sends ${t.channels.join(' and ')} only. You can still prepare this template; turn the channel on in <a href="#/automation/${s.id}">Automation Settings</a>.</div>` : ''}
   <div id="tpl"></div>`;
  pick.bind();
  $$('[data-tab]').forEach((b) => (b.onclick = () => { location.hash = `#/templates/${s.id}?tab=${b.dataset.tab}`; }));
  if (tab === 'email') emailEditor(s, t.email, t.tested.email); else whatsappEditor(s, t.whatsapp, t.tested.whatsapp);
};

function insertAtCursor(el, text) {
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, a) + text + el.value.slice(b); el.focus(); el.selectionStart = el.selectionEnd = a + text.length;
}

function emailEditor(s, tpl, tested) {
  $('#tpl').innerHTML = `<div class="card">
    <div class="field"><label for="subj">Subject</label><input id="subj" type="text" value="${esc(tpl.subject || '')}"></div>
    <div class="field"><label for="body">Message</label><textarea id="body">${esc(tpl.body || '')}</textarea>
      <div class="hint vars">Click to insert: ${VARS.map((v) => `<code data-var="${esc(v)}">${esc(v)}</code>`).join('')}<br>{{media_links}} = links to large files / website links. A footer with the shop name and an unsubscribe link is always added automatically (required by anti-spam rules).</div></div>
    <div class="row"><button class="secondary" id="prev">Preview</button><button id="save">Save template</button><button class="secondary" id="test">Send test to me</button>
      ${tested ? '<span class="badge ok">Test sent ✓</span>' : '<span class="badge warn">Not tested yet</span>'}</div>
    <div class="hint">Attachments: choose them on the <a href="#/attachments/${s.id}">Attachments</a> page.</div>
    <div id="pv" style="margin-top:14px"></div></div>`;
  let last = $('#body');
  $('#subj').onfocus = (e) => (last = e.target); $('#body').onfocus = (e) => (last = e.target);
  $$('[data-var]').forEach((c) => (c.onclick = () => insertAtCursor(last, c.dataset.var)));
  const data = () => ({ subject: $('#subj').value, body: $('#body').value });
  $('#prev').onclick = (e) => act(e.currentTarget, async () => {
    const p = await api('POST', `/api/shops/${s.id}/preview/email`, data());
    $('#pv').innerHTML = `<h3>Preview <span class="small muted">(using ${p.sample.name ? 'row "' + esc(p.sample.name) + '"' : 'sample data'})</span></h3><div class="preview"><b>Subject:</b> ${esc(p.subject)}\n\n${esc(p.text)}${p.links.length ? '\n\n' + p.links.map((l) => '📎 ' + esc(l.title) + ': ' + esc(l.url)).join('\n') : ''}\n\n<span class="muted">— ${esc(p.footer)}</span>${p.attachments.length ? `\n\n<b>Attached:</b> ${p.attachments.map(esc).join(', ')}` : ''}</div>`;
  });
  $('#save').onclick = (e) => act(e.currentTarget, async () => { await api('PUT', `/api/shops/${s.id}/templates/email`, data()); toast('Email template saved. Send a test to yourself before going live.'); render(); });
  $('#test').onclick = (e) => act(e.currentTarget, async () => {
    await api('PUT', `/api/shops/${s.id}/templates/email`, data());
    const r = await api('POST', `/api/shops/${s.id}/test/email`); toast(r.message, r.simulated, 9000); render();
  });
}

async function whatsappEditor(s, tpl, tested) {
  const box = $('#tpl');
  if (!s.whatsapp_account_id) { box.innerHTML = `<div class="notice warn">Select a WhatsApp account for this shop first (<a href="#/shop/${s.id}">shop settings</a> → Accounts).</div>`; return; }
  box.innerHTML = '<div class="card muted">Loading your approved WhatsApp templates…</div>';
  let list, mediaLib;
  try { [list, mediaLib] = await Promise.all([api('GET', `/api/accounts/${s.whatsapp_account_id}/wa-templates`), api('GET', `/api/shops/${s.id}/media`)]); }
  catch (e) { box.innerHTML = `<div class="notice bad">Could not load templates from WhatsApp: ${esc(e.message)}</div>`; return; }
  const key = (x) => `${x.name}|${x.language}`;
  let cur = list.find((x) => key(x) === `${tpl.template_name}|${tpl.language}`) || null;
  const draw = () => {
    const needMedia = cur && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(cur.header_format);
    const mediaOpts = needMedia ? mediaLib.items.filter((m) => m.kind === 'file' && m.whatsapp.ok && m.whatsapp.type === cur.header_format.toLowerCase()) : [];
    const sameTpl = cur && key(cur) === `${tpl.template_name}|${tpl.language}`;
    const defVal = (i) => (sameTpl && tpl.body_params?.[i]) || (i === 0 ? '{{name}}' : i === 1 ? '{{business_name}}' : '');
    box.innerHTML = `<div class="card">
      <div class="notice small">WhatsApp only allows businesses to start a conversation with a <b>template approved by Meta</b>. Create templates in <b>WhatsApp Manager → Message templates</b>; once approved they appear below. Extra files are sent as separate messages only if the customer messaged you in the last 24 hours — otherwise they're sent as links through <code>{{media_links}}</code>.</div>
      ${list.length ? '' : '<div class="notice warn">No approved templates found on this WhatsApp account yet.</div>'}
      <div class="field"><label for="tsel">Approved template</label><select id="tsel"><option value="">— choose —</option>${list.map((x) => `<option value="${esc(key(x))}" ${cur && key(cur) === key(x) ? 'selected' : ''}>${esc(x.name)} (${esc(x.language)}, ${esc(x.category)})</option>`).join('')}</select></div>
      ${cur ? `<div class="field"><label>Template text (from Meta)</label><div class="wa-bubble">${esc(cur.body_text)}</div></div>
        ${cur.header_format === 'TEXT' && cur.header_params ? `<div class="field"><label>Header variable</label><input type="text" class="hp" value="${esc((sameTpl && tpl.header_text_params?.[0]) || '{{business_name}}')}"></div>` : ''}
        ${needMedia ? `<div class="field"><label>Header ${cur.header_format.toLowerCase()} (required by this template)</label><select id="hm"><option value="">— choose —</option>${mediaOpts.map((m) => `<option value="${m.id}" ${tpl.header_media_id === m.id ? 'selected' : ''}>${esc(m.filename)} (${mb(m.size)})</option>`).join('')}</select>
          ${mediaOpts.length ? '' : `<div class="hint">Upload a suitable ${cur.header_format.toLowerCase()} on the <a href="#/attachments/${s.id}">Attachments</a> page first.</div>`}</div>` : ''}
        ${cur.body_params ? `<h3>Fill the template variables</h3><p class="small muted">Use the contact's details: ${VARS.map((v) => `<code>${esc(v)}</code>`).join(' ')}</p>
          ${Array.from({ length: cur.body_params }, (_, i) => `<div class="field"><label>Variable ${cur.body_param_names[i] ? `{{${esc(cur.body_param_names[i])}}}` : `{{${i + 1}}}`}</label><input type="text" class="bp" value="${esc(defVal(i))}"></div>`).join('')}` : '<p class="muted small">This template has no variables.</p>'}
        ${cur.url_buttons.map((b) => `<div class="field"><label>Website button ${b.index + 1} — end of link (${esc(b.url)})</label><input type="text" class="ub" data-index="${b.index}" value="${esc((sameTpl && tpl.url_buttons?.find((u) => u.index === b.index)?.expr) || '')}"></div>`).join('')}
        <div class="row"><button class="secondary" id="prev">Preview</button><button id="save">Save template</button><button class="secondary" id="test">Send test to my WhatsApp</button>${tested ? '<span class="badge ok">Test sent ✓</span>' : '<span class="badge warn">Not tested yet</span>'}</div>
        <div id="pv" style="margin-top:14px"></div>` : ''}</div>`;
    $('#tsel').onchange = (e) => { cur = list.find((x) => key(x) === e.target.value) || null; draw(); };
    if (!cur) return;
    const data = () => ({
      template_name: cur.name, language: cur.language, template: cur,
      body_params: $$('.bp').map((x) => x.value), header_text_params: $$('.hp').map((x) => x.value),
      header_media_id: $('#hm')?.value || null, url_buttons: $$('.ub').map((x) => ({ index: Number(x.dataset.index), expr: x.value })),
    });
    $('#prev').onclick = (e) => act(e.currentTarget, async () => {
      const d = data();
      const p = await api('POST', `/api/shops/${s.id}/preview/whatsapp`, { ...d, body_text: cur.body_text, body_param_names: cur.body_param_names });
      $('#pv').innerHTML = `<h3>Preview <span class="small muted">(using ${p.sample.name ? 'row "' + esc(p.sample.name) + '"' : 'sample data'})</span></h3>${p.header_media ? `<div class="small muted">Header: ${esc(p.header_media)}</div>` : ''}<div class="wa-bubble">${esc(p.text)}</div>${p.notes.length ? `<div class="notice warn small" style="margin-top:10px">${p.notes.map(esc).join('\n')}</div>` : ''}`;
    });
    $('#save').onclick = (e) => act(e.currentTarget, async () => { await api('PUT', `/api/shops/${s.id}/templates/whatsapp`, data()); toast('WhatsApp template saved. Send a test to yourself before going live.'); render(); });
    $('#test').onclick = (e) => act(e.currentTarget, async () => {
      await api('PUT', `/api/shops/${s.id}/templates/whatsapp`, data());
      const r = await api('POST', `/api/shops/${s.id}/test/whatsapp`); toast(r.message, r.simulated, 9000); render();
    });
  };
  draw();
}

// ---------- Attachments ----------
pages.attachments = async (id) => {
  const pick = await pickShop(id, 'attachments'); if (!pick) return;
  const sid = pick.shop.id;
  const lib = await api('GET', `/api/shops/${sid}/media`);
  const sel = { email: [...lib.selection.email], whatsapp: [...lib.selection.whatsapp] };
  const byId = (mid) => lib.items.find((m) => m.id === mid);
  const seqList = (ch) => sel[ch].map((mid, i) => { const m = byId(mid); if (!m) return ''; const w = ch === 'whatsapp' ? m.whatsapp : null;
    return `<div class="list-item"><div><b>${i + 1}.</b> ${esc(m.title || m.filename)} <span class="badge">${esc(m.label)}</span>${m.size ? ` <span class="small muted">${mb(m.size)}</span>` : ''}
      ${ch === 'email' && m.kind === 'file' && m.size > lib.email_limit_mb * 1048576 ? '<div class="small" style="color:var(--warn)">Too big to attach — will be sent as a secure download link automatically.</div>' : ''}
      ${w && !w.ok ? `<div class="small" style="color:var(--warn)">${esc(w.reason)}. ${esc(w.alternative)}.</div>` : ''}
      ${w && w.ok && w.type !== 'link' ? '<div class="small muted">Sent as a separate WhatsApp message only within 24h of the customer messaging you; otherwise as a link.</div>' : ''}</div>
      <div class="row"><button class="ghost small" data-up="${ch}:${i}" ${i ? '' : 'disabled'}>↑</button><button class="ghost small" data-down="${ch}:${i}" ${i < sel[ch].length - 1 ? '' : 'disabled'}>↓</button><button class="danger small" data-unsel="${ch}:${mid}">Remove</button></div></div>`; }).join('') || '<p class="muted small">Nothing selected.</p>';
  app.innerHTML = `<div class="page-head"><div><h1>Attachments</h1><p class="muted">Upload once, then choose what each channel sends. Files belong to this shop only.</p></div></div>
   ${pick.html}
   <div class="card"><h2>Add to the library</h2>
    <div class="field"><label for="files">Upload files (pictures, videos, PDF, Excel, Word, presentations, audio)</label><input id="files" type="file" multiple><div class="progress" hidden><div></div></div></div>
    <form id="lf" class="row"><input name="title" type="text" placeholder="Link title, e.g. Our website" style="flex:1;min-width:180px"><input name="url" type="url" placeholder="https://…" style="flex:2;min-width:220px" required><button class="secondary">Add website link</button></form></div>
   <div class="two">
    <div class="card"><h2>✉ Sent with emails</h2>${seqList('email')}</div>
    <div class="card"><h2>💬 Sent with WhatsApp</h2>${seqList('whatsapp')}<div class="hint">The WhatsApp template's own header picture/video/document is chosen on the Message Templates page.</div></div>
   </div>
   <div class="card"><h2>Library (${lib.items.length})</h2>
    ${lib.items.map((m) => `<div class="list-item"><div style="min-width:0"><b>${esc(m.title || m.filename)}</b> <span class="badge">${esc(m.label)}</span> ${m.size ? `<span class="small muted">${mb(m.size)}</span>` : ''}
      ${m.kind === 'link' ? `<div class="small mono">${esc(m.url)}</div>` : ''}
      <div class="small ${m.whatsapp.ok ? 'muted' : ''}" style="${m.whatsapp.ok ? '' : 'color:var(--warn)'}">WhatsApp: ${m.whatsapp.ok ? (m.whatsapp.type === 'link' ? 'sent as a link' : 'supported as ' + m.whatsapp.type) : esc(m.whatsapp.reason) + ' — ' + esc(m.whatsapp.alternative)}</div></div>
      <div class="row"><label class="inline"><input type="checkbox" data-sel="email:${m.id}" ${sel.email.includes(m.id) ? 'checked' : ''}> Email</label>
       <label class="inline"><input type="checkbox" data-sel="whatsapp:${m.id}" ${sel.whatsapp.includes(m.id) ? 'checked' : ''}> WhatsApp</label>
       <button class="danger small" data-del="${m.id}">Delete</button></div></div>`).join('') || '<p class="muted">No files yet.</p>'}</div>`;
  pick.bind();
  const save = async (ch) => { await api('PUT', `/api/shops/${sid}/media/selection/${ch}`, { ids: sel[ch] }); render(); };
  $$('[data-sel]').forEach((c) => (c.onchange = () => act(null, async () => { const [ch, mid] = c.dataset.sel.split(':'); const n = Number(mid); sel[ch] = c.checked ? [...sel[ch], n] : sel[ch].filter((x) => x !== n); await save(ch); toast('Saved'); })));
  $$('[data-unsel]').forEach((b) => (b.onclick = () => act(b, async () => { const [ch, mid] = b.dataset.unsel.split(':'); sel[ch] = sel[ch].filter((x) => x !== Number(mid)); await save(ch); })));
  const move = (spec, d) => { const [ch, i] = spec.split(':'); const a = sel[ch]; const j = Number(i); [a[j], a[j + d]] = [a[j + d], a[j]]; return save(ch); };
  $$('[data-up]').forEach((b) => (b.onclick = () => act(b, () => move(b.dataset.up, -1))));
  $$('[data-down]').forEach((b) => (b.onclick = () => act(b, () => move(b.dataset.down, 1))));
  $$('[data-del]').forEach((b) => (b.onclick = () => { if (confirm('Delete this item from the library?')) act(b, async () => { await api('DELETE', `/api/shops/${sid}/media/${b.dataset.del}`); render(); }); }));
  $('#lf').addEventListener('submit', (e) => { e.preventDefault(); act(e.submitter, async () => { await api('POST', `/api/shops/${sid}/media/link`, Object.fromEntries(new FormData(e.target))); toast('Link added'); render(); }); });
  $('#files').onchange = async (e) => {
    const files = [...e.target.files];
    const bar = $('.progress'); bar.hidden = false;
    for (const [n, f] of files.entries()) {
      try {
        await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('POST', `/api/shops/${sid}/media?filename=${encodeURIComponent(f.name)}`);
          x.setRequestHeader('x-requested-with', 'sheetsender');
          x.setRequestHeader('content-type', f.type || 'application/octet-stream');
          x.upload.onprogress = (ev) => { $('.progress > div').style.width = `${((n + ev.loaded / ev.total) / files.length) * 100}%`; };
          x.onload = () => (x.status < 300 ? resolve() : reject(new Error(JSON.parse(x.responseText || '{}').error || 'Upload failed')));
          x.onerror = () => reject(new Error('Upload failed — check your connection'));
          x.send(f);
        });
      } catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
    toast('Upload finished'); render();
  };
};

// ---------- Automation Settings ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
pages.automation = async (id) => {
  const pick = await pickShop(id, 'automation'); if (!pick) return;
  const s = await api('GET', `/api/shops/${pick.shop.id}`);
  const st = s.settings;
  let headers = [];
  try { headers = (await api('GET', `/api/shops/${s.id}/sheet/preview`)).headers.filter(Boolean); } catch { /* not connected */ }
  const [shopOpt, globalOpt] = await Promise.all([api('GET', `/api/optouts?shop=${s.id}`), api('GET', '/api/optouts')]);
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Muscat', 'Europe/London', 'UTC']; } })();
  const condRow = (c = {}) => `<div class="row cond" style="margin-bottom:8px"><select class="cc" style="flex:2;min-width:140px"><option value="">— column —</option>${headers.map((h) => `<option ${c.column === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>
     <select class="co" style="flex:1;min-width:120px">${META.condition_ops.map((o) => `<option value="${o}" ${c.op === o ? 'selected' : ''}>${o.replace('_', ' ')}</option>`).join('')}</select>
     <input class="cv" type="text" value="${esc(c.value || '')}" placeholder="value" style="flex:2;min-width:120px"><button type="button" class="ghost small" data-rmcond>✕</button></div>`;
  const optList = (rows) => rows.map((o) => `<div class="list-item"><div><span class="mono">${esc(o.value)}</span> <span class="badge">${o.channel === 'all' ? 'All channels' : o.channel}</span><div class="small muted">${esc(o.reason || '')} · ${fmtDate(o.created_at)}</div></div><button class="danger small" data-rmopt="${o.id}">Remove</button></div>`).join('') || '<p class="muted small">Nobody yet.</p>';
  app.innerHTML = `<div class="page-head"><div><h1>Automation Settings</h1><p class="muted">These rules apply to this shop only.</p></div>
    <div class="row">${s.status === 'active' ? '<button class="danger" id="pz">⏸ Pause shop</button>' : '<button id="go">▶ Start shop</button>'}</div></div>
   ${pick.html}
   <form id="af">
   <div class="card"><h2>What to send</h2>
    ${['email', 'whatsapp', 'both'].map((c) => `<label class="inline"><input type="radio" name="channels" value="${c}" ${st.channels === c ? 'checked' : ''}> ${c === 'email' ? 'Email only' : c === 'whatsapp' ? 'WhatsApp only' : 'Email and WhatsApp'}</label>`).join('')}
    <div class="hint">Email and WhatsApp are handled separately — if one fails, the other still goes out.</div></div>
   <div class="card"><h2>When to send</h2>
    <div class="field" style="max-width:280px"><label for="delay">Wait before sending (minutes)</label><input id="delay" type="number" min="0" max="10080" value="${st.delay_minutes}"><div class="hint">0 = send right away (within about a minute of the row appearing).</div></div>
    <label class="inline"><input type="checkbox" id="schOn" ${st.schedule.enabled ? 'checked' : ''}> Only send during business hours</label>
    <div id="sch" ${st.schedule.enabled ? '' : 'hidden'}>
     <div class="row"><div style="flex:2;min-width:200px"><label for="tz">Time zone</label><select id="tz">${zones.map((z) => `<option ${z === st.schedule.tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
      <div style="width:130px"><label for="from">From</label><input id="from" type="time" value="${esc(st.schedule.start)}"></div><div style="width:130px"><label for="to">Until</label><input id="to" type="time" value="${esc(st.schedule.end)}"></div></div>
     <div style="margin-top:10px">${DAYS.map((d, i) => `<label class="inline"><input type="checkbox" class="day" value="${i}" ${st.schedule.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
     <div class="hint">Rows that arrive outside these hours wait and are sent when the next window opens.</div></div></div>
   <div class="card"><h2>Consent</h2>
    <label class="inline"><input type="checkbox" id="consReq" ${st.consent.required ? 'checked' : ''}> Only message contacts whose Consent column says yes</label>
    <div class="field" style="margin-top:8px"><label for="consAcc">Values that count as "yes" (comma separated)</label><input id="consAcc" type="text" value="${esc(st.consent.accepted)}"></div>
    ${st.consent.required && !s.column_map.consent ? '<div class="notice warn small">Consent is required but no Consent column is matched — every row will be skipped. Match the column in shop settings or untick this.</div>' : ''}
    <div class="hint">Rows without consent are marked "Skipped – no consent" (not an error). If the Consent cell is changed to yes later, the row is sent then.</div></div>
   <div class="card"><h2>Conditions</h2><p class="small muted">Only send when every condition is true (e.g. Source equals Instagram). Leave empty to send to every new row.</p>
    <div id="conds">${(st.conditions || []).map(condRow).join('')}</div><button type="button" class="secondary small" id="addCond" ${headers.length ? '' : 'disabled'}>+ Add condition</button></div>
   <div class="card"><h2>Edits and duplicates</h2>
    <label class="inline"><input type="checkbox" id="resend" ${st.resend_on_edit ? 'checked' : ''}> Send again when someone edits a row that was already messaged</label>
    <div class="hint">Off (recommended): editing a row never re-sends. A contact is never messaged twice for the same campaign, even if they appear in several rows.</div>
    <div class="two" style="margin-top:12px"><div class="field"><label for="camp">Campaign name</label><input id="camp" type="text" value="${esc(st.campaign)}"><div class="hint">Duplicate protection is per campaign. Change it only when you want a new round of messages for new rows.</div></div>
    <div class="field"><label for="cc">Default country code for phone numbers</label><input id="cc" type="text" value="${esc(st.default_country_code)}"><div class="hint">971 = UAE. Numbers like 050 123 4567 become +971501234567.</div></div></div></div>
   <div class="row" style="margin-bottom:16px"><button class="big">Save settings</button></div></form>

   <div class="two">
    <div class="card"><h2>Opted out of ${esc(s.name)}</h2>${optList(shopOpt)}
     <form class="row optf" data-scope="${s.id}" style="margin-top:10px"><input name="value" type="text" placeholder="email or phone" style="flex:2;min-width:160px" required><select name="channel" style="flex:1;min-width:110px"><option value="all">All</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select><button class="secondary">Add</button></form></div>
    <div class="card"><h2>Opted out of ALL shops</h2>${optList(globalOpt)}
     <form class="row optf" data-scope="global" style="margin-top:10px"><input name="value" type="text" placeholder="email or phone" style="flex:2;min-width:160px" required><select name="channel" style="flex:1;min-width:110px"><option value="all">All</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select><button class="secondary">Add</button></form>
     <div class="hint">Unsubscribe links and WhatsApp "STOP" replies are added automatically.</div></div></div>`;
  pick.bind();
  $('#schOn').onchange = (e) => ($('#sch').hidden = !e.target.checked);
  $('#addCond').onclick = () => $('#conds').insertAdjacentHTML('beforeend', condRow());
  $('#conds').addEventListener('click', (e) => { if (e.target.closest('[data-rmcond]')) e.target.closest('.cond').remove(); });
  if ($('#go')) $('#go').onclick = () => startModal(s.id);
  if ($('#pz')) $('#pz').onclick = (e) => act(e.currentTarget, async () => { await api('POST', `/api/shops/${s.id}/pause`); render(); });
  $('#af').addEventListener('submit', (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      await api('PATCH', `/api/shops/${s.id}`, { settings: {
        channels: $('input[name=channels]:checked').value, delay_minutes: Number($('#delay').value || 0),
        schedule: { enabled: $('#schOn').checked, tz: $('#tz').value, start: $('#from').value, end: $('#to').value, days: $$('.day:checked').map((d) => Number(d.value)) },
        consent: { required: $('#consReq').checked, accepted: $('#consAcc').value },
        conditions: $$('.cond').map((r) => ({ column: $('.cc', r).value, op: $('.co', r).value, value: $('.cv', r).value })).filter((c) => c.column),
        resend_on_edit: $('#resend').checked, campaign: $('#camp').value, default_country_code: $('#cc').value,
      } });
      toast('Settings saved'); render();
    });
  });
  $$('.optf').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); act(e.submitter, async () => { await api('POST', '/api/optouts', { scope: f.dataset.scope, ...Object.fromEntries(new FormData(f)) }); toast('Added to opt-out list'); render(); }); }));
  $$('[data-rmopt]').forEach((b) => (b.onclick = () => { if (confirm('Remove from the opt-out list? Only do this if the person asked to receive messages again.')) act(b, async () => { await api('DELETE', `/api/optouts/${b.dataset.rmopt}`); render(); }); }));
};

// ---------- Activity Log ----------
const EVENT_BADGE = { sent: 'ok', delivered: 'ok', read: 'ok', test_sent: 'ok', simulated: 'warn', failed: 'bad', blocked: 'bad', account_error: 'bad', retry: 'warn', skipped: '', invalid: 'warn', opted_out: 'warn', queued: 'info' };
pages.activity = async (_, params) => {
  const { shops } = await api('GET', '/api/overview');
  const shopId = params.get('shop') || '';
  const channel = params.get('channel') || '';
  const q = new URLSearchParams(); if (shopId) q.set('shop', shopId); if (channel) q.set('channel', channel);
  const [rows, failed] = await Promise.all([api('GET', `/api/activity?${q}`), shopId ? api('GET', `/api/jobs?shop=${shopId}`) : Promise.resolve(null)]);
  const problem = failed ? failed.filter((j) => ['failed', 'blocked'].includes(j.status)) : [];
  const setQ = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); location.hash = '#/activity?' + p; };
  app.innerHTML = `<div class="page-head"><div><h1>Activity Log</h1><p class="muted">Every send attempt and important event. Contact details are partly hidden.</p></div></div>
   <div class="row" style="margin-bottom:14px"><div style="min-width:220px"><label for="fs">Shop</label><select id="fs"><option value="">All shops</option>${shops.map((s) => `<option value="${s.id}" ${String(s.id) === shopId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div style="min-width:160px"><label for="fc">Channel</label><select id="fc"><option value="">All</option><option value="email" ${channel === 'email' ? 'selected' : ''}>Email</option><option value="whatsapp" ${channel === 'whatsapp' ? 'selected' : ''}>WhatsApp</option></select></div>
    <div style="align-self:flex-end"><button class="secondary" id="rf">↻ Refresh</button></div></div>
   ${shopId ? `<div class="card"><h2>Failed or waiting messages (${problem.length})</h2>
     ${problem.length ? `<p class="small muted">Retrying only re-sends these. Messages that already went out are never sent twice.</p>
      <div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="all"></th><th>Row</th><th>Channel</th><th>Contact</th><th>Status</th><th>Reason</th></tr></thead><tbody>
      ${problem.map((j) => `<tr><td><input type="checkbox" class="jr" value="${j.id}"></td><td>${j.row_number}</td><td>${j.channel}</td><td class="mono">${esc(j.recipient || '—')}</td><td><span class="badge ${j.status === 'failed' ? 'bad' : 'warn'}">${esc(j.status_text)}</span></td><td class="wrap small">${esc(j.last_error || '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button id="retrySel" class="secondary">Retry selected</button><button id="retryAll">Retry all failed</button></div>` : '<p class="muted small">None 🎉</p>'}</div>`
    : '<div class="notice small">Choose a shop above to see and retry its failed messages.</div>'}
   <div class="card"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Shop</th><th>Channel</th><th>Contact</th><th>Event</th><th>Details</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="small" style="white-space:nowrap">${fmtDate(r.ts)}</td><td>${esc(r.shop_name || '—')}</td><td>${esc(r.channel || '')}</td><td class="small mono">${esc(r.contact_ref || '')}</td>
      <td><span class="badge ${EVENT_BADGE[r.event] ?? ''}">${esc(r.event.replace(/_/g, ' '))}</span>${r.simulated ? ' <span class="badge warn">SIMULATED</span>' : ''}${r.result && r.result !== 'ok' ? `<div class="small muted">${esc(r.result.replace(/_/g, ' '))}</div>` : ''}</td>
      <td class="wrap small">${esc(r.detail || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No activity yet</td></tr>'}</tbody></table></div>
    ${rows.length === 100 ? `<div class="row" style="margin-top:10px"><button class="secondary" id="more">Older entries…</button></div>` : ''}</div>`;
  $('#fs').onchange = (e) => setQ('shop', e.target.value);
  $('#fc').onchange = (e) => setQ('channel', e.target.value);
  $('#rf').onclick = render;
  if ($('#more')) $('#more').onclick = () => setQ('before', rows[rows.length - 1].id);
  if ($('#all')) $('#all').onchange = (e) => $$('.jr').forEach((c) => (c.checked = e.target.checked));
  if ($('#retrySel')) $('#retrySel').onclick = (e) => act(e.currentTarget, async () => { const ids = $$('.jr:checked').map((c) => Number(c.value)); if (!ids.length) throw new Error('Tick at least one message'); const r = await api('POST', `/api/shops/${shopId}/retry`, { job_ids: ids }); toast(`${r.count} message(s) queued again`); render(); });
  if ($('#retryAll')) $('#retryAll').onclick = (e) => act(e.currentTarget, async () => { const r = await api('POST', `/api/shops/${shopId}/retry`, {}); toast(`${r.count} message(s) queued again`); render(); });
};

start();
