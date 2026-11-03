# Shop Follow-ups

A free web app for following up with interested buyers of several shops.
Anyone opens the link with their Google account and gets their **own private workspace** (a Google Sheet in their own Drive): they add their shops, connect as many Gmail accounts as they need, upload Excel files, and press **Start sending**. Emails then go out automatically, one every few minutes, **from the Gmail account connected for that shop**, and every result is recorded. A workspace owner can add helpers (e.g. Dad) who can send but not change settings.

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
| Each Gmail account's refresh/access token | The workspace owner's `UserProperties` | Only code running as that owner (their session, their trigger) |
| WhatsApp Business API access token | The workspace owner's `UserProperties` | Only code running as that owner |
| Mac helper secret | On that Mac (`~/.shop-followups/bridge.json`, mode 600); the app keeps only its SHA-256 | That Mac |
| Connected addresses + status | Script properties, per workspace | Non-secret; shown in the app |

No token or secret is ever sent to the web page or written to a Google Sheet. The script is standalone, so people who can edit a Sheet cannot see or change the code.

## Many people, one app (workspaces)

`src/Workspaces.gs`. Each person who opens the link creates their own workspace; the app never shows one workspace's data to another. Owners add or remove people in ⚙ Settings → People (they become editors of that workspace's Sheet). Each owner has their own every-minute trigger (created when they connect Gmail or the WhatsApp API), which only works on their workspace. The person who ran `setup` is the **administrator**: only they set the Google sign-in client. Updating from the single-owner version is automatic: the existing Sheet becomes the administrator's workspace, its settings move into it, and the Sheet's editors (e.g. Dad) keep access.

While the Google Cloud OAuth app is unverified, Google allows at most **100 users ever** and shows a warning screen.

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
