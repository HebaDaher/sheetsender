// Shops, Excel uploads and column matching.
import { html, csrfField, fmtDate, plural, showAddress, countryOptions } from '../html.js';
import { HttpError } from '../http.js';
import { q, one, rows, tx } from '../db.js';
import { owned, str } from './util.js';
import { parseSpreadsheet, guessMapping, FIELDS } from '../excel.js';
import { buildContacts, COUNTRIES } from '../contacts.js';

export async function shopStats(shopId) {
  return one(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE email IS NOT NULL AND consent_email)::int AS email_ok,
    count(*) FILTER (WHERE phone IS NOT NULL AND consent_whatsapp)::int AS wa_ok,
    count(*) FILTER (WHERE email_raw<>'' AND email IS NULL)::int AS bad_email,
    count(*) FILTER (WHERE phone_raw<>'' AND phone IS NULL)::int AS bad_phone,
    count(*) FILTER (WHERE NOT consent_email AND NOT consent_whatsapp)::int AS no_consent
    FROM contacts c JOIN shops s ON s.current_upload_id=c.upload_id WHERE s.id=$1`, [shopId]);
}

export default function register(r) {
  r.get('/shops', async (ctx) => {
    const shops = await rows(`SELECT s.*, u.filename, u.created_at AS uploaded_at, u.row_count FROM shops s LEFT JOIN uploads u ON u.id=s.current_upload_id
      WHERE s.user_id=$1 ORDER BY lower(s.name)`, [ctx.user.id]);
    ctx.page('Shops & files', html`
      <h1>Shops & customer files</h1>
      <p class="lead">Each shop has its own Excel file. Upload a new file whenever your list changes — it replaces that shop's previous list.</p>
      ${shops.length ? html`<div class="grid">${shops.map((s) => html`<a class="card tile" href="/shops/${s.id}">
          <h2>${s.name}</h2>
          <p class="muted">${s.filename ? html`${s.filename} · ${plural(s.row_count, 'row')} · uploaded ${fmtDate(s.uploaded_at, ctx.user.timezone)}` : 'No file uploaded yet'}</p></a>`)}</div>` : ''}
      <section class="card">
        <h2>Add a shop</h2>
        <form method="post" action="/shops" class="row">${csrfField(ctx.csrf)}
          <input name="name" placeholder="Shop name" required maxlength="80">
          <button class="primary">Add shop</button>
        </form>
      </section>`, { active: '/shops' });
  });

  r.post('/shops', async (ctx) => {
    const name = str(ctx.body.name, 80);
    if (!name) return ctx.go('/shops', { err: 'Please type a shop name.' });
    if (await one('SELECT 1 FROM shops WHERE user_id=$1 AND lower(name)=lower($2)', [ctx.user.id, name])) return ctx.go('/shops', { err: 'You already have a shop with that name.' });
    const s = await one('INSERT INTO shops (user_id, name) VALUES ($1,$2) RETURNING id', [ctx.user.id, name]);
    ctx.go(`/shops/${s.id}`, { ok: 'Shop added. Now upload its Excel file.' });
  });

  r.get('/shops/:id', async (ctx) => {
    const shop = await owned('shops', ctx.params.id, ctx.user);
    const up = shop.current_upload_id ? await one('SELECT id, filename, created_at, row_count, mapping FROM uploads WHERE id=$1', [shop.current_upload_id]) : null;
    const st = up ? await shopStats(shop.id) : null;
    const contacts = up ? await rows('SELECT * FROM contacts WHERE upload_id=$1 ORDER BY row_number LIMIT 500', [up.id]) : [];
    const yes = (b) => (b ? html`<span class="badge green">yes</span>` : html`<span class="badge grey">no</span>`);
    ctx.page(shop.name, html`
      <p class="crumbs"><a href="/shops">Shops</a> ›</p>
      <h1>${shop.name}</h1>
      <section class="card">
        <h2>${up ? 'Replace the customer file' : 'Upload the customer file'}</h2>
        <p>Excel (.xlsx) or CSV, with the column titles in the first row.</p>
        <form method="post" action="/shops/${shop.id}/upload" enctype="multipart/form-data" class="row">${csrfField(ctx.csrf)}
          <input type="file" name="file" accept=".xlsx,.csv" required>
          <button class="primary">Upload</button>
        </form>
      </section>
      ${up ? html`<section class="card">
        <div class="row between"><h2>Current list</h2><div class="row"><a class="button" href="/uploads/${up.id}/map">Change column matching</a><a class="button primary" href="/campaigns/new?shop=${shop.id}">New campaign</a></div></div>
        <p class="muted">${up.filename} · uploaded ${fmtDate(up.created_at, ctx.user.timezone)}</p>
        <div class="stats">
          <div><b>${st.total}</b><span>people</span></div>
          <div><b>${st.email_ok}</b><span>can get email</span></div>
          <div><b>${st.wa_ok}</b><span>can get WhatsApp</span></div>
          <div><b>${st.no_consent}</b><span>no consent</span></div>
          <div><b>${st.bad_email + st.bad_phone}</b><span>invalid details</span></div>
        </div>
        <div class="tablewrap"><table>
          <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>WhatsApp / phone</th><th>Email OK</th><th>WhatsApp OK</th></tr></thead>
          <tbody>${contacts.map((c) => html`<tr>
            <td>${c.row_number}</td><td>${c.name}</td>
            <td>${c.email || (c.email_raw ? html`<span class="bad">${c.email_raw} (invalid)</span>` : '—')}</td>
            <td>${showAddress('whatsapp', c.phone) || (c.phone_raw ? html`<span class="bad">${c.phone_raw} (invalid)</span>` : '—')}</td>
            <td>${yes(c.email && c.consent_email)}</td><td>${yes(c.phone && c.consent_whatsapp)}</td></tr>`)}</tbody>
        </table></div>
        ${st.total > 500 ? html`<p class="muted">Showing the first 500 of ${st.total} rows.</p>` : ''}
      </section>` : ''}
      <details class="danger"><summary>Delete this shop</summary>
        <form method="post" action="/shops/${shop.id}/delete" data-confirm="Delete ${shop.name}, its customer list and its campaign history? This cannot be undone.">${csrfField(ctx.csrf)}
          <button class="danger">Delete shop and its data</button></form></details>`, { active: '/shops', wide: true });
  });

  r.post('/shops/:id/upload', async (ctx) => {
    const shop = await owned('shops', ctx.params.id, ctx.user);
    const f = ctx.files.find((x) => x.field === 'file');
    if (!f) return ctx.go(`/shops/${shop.id}`, { err: 'Choose a file first.' });
    if (f.data.length > 15 * 1024 * 1024) return ctx.go(`/shops/${shop.id}`, { err: 'The file is larger than 15 MB.' });
    let parsed;
    try { parsed = parseSpreadsheet(f.data, f.filename); } catch (e) { return ctx.go(`/shops/${shop.id}`, { err: e.message }); }
    const up = await one(`INSERT INTO uploads (user_id, shop_id, filename, headers, rows, row_count, mapping) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, shop.id, f.filename.slice(0, 200), JSON.stringify(parsed.headers), JSON.stringify(parsed.rows), parsed.rows.length, guessMapping(parsed.headers)]);
    ctx.go(`/uploads/${up.id}/map`, { ok: `Read ${plural(parsed.rows.length, 'customer row')}. Check that each column is matched correctly.` });
  });

  r.get('/uploads/:id/map', async (ctx) => {
    const up = await owned('uploads', ctx.params.id, ctx.user);
    const shop = await owned('shops', up.shop_id, ctx.user);
    if (!up.rows) throw new HttpError(410, 'This older upload is no longer stored. Upload the file again.');
    const mapping = up.mapping || {};
    const sample = up.rows.slice(0, 5);
    ctx.page('Match columns', html`
      <p class="crumbs"><a href="/shops">Shops</a> › <a href="/shops/${shop.id}">${shop.name}</a> ›</p>
      <h1>Match the columns of ${up.filename}</h1>
      <form method="post" action="/uploads/${up.id}/map" class="card stack">${csrfField(ctx.csrf)}
        <p>Tell the app which column holds each detail. We guessed where we could — please check every line.</p>
        ${FIELDS.map((fd) => html`<label class="maprow"><span>${fd.label}</span>
          <select name="${fd.key}"><option value="">— not in this file —</option>
          ${up.headers.map((h) => html`<option value="${h}" ${mapping[fd.key] === h ? 'selected' : ''}>${h}</option>`)}</select></label>`)}
        <p class="note">Only people whose <b>Consent Status</b> says they agreed (for example <i>Yes</i>) are messaged. An empty cell counts as no consent.</p>
        <label class="maprow"><span>Phone numbers without a country code are from</span>
          <select name="country">${countryOptions(COUNTRIES, ctx.user.default_country)}</select></label>
        <button class="primary">Save matching</button>
      </form>
      <section class="card"><h2>First rows of the file</h2><div class="tablewrap"><table>
        <thead><tr><th>Row</th>${up.headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
        <tbody>${sample.map((row) => html`<tr>${row.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div></section>`, { active: '/shops', wide: true });
  });

  r.post('/uploads/:id/map', async (ctx) => {
    const up = await owned('uploads', ctx.params.id, ctx.user);
    if (!up.rows) throw new HttpError(410, 'Upload the file again.');
    const mapping = {};
    for (const fd of FIELDS) { const v = str(ctx.body[fd.key], 300); if (v && up.headers.includes(v)) mapping[fd.key] = v; }
    const back = `/uploads/${up.id}/map`;
    if (!mapping.email && !mapping.phone && !mapping.whatsapp) return ctx.go(back, { err: 'Match at least an Email, Phone Number or WhatsApp Number column.' });
    if (!mapping.consent && !mapping.consent_email && !mapping.consent_whatsapp) return ctx.go(back, { err: 'Match the Consent Status column. Without it nobody can be messaged, because the app only sends to people who agreed.' });
    const used = Object.values(mapping); if (new Set(used).size !== used.length) return ctx.go(back, { err: 'The same column is matched twice. Each column can be used for one detail only.' });
    const country = COUNTRIES[ctx.body.country] ? ctx.body.country : ctx.user.default_country;
    const contacts = buildContacts(up, mapping, country);
    await tx(async (db) => {
      await db.query('DELETE FROM contacts WHERE upload_id=$1', [up.id]);
      for (let i = 0; i < contacts.length; i += 1000) {
        await db.query(`INSERT INTO contacts (user_id, shop_id, upload_id, row_number, name, email, email_raw, phone, phone_raw, consent_email, consent_whatsapp, consent_raw, extra)
          SELECT $1, $2, $3, x.row_number, x.name, x.email, x.email_raw, x.phone, x.phone_raw, x.consent_email, x.consent_whatsapp, x.consent_raw, x.extra
          FROM jsonb_to_recordset($4::jsonb) AS x(row_number int, name text, email text, email_raw text, phone text, phone_raw text, consent_email boolean, consent_whatsapp boolean, consent_raw text, extra jsonb)`,
        [ctx.user.id, up.shop_id, up.id, JSON.stringify(contacts.slice(i, i + 1000))]);
      }
      await db.query("UPDATE uploads SET mapping=$2, status='ready' WHERE id=$1", [up.id, mapping]);
      await db.query('UPDATE shops SET current_upload_id=$2 WHERE id=$1', [up.shop_id, up.id]);
      // Keep only the current file: older lists of this shop are deleted to store as little personal data as possible.
      await db.query('DELETE FROM uploads WHERE shop_id=$1 AND id<>$2', [up.shop_id, up.id]);
      await db.query('UPDATE users SET default_country=$2 WHERE id=$1', [ctx.user.id, country]);
    });
    ctx.go(`/shops/${up.shop_id}`, { ok: `Saved. ${plural(contacts.length, 'customer')} loaded.` });
  });

  r.post('/shops/:id/delete', async (ctx) => {
    const shop = await owned('shops', ctx.params.id, ctx.user);
    if (await one("SELECT 1 FROM campaigns WHERE shop_id=$1 AND status IN ('active','paused')", [shop.id])) return ctx.go(`/shops/${shop.id}`, { err: 'This shop has a running or paused campaign. Cancel it first.' });
    await q('DELETE FROM shops WHERE id=$1 AND user_id=$2', [shop.id, ctx.user.id]);
    ctx.go('/shops', { ok: `${shop.name} and its data were deleted.` });
  });
}
