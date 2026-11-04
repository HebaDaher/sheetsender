#!/usr/bin/env python3
"""
Shop Follow-ups — WhatsApp Sender (runs on your Mac).

Sends the messages from a send list made by the Shop Follow-ups app ("Download the send list"),
one person at a time through WhatsApp Web, slowly, to lower the risk of the number being blocked:

  * waits 5–7 minutes between messages (never less than 5 by default),
  * at most 30 messages per day for this phone number (counted across all send lists),
  * only between 9:00 and 21:00 (your Mac's local time),
  * stops by itself after 3 problems in a row or if WhatsApp logs out,
  * remembers what it already sent: running it again continues where it stopped, nobody gets a message twice.

It writes "<send list>-results.json" next to the send list. Upload that file in the app (WhatsApp tab → Upload results).

Usage:  python3 whatsapp_sender.py [path/to/whatsapp-job-....json]
        (without a path it uses the newest whatsapp-job-*.json in your Downloads folder)
"""

import json
import os
import random
import re
import signal
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------- settings
HOME = Path.home()
DATA_DIR = HOME / ".shop-followups"
PROFILE_DIR = DATA_DIR / "whatsapp-profile"          # keeps you logged in to WhatsApp Web between runs
LEDGER_FILE = DATA_DIR / "whatsapp-ledger.json"       # every message sent from this Mac (for the daily limit)
WA_URL = os.environ.get("SF_WA_URL", "https://web.whatsapp.com").rstrip("/")
TIME_SCALE = float(os.environ.get("SF_TIME_SCALE", "1"))  # tests only: 0.001 makes waits 1000x shorter

MIN_DELAY_MINUTES = 3          # never wait less than this between messages (the app's default is 5)
MAX_EXTRA = 0.40               # with "Random extra wait" on, each wait is up to 40% longer, at random
DAILY_CAP = 30                 # default messages per day from this phone number (the app can set 1-60)
MAX_DAILY_CAP = 60
START_HOUR, END_HOUR = 9, 21   # sending hours (local time)
MAX_PROBLEMS_IN_A_ROW = 3
LOGIN_TIMEOUT_S = int(os.environ.get("SF_LOGIN_TIMEOUT", "180"))

# WhatsApp Web page elements (WhatsApp changes its page from time to time; update here if needed)
SEL_LOGGED_IN = "#pane-side, [aria-label='Chat list'], [data-testid='chat-list']"
SEL_QR = "canvas[aria-label*='Scan'], [data-ref] canvas, div[data-ref]"
SEL_COMPOSE = "footer div[contenteditable='true'], div[contenteditable='true'][data-tab='10']"
SEL_SEND_BUTTON = ("[data-icon='send'], [data-icon='wds-ic-send-filled'], button[aria-label='Send'], "
                   "button[aria-label='إرسال'], [data-testid='send'], [data-testid='compose-btn-send']")
# Photos and videos: the attach (📎/+) button, the file box of "Photos & videos", the caption box and Send in the preview.
SEL_ATTACH = ("[data-icon='plus-rounded'], [data-icon='plus'], [data-icon='attach-menu-plus'], [data-icon='clip'], "
              "button[aria-label='Attach'], [title='Attach'], button[aria-label='إرفاق'], [title='إرفاق']")
SEL_MEDIA_INPUT = "input[type='file'][accept*='image'], input[type='file'][accept*='video']"
ATTACH_MENU_TEXTS = ["Photos & videos", "Photos & Videos", "Photos and videos", "الصور والفيديوهات", "صور وفيديوهات"]
SEL_CAPTION = ("div[contenteditable='true'][aria-label*='caption' i], div[contenteditable='true'][aria-placeholder*='caption' i], "
               "div[contenteditable='true'][aria-label*='تعليق'], div[contenteditable='true'][data-tab='undefined']")
SEL_MEDIA_SEND = ("div[role='button'][aria-label='Send'], div[role='button'][aria-label='إرسال'], "
                  "[data-icon='wds-ic-send-filled'], [data-icon='send']")
