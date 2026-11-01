import { one } from '../db.js';
import { HttpError } from '../http.js';

const TABLES = new Set(['shops', 'uploads', 'senders', 'campaigns', 'media']);

// Loads a row only if it belongs to the signed-in user; otherwise behaves as "not found".
export async function owned(table, id, user) {
  if (!TABLES.has(table)) throw new Error('bad table');
  if (!/^\d{1,18}$/.test(String(id))) throw new HttpError(404, 'Not found.');
  const row = await one(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`, [id, user.id]);
  if (!row) throw new HttpError(404, 'Not found.');
  return row;
}

export const str = (v, max = 1000) => String(Array.isArray(v) ? v[0] : v ?? '').trim().slice(0, max);
export const list = (v) => (v === undefined ? [] : [].concat(v));
