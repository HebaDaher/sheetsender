# SheetSender — setup guide

Follow these steps once, in order. You only need a web browser — no command line and no laptop that stays on.
Everything here uses free plans. The only thing that costs money is WhatsApp itself: **Meta charges per WhatsApp message** to the card on your WhatsApp Business account. Email through Gmail is free.

| Part | Service (free plan) | What it does |
|---|---|---|
| Code | GitHub — `HebaDaher/sheetsender` | Stores the app's code |
| Database | Supabase | Stores accounts, shops, customer lists, campaigns |
| Hosting | Render | Runs the app at a secure `https://…onrender.com` link |
| Scheduler | cron-job.org | Wakes the app every minute so campaigns keep sending |
| Email | Your Gmail / Google Workspace | Sends the emails from **your** address |
| WhatsApp | Meta WhatsApp Business Platform (Cloud API) | Sends official WhatsApp template messages from **your** number |

Time needed: about 30 minutes, plus Meta's checks for WhatsApp.

---

## Step 1 — Create the database (Supabase)

1. Go to **supabase.com** → **Start your project** → sign in with GitHub.
2. Click **New project**.
   - **Name:** `sheetsender`
   - **Database Password:** click **Generate a password**, then click **Copy** and paste it somewhere safe (you need it in a minute). If you type your own, use **only letters and numbers**.
   - **Region:** **Central EU (Frankfurt)** — use Frankfurt for Render too, so they are close to each other.
   - Click **Create new project** and wait until it says the project is ready.
3. At the top of the project page click **Connect**.
4. Choose the **Session pooler** connection string (not "Direct connection" — Render cannot reach that one on the free plan). It looks like:
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`
5. Copy it and replace `[YOUR-PASSWORD]` (including the square brackets) with your database password.
   ✅ Check: the result contains `pooler.supabase.com:5432` and no square brackets.

Keep this text — it is your **DATABASE_URL**.

## Step 2 — Put the app online (Render)

1. Go to **render.com** → **Get Started** → sign up **with GitHub** (no card needed).
2. Click **New +** → **Web Service** → **Git Provider** → allow Render to see **HebaDaher/sheetsender** → select it → **Connect**.
3. Fill in:
   - **Name:** `sheetsender` (your link becomes `https://sheetsender-xxxx.onrender.com`)
   - **Region:** **Frankfurt (EU Central)**
   - **Branch:** `main`
   - **Runtime / Language:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
4. Under **Environment Variables** add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the text from Step 1 |
   | `SIGNUP_CODE` | a word only you know, e.g. `skate-2026-blue`. Anyone who wants an account needs it, so strangers cannot sign up. |
5. Click **Deploy Web Service**. Wait until the log says **Your service is live**.
6. Open your link (top left, `https://….onrender.com`). You will see **"Almost there — finish the hosting setup"** with a long random value for **APP_SECRET**.
7. Copy that value. In Render go to **Environment** → **Add Environment Variable** → Key `APP_SECRET`, Value = the copied text → **Save, rebuild, and deploy**.
   ⚠️ Never change or lose APP_SECRET — it locks the saved Gmail and WhatsApp passwords. Store a copy in your password manager.
8. When the deploy finishes, reload your link. You now see the **Log in** page.
   ✅ Check: opening `https://YOUR-LINK/health` shows `{"ok":true}`.

## Step 3 — Create your account

1. Open your link → **Create an account** → enter your name, email, a password of at least 10 characters, and the SIGNUP_CODE.
2. Go to **Settings** and check:
   - **Time zone:** Asia/Dubai
   - **Send only from 09:00 until 18:00** (the UAE telemarketing rules allow marketing messages through phone and social-media apps only in this window — keep it unless your lawyer says otherwise).
   - **Default country:** United Arab Emirates (+971)
   - Click **Save**.

## Step 4 — Keep campaigns running 24/7 (cron-job.org)

Render's free plan puts the app to sleep after 15 minutes without visitors. This free scheduler visits it every minute, so automatic campaigns keep sending even when nobody has the app open.

1. In the app, open **Settings** → copy the address under **"Keep campaigns running…"** (it ends with `/cron/tick?key=…`). Keep the key private.
2. Go to **cron-job.org** → **Sign up** (free) → confirm your email → **Create cronjob**.
   - **Title:** `SheetSender`
   - **URL:** paste the address
   - **Execution schedule:** **Every minute**
   - Under **Notifications**, tick **"execution of the cronjob fails"** (and keep "the cronjob will be disabled because of too many failures" on).
   - Click **Create**.
3. ✅ Check after 2–3 minutes: in cron-job.org the job's history shows status **200 OK** (the very first run may time out while Render wakes up — that's normal).

> Render gives each workspace **750 free hours per month**, which is enough for exactly one app running all month. If you keep another free Render app awake in the same Render account, the hours run out before the month ends and Render pauses both until the 1st.

