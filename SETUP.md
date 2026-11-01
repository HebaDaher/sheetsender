# SheetSender — Setup Guide (step by step)

## Option A (free): run it on your Mac

No server, no card, no domain. SheetSender runs on your Mac and sends messages **while your Mac is on and the SheetSender window is open**. (It keeps the Mac from falling asleep by itself. If you close the laptop lid, it pauses, then catches up when you open it again.)

1. Put the project folder in **Documents** (download it from GitHub: green **Code** button → **Download ZIP**, then double-click the zip).
2. Open the folder and **double-click `Start SheetSender.command`**.
   - The first time, macOS may say it can't verify the file. **Right-click** it → **Open** → **Open**.
3. A window opens. The first time it downloads Node.js by itself (about 1 minute), then asks you to **choose a dashboard password** (10+ characters).
4. Your browser opens **http://localhost:3000** → sign in with that password.
5. Connect Gmail: follow **Step 4** below, but use this redirect address: `http://localhost:3000/oauth/google/callback` (no domain needed, no billing needed). Your settings file is at `~/Library/Application Support/SheetSender/settings.env` — put the Google Client ID and secret there, then close and re-open the SheetSender window.
6. Continue with **Step 7** (set up your shops).

> On your Mac, WhatsApp **sending** works, but "Delivered/Read" updates and STOP replies (Step 6d) need Option B, because Meta can't reach a laptop.

---

## Option B: run it 24/7 on a server

Follow the steps **in order**. Each step ends with a ✅ check so you know it worked before moving on.
Total time: about 2–3 hours the first time (most of it is waiting for Google / Meta screens).

**What you will end up with:** your own private website, e.g. `https://sender.yourdomain.com`, running 24/7 on a free Google Cloud server. It checks every shop's spreadsheet every minute and sends the emails and WhatsApp messages by itself — your computer and browser can be closed.

**What you need before you start**
- A domain you own (for example the one you use for your websites). You will add one subdomain like `sender.yourdomain.com`.
- A Google account with a payment card (Google requires a card for the server, but the "Always Free" server below costs $0 if you follow the settings exactly).
- The Gmail account you want to send from.
- A Meta Business account with your WhatsApp Business number (Step 6).
- `sheetsender.zip` (this app).

---

## Step 1 — Create the free server (Google Cloud)

1. Go to **console.cloud.google.com** and sign in.
2. Top bar → project picker → **New project** → name it `SheetSender` → **Create**. Make sure it is selected.
3. Left menu → **Compute Engine → VM instances**. If asked, click **Enable** and add billing.
4. Click **Create instance** and set **exactly**:
   - **Name:** `sheetsender`
   - **Region:** `us-central1 (Iowa)` ← must be us-central1, us-west1 or us-east1, otherwise it is not free
   - **Machine type:** `e2-micro`
   - **Boot disk → Change:** Operating system `Debian`, version `Debian GNU/Linux 12 (bookworm)`, disk type **Standard persistent disk**, size **30 GB** → **Select**
   - **Firewall / Networking:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**
5. Click **Create**. Wait for the green tick.
6. Copy the **External IP** shown next to the server (e.g. `34.68.12.34`).

> Cost: the e2-micro server and 30 GB standard disk are in Google's Always Free tier. The free tier includes 1 GB of outgoing data per month; if you email large attachments to many people you may go above it and pay a few cents per extra GB. Sending big files as download links (automatic above 18 MB) keeps this low. **Do not stop/start the server** — the IP address can change when you do.

✅ **Check:** the server shows a green tick and an External IP.

## Step 2 — Point your subdomain to the server

1. Open the DNS settings where your domain is managed.
2. Add a record: **Type** `A`, **Name/Host** `sender`, **Value** = the External IP from Step 1, TTL default.
3. Save. It usually works within 5–30 minutes.

✅ **Check:** open **dnschecker.org**, type `sender.yourdomain.com`, choose **A** → it shows your server IP.

## Step 3 — Install the app on the server

1. In Google Cloud → VM instances → click **SSH** next to `sheetsender`. A black terminal window opens.
2. Copy-paste these lines **one block at a time** and press Enter (wait for each to finish):

```bash
sudo apt update && sudo apt install -y curl unzip sqlite3 gnupg debian-keyring debian-archive-keyring apt-transport-https
```
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs && node -v
```
(The last line must print `v22.13` or higher.)
```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

