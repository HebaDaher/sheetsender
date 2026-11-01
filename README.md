# SheetSender

Multi-shop automation: when a new contact row appears in a shop's **Google Sheet** or **Excel file on OneDrive**, it automatically sends that shop's **Gmail** email and/or **official WhatsApp Business** template message, then writes the result back into the sheet.

➡ **To install and use it, follow [SETUP.md](SETUP.md) step by step.**

## How it works

```
 Browser (dashboard, any device)            Meta webhooks (delivered / STOP)
            │ HTTPS                                    │
     ┌──────▼──────────────────────────────────────────▼──────┐
     │ server.js  — dashboard, API, sign-in, OAuth, webhooks,  │
     │              unsubscribe pages, signed file links       │
     └──────────────────────┬──────────────────────────────────┘
                            │  SQLite (data/app.db) — shops, encrypted tokens,
                            │  jobs (idempotency keys), activity, opt-outs
     ┌──────────────────────┴──────────────────────────────────┐
     │ worker.js  — runs 24/7, browser not needed              │
     │  every minute per active shop: read sheet → detect new  │
     │  rows → queue jobs → send → write statuses back         │
     └───┬───────────────┬──────────────────┬──────────────────┘
     Google Sheets   Microsoft Graph     Gmail API / WhatsApp Cloud API
```

- **Zero dependencies**: Node.js 22.13+ built-ins only (built-in SQLite, HTTP, crypto, fetch). No build step.
- **Shops are isolated**: every query is scoped by shop; templates, files, rules, opt-outs, history and Start/Pause are per shop.
- **No duplicates**: each message has a unique key `shop | mode | campaign | channel | recipient | revision` enforced by the database. Retries only re-queue failed/waiting messages; a message that was mid-send during a crash is marked for manual review instead of being re-sent.
- **New rows only**: rows already in the sheet when you click Start are recorded and not messaged (optional override).
- **Channels are independent**: email and WhatsApp are separate jobs; one failing never blocks the other.
- **Safe failures**: temporary errors retry with backoff (1, 5, 15, 60 min); expired sign-ins pause that channel, alert you (dashboard + email) and resume after you reconnect.
- **Simulation is labelled**: until an account is connected and tested, sends are recorded as **SIMULATED – not sent** everywhere (sheet, dashboard, log). Live mode is locked until real tests succeed.
- **Security**: OAuth only (no passwords), tokens encrypted with AES-256-GCM, signed session cookie, CSRF protection, signed/expiring download links, Meta webhook signature verification, CSP headers.
- **Compliance helpers**: consent rules, shop-level and global opt-out lists, one-click unsubscribe headers + footer, WhatsApp STOP handling, approved templates only, 24-hour window respected for extra media.

## Files

| Path | What it is |
|---|---|
| `server.js` | Web server + API |
| `worker.js` | Background worker (must always run) |
| `lib/engine.js` | Row detection, eligibility, sending, retries, sheet write-back, webhooks |
| `lib/sheets.js`, `lib/xlsx.js` | Google Sheets / OneDrive Excel (workbook API + safe file mode for personal OneDrive) / demo sheet |
| `lib/gmail.js`, `lib/whatsapp.js` | Provider clients |
| `lib/accounts.js` | OAuth, token refresh, health checks |
| `lib/media.js` | Per-shop media library, WhatsApp limits, signed links |
| `public/` | Dashboard (plain HTML/CSS/JS) |
| `deploy/` | systemd services, Caddy (HTTPS) config, backup script |
| `scripts/e2e-test.js` | 50 end-to-end checks (real server + worker, two shops) |
| `scripts/live-path-test.js` | 48 checks of the exact Gmail / WhatsApp / Sheets / Graph requests |

Run the tests: `npm test` and `node --no-warnings scripts/live-path-test.js`.