## Step 5 — Connect your Gmail (email sender)

Customers will see emails coming from this address. The customer spreadsheet is never used as the sender.

1. In Google: **myaccount.google.com** → **Security** → turn on **2-Step Verification** (if it isn't already).
2. Open **myaccount.google.com/apppasswords** → App name `SheetSender` → **Create** → copy the 16-letter password (spaces don't matter).
3. In the app: **Senders** → **Connect an email address**:
   - **Name for this sender:** e.g. `GoSkate Gmail`
   - **Email address:** your Gmail address
   - **Name customers will see:** e.g. `GoSkate Dubai`
   - **App password:** paste it → **Test and send verification code**
4. Open that Gmail inbox, find the email **"SheetSender verification code: 123456"**, type the 6 digits in the app → **Verify**.
   ✅ Check: the sender shows a green **VERIFIED** badge and "Daily limit: 500 per 24 hours" (2,000 for Google Workspace addresses).

If you later change your Google password, Google cancels the app password — campaigns pause and the sender page asks for a new one (**Change the app password**).

## Step 6 — Connect WhatsApp (official WhatsApp Business Platform)

You need: a Meta Business portfolio (business.facebook.com), a phone number that can receive an SMS or call, and a payment card.
⚠️ The number you connect here **cannot at the same time be used in the normal WhatsApp or WhatsApp Business app**. Use a separate number (recommended), or delete the WhatsApp account on that phone first.

### 6a. Create the Meta app
1. Go to **developers.facebook.com** → **My Apps** → **Create app**.
2. Choose the use case **"Connect with customers through WhatsApp"** → select your business portfolio → **Create app**.
3. You land on **Customize use case → WhatsApp**. (To come back later: left menu **Use cases** → WhatsApp → **Customize**.)

### 6b. Add your real number and a payment method
1. Open **API Setup**. Click **Add phone number**, enter the display name (your shop/brand name) and the number, then verify it with the SMS/call code.
2. On the same page click **Add payment method** (or in **business.facebook.com → Settings → WhatsApp accounts → your account → Settings → Payment settings**) and add your card. Without it WhatsApp will not send business-started messages.
3. In **API Setup**, choose **your** number in the **From** list and copy two numbers:
   - **Phone number ID**
   - **WhatsApp Business Account ID**
4. Left menu **App settings → Basic**: copy the **App ID**, and click **Show** next to **App secret** and copy it.

### 6c. Create a permanent access token (System user)
1. Go to **business.facebook.com** → **Settings** → **Users → System users** → **Add** → name `sheetsender`, role **Admin** → **Create system user**.
2. With the system user selected click **Assign assets**:
   - **Apps** → your app → **Full control** (Manage app)
   - **WhatsApp accounts** → your WhatsApp account → **Full control**
   → **Save changes**.
3. Click **Generate new token** → choose your app → **Token expiration: Never** → tick **whatsapp_business_messaging** and **whatsapp_business_management** → **Generate token** → copy it (it is shown only once).

### 6d. Connect it in the app
1. **Senders** → **Connect a WhatsApp Business number** → paste the five values (Phone number ID, WhatsApp Business Account ID, App ID, App secret, token) → **Check and connect**.
2. The app checks everything with Meta and shows your number, quality rating and **messaging limit** (new businesses start at **250 different people per 24 hours**; after Meta business verification it rises to 2,000 and then grows automatically).

### 6e. Connect the webhook (opt-outs + delivery reports) — required
1. On the sender page, copy **Callback URL** and **Verify token**.
2. In developers.facebook.com → your app → **WhatsApp → Configuration** → **Webhook** → **Edit** → paste both → **Verify and save**.
3. Below, under **Webhook fields**, find **messages** → click **Subscribe**.
4. Reload the sender page. ✅ Check: the Webhook box shows **VERIFIED**.
5. Send a test: **Send a test to your own WhatsApp** → type your own number → pick `hello_world` → **Send test**.

### 6f. Create a template with an opt-out button
WhatsApp only lets businesses start a conversation with a **Meta-approved template**, and this app only sends templates that let people opt out.
1. Sender page → **Create a template**.
2. Name (e.g. `november_offer`), language, optional image/video, the text (use `{{1}}` where the customer's name goes, not at the very start or end), and keep the **Stop promotions** button (Arabic example: `إيقاف العروض`).
3. **Submit to Meta for approval**. Reload the sender page after a few minutes — when the template shows **ready**, you can use it.

## Step 7 — Upload a shop's Excel file

1. **Shops & files** → type the shop name → **Add shop**. Make one shop per branch/business.
2. **Upload** the Excel file (.xlsx) or CSV. The first row must be column titles, for example:

   | Name | Email | Phone | WhatsApp | Consent |
   |---|---|---|---|---|
   | Sara Ali | sara@example.com | 0501234567 | | Yes |
   | ليلى | | | +971562223333 | نعم |

3. On **Match the columns**, check each line (the app guesses) → **Save matching**.
   - **Consent** must say the person agreed, e.g. `Yes`, `Opted in`, `نعم`. Anything else — including an empty cell — means **no consent**, and that person is never messaged.
   - Phone numbers without `+971` are read as UAE numbers (change the country on that page if needed).
   - If you have separate permission for email and WhatsApp, map them to **Email consent** and **WhatsApp consent**.
4. The shop page shows how many people can receive email / WhatsApp and which rows are invalid.

Uploading a new file for a shop **replaces** that shop's list (the old list is deleted). People who unsubscribed stay blocked even if the new file says "Yes".

## Step 8 — Send a campaign

1. **Campaigns → New campaign** → choose the **shop** and the **sender** (your verified Gmail or WhatsApp number) → **Continue**.
2. Write the message:
   - **Email:** subject + text. Personalise with `{{first_name}}`, `{{name}}`, `{{shop}}` or any column title like `{{Branch}}`. Add images (shown in the email) or MP4 videos (attached).
   - **WhatsApp:** pick an approved template, choose what fills each `{{…}}` (e.g. *First name*), and attach the image/video if the template has one.
3. Recipients: **Everyone who can receive it** (default) or tick specific people. Keep **"Skip people who already received this exact message"** on.
4. **Save and preview** → check the sample message and the numbers (*will be sent* / *skipped and why*). Use **Send this test** to see it yourself.
5. Choose **Automatic sending**, tick the consent confirmation → **Activate campaign**.
6. The progress page updates by itself: **queued, sent, delivered, read, failed, skipped**. Use **Pause**, **Resume** or **Cancel campaign** any time. You can close the browser — sending continues.

## What the app does automatically (so you don't get blocked)

- **Never twice:** each person is queued once per campaign; activating again or double-clicking does nothing. If the server restarts in the middle of sending one message, that message is marked **check manually** instead of being sent again.
- **Consent and opt-outs:** people without consent, with invalid details, duplicates, and anyone on the **Opt-outs** list are skipped. Email unsubscribes (one-click link + Gmail's unsubscribe button) and WhatsApp *Stop promotions* / STOP replies are added to the list automatically, and the person gets a confirmation on WhatsApp.
- **Official limits:** Gmail 500/day (Workspace 2,000/day); WhatsApp's messaging limit (unique people per 24 hours, shared by your whole Meta business portfolio). When a limit is reached the campaign **waits** and continues by itself when the 24-hour window allows.
- **Provider instructions:** if Gmail or WhatsApp says "slow down" (e.g. WhatsApp error 130429), the app waits for the time WhatsApp gives, or Meta's recommended back-off, then continues. If WhatsApp restricts the number for spam reports (131048), or Gmail reports spam blocking, the campaign is **paused** for you to review — it does not push on. WhatsApp's per-person marketing limit (131049) is never retried early.
- **Allowed hours:** nothing is sent outside your Settings hours; campaigns resume when the window opens.
- There are **no random delays or tricks** — the app sends as fast as each provider officially allows and obeys every slow-down or pause.

## Your responsibilities (law and provider rules)

- Only upload people who **clearly agreed** to receive marketing from that shop on that channel, and keep proof of when/how they agreed (UAE PDPL and TDRA rules; Meta's WhatsApp Business Messaging Policy; Google's sender guidelines).
- Keep the 09:00–18:00 window for marketing messages in the UAE. Numbers on the UAE Do Not Call Registry (DNCR) are protected under the same rules — check with a legal adviser before marketing to them.
- Use honest content; marketing WhatsApp templates must be categorised as **Marketing**.
- This guide is practical help, not legal advice.

## Troubleshooting

| You see | Do this |
|---|---|
| "Almost there — finish the hosting setup" | Add the missing setting shown on the page in Render → Environment. |
| First page load takes ~1 minute | Render free plan was asleep. The cron-job (Step 4) prevents this. |
| Email sender: "Could not sign in" | Use an **App password**, not your Gmail password. Check 2-Step Verification is on. |
| Campaign "Waiting until …" | A daily/WhatsApp limit or a provider slow-down. It continues by itself — nothing to do. |
| Campaign paused with a reason | Read the reason, fix it (e.g. reconnect sender, check WhatsApp quality rating), then **Resume**. |
| WhatsApp messages "failed (131026)" | That number can't receive WhatsApp (not on WhatsApp, or old app). |
| "Check manually" (unknown) | The server restarted mid-send. Ask the customer or check the Gmail *Sent* folder; use **Retry** only if it didn't arrive. |
| Webhook not verified | Re-copy Callback URL + Verify token from the sender page; make sure the app is live. |

## Updating the app
When new code is pushed to GitHub (`main`), Render redeploys automatically. Your data stays in Supabase.