3. Upload the app: in the SSH window click the **Upload file** button (top right, ⬆ icon) → choose `sheetsender.zip`. Then run:
```bash
sudo useradd --system --no-create-home sheetsender
sudo unzip -o ~/sheetsender.zip -d /opt/
sudo chown -R sheetsender:sheetsender /opt/sheetsender
cd /opt/sheetsender && node scripts/gen-secrets.js
```
4. The last command prints three lines (`SESSION_SECRET=…`, `ENCRYPTION_KEY=…`, `WHATSAPP_VERIFY_TOKEN=…`). **Copy them into a safe note** (e.g. your password manager).
5. Create the settings file:
```bash
sudo cp .env.example .env && sudo nano .env
```
   In the editor fill in:
   - `BASE_URL=https://sender.yourdomain.com` (your real subdomain)
   - `ADMIN_PASSWORD=` a strong password you will use to sign in
   - `SESSION_SECRET=`, `ENCRYPTION_KEY=`, `WHATSAPP_VERIFY_TOKEN=` — paste the three values from step 4
   - Leave the Google / Microsoft / Meta lines empty for now.

   Save: press `Ctrl+O`, `Enter`, then `Ctrl+X`. Then protect the file:
```bash
sudo chown sheetsender:sheetsender .env && sudo chmod 600 .env
```
6. Start the app and the background worker (they restart automatically after a reboot or crash):
```bash
sudo cp deploy/sheetsender-web.service deploy/sheetsender-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sheetsender-web sheetsender-worker
```
7. Turn on HTTPS:
```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo sed -i 's/sender.yourdomain.com/YOUR-SUBDOMAIN-HERE/' /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
   (Replace `YOUR-SUBDOMAIN-HERE` with e.g. `sender.example.com` before pressing Enter.)

✅ **Check:** open `https://sender.yourdomain.com` → you see the **Sign in** page with a padlock 🔒 in the address bar. Sign in with your ADMIN_PASSWORD. The dashboard must **not** show "The background service is not running".

> **Important — keep ENCRYPTION_KEY safe.** All connected account tokens are encrypted with it. If it is lost or changed you must reconnect every account.

**Optional now:** you can already try everything with the built-in **Demo sheet** (Step 7, choose "Demo sheet") before connecting real accounts. Messages show as **SIMULATED** until real accounts are connected and tested.

---

## Step 4 — Google: Gmail + Google Sheets

1. **console.cloud.google.com** → same `SheetSender` project.
2. Left menu → **APIs & Services → Library**. Search and **Enable** both: **Gmail API** and **Google Sheets API**.
3. Left menu → **Google Auth Platform** (also called "OAuth consent screen") → **Get started**:
   - App name `SheetSender`, user support email = your email → Next
   - Audience: **External** → Next
   - Contact email = your email → Next → agree → **Create**
4. **Branding** tab → **Authorized domains** → add `yourdomain.com` (without `sender.`) → Save.
5. **Audience** tab → **Publish app** → Confirm. Status must say **In production**.
   ⚠️ Don't skip this: while the app is in "Testing", Google disconnects Gmail every 7 days.
6. **Clients** tab → **Create client**:
   - Application type: **Web application**, name `SheetSender`
   - **Authorized redirect URIs** → Add URI: `https://sender.yourdomain.com/oauth/google/callback`
   - **Create**. Copy the **Client ID** and **Client secret**.
7. On the server (SSH):
```bash
cd /opt/sheetsender && sudo nano .env
```
   Fill `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`, save (`Ctrl+O`, `Enter`, `Ctrl+X`), then restart:
```bash
sudo systemctl restart sheetsender-web sheetsender-worker
```
8. In the app → **Connections** → **+ Connect Google account** → choose your Gmail.
   - Google will show **"Google hasn't verified this app"**. This is expected because it is your own private app: click **Advanced → Go to SheetSender (unsafe)**.
   - On the permissions screen **tick every box** (send email + Google Sheets) → Continue.

✅ **Check:** Connections shows your Gmail with **Connected ✓**. Click **Test** → green message.

> Gmail limits: about **500 emails/day** on a free Gmail account and about **2,000/day** on Google Workspace. The app stops at `GMAIL_DAILY_LIMIT` (400 by default) and continues automatically the next day. If you use Google Workspace, set `GMAIL_DAILY_LIMIT=1800` in `.env`.

## Step 5 — Microsoft: Excel files on OneDrive (skip if you only use Google Sheets)

1. Go to **entra.microsoft.com** and sign in with the Microsoft account that owns the Excel files (if asked, create the free Azure account — app registrations cost nothing).
2. **Applications → App registrations → New registration**:
   - Name `SheetSender`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: platform **Web**, `https://sender.yourdomain.com/oauth/microsoft/callback`
   - **Register**. Copy the **Application (client) ID**.
