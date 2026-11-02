#!/usr/bin/env python3
"""
Shop Follow-ups — WhatsApp Sender helper (runs in the background on the Mac).

Installed once by "Install WhatsApp Sender.command"; macOS then starts it automatically at login.
It keeps in touch with the Shop Follow-ups app through a secure "bridge" link (a secret token that stays on
this Mac), so the WhatsApp tab in the app can:
  * show whether WhatsApp is connected on this Mac,
  * start / stop sending (it starts within seconds),
  * see the progress; every result is saved back to the app by itself.

Sending rules come from the app (start time, minutes between messages, random extra wait, daily limit, hours).
The helper never sends faster than 3 minutes apart and stops after 3 problems in a row or if WhatsApp logs out.
"""

import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import whatsapp_sender as core  # noqa: E402  (WhatsApp Web functions and file helpers)

VERSION = 2
BRIDGE_FILE = core.DATA_DIR / "bridge.json"          # {"url": ..., "token": ...} written by the installer
JOBS_DIR = core.DATA_DIR / "jobs"
POLL_S = float(os.environ.get("SF_POLL_S", "8"))       # how often to check the app for commands
TICK_S = float(os.environ.get("SF_TICK_S", "2"))
HEADLESS = os.environ.get("SF_HEADLESS") == "1"


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- bridge
class Bridge:
    def __init__(self):
        cfg = core.load_json(BRIDGE_FILE, {})
        self.url = os.environ.get("SF_BRIDGE_URL") or cfg.get("url", "")
        self.token = os.environ.get("SF_BRIDGE_TOKEN") or cfg.get("token", "")
        if not self.url or not self.token:
            sys.exit(f"Not set up: {BRIDGE_FILE} is missing. Run 'Install WhatsApp Sender.command' again.")

    def call(self, action, **data):
        body = json.dumps({"token": self.token, "action": action, **data}).encode("utf-8")
        req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=40) as r:  # Google answers with a redirect; urllib follows it
            out = json.loads(r.read().decode("utf-8") or "{}")
        if not out.get("ok"):
            raise RuntimeError(out.get("error") or "bridge error")
        return out


# ---------------------------------------------------------------- job state (saved on disk, survives restarts)
def job_path(job_id):
    return JOBS_DIR / f"{job_id}.json"


def save_job(st):
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    core.save_json(job_path(st["job"]["job_id"]), st)


