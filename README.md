# Shop Follow-ups

A private, free web app for following up with interested buyers of several shops.
Your dad opens a link, picks a shop, uploads the shop's Excel file, checks the columns, reviews the message and clicks **Start sending**. Emails then go out automatically, one every few minutes, **from the Gmail account connected for that shop**, and every result is recorded.

- **Backend + hosting:** Google Apps Script (JavaScript, V8), standalone project
- **Interface:** HTML / CSS / browser JavaScript served by HTML Service
- **Database:** one Google Sheet with the tabs `Shops`, `Contacts`, `Templates`, `Campaigns`, `Send Log` (created by `setup`)
- **Email:** Gmail API through Google OAuth 2.0 — each shop's Gmail account is connected once (scope `gmail.send` only)
- **Excel reading:** SheetJS Community Edition 0.18.12, bundled locally in `src/SheetJS.html` (Apache 2.0, see `third-party/`)
- **WhatsApp:** free manual mode — a button opens WhatsApp with the message already written; a person presses Send

The full setup and usage guide is in the shared document that came with this project.

## Why the Gmail API instead of GmailApp

`GmailApp` can only send from the Google account that runs the script (and its "Send mail as" aliases). It cannot send from separately connected Gmail accounts. So only the sending component changed: `src/Senders.gs` connects each Gmail account with OAuth and sends through the Gmail API with `UrlFetchApp`. Everything else is unchanged.

## Where secrets live

| Secret | Stored in | Who can read it |
|---|---|---|
| OAuth client secret | Owner's `UserProperties` | Only code running as the owner |
| Each account's refresh/access token | Owner's `UserProperties` | Only code running as the owner (owner's session, owner's trigger) |
| Connected addresses + status | Script properties | Non-secret; shown in the app |

No token or secret is ever sent to the web page or written to the Google Sheet. The script is standalone, so people who can edit the Sheet cannot see or change the code.

## Folder layout

| Path | What it is |
|---|---|
| `src/Code.gs` | Setup, access checks, Sheet database layer, import, templates, campaigns, WhatsApp log |
| `src/Senders.gs` | Google OAuth connect / callback / refresh / test / disconnect, Gmail API sending |
| `src/Sending.gs` | The queue: the every-minute trigger that sends the next due email |
| `src/Index.html`, `src/Styles.html`, `src/App.html` | The web page (including the owner's Settings page) |
| `src/SheetJS.html` | Bundled Excel reader (no CDN) |
| `src/appsscript.json` | Manifest: time zone, scopes, web app settings |
| `config/appsscript.json` | Backup copy of the manifest (clasp may overwrite the one in `src/`) |
| `sample-contacts.xlsx` | Fake contacts for testing |
| `tests/` | Node tests with simulated Sheets / OAuth / Gmail API / triggers + browser click-through test |

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
node tests/test.js          # 42 checks against simulated Google services
pip install playwright && playwright install chromium
python3 tests/ui.py         # clicks through the real interface in a headless browser
```
