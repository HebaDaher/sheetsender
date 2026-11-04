/**
 * Upload history ("lists").
 *
 * Every Excel/CSV file that is uploaded becomes a list. A person keeps the lists they were in (the "lists" column of
 * Contacts, list ids separated by commas), so a file uploaded once can be used again later for a different message
 * without uploading it again. Uploading a file with the same name again for the same shop replaces that list's people
 * with the people in the new file (the contacts themselves are never deleted).
 */

const LIST_MAX_NAME = 80;

function listIdsOf_(c) {
  return String((c && c.lists) || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}

function addToList_(c, listId) {
  const ids = listIdsOf_(c);
  if (ids.indexOf(listId) !== -1) return false;
  ids.push(listId);
  c.lists = ids.join(',');
  return true;
}

function removeFromList_(c, listId) {
  const ids = listIdsOf_(c);
  const i = ids.indexOf(listId);
  if (i === -1) return false;
  ids.splice(i, 1);
  c.lists = ids.join(',');
  return true;
}

function cleanListName_(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIST_MAX_NAME);
}

/** Lists of one shop that were not removed. */
function shopLists_(ss, shopId) {
  return readTable_(ss, TABS.LISTS).rows.filter(function (l) { return l.shop_id === shopId && l.status !== 'removed'; });
}

/**
 * Checks the files chosen on a Send page. An empty choice means "everyone in this shop".
 * Returns { ids: [...], names: [...] } with only lists that still exist.
 */
function cleanListChoice_(ss, shopId, listIds) {
  if (listIds === undefined || listIds === null || listIds === '') return { ids: [], names: [] };
  if (!Array.isArray(listIds)) listIds = String(listIds).split(',');
  listIds = listIds.map(function (s) { return String(s).trim(); }).filter(String);
  if (!listIds.length) return { ids: [], names: [] };
  if (listIds.length > 200) throw new Error('Too many files chosen.');
  const byId = {};
  shopLists_(ss, shopId).forEach(function (l) { byId[l.list_id] = l; });
  const ids = [], names = [];
  listIds.forEach(function (id) {
    if (byId[id] && ids.indexOf(id) === -1) { ids.push(id); names.push(byId[id].name || byId[id].file_name); }
  });
  if (!ids.length) throw new Error('The chosen uploaded files were removed. Reload the page and choose again.');
  return { ids: ids, names: names };
}

/** Keeps only the contacts that are in at least one of the chosen lists (all contacts when none are chosen). */
function filterByLists_(contacts, choice) {
  if (!choice || !choice.ids.length) return contacts;
  const set = {};
  choice.ids.forEach(function (id) { set[id] = true; });
  return contacts.filter(function (c) { return listIdsOf_(c).some(function (id) { return set[id]; }); });
}

/**
 * Finds (or makes) the list an upload goes into. Called by importContacts inside the lock.
 * meta.listId: the list returned by the first part of the same upload.
 * meta.first: true for the first part of an upload; an older list with the same file name then starts empty again.
 */
