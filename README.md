# Shop Follow-ups

A free web app for following up with interested buyers of several shops.
Anyone opens the link, clicks **Sign in with Google** (Google asks only for their email address — no warning screen) and gets their **own private workspace**: they add their shops, connect as many Gmail accounts as they need, upload Excel files, and press **Start sending**. Emails then go out automatically, one every few minutes, **from the Gmail account connected for that shop**, and every result is recorded. A workspace owner can add helpers (e.g. Dad) who can send but not change settings.

- **Backend + hosting:** Google Apps Script (JavaScript, V8), standalone project
- **Interface:** HTML / CSS / browser JavaScript served by HTML Service
- **Database:** one Google Sheet per workspace with the tabs `Shops`, `Contacts`, `Templates`, `Campaigns`, `Send Log`
- **Email:** Gmail API through Google OAuth 2.0 — each shop's Gmail account is connected once (scope `gmail.send` only)
- **Excel reading:** SheetJS Community Edition 0.18.12, bundled locally in `src/SheetJS.html` (Apache 2.0, see `third-party/`)
- **WhatsApp:** (1) free, from a Mac: a background helper sends through WhatsApp Web — paired from the app with one Terminal line (`mac/install.sh`); (2) paid, the **WhatsApp Business API** (Meta Cloud API, Graph v25.0) with approved templates — works with every laptop off; (3) by hand: a button opens WhatsApp with the message written

**Use it:** [Open Shop Follow-ups](https://script.google.com/macros/s/AKfycbxbNPWgRTi4oL_4c0Z_jNo2FH-zCCc7M20dGO-TMZkIkq5vpFTXS2kv1RzDlk4K8S4/exec) · **New users, start here:** [How to start](https://hebadaher.github.io/sheetsender/start.html)

The full setup guide for the administrator is in the shared document that came with this project.

## Why the Gmail API instead of GmailApp

`GmailApp` can only send from the Google account that runs the script (and its "Send mail as" aliases). It cannot send from separately connected Gmail accounts. So only the sending component changed: `src/Senders.gs` connects each Gmail account with OAuth and sends through the Gmail API with `UrlFetchApp`. Everything else is unchanged.

## Where secrets live

| Secret | Stored in | Who can read it |
|---|---|---|
| OAuth client secret (one for the app, made by the administrator) | Script properties (`OAUTH_CLIENT_SECRET`) | Server code only; never returned to a page |
| Session signing key | Script properties (`SESSION_KEY`) | Server code only |
| Each Gmail account's refresh/access token | Administrator's `UserProperties`, key per workspace | Server code only; from a page only the workspace owner can use it |
| WhatsApp Business API access token | Administrator's `UserProperties`, key per workspace | Same |
| Mac helper secret | On that Mac (`~/.shop-followups/bridge.json`, mode 600); the app keeps only its SHA-256 | That Mac |
| Connected addresses + status | Script properties, per workspace | Non-secret; shown in the app |

No token or secret is ever sent to the web page or written to a Google Sheet. The script is standalone, so people who can edit a Sheet cannot see or change the code.

## Many people, one app (workspaces)

`src/Workspaces.gs`. The web app runs as the **administrator** (the person who ran `setup`): *Execute as: Me*, *Anyone*. Visitors authorize nothing in Apps Script, so they see no permission or warning screen. They click **Sign in with Google**; Google is asked only for `openid email` (non-sensitive), the server checks Google's answer and gives the page a signed session (HMAC, 30 days). Every page call goes through `api(session, action, args)`; only the listed actions can be called, and the signed-in email always comes from the session.

Each workspace is a Google Sheet in the administrator's Drive, shared with its owner. Owners add helpers in ⚙ Settings → People (app access only). Gmail and WhatsApp Business API tokens are kept in the administrator's private server store under each workspace's own keys and are only usable for that workspace (from a page: only by its owner). One every-minute trigger sends for all workspaces that have something due (`DUE_INDEX`). Settings are read through the script cache to stay inside Google's daily limits.

Updating from earlier versions is automatic: the original Sheet stays the administrator's workspace and its editors (e.g. Dad) become its members. A workspace made with the previous sign-in (Sheet in the person's own Drive) is simply made again by its owner.

Limits to know: the Gmail connection screen still shows Google's "unverified app" warning (the `gmail.send` scope is sensitive), and Google allows at most 100 Gmail connections while the app is unverified. Everything runs on the administrator's Apps Script quotas (e.g. 90 minutes of trigger time and about 20,000 outside requests a day for a free Gmail account), which is plenty for a few dozen active users.

## Folder layout

| Path | What it is |
|---|---|
| `src/Code.gs` | Setup, Sheet database layer, import, templates, campaigns, WhatsApp Mac helper + bridge |
| `src/Workspaces.gs` | Workspaces, people, shops, per-owner triggers, upgrade from the single-owner version |
| `src/WhatsAppApi.gs` | WhatsApp Business API: connect, templates, sending, error handling |
| `src/Senders.gs` | Google OAuth connect / callback / refresh / test / disconnect, Gmail API sending |
| `src/Sending.gs` | The queue: the every-minute trigger that sends the next due email |
| `src/Index.html`, `src/Styles.html`, `src/App.html` | The web page (including the owner's Settings page) |
| `src/SheetJS.html` | Bundled Excel reader (no CDN) |
| `src/appsscript.json` | Manifest: time zone, scopes, web app settings |
| `config/appsscript.json` | Backup copy of the manifest (clasp may overwrite the one in `src/`) |
| `sample-contacts.xlsx` | Fake contacts for testing |
| `whatsapp/` | The Mac helper (Python + Playwright) and the administrator's installers |
| `mac/install.sh` | One-line installer for any person's Mac (published on GitHub Pages) |
| `tests/` | Node tests with simulated Sheets / OAuth / Gmail API / Meta API / triggers, browser tests, WhatsApp helper tests |

## Quick start (details in the guide)

```bash
npm install -g @google/clasp
clasp login
clasp create-script --type standalone --title "Shop Follow-ups" --rootDir src
cp config/appsscript.json src/appsscript.json
clasp push --force
```

Then in the Apps Script editor run `setup` once, deploy as a web app (**Execute as: User accessing the web app**, **Who has access: Anyone with Google account**), create the OAuth client in Google Cloud, and finish in the app's **Settings** page.

## Running the tests

```bash
node tests/test.js          # core checks against simulated Google services
node tests/test_multi.js    # workspaces, upgrade from the old version, Mac pairing, WhatsApp Business API
pip install playwright && playwright install chromium
python3 tests/ui.py         # clicks through the real interface in a headless browser
python3 tests/ui_multi.py   # a new person's workspace, Settings, WhatsApp tab
python3 tests/whatsapp/test_wa.py                 # the Mac sender against a fake WhatsApp Web
E2E_PAIRED=1 python3 tests/whatsapp/e2e.py        # page → app → bridge → Mac helper → fake WhatsApp
```
