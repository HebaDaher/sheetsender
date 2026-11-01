// Spreadsheet providers: Google Sheets, Excel on OneDrive (Microsoft Graph), and a built-in Demo sheet.
// Every provider exposes: resolve(), listTabs(), read(), write().
import { getAccessToken } from './accounts.js';
import { request, ProviderError } from './http.js';
import { one, run } from './db.js';
import * as xlsx from './xlsx.js';

export const indexToCol = xlsx.indexToCol;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const fileCache = new Map(); // shopId -> { buf, etag } for personal-OneDrive file mode

// ---------- Google Sheets ----------
const google = {
  async resolve(accountId, url) {
    const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || String(url).match(/^([a-zA-Z0-9-_]{30,})$/);
    if (!m) throw new Error('That does not look like a Google Sheets link. Open the sheet in your browser and copy the full address bar link.');
    const id = m[1];
    const t = await getAccessToken(accountId);
    const meta = await request('Google Sheets', `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title`, { headers: { authorization: `Bearer ${t}` } });
    return { ref: { spreadsheetId: id, title: meta.properties.title, url: `https://docs.google.com/spreadsheets/d/${id}` }, tabs: meta.sheets.map((s) => s.properties.title) };
  },
  async read(shop) {
    const t = await getAccessToken(shop.sheet_account_id);
    const range = encodeURIComponent(`'${shop.sheet_tab.replace(/'/g, "''")}'`);
    const r = await request('Google Sheets', `https://sheets.googleapis.com/v4/spreadsheets/${shop.sheet_ref.spreadsheetId}/values/${range}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${t}` } });
    return (r.values || []).map((row) => row.map((v) => (v == null ? '' : String(v))));
  },
  async write(shop, cells) {
    if (!cells.length) return;
    const t = await getAccessToken(shop.sheet_account_id);
    const tab = `'${shop.sheet_tab.replace(/'/g, "''")}'`;
    await request('Google Sheets', `https://sheets.googleapis.com/v4/spreadsheets/${shop.sheet_ref.spreadsheetId}/values:batchUpdate`, {
      method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: cells.map((c) => ({ range: `${tab}!${indexToCol(c.col)}${c.row}`, values: [[c.value]] })) }),
    });
  },
};