3. **Certificates & secrets → New client secret** → expires **24 months** → Add → copy the **Value** immediately (it is shown once). Put a reminder in your calendar 23 months from now to create a new one.
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** → tick `Files.ReadWrite`, `offline_access`, `User.Read` → **Add permissions**.
5. On the server: `sudo nano /opt/sheetsender/.env` → fill `MICROSOFT_CLIENT_ID=` and `MICROSOFT_CLIENT_SECRET=` → save → `sudo systemctl restart sheetsender-web sheetsender-worker`
6. In the app → **Connections → + Connect Microsoft account**.

✅ **Check:** Connections shows the Microsoft account **Connected ✓** → **Test** is green.

> **Excel files must be .xlsx and stored in OneDrive.** A file that only exists on your computer can't be reached by the server. Move it into your OneDrive folder (it stays on your computer and syncs automatically). Then in OneDrive right-click the file → **Share → Copy link** and paste that link into the app.
> On a **personal** OneDrive, Microsoft doesn't allow cell-by-cell updates, so the app updates the status columns by re-saving the file safely (it never overwrites changes you made in the meantime — it just tries again on the next check). On **OneDrive for Business / SharePoint** cells are updated directly.

## Step 6 — WhatsApp Business (official Meta Cloud API)

You need: a Meta Business account (business.facebook.com) and a phone number for WhatsApp Business **that is not active in the WhatsApp app** (or migrate it).

**6a. Create the Meta app**
1. **developers.facebook.com → My Apps → Create app** → use case **Connect with customers through WhatsApp** → choose your business portfolio → Create.
2. In the app → **WhatsApp → API Setup**: click **Add phone number** and register your real business number (verify by SMS). Pick the display name carefully — Meta reviews it.
3. Still on **API Setup**, select your real number and copy:
   - **Phone number ID**
   - **WhatsApp Business Account ID**
4. **App settings → Basic**: copy the **App secret** (click Show). Also fill **Privacy policy URL** (a page on your website) → Save.
5. Top of the app dashboard → switch **App mode** to **Live** (needed to receive delivery updates for real numbers).
6. **business.facebook.com → Business settings → Accounts → WhatsApp accounts** → your account → **Payment method**: add a card. (Meta charges for template messages per its pricing; the app has no extra cost.)

