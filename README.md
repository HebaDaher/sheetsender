# SheetSender

A hosted web app for sending your own customers an **email** or an **official WhatsApp Business** message, using one Excel file per shop.

➡ **To put it online and use it, follow [SETUP.md](SETUP.md) step by step.**

Upload a file → choose a shop and recipients → choose your verified sender → write or attach the message → preview → activate automatic sending → track progress (queued / sent / delivered / failed), pause or cancel at any time.

> The previous "run on your Mac" version is kept in git under the tag `mac-version`.

## How it works

```
Browser (any device) ──HTTPS──► Render (free web service)
                                 src/server.js  pages, sign-in, uploads, webhooks
                                 src/worker.js  sends queued messages (every 10 s while awake
                                                + every minute via cron-job.org /cron/tick)
                                     │
                     ┌───────────────┼───────────────────────────┐
              Supabase Postgres   Your Gmail (SMTP,         Meta WhatsApp Cloud API
              (all app data)      app password)             (templates, media, webhooks)
```

- **No dependencies.** Plain Node.js 22 (built-in `crypto`, `tls`, `fetch`, `zlib`). The PostgreSQL client, SMTP client, MIME builder, Excel/CSV reader and multipart parser are small files in `src/`. Nothing to install, nothing to break at deploy time.
- **Accounts are isolated.** Every table carries `user_id` and every query is scoped by it (`routes/util.js → owned()`); other users' IDs return "not found".
- **Senders are yours.** Each account connects and verifies its own Gmail (6-digit code sent to that mailbox) and WhatsApp number (checked with Meta). Spreadsheet data is never used as the sender.
- **Consent first.** Only rows whose consent column says yes (`Yes`, `Opted in`, `نعم`, …) are eligible. Invalid emails/phones, duplicates, and opted-out people are skipped and the reason is shown.
- **Opt-out.** Emails carry RFC 8058 one-click unsubscribe headers plus a footer link. WhatsApp campaigns can only use templates with an opt-out (a "Stop promotions" button or STOP text); taps/replies arrive by signed webhook and are added to the account's opt-out list (and confirmed to the person).
- **No duplicate sends.** Activation happens once (row lock + status check + unique activation key); each person is one row per campaign (`UNIQUE(campaign_id, dedupe_key)`); the worker claims rows with `FOR UPDATE SKIP LOCKED` under an advisory lock; a row left in "sending" by a crash becomes "unknown" and is never resent automatically.
- **Provider limits are obeyed, never worked around.** Gmail 500/day (Workspace 2,000), WhatsApp portfolio messaging limit (unique people per moving 24 hours, read from `whatsapp_business_manager_messaging_limit`), throughput/rate errors (130429, 80007, 4) wait for Meta's `estimated_time_to_regain_access` or 4^X back-off, pair-rate 131056 retries only that person, 131049 is not retried, 131050 adds an opt-out, 131048 and spam blocks pause the campaign for review. No random delays.
- **Allowed hours** per account (default 09:00–18:00 Asia/Dubai).
- **Security.** Credentials encrypted with AES-256-GCM (key derived from `APP_SECRET`), scrypt password hashes, HttpOnly/SameSite session cookies, CSRF tokens on every form, strict Content-Security-Policy, login lockout and rate limits, signed unsubscribe links, Meta webhook signature check (`X-Hub-Signature-256`), private media URLs.

## Settings (environment variables)

| Name | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **Session pooler** connection string |
| `APP_SECRET` | yes | ≥ 32 random characters; never change it (the app shows a generated one on first start) |
| `SIGNUP_CODE` | recommended | code needed to create an account |
| `PUBLIC_URL` | no | detected from Render's `RENDER_EXTERNAL_URL` |
| `DATABASE_CA_CERT` | no | Supabase CA certificate to fully verify the database TLS certificate |
| `GRAPH_API_VERSION` | no | default `v26.0` |

## Files

| Path | Purpose |
|---|---|
| `src/server.js` | HTTP server, routing, CSRF, security headers, setup page |
| `src/routes/` | pages: `public` (sign-in, unsubscribe, webhooks, cron), `shops`, `senders`, `campaigns`, `account`, `media` |
| `src/campaigns.js` | eligibility, preview, personalisation, one-time activation |
| `src/worker.js` | sending loop, limits, hours, error handling |
| `src/providers/email.js`, `src/smtp.js`, `src/mime.js` | Gmail/SMTP sending |
| `src/providers/whatsapp.js` | WhatsApp Cloud API (templates, media, errors, webhooks) |
| `src/pg.js`, `src/db.js`, `src/schema.sql` | database client and tables |
| `src/excel.js`, `src/xlsx.js`, `src/contacts.js` | file reading, column guessing, email/phone/consent checks |
| `test/` | end-to-end tests with a real PostgreSQL, a mock Gmail (SMTP over TLS) and a mock WhatsApp API |

## Running the tests (developers)

Needs a local PostgreSQL and a self-signed TLS certificate for the mock mail server:

```bash
TEST_DATABASE_URL="postgres://postgres:PASSWORD@localhost:5432/postgres?sslmode=disable" \
TEST_TLS_KEY=server.key TEST_TLS_CERT=server.crt NODE_EXTRA_CA_CERTS=server.crt npm test
```