// ---------- Excel on OneDrive (Microsoft Graph) ----------
// OneDrive for Business / SharePoint: Excel workbook API (cell-level, safe while the file is open).
// Personal OneDrive: Microsoft does not support the workbook API, so the file is downloaded, updated and
// re-uploaded with an ETag check (never overwrites someone else's newer changes).
const microsoft = {
  async resolve(accountId, url) {
    const t = await getAccessToken(accountId);
    const shareId = 'u!' + Buffer.from(String(url).trim()).toString('base64url');
    let item;
    try {
      item = await request('OneDrive', `${GRAPH}/shares/${shareId}/driveItem?$select=id,name,parentReference,webUrl,file`, { headers: { authorization: `Bearer ${t}`, Prefer: 'redeemSharingLink' } });
    } catch (e) {
      throw new Error('Could not open that OneDrive link. In OneDrive, right-click the Excel file → Share → Copy link, and paste that link here. ' + e.message);
    }
    if (!/\.xlsx$/i.test(item.name)) throw new Error(`"${item.name}" is not an .xlsx file. Open it in Excel and use File → Save As → Excel Workbook (.xlsx).`);
    const ref = { driveId: item.parentReference.driveId, itemId: item.id, title: item.name, url: String(url).trim(), webUrl: item.webUrl, mode: 'workbook' };
    const base = `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}`;
    try {
      const ws = await request('Excel', `${base}/workbook/worksheets?$select=name`, { headers: { authorization: `Bearer ${t}` } });
      return { ref, tabs: ws.value.map((w) => w.name) };
    } catch (e) {
      if (e.kind === 'auth') throw e;
      ref.mode = 'file';
      const buf = await downloadItem(t, ref);
      return { ref, tabs: xlsx.sheetNames(buf.buf) };
    }
  },
  async read(shop) {
    const t = await getAccessToken(shop.sheet_account_id);
    const ref = shop.sheet_ref;
    if (ref.mode === 'file') {
      const f = await downloadItem(t, ref);
      fileCache.set(shop.id, f);
      return xlsx.readSheet(f.buf, shop.sheet_tab);
    }
    const r = await request('Excel', `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(shop.sheet_tab)}/usedRange(valuesOnly=true)?$select=address,text`, { headers: { authorization: `Bearer ${t}` } });
    // usedRange may not start at A1 — pad so array index = sheet position.
    const start = String(r.address).split('!').pop().split(':')[0].replace(/\$/g, '');
    const c0 = xlsx.colToIndex(start.replace(/\d+/g, '')), r0 = Number(start.replace(/\D+/g, '')) - 1;
    const rows = [];
    for (let i = 0; i < r0; i++) rows.push([]);
    for (const row of r.text || []) rows.push([...Array(c0).fill(''), ...row.map((v) => String(v ?? ''))]);
    return rows;
  },
  async write(shop, cells) {
    if (!cells.length) return;
    const t = await getAccessToken(shop.sheet_account_id);
    const ref = shop.sheet_ref;
    if (ref.mode === 'file') {
      const cached = fileCache.get(shop.id);
      if (!cached) throw new ProviderError('Excel file not loaded yet', { kind: 'transient' });
      const out = xlsx.writeCells(cached.buf, shop.sheet_tab, cells);
      const res = await request('OneDrive', `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/content`, {
        method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'if-match': cached.etag }, body: out,
      });
      fileCache.set(shop.id, { buf: out, etag: res.eTag });
      return;
    }
    // Group neighbouring cells in the same row into one range update.
    const byRow = new Map();
    for (const c of cells) { if (!byRow.has(c.row)) byRow.set(c.row, []); byRow.get(c.row).push(c); }
    for (const [row, list] of byRow) {
      list.sort((a, b) => a.col - b.col);
      let group = [list[0]];
      const flush = async () => {
        const addr = `${indexToCol(group[0].col)}${row}:${indexToCol(group[group.length - 1].col)}${row}`;
        await request('Excel', `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(shop.sheet_tab)}/range(address='${addr}')`, {
          method: 'PATCH', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
          body: JSON.stringify({ values: [group.map((g) => g.value)], numberFormat: [group.map(() => '@')] }),
        });
      };
      for (let i = 1; i < list.length; i++) {
        if (list[i].col === group[group.length - 1].col + 1) group.push(list[i]);
        else { await flush(); group = [list[i]]; }
      }
      await flush();
    }
  },
};

async function downloadItem(token, ref) {
  const meta = await request('OneDrive', `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}?$select=eTag,size`, { headers: { authorization: `Bearer ${token}` } });
  const res = await request('OneDrive', `${GRAPH}/drives/${ref.driveId}/items/${ref.itemId}/content`, { headers: { authorization: `Bearer ${token}` }, raw: true });
  return { buf: Buffer.from(await res.arrayBuffer()), etag: meta.eTag };
}

// ---------- Demo sheet (built in, for trying the app before connecting a real spreadsheet) ----------
const demo = {
  async resolve() { return { ref: { title: 'Demo sheet (built in)' }, tabs: ['Sheet1'] }; },
  async read(shop) {
    const r = one('SELECT rows FROM demo_sheets WHERE shop_id = ?', shop.id);
    return r ? JSON.parse(r.rows) : [];
  },
  async write(shop, cells) {
    const rows = await demo.read(shop);
    for (const c of cells) {
      while (rows.length < c.row) rows.push([]);
      const row = rows[c.row - 1];
      while (row.length <= c.col) row.push('');
      row[c.col] = c.value;
    }
    run('INSERT INTO demo_sheets (shop_id, rows) VALUES (?, ?) ON CONFLICT(shop_id) DO UPDATE SET rows = excluded.rows', shop.id, JSON.stringify(rows));
  },
};

export const providers = { google, microsoft, demo };
export function providerFor(shop) {
  const p = providers[shop.sheet_provider];
  if (!p) throw new Error('No spreadsheet connected');
  return p;
}
export function setDemoRows(shopId, rows) {
  run('INSERT INTO demo_sheets (shop_id, rows) VALUES (?, ?) ON CONFLICT(shop_id) DO UPDATE SET rows = excluded.rows', shopId, JSON.stringify(rows));
}
export function forgetFileCache(shopId) { fileCache.delete(shopId); }