function listForImport_(ss, shopId, meta, actor, contactsTable, toUpdate) {
  const table = readTable_(ss, TABS.LISTS);
  const now = nowIso_();
  let list = null;
  if (meta.listId) {
    list = table.rows.filter(function (l) { return l.list_id === meta.listId && l.shop_id === shopId && l.status !== 'removed'; })[0];
    if (!list) throw new Error('This upload\'s file was removed while uploading. Upload the file again.');
    const up = parseJson_(CacheService.getScriptCache().get('LUP_' + String(meta.uploadToken || '')) || '');
    list._token = up && up.list === list.list_id ? String(meta.uploadToken) : '';
    list._reuploaded = !!(up && up.reupload);
  } else {
    const fileName = cleanListName_(meta.fileName) || ('Upload ' + Utilities.formatDate(new Date(), 'Asia/Dubai', 'd MMM yyyy HH:mm'));
    const wanted = norm_(fileName);
    const sameName = table.rows.filter(function (l) {
      return l.shop_id === shopId && l.status !== 'removed' && norm_(l.file_name) === wanted;
    });
    list = meta.asNew ? null : sameName[0];
    if (list) {
      // Same file uploaded again: the list becomes exactly the people in the new file. People who are no longer in
      // the file leave the list only when the LAST part has arrived (a failed upload never leaves half a list).
      list.rows = '0';
      list.updated_at = now;
      list._reuploaded = true;
    } else {
      // "Keep both": the new upload gets its own list, named "file (2)", "file (3)"…
      let name = fileName;
      if (sameName.length) {
        const names = {};
        table.rows.forEach(function (l) { if (l.shop_id === shopId && l.status !== 'removed') names[norm_(l.name)] = true; });
        for (let n = 2; names[norm_(name)]; n++) name = fileName.slice(0, LIST_MAX_NAME - 6) + ' (' + n + ')';
      }
      list = { list_id: newId_('F'), shop_id: shopId, name: name, file_name: fileName, created_at: now,
        created_by: actor || '', updated_at: now, rows: '0', status: '' };
      appendRows_(table, [list]);
    }
  }
  if (!meta.listId) {
    list._token = Utilities.getUuid();
    CacheService.getScriptCache().put('LUP_' + list._token, JSON.stringify({ list: list.list_id, reupload: !!list._reuploaded }), 21600);
  }
  list._table = table;
  return list;
}

/**
 * Remembers who was in this part of the upload; after the last part of a re-upload, people who are not in the new
 * file leave that list (they stay in Contacts). If the memory was lost (6 hours), nobody is taken out.
 */
function finishListParts_(list, meta, seenIds, contactsTable, toUpdate, result) {
  if (!list._token) return;
  const cache = CacheService.getScriptCache();
  const part = Math.max(0, Math.floor(Number(meta.part) || 0));
  if (part > 500) throw new Error('This file is too big for one upload.');
  cache.put('LSEEN_' + list._token + '_' + part, seenIds.join(','), 21600);
  if (meta.last === false || !list._reuploaded) return;
  const keys = [];
  for (let i = 0; i <= part; i++) keys.push('LSEEN_' + list._token + '_' + i);
  const got = cache.getAll ? cache.getAll(keys) : keys.reduce(function (o, k) { const v = cache.get(k); if (v !== null) o[k] = v; return o; }, {});
  if (keys.some(function (k) { return got[k] === undefined || got[k] === null; })) { result.keptOldPeople = true; return; }
  const seen = {};
  keys.forEach(function (k) { String(got[k] || '').split(',').forEach(function (id) { if (id) seen[id] = true; }); });
  let removed = 0;
  contactsTable.rows.forEach(function (c) {
    if (c.shop_id === list.shop_id && !seen[c.contact_id] && removeFromList_(c, list.list_id)) {
      removed++;
      if (toUpdate.indexOf(c) === -1) toUpdate.push(c);
    }
  });
  result.leftList = removed;
}

function finishListImport_(list, rowsInPart) {
  const table = list._table;
  list.rows = String((Number(list.rows) || 0) + rowsInPart);
  list.updated_at = nowIso_();
  updateRow_(table, list); // only the tab's columns are written
}

/**
 * Contacts imported before upload history existed: their file (source_file) becomes a list once.
 * Only files that never had a list are made (a list that was removed is not made again).
 */