SETTLE_S = 3  # seconds the chat must stay open with the text before sending
INVALID_TEXTS = ["phone number shared via url is invalid", "رقم الهاتف الذي تمت مشاركته عبر الرابط غير صالح"]

stop_requested = False


def plural(n, one, many):
    return f"{n} {one if n == 1 else many}"


def say(msg=""):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def sleep_s(seconds):
    """Sleeps in small steps so Ctrl+C stops quickly."""
    end = time.time() + seconds * TIME_SCALE
    while time.time() < end and not stop_requested:
        time.sleep(min(1.0, max(0.0, end - time.time())))


def on_ctrl_c(signum, frame):
    global stop_requested
    if stop_requested:
        sys.exit(1)
    stop_requested = True
    print("\nStopping after the current step… (press Ctrl+C again to quit immediately)", flush=True)


# ---------------------------------------------------------------- files
def find_job(arg):
    if arg:
        p = Path(arg).expanduser()
        if not p.exists():
            sys.exit(f"File not found: {p}")
        return p
    jobs = sorted((HOME / "Downloads").glob("whatsapp-job-*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    jobs = [j for j in jobs if not j.name.endswith("-results.json")]
    if not jobs:
        sys.exit("No send list found in Downloads. In the app open the WhatsApp tab and click 'Download the send list'.")
    return jobs[0]


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def results_path(job_path):
    return job_path.with_name(job_path.stem + "-results.json")


MEDIA_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "video/mp4": ".mp4", "video/3gpp": ".3gp"}


def validate_media(media):
    """The photo/video of a send list (or None). Only the 4 kinds WhatsApp takes, at most 16 MB."""
    if not media:
        return None
    if not isinstance(media, dict) or media.get("mime") not in MEDIA_TYPES or not re.fullmatch(r"[A-Za-z0-9_-]{4,40}", str(media.get("media_id", ""))):
        raise ValueError("The photo or video of this send list is not valid.")
    size = int(media.get("size") or 0)
    if not (0 < size <= 16 * 1024 * 1024):
        raise ValueError("The photo or video of this send list is too big.")
    return {**media, "size": size}


def media_file_name(media):
    """Where the helper keeps a downloaded photo/video (the name comes from the app's id, never from the file name)."""
    return str(media["media_id"]) + MEDIA_TYPES[media["mime"]]


def validate_job(job):
    if not isinstance(job, dict) or job.get("kind") != "shop-followups-whatsapp-job" or not isinstance(job.get("items"), list):
        raise ValueError("This file is not a Shop Follow-ups send list.")
    validate_media(job.get("media"))
    good = []
    for it in job["items"]:
        phone = re.sub(r"\D", "", str(it.get("phone", "")))
        if it.get("contact_id") and 8 <= len(phone) <= 15 and str(it.get("text", "")).strip():
            good.append({**it, "phone": phone})
    return good


def sent_today(ledger):
    today = datetime.now().strftime("%Y-%m-%d")
    return sum(1 for e in ledger.get("sent", []) if str(e.get("at", "")).startswith(today))


# ---------------------------------------------------------------- WhatsApp Web
def wait_for_login(page):
    say("Opening WhatsApp Web…")
    page.goto(WA_URL + "/", wait_until="domcontentloaded")
    deadline = time.time() + LOGIN_TIMEOUT_S
    told = False
    while time.time() < deadline and not stop_requested:
        if page.query_selector(SEL_LOGGED_IN):
            say("Logged in to WhatsApp.")
            return True
        if not told and page.query_selector(SEL_QR):
            say("Scan the QR code in the browser window with the phone: WhatsApp → Settings → Linked devices → Link a device.")
            told = True
        time.sleep(1)
    return False


def _safe(fn, default=None):
    """WhatsApp Web reloads itself while a chat opens; reading the page during that throws. Treat it as 'not yet'."""
    try:
        return fn()
    except Exception:
        return default


def _box_text(page):
    box = _safe(lambda: page.query_selector(SEL_COMPOSE))
    if box is None:
        return None
    t = _safe(lambda: box.inner_text())
    return None if t is None else t.strip()


def _wait_box_empty(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if _box_text(page) == "":
            return True
        time.sleep(0.4)
    return False


def _problem_screenshot(page, phone):
    try:
        folder = DATA_DIR / "problems"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{phone[-4:]}.png"
        page.screenshot(path=str(path))
        return path
    except Exception:
        return None


def send_one(page, phone, text, media_path=None):
    """Returns ('sent', '') or ('failed', reason) or ('logged_out', reason). Never raises because of page reloads."""
    if media_path:
        return send_media(page, phone, text, media_path)
    url = f"{WA_URL}/send?phone={phone}&text={urllib.parse.quote(text)}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
    except Exception as e:
        return "failed", f"WhatsApp did not load ({str(e).splitlines()[0][:80]})"

    # Wait until the chat is open with the message written in the box, and stays like that for a moment
    # (WhatsApp Web often reloads once while opening a chat from a link).
    deadline = time.time() + 90
    ready_since = None
    while True:
        if time.time() > deadline:
            _problem_screenshot(page, phone)
            return "failed", "WhatsApp did not open the chat in time"
        body = (_safe(lambda: page.inner_text("body"), "") or "").lower()
        if any(t in body for t in INVALID_TEXTS):
            return "failed", "This number is not on WhatsApp"
        if _safe(lambda: page.query_selector(SEL_QR)) and not _safe(lambda: page.query_selector(SEL_LOGGED_IN)):
            return "logged_out", "WhatsApp Web logged out"
        if _box_text(page):
            ready_since = ready_since or time.time()
            if time.time() - ready_since >= SETTLE_S * TIME_SCALE:
                break
        else:
            ready_since = None
        time.sleep(0.5)

    time.sleep(random.uniform(1, 3) * TIME_SCALE)  # a short human-like pause
    # Press Enter in the box; if WhatsApp did not take it, click the Send button. Sent = the box is empty again.
    # If WhatsApp reloads right after a press, the box fills up again from the link even though the message may
    # already be sent: then it is NEVER pressed again (no double messages); the chat is checked instead.
    for _ in range(3):
        for action in ("enter", "button"):
            target = _safe(lambda: page.query_selector(SEL_COMPOSE if action == "enter" else SEL_SEND_BUTTON))
            if target is None:
                continue
            _safe(lambda: page.evaluate("window.__sfPressed = true"))
            if action == "enter":
                _safe(lambda: target.click())
                _safe(lambda: page.keyboard.press("Enter"))
            else:
                _safe(lambda: target.click())
            if _wait_box_empty(page, 8):
                time.sleep(2 * TIME_SCALE)  # let WhatsApp hand the message to the phone
                return "sent", ""
            if not _safe(lambda: page.evaluate("window.__sfPressed === true"), False):
                _wait_box_has_text(page, 30)
                if _in_chat(page, text):
                    return "sent", ""
                return "failed", ("WhatsApp reloaded just as the message was being sent. To avoid sending it twice it was not "
                                  "sent again — check this chat on the phone")
        if _box_text(page) is None:  # the chat disappeared (WhatsApp reloaded): wait for it to come back
            _wait_box_has_text(page, 30)
    shot = _problem_screenshot(page, phone)
    return "failed", "The message stayed in the box (not sent)" + (f" — picture saved: {shot.name}" if shot else "")


def _first(page, selector):
    for sel in selector.split(", "):
        el = _safe(lambda: page.query_selector(sel))
        if el is not None:
            return el
    return None


def _out_count(page):
    return len(_safe(lambda: page.query_selector_all("div.message-out"), []) or [])


def send_media(page, phone, text, media_path):
    """Sends a photo or video with the text as its caption. Same promise as send_one: never sends twice."""
    url = f"{WA_URL}/send?phone={phone}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
    except Exception as e:
        return "failed", f"WhatsApp did not load ({str(e).splitlines()[0][:80]})"
    # 1. The chat is open (the message box is there) and stays open for a moment.
    deadline = time.time() + 90
    ready_since = None
    while True:
        if time.time() > deadline:
            _problem_screenshot(page, phone)
            return "failed", "WhatsApp did not open the chat in time"
        body = (_safe(lambda: page.inner_text("body"), "") or "").lower()
        if any(t in body for t in INVALID_TEXTS):
            return "failed", "This number is not on WhatsApp"
        if _safe(lambda: page.query_selector(SEL_QR)) and not _safe(lambda: page.query_selector(SEL_LOGGED_IN)):
            return "logged_out", "WhatsApp Web logged out"
        if _box_text(page) is not None:
            ready_since = ready_since or time.time()
            if time.time() - ready_since >= SETTLE_S * TIME_SCALE:
                break
        else:
            ready_since = None
        time.sleep(0.5)
    time.sleep(random.uniform(1, 2) * TIME_SCALE)
    before = _out_count(page)

    # 2. Attach the file: 📎 / + button, then the "Photos & videos" file box.
    attach = _first(page, SEL_ATTACH)
    if attach is None:
        _problem_screenshot(page, phone)
        return "failed", "Could not find WhatsApp's attach (📎) button — WhatsApp Web may have changed"
    if not _safe(lambda: (attach.click(timeout=5000), True)[1], False):  # an icon inside the button: click the button
        _safe(lambda: attach.evaluate("e => (e.closest('button,[role=button]') || e).click()"))
    attached = False
    end = time.time() + 10
    while time.time() < end and not attached:
        inp = _first(page, SEL_MEDIA_INPUT)
        if inp is not None and _safe(lambda: (inp.set_input_files(str(media_path)), True)[1], False):
            attached = True
            break
        for label in ATTACH_MENU_TEXTS:  # some versions only open the file box from the menu item
            item = _safe(lambda: page.get_by_text(label, exact=True).first)
            if item is not None and _safe(lambda: item.is_visible(), False):
                try:
                    with page.expect_file_chooser(timeout=5000) as fc:
                        item.click()
                    fc.value.set_files(str(media_path))
                    attached = True
                except Exception:
                    pass
                break
        time.sleep(0.5)
    if not attached:
        _problem_screenshot(page, phone)
        return "failed", "Could not attach the photo or video — WhatsApp Web may have changed"

    # 3. The preview opens with a caption box: write the text there (new lines with Shift+Enter).
    cap = None
    end = time.time() + 60
    while time.time() < end and cap is None:
        cap = _first(page, SEL_CAPTION)
        if cap is None:
            time.sleep(0.5)
    if cap is None:
        _problem_screenshot(page, phone)
        _safe(lambda: page.keyboard.press("Escape"))
        return "failed", "WhatsApp did not show the photo/video preview"
    _safe(lambda: cap.click(timeout=5000))
    lines = str(text).split("\n")
    for i, line in enumerate(lines):
        if line:
            _safe(lambda: page.keyboard.insert_text(line))
        if i < len(lines) - 1:
            _safe(lambda: page.keyboard.press("Shift+Enter"))
    time.sleep(random.uniform(1, 2) * TIME_SCALE)
    want = " ".join(str(text).split())
    got = " ".join((_safe(lambda: cap.inner_text(), "") or "").split())
    if want and want[:40] not in got:
        _problem_screenshot(page, phone)
        _safe(lambda: page.keyboard.press("Escape"))
        return "failed", "The caption could not be written under the photo/video (not sent)"

    # 4. Send ONCE (Enter; the Send button only if the preview is still open with the caption, i.e. Enter was ignored).
    _safe(lambda: page.evaluate("window.__sfPressed = true"))
    _safe(lambda: page.keyboard.press("Enter"))

    def preview_closed():
        return _first(page, SEL_CAPTION) is None

    end = time.time() + 15
    while time.time() < end and not preview_closed():
        time.sleep(0.5)
    if not preview_closed() and _safe(lambda: page.evaluate("window.__sfPressed === true"), False):
        btn = _first(page, SEL_MEDIA_SEND)
        if btn is not None:
            if not _safe(lambda: (btn.click(timeout=5000), True)[1], False):
                _safe(lambda: btn.evaluate("e => (e.closest('button,[role=button]') || e).click()"))
        end = time.time() + 120  # a video can take a while to prepare
        while time.time() < end and not preview_closed():
            time.sleep(0.5)
    if not _safe(lambda: page.evaluate("window.__sfPressed === true"), False):
        # WhatsApp reloaded: never press again; look in the chat instead.
        end = time.time() + 20
        while time.time() < end:
            if _in_chat(page, text):
                return "sent", ""
            time.sleep(0.5)
        return "failed", ("WhatsApp reloaded just as the photo/video was being sent. To avoid sending it twice it was not "
                          "sent again — check this chat on the phone")
    if not preview_closed():
        shot = _problem_screenshot(page, phone)
        _safe(lambda: page.keyboard.press("Escape"))
        return "failed", "The photo/video stayed in the preview (not sent)" + (f" — picture saved: {shot.name}" if shot else "")
    # 5. The preview closed: the message is on its way. Give WhatsApp time to hand it to the phone (videos upload first).
    end = time.time() + 60
    while time.time() < end and _out_count(page) <= before and not _in_chat(page, text):
        time.sleep(0.5)
    time.sleep(2 * TIME_SCALE)
    return "sent", ""


def _in_chat(page, text):
    """Is this message already in the open chat as a sent message?"""
    want = " ".join(str(text).split())[:60]
    for el in _safe(lambda: page.query_selector_all("div.message-out"), []) or []:
        got = " ".join((_safe(lambda: el.inner_text(), "") or "").split())
        if want and want in got:
            return True
    return False


def _wait_box_has_text(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if _box_text(page):
            return True
        time.sleep(0.5)
    return False


# ---------------------------------------------------------------- main
def main():
    signal.signal(signal.SIGINT, on_ctrl_c)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    job_path = find_job(sys.argv[1] if len(sys.argv) > 1 else "")
    job = load_json(job_path, None)
    try:
        items = validate_job(job)
    except ValueError as e:
        sys.exit(str(e))
    media_path = None
    if job.get("media"):
        # The photo/video must be next to the send list, with its original name (the helper downloads it by itself).
        try:
            m = validate_media(job["media"])
        except ValueError as e:
            sys.exit(str(e))
        fname = Path(str(m.get("name", "") or "")).name
        candidate = job_path.with_name(fname) if fname else None
        good = bool(candidate) and candidate.is_file() and candidate.stat().st_size == m["size"]
        if good and m.get("md5"):
            import hashlib
            good = hashlib.md5(candidate.read_bytes()).hexdigest() == m["md5"]
        if not good:
            sys.exit(f"This send list has a {'video' if m.get('kind') == 'video' else 'photo'}: put '{m.get('name')}' in the same folder "
                     f"as the send list ({job_path.parent}), or press 'Start sending' in the app instead.")
        media_path = candidate
    rules = job.get("rules") or {}
    delay = max(MIN_DELAY_MINUTES, float(rules.get("delayMinutes", 5)))
    cap = max(1, min(MAX_DAILY_CAP, int(rules.get("dailyCap", DAILY_CAP))))
    start_h, end_h = int(rules.get("startHour", START_HOUR)), int(rules.get("endHour", END_HOUR))
    extra = MAX_EXTRA if rules.get("randomExtra", True) else 0.0
    start_at = None
    if rules.get("startAt"):
        try:
            start_at = datetime.fromisoformat(str(rules["startAt"]).replace("Z", "+00:00")).astimezone()
        except ValueError:
            start_at = None

    res_path = results_path(job_path)
    results = load_json(res_path, None) or {
        "kind": "shop-followups-whatsapp-results", "job_id": job["job_id"], "shop_id": job["shop_id"],
        "template_id": job.get("template_id", ""), "created_at": job.get("created_at", ""), "items": []}
    done = {r["contact_id"] for r in results["items"] if r.get("status") in ("sent", "failed")}
    ledger = load_json(LEDGER_FILE, {"sent": []})
    already_phones = {e.get("phone") + "|" + e.get("job_id", "") for e in ledger.get("sent", [])}

    todo = [it for it in items if it["contact_id"] not in done and (it["phone"] + "|" + job["job_id"]) not in already_phones]
    say(f"Send list: {job_path.name} — shop '{job.get('shop_name', '')}'")
    say(f"{plural(len(items), 'person', 'people')} in the list, {len(items) - len(todo)} already done, {len(todo)} to send.")
    gap = f"{delay:g}–{delay * (1 + extra):.0f}" if extra else f"exactly {delay:g}"
    say(f"Rules: {gap} min between messages, max {cap}/day, {start_h}:00–{end_h}:00"
        + (f", starting {start_at.strftime('%d %b %H:%M')}" if start_at else "") + ".")
    if not todo:
        say(f"Nothing left to send. Upload '{res_path.name}' in the app (WhatsApp tab → Upload results).")
        return

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright is not installed. Run the 'WhatsApp Sender.command' launcher, which installs it.")

    problems = 0
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(str(PROFILE_DIR), headless=os.environ.get("SF_HEADLESS") == "1",
                                                    viewport={"width": 1100, "height": 800})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if not wait_for_login(page):
            ctx.close()
            sys.exit("Not logged in to WhatsApp Web. Run again and scan the QR code within 3 minutes.")

        # Scheduled start
        while start_at and not stop_requested and datetime.now().astimezone() < start_at:
            left = (start_at - datetime.now().astimezone()).total_seconds()
            say(f"Scheduled: waiting until {start_at.strftime('%d %b %H:%M')} to start ({left / 60:.0f} min). Keep the Mac awake.")
            end = time.time() + min(600, max(0.5, left))  # real time: the start time is a clock time
            while time.time() < end and not stop_requested:
                time.sleep(min(1.0, end - time.time()))

        for i, it in enumerate(todo, 1):
            if stop_requested:
                break
            # Sending hours
            while not stop_requested and not (start_h <= datetime.now().hour < end_h):
                say(f"Outside sending hours ({start_h}:00–{end_h}:00). Waiting… (keep the Mac awake)")
                sleep_s(600)
            # Daily limit
            if sent_today(ledger) >= cap:
                say(f"Daily limit of {cap} reached. Stopping for today — run again tomorrow to continue.")
                break
            if stop_requested:
                break

            name = it.get("name") or it["phone"]
            say(f"({i}/{len(todo)}) Sending to {name} (+{it['phone']})…")
            status, reason = send_one(page, it["phone"], it["text"], media_path)
            now = datetime.now().isoformat(timespec="seconds")
            if status == "logged_out":
                say("WhatsApp Web logged out. Stopping. Run again and scan the QR code.")
                break
            results["items"].append({"contact_id": it["contact_id"], "phone": it["phone"], "status": status, "reason": reason, "at": now})
            save_json(res_path, results)
            if status == "sent":
                problems = 0
                ledger.setdefault("sent", []).append({"phone": it["phone"], "job_id": job["job_id"], "at": now})
                save_json(LEDGER_FILE, ledger)
                say(f"  ✓ Sent to {name}.")
            else:
                problems += 1
                say(f"  ✗ Not sent to {name}: {reason}")
                if problems >= MAX_PROBLEMS_IN_A_ROW:
                    say(f"{MAX_PROBLEMS_IN_A_ROW} problems in a row — stopping to protect the number. Check WhatsApp, then run again.")
                    break

            if i < len(todo) and not stop_requested:
                wait_min = delay * (1 + random.random() * extra)
                say(f"  Waiting {wait_min:.1f} minutes before the next message…")
                sleep_s(wait_min * 60)

        ctx.close()

    sent = sum(1 for r in results["items"] if r["status"] == "sent")
    failed = sum(1 for r in results["items"] if r["status"] == "failed")
    left = len(items) - len({r["contact_id"] for r in results["items"]})
    say(f"Done for now: {sent} sent, {failed} not sent, {left} left.")
    say(f"Upload this file in the app (WhatsApp tab → Upload results): {res_path}")


if __name__ == "__main__":
    main()
