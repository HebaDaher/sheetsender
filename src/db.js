import fs from 'node:fs';
import { Pool } from './pg.js';
import { config } from './config.js';

export let pool = null;

export async function initDb() {
  pool = new Pool(config.databaseUrl, { max: 5, ca: config.databaseCa });
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql, null);
  return pool;
}

export const q = (text, params) => pool.query(text, params);
export const rows = async (text, params) => (await pool.query(text, params)).rows;
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
export const tx = (fn) => pool.tx(fn);
