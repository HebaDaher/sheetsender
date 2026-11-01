// Background worker — runs 24/7 on the server, independent of any browser.
// Polls every active shop's spreadsheet, processes queued messages, writes statuses back,
// checks connected accounts and sends alert emails.
import { config, checkConfig } from './lib/config.js';
import { all, run, one, logActivity, getSetting } from './lib/db.js';
import { pollShop, processJob, flushSoon, globalPaused, sendNotifications, healthCheck } from './lib/engine.js';

const problems = checkConfig();
if (problems.length) { console.error('Configuration problems:\n- ' + problems.join('\n- ')); process.exit(1); }

const TICK_MS = 5000;
const POLL_CONCURRENCY = 4;
const SEND_CONCURRENCY = 3;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// A message that was mid-send when the worker stopped might or might not have gone out.
// To never send twice, it is marked failed for the user to check and retry manually.
const stuck = run(`UPDATE jobs SET status='failed', error_kind='interrupted',
  last_error='The worker restarted while sending. Check whether this message arrived before retrying.' WHERE status='processing'`);
if (stuck.changes) log(`Marked ${stuck.changes} interrupted message(s) as failed for manual review`);

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { log('error', e.message); } } }));
}

let lastHealth = 0, lastNotify = 0, busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    run("INSERT INTO settings(key, value) VALUES ('worker_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(Date.now()));
    const paused = globalPaused();
    const nowMs = Date.now();
    const shops = all('SELECT id, status, last_polled_at FROM shops WHERE sheet_provider IS NOT NULL AND sheet_tab IS NOT NULL');
    const due = shops.filter((s) => {
      const last = s.last_polled_at ? Date.parse(s.last_polled_at) : 0;
      const hasDirty = !!one('SELECT 1 FROM sheet_dirty WHERE shop_id=? LIMIT 1', s.id);
      if (s.status === 'active' && !paused) return nowMs - last >= config.pollSeconds * 1000 || (flushSoon.has(s.id) && nowMs - last >= 10000);
      return hasDirty && nowMs - last >= config.pollSeconds * 1000; // paused: only write pending status updates
    });
    await pool(due, POLL_CONCURRENCY, async (s) => {
      flushSoon.delete(s.id);
      const r = await pollShop(s.id, { flushOnly: s.status !== 'active' || paused });
      if (r.created) log(`shop ${s.id}: ${r.created} new row(s)`);
      if (r.ok === false) log(`shop ${s.id}: ${r.error}`);
    });
    if (!paused) {
      const jobs = all(`SELECT j.id FROM jobs j JOIN shops s ON s.id = j.shop_id
                        WHERE j.status='pending' AND j.next_attempt_at <= ? AND s.status='active'
                        ORDER BY j.next_attempt_at, j.id LIMIT 30`, Date.now());
      await pool(jobs, SEND_CONCURRENCY, (j) => processJob(j.id));
    }
    if (nowMs - lastNotify > 30000) { lastNotify = nowMs; await sendNotifications(); }
    if (nowMs - lastHealth > 30 * 60000) { lastHealth = nowMs; await healthCheck(); }
  } catch (e) {
    log('tick error', e.stack || e.message);
  } finally { busy = false; }
}

log(`Worker started. Polling every ${config.pollSeconds}s. Global pause: ${getSetting('global_paused', false)}`);
logActivity({ event: 'worker_started', result: 'ok' });
const timer = setInterval(tick, TICK_MS);
tick();
// Graceful stop: finish the messages currently being sent before exiting (max 60s).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  log('Worker stopping…');
  clearInterval(timer);
  const started = Date.now();
  const wait = setInterval(() => { if (!busy || Date.now() - started > 60000) { clearInterval(wait); process.exit(0); } }, 200);
});