def latest_running_job():
    if not JOBS_DIR.exists():
        return None
    for f in sorted(JOBS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = core.load_json(f, None)
        if st and st.get("state") == "running":
            return st
    return None


def parse_time(s):
    if not s:
        return 0.0
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z") if ts else ""


class Helper:
    def __init__(self):
        self.bridge = Bridge()
        self.pw = None
        self.ctx = None
        self.page = None
        self.wa = "closed"              # closed | loading | qr | connected
        self.job = latest_running_job()  # resume after a restart
        self.last_poll = 0.0
        self.last_error = ""
        self.caffeinate = None
        if self.job:
            log(f"Resuming send {self.job['job']['job_id']} ({self.job['job'].get('shop_name', '')}).")

    # ---------------- browser / WhatsApp Web
    def ensure_browser(self):
        if self.ctx is not None:
            return
        from playwright.sync_api import sync_playwright
        if self.pw is None:
            self.pw = sync_playwright().start()
        log("Opening WhatsApp Web…")
        self.ctx = self.pw.chromium.launch_persistent_context(str(core.PROFILE_DIR), headless=HEADLESS,
                                                              viewport={"width": 1100, "height": 800})
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        self.page.goto(core.WA_URL + "/", wait_until="domcontentloaded")
        self.wa = "loading"

    def close_browser(self):
        try:
            if self.ctx:
                self.ctx.close()
        except Exception:
            pass
        self.ctx = self.page = None
        self.wa = "closed"

    def check_whatsapp(self):
        if self.ctx is None or self.page is None:
            self.wa = "closed"
            return
        try:
            if self.page.is_closed():
                raise RuntimeError("closed")
            if self.page.query_selector(core.SEL_LOGGED_IN):
                self.wa = "connected"
            elif self.page.query_selector(core.SEL_QR):
                self.wa = "qr"
            else:
                self.wa = "loading"
        except Exception:
            log("The WhatsApp window was closed.")
            self.close_browser()

    # ---------------- keep the Mac awake while a send is running
    def keep_awake(self, on):
        if on and self.caffeinate is None and shutil.which("caffeinate"):
            self.caffeinate = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        if not on and self.caffeinate is not None:
            self.caffeinate.terminate()
            self.caffeinate = None

    # ---------------- status sent to the app
    def status(self):
        ledger = core.load_json(core.LEDGER_FILE, {"sent": []})
        st = {"version": VERSION, "wa": self.wa, "sent_today": core.sent_today(ledger), "error": self.last_error[:200],
              "mac_time": datetime.now().astimezone().isoformat(timespec="minutes")}
        if self.job:
            j, items = self.job["job"], self.job["job"]["items"]
            res = self.job["results"]["items"]
            st["job"] = {
                "job_id": j["job_id"], "shop_id": j.get("shop_id"), "shop_name": j.get("shop_name", ""),
                "state": self.job["state"], "message": self.job.get("message", ""),
                "total": len(items), "sent": sum(1 for r in res if r["status"] == "sent"),
                "failed": sum(1 for r in res if r["status"] == "failed"),
                "left": len(items) - len({r["contact_id"] for r in res}),
                "next_at": iso(self.job.get("next_at", 0)), "cap": self.job["rules"]["dailyCap"],
                "last": res[-1] if res else None,
            }
        return st

    # ---------------- commands from the app
    def poll(self):
        self.last_poll = time.time()
        try:
            out = self.bridge.call("poll", status=self.status())
            self.last_error = ""
        except Exception as e:  # offline, Google busy … try again next time
            self.last_error = f"Cannot reach the app: {e}"
            log(self.last_error)
            return
        done = []
        for cmd in out.get("commands", []):
            try:
                self.handle(cmd)
            except Exception as e:
                log(f"Command {cmd.get('type')} failed: {e}")
                if self.job is None:
                    self.last_error = str(e)
            done.append(cmd["id"])
        if done:
            try:
                self.bridge.call("ack", ids=done)
            except Exception as e:
                log(f"Could not confirm commands: {e}")
        self.push_results()

    def handle(self, cmd):
        t = cmd.get("type")
        log(f"Command from the app: {t} (by {cmd.get('by', '?')})")
        if t == "open":
            self.ensure_browser()
            try:
                self.page.bring_to_front()
            except Exception:
                pass
        elif t == "stop":
            if self.job and self.job["state"] == "running":
                self.job["state"] = "stopped"
                self.job["message"] = "Stopped from the app."
                save_job(self.job)
                self.keep_awake(False)
        elif t == "start":
            if self.job and self.job["state"] == "running":
                raise RuntimeError("A send is already running.")
            job = self.bridge.call("job", command_id=cmd["id"])["job"]
            items = core.validate_job(job)
            rules = job.get("rules") or {}
            delay = max(core.MIN_DELAY_MINUTES, float(rules.get("delayMinutes", 5)))
            cap = max(1, min(core.MAX_DAILY_CAP, int(rules.get("dailyCap", core.DAILY_CAP))))
            start_at = parse_time(rules.get("startAt"))
            job["items"] = items
            self.job = {
                "job": job, "state": "running", "message": "Starting…", "problems": 0,
                "rules": {"delay": delay, "extra": core.MAX_EXTRA if rules.get("randomExtra", True) else 0.0,
                          "dailyCap": cap, "startHour": int(rules.get("startHour", 9)), "endHour": int(rules.get("endHour", 21)),
                          "startAt": start_at},
                "next_at": max(time.time(), start_at),
                "results": {"kind": "shop-followups-whatsapp-results", "job_id": job["job_id"], "shop_id": job["shop_id"],
                            "template_id": job.get("template_id", ""), "created_at": job.get("created_at", ""), "items": []},
                "pushed": 0,
            }
            save_job(self.job)
            log(f"New send: {len(items)} people, shop '{job.get('shop_name', '')}'.")
            self.ensure_browser()
            self.keep_awake(True)

    def push_results(self):
        if not self.job:
            return
        items = self.job["results"]["items"]
        if self.job.get("pushed", 0) >= len(items):
            return
        try:
            self.bridge.call("results", results={**self.job["results"], "items": items[self.job.get("pushed", 0):]})
            self.job["pushed"] = len(items)
            save_job(self.job)
        except Exception as e:
            log(f"Could not save results to the app yet (will retry): {e}")

    # ---------------- sending (one message per step, never blocks for long)
    def step(self):
        j = self.job
        if not j or j["state"] != "running":
            return
        R = j["rules"]
        now = time.time()
        if self.ctx is None:
            self.ensure_browser()
        if self.wa != "connected":
            j["message"] = ("Scan the QR code in the WhatsApp window on the Mac (WhatsApp → Settings → Linked devices)."
                            if self.wa == "qr" else "Waiting for WhatsApp to open…")
            return
        if now < R["startAt"]:
            j["message"] = "Scheduled: starts " + datetime.fromtimestamp(R["startAt"]).strftime("%d %b %H:%M") + "."
            return
        if now < j["next_at"]:
            return
        hour = datetime.now().hour
        if not (R["startHour"] <= hour < R["endHour"]):
            j["message"] = f"Outside sending hours ({R['startHour']}:00–{R['endHour']}:00). Continues by itself."
            return
        ledger = core.load_json(core.LEDGER_FILE, {"sent": []})
        if core.sent_today(ledger) >= R["dailyCap"]:
            j["message"] = f"Daily limit of {R['dailyCap']} reached. Continues tomorrow at {R['startHour']}:00."
            return
        done = {r["contact_id"] for r in j["results"]["items"]}
        already = {e.get("phone", "") + "|" + e.get("job_id", "") for e in ledger.get("sent", [])}
        todo = [it for it in j["job"]["items"] if it["contact_id"] not in done and
                (it["phone"] + "|" + j["job"]["job_id"]) not in already]
        if not todo:
            j["state"] = "done"
            j["message"] = "Finished."
            save_job(j)
            self.keep_awake(False)
            log("Send finished.")
            return
        it = todo[0]
        name = it.get("name") or it["phone"]
        j["message"] = f"Sending to {name}…"
        log(f"Sending to {name} (+{it['phone']})…")
        status, reason = core.send_one(self.page, it["phone"], it["text"])
        stamp = datetime.now().isoformat(timespec="seconds")
        if status == "logged_out":
            self.wa = "qr"
            j["message"] = "WhatsApp logged out on the Mac. Scan the QR code in the WhatsApp window to continue."
            save_job(j)
            return
        j["results"]["items"].append({"contact_id": it["contact_id"], "phone": it["phone"], "status": status, "reason": reason, "at": stamp})
        if status == "sent":
            j["problems"] = 0
            ledger.setdefault("sent", []).append({"phone": it["phone"], "job_id": j["job"]["job_id"], "at": stamp})
            core.save_json(core.LEDGER_FILE, ledger)
            log(f"  ✓ sent to {name}")
        else:
            j["problems"] = j.get("problems", 0) + 1
            log(f"  ✗ not sent to {name}: {reason}")
            if j["problems"] >= core.MAX_PROBLEMS_IN_A_ROW:
                j["state"] = "stopped"
                j["message"] = f"Stopped after {core.MAX_PROBLEMS_IN_A_ROW} problems in a row, to protect the number. Check WhatsApp, then start again."
                self.keep_awake(False)
        wait_min = R["delay"] * (1 + random.random() * R["extra"])
        j["next_at"] = time.time() + wait_min * 60 * core.TIME_SCALE
        if j["state"] == "running":
            j["message"] = f"Next message at {datetime.fromtimestamp(j['next_at']).strftime('%H:%M')}."
        save_job(j)
        self.push_results()

    # ---------------- main loop
    def run(self):
        log(f"WhatsApp Sender helper v{VERSION} started.")
        if self.job:
            self.keep_awake(True)
        while True:
            try:
                self.check_whatsapp()
                if time.time() - self.last_poll >= POLL_S:
                    self.poll()
                self.step()
            except Exception as e:
                self.last_error = str(e)
                log(f"Problem: {e}")
                if "closed" in str(e).lower() or "target" in str(e).lower():
                    self.close_browser()
            time.sleep(TICK_S)


if __name__ == "__main__":
    Helper().run()