**6b. Create a permanent token** (the "temporary" token on API Setup stops working after 24 hours — don't use it)
1. **business.facebook.com → Business settings → Users → System users → Add** → name `sheetsender`, role **Admin** → Create.
2. Select it → **Assign assets**: **Apps** → your app → **Full control**; **WhatsApp accounts** → your account → **Full control** → Save.
3. **Generate new token** → app = your app → **Token expiration: Never** → permissions: tick `whatsapp_business_messaging` and `whatsapp_business_management` → Generate → **copy the token**.

**6c. Connect in the app**
1. On the server: `sudo nano /opt/sheetsender/.env` → fill `META_APP_SECRET=` (from 6a-4) → save → `sudo systemctl restart sheetsender-web sheetsender-worker`
2. App → **Connections → + Connect WhatsApp Business account** → paste Phone number ID, WhatsApp Business Account ID and the permanent token → **Connect & test**.

**6d. Delivery updates and STOP replies (webhook)**
1. developers.facebook.com → your app → **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://sender.yourdomain.com/webhooks/whatsapp`
   - Verify token: your `WHATSAPP_VERIFY_TOKEN` value
   - **Verify and save**
2. Under **Webhook fields** → **messages** → **Subscribe**.

**6e. Message templates** (WhatsApp only lets businesses start a chat with a template that Meta approved)
1. **business.facebook.com → WhatsApp Manager → Message templates → Create template**.
2. Category: **Marketing** for offers/welcome promos, **Utility** for confirmations. Language: the language you write in (Arabic = `ar`, English = `en`).
3. Body example: `Hi {{1}}, thank you for your interest in {{2}}! Our team will contact you shortly.` Add sample values when asked.
4. Optional **header**: image, video or document (you choose the file later in the app).
5. Submit. Approval usually takes minutes to a few hours.

✅ **Check:** Connections shows WhatsApp **Connected ✓** with your number and quality rating. After approval, your template appears in **Message Templates → WhatsApp**.

> WhatsApp rules the app follows for you: business-initiated messages always use an approved template; extra files are sent as separate messages **only** if the customer messaged you in the last 24 hours, otherwise they are included as links through `{{media_links}}`; contacts who reply **STOP** are opted out automatically; only message people who gave consent (Meta can restrict numbers that get blocked or reported).

---

## Step 7 — Set up your first shop (in the app)

1. **Connections → Your test contact**: enter **your own** email and WhatsApp number → Save. Test mode sends only to these.
2. **Shops → + Add New Shop** → business name (it appears in every email) → Create.
3. **1. Spreadsheet**: choose Google Sheets or Excel on OneDrive → choose the account → paste the link → **Connect spreadsheet**. If the file has several tabs, choose the tab → **Use this tab**.
   Your sheet needs a header row with column titles, e.g. `Name | Email | Phone Number | Consent Status`.
4. **2. Match your columns**: check each field points at the right column → **Save column matching**. Status columns (Email Status, WhatsApp Status, Sent At, Error Details) are added to your sheet automatically.
5. **3. Accounts**: pick the Gmail and WhatsApp accounts (all shops can share the same ones).
6. **Message Templates**:
   - Email: subject + message, use `{{name}}`, `{{business_name}}` etc. → **Preview** → **Save** → **Send test to me** → check your inbox.
   - WhatsApp: choose the approved template → fill each variable (e.g. variable 1 = `{{name}}`, variable 2 = `{{business_name}}`) → choose the header file if the template has one → **Preview** → **Save** → **Send test to my WhatsApp** → check your phone.
7. **Attachments**: upload files once, tick which ones go with Email and which with WhatsApp, use ↑ ↓ to set the order.
8. **Automation Settings**: Email / WhatsApp / both, delay, business hours, consent rule, conditions → **Save settings**.
9. Dashboard → **▶ Start** → **Test mode** → Start. Add a row to the sheet with your own details. Within about a minute you get the message(s) and the sheet shows **"Sent (TEST – sent to you)"**.
10. When everything looks right: **▶ Start → Live**. From now on, every new eligible row is messaged automatically.

Repeat steps 2–10 for each shop. Each shop has its own sheet, templates, files, rules and Start/Pause.

## Step 8 — Daily use

- **Dashboard**: each card shows sheet + account status, contacts, Sent / Pending / Need action, and Start/Pause. **Pause all shops** stops everything instantly.
- **Activity Log**: every attempt and its result. Choose a shop to see failed messages and **Retry** them — retry never re-sends a message that already went out.
- Red banners tell you when something needs attention (e.g. Gmail disconnected). The same alert is emailed to your test-contact email.
- Rows that already existed when you clicked Start are **not** messaged (unless you tick "Also message rows already in the sheet").
- Editing a row never re-sends (unless you turn that on in Automation Settings). If a row was skipped (e.g. no consent) and you fix it, it is sent then.
- A contact is never messaged twice by the same shop for the same campaign, even if they appear twice.

## Step 9 — Backups (do this once)

```bash
sudo cp /opt/sheetsender/deploy/backup.sh /usr/local/bin/sheetsender-backup && echo '30 2 * * * root /usr/local/bin/sheetsender-backup' | sudo tee /etc/cron.d/sheetsender-backup
```
This saves the database and files every night at 02:30 (server time) into `/opt/sheetsender-backups`, keeping 14 days. Also keep your `.env` values (especially **ENCRYPTION_KEY**) in your password manager.

## Step 10 — Troubleshooting

| You see | Do this |
|---|---|
| "The background service is not running" | SSH → `sudo systemctl restart sheetsender-worker` → `sudo journalctl -u sheetsender-worker -n 50` |
| Site doesn't open / no padlock | Check Step 2 DNS; then `sudo systemctl status caddy` |
| Gmail "needs attention" | Connections → Reconnect. If it happens every 7 days, the Google app is still in "Testing" (Step 4.5) |
| WhatsApp "needs attention" / code 190 | The token was revoked. Create a new permanent token (Step 6b) → Connections → Update token |
| WhatsApp failed "code 131030" | You are using Meta's test number — use your real number, or add the recipient to the test number's allowed list |
| WhatsApp failed "code 131026" | That number is not on WhatsApp or can't receive messages — nothing to fix in the app |
| WhatsApp failed "code 132000 / 132001" | Template variables don't match or template not approved — fix on Message Templates and save again |
| "Skipped – no consent" | The Consent column is empty/No. Change it to Yes — the row is then sent automatically |
| Spreadsheet error | Shop settings → check the link, tab and header row → "Check sheet now" |

**Change a setting in .env** → always run `sudo systemctl restart sheetsender-web sheetsender-worker` afterwards.

**Update the app** → upload the new zip, then:
```bash
sudo systemctl stop sheetsender-worker sheetsender-web
sudo unzip -o ~/sheetsender.zip -d /opt/ && sudo chown -R sheetsender:sheetsender /opt/sheetsender
sudo systemctl start sheetsender-web sheetsender-worker
```
(Your `.env` and `data` folder are kept.)
