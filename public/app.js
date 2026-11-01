// Small enhancements; every page also works without JavaScript.
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) { e.preventDefault(); return; }
  if (f.dataset.once !== undefined) {
    if (f.dataset.sent) { e.preventDefault(); return; }
    f.dataset.sent = '1';
    f.querySelectorAll('button').forEach((b) => { b.disabled = true; b.textContent = 'Working…'; });
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-autosubmit]')) { el.form.querySelectorAll('input[type=file]').forEach((i) => { i.value = ''; }); el.form.requestSubmit(); }
  if (el.matches('[data-select-all]')) {
    document.querySelectorAll(`input[name="${el.dataset.selectAll}[]"][data-eligible]`).forEach((c) => { c.checked = el.checked; });
    const radio = document.querySelector('input[name=audience][value=selected]'); if (radio && el.checked) radio.checked = true;
  }
});

document.addEventListener('click', (e) => {
  const c = e.target.closest('code.copy');
  if (c && navigator.clipboard) { navigator.clipboard.writeText(c.textContent.trim()); c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 1200); }
});

const poll = document.querySelector('[data-poll]');
if (poll) {
  const status0 = poll.dataset.pollStatus;
  if (['active', 'paused'].includes(status0)) {
    setInterval(async () => {
      try {
        const r = await fetch(poll.dataset.poll, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return;
        const d = await r.json();
        if (d.status !== status0) { location.reload(); return; }
        const n = d.counts;
        const vals = { queued: n.queued + n.sending, sent: n.sentTotal, delivered: n.delivered + n.read, read: n.read, failed: n.failed, skipped: n.skipped, unknown: n.unknown, cancelled: n.cancelled };
        for (const [k, v] of Object.entries(vals)) { const el = poll.querySelector(`[data-count="${k}"]`); if (el) el.textContent = v; }
        const done = n.sentTotal + n.failed + n.unknown; const total = done + n.queued + n.sending;
        const p = poll.querySelector('[data-progress]'); if (p) p.value = total ? Math.round((done / total) * 100) : 100;
        const w = poll.querySelector('[data-waiting]'); if (w) { w.textContent = d.waiting || ''; w.hidden = !d.waiting; }
      } catch {}
    }, 5000);
  }
}