function backfillLists_(ss, shopId) {
  const contacts = readTable_(ss, TABS.CONTACTS);
  const lists = readTable_(ss, TABS.LISTS);
  const known = {};
  lists.rows.forEach(function (l) { if (l.shop_id === shopId) known[norm_(l.file_name)] = true; });
  const groups = {};
  contacts.rows.forEach(function (c) {
    if (c.shop_id !== shopId || c.lists || !c.source_file) return;
    const key = norm_(c.source_file);
    if (known[key]) return;
    (groups[key] = groups[key] || { name: c.source_file, people: [], first: c.created_at }).people.push(c);
    if (c.created_at && c.created_at < groups[key].first) groups[key].first = c.created_at;
  });
  const keys = Object.keys(groups);
  if (!keys.length) return false;
  const newLists = [], changed = [];
  keys.forEach(function (k) {
    const g = groups[k];
    const name = cleanListName_(g.name) || 'Earlier upload';
    const l = { list_id: newId_('F'), shop_id: shopId, name: name, file_name: name, created_at: g.first || nowIso_(),
      created_by: '', updated_at: g.first || nowIso_(), rows: String(g.people.length), status: '' };
    newLists.push(l);
    g.people.forEach(function (c) { addToList_(c, l.list_id); changed.push(c); });
  });
  appendRows_(lists, newLists);
  saveRows_(contacts, changed);
  return true;
}

function needsBackfill_(ss, shopId) {
  const known = {};
  readTable_(ss, TABS.LISTS).rows.forEach(function (l) { if (l.shop_id === shopId) known[norm_(l.file_name)] = true; });
  return readTable_(ss, TABS.CONTACTS).rows.some(function (c) {
    return c.shop_id === shopId && !c.lists && c.source_file && !known[norm_(c.source_file)];
  });
}

/** Upload history for the Contacts page: newest first, with how many people are in each file now. */
function listSummaries_(ss, shopId, contactRows, campaigns) {
  const count = {}, email = {}, wa = {};
  contactRows.forEach(function (c) {
    if (c.shop_id !== shopId) return;
    const okE = eligibility_(c, 'email').ok, okW = eligibility_(c, 'whatsapp').ok;
    listIdsOf_(c).forEach(function (id) {
      count[id] = (count[id] || 0) + 1;
      if (okE) email[id] = (email[id] || 0) + 1;
      if (okW) wa[id] = (wa[id] || 0) + 1;
    });
  });
  const used = {};
  (campaigns || []).forEach(function (k) {
    String(k.list_ids || '').split(',').filter(String).forEach(function (id) { (used[id] = used[id] || []).push(k.campaign_id); });
  });
  return shopLists_(ss, shopId).map(function (l) {
    return { list_id: l.list_id, name: l.name || l.file_name, file_name: l.file_name, created_at: l.created_at,
      created_by: l.created_by, updated_at: l.updated_at, rows: Number(l.rows) || 0, people: count[l.list_id] || 0,
      emailOk: email[l.list_id] || 0, waOk: wa[l.list_id] || 0, campaigns: used[l.list_id] || [] };
  }).sort(function (a, b) { return a.updated_at < b.updated_at ? 1 : -1; });
}

function renameList(shopId, listId, name) {
  const ctx = requireUser_();
  name = cleanListName_(name);
  if (!name) throw new Error('Write a name.');
  return withLock_(function () {
    findShop_(ctx.ss, shopId);
    const table = readTable_(ctx.ss, TABS.LISTS);
    const l = table.rows.filter(function (r) { return r.list_id === listId && r.shop_id === shopId && r.status !== 'removed'; })[0];
    if (!l) throw new Error('That uploaded file was not found. Reload the page.');
    l.name = name;
    updateRow_(table, l);
    return { list_id: l.list_id, name: l.name };
  });
}

/** Removes a file from the upload history. The people stay in Contacts (and in other files they were in). */
function removeList(shopId, listId) {
  const ctx = requireUser_();
  return withLock_(function () {
    findShop_(ctx.ss, shopId);
    const table = readTable_(ctx.ss, TABS.LISTS);
    const l = table.rows.filter(function (r) { return r.list_id === listId && r.shop_id === shopId && r.status !== 'removed'; })[0];
    if (!l) throw new Error('That uploaded file was not found. Reload the page.');
    l.status = 'removed';
    l.updated_at = nowIso_();
    updateRow_(table, l);
    const contacts = readTable_(ctx.ss, TABS.CONTACTS);
    const changed = contacts.rows.filter(function (c) { return c.shop_id === shopId && removeFromList_(c, listId); });
    saveRows_(contacts, changed);
    return true;
  });
}
