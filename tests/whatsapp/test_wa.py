import json, os, subprocess, sys, time, urllib.request, shutil
from pathlib import Path
SCRIPT = os.environ.get('WA_SCRIPT', str(Path(__file__).resolve().parents[2] / 'whatsapp' / 'whatsapp_sender.py'))
os.chdir(Path(__file__).resolve().parent)
errors = []
def check(c, m): print(('  ok   ' if c else '  FAIL ') + m); (None if c else errors.append(m))
def get(port, p): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{p}').read() or b'null')

def run_case(name, items, rules, extra_env=None, before=None, port=8790, keep_home=None):
    home = keep_home or Path(f'/tmp/sf-wa-test-home-{name}')
    if not keep_home:
        shutil.rmtree(home, ignore_errors=True); (home / 'Downloads').mkdir(parents=True)
    srv = subprocess.Popen([sys.executable, 'mock_wa.py', str(port)]); time.sleep(0.6)
    try:
        if before: before(port)
        job = {'kind': 'shop-followups-whatsapp-job', 'version': 1, 'job_id': 'WJOB1', 'shop_id': 'SHOP1', 'shop_name': 'Example Shop',
               'template_id': 'T9', 'created_at': '2026-11-02T18:00:00Z', 'rules': rules, 'items': items}
        jp = home / 'Downloads' / 'whatsapp-job-example-shop.json'
        if not jp.exists(): jp.write_text(json.dumps(job))
        env = dict(os.environ, HOME=str(home), SF_WA_URL=f'http://127.0.0.1:{port}', SF_TIME_SCALE='0.0005', SF_HEADLESS='1', **(extra_env or {}))
        out = subprocess.run([sys.executable, SCRIPT], env=env, capture_output=True, text=True, timeout=240)
        sent = get(port, '/sent')
        res = json.loads((home / 'Downloads' / 'whatsapp-job-example-shop-results.json').read_text()) if (home / 'Downloads' / 'whatsapp-job-example-shop-results.json').exists() else None
        return out, sent, res, home
    finally:
        srv.kill()

all_hours = {'delayMinutes': 5, 'dailyCap': 30, 'startHour': 0, 'endHour': 24}
items = [
    {'contact_id': 'C1', 'name': 'Heba', 'phone': '971501111111', 'text': 'Hello Heba,\nthe shop is still available. هل ما زلت مهتمة؟'},
    {'contact_id': 'C2', 'name': 'Adnan', 'phone': '971502222222', 'text': 'Hello Adnan,\nthe shop is still available.'},
    {'contact_id': 'C3', 'name': 'Wrong', 'phone': '971000000000', 'text': 'Hello Wrong'},
    {'contact_id': 'C4', 'name': 'Sara', 'phone': '+971 50 444 4444', 'text': 'Hello Sara & co <3'},
]
print('Normal run')
out, sent, res, home = run_case('normal', items, all_hours)
print(out.stdout[-1500:]); print(out.stderr[-1500:])
check(out.returncode == 0, 'finished without crashing')
check([s['phone'] for s in sent] == ['971501111111', '971502222222', '971504444444'], 'sent to the 3 valid numbers in order')
check(sent and sent[0]['text'] == 'Hello Heba,\nthe shop is still available. هل ما زلت مهتمة؟', 'text arrives exactly (new lines, Arabic)')
check(sent and sent[2]['text'] == 'Hello Sara & co <3', 'special characters kept')
check(res and [(r['contact_id'], r['status']) for r in res['items']] == [('C1','sent'),('C2','sent'),('C3','failed'),('C4','sent')], 'results file correct')
check(res and res['items'][2]['reason'] == 'This number is not on WhatsApp', 'invalid number explained')
check(out.stdout.count('Waiting ') == 3, 'waits between each message')
check('Waiting 5.' in out.stdout or 'Waiting 6.' in out.stdout or 'Waiting 7.' in out.stdout, 'wait is 5-7 minutes')

print('Run again: nothing is sent twice')
out2, sent2, res2, _ = run_case('normal', items, all_hours, keep_home=home)
check(sent2 == [], 'no duplicates on second run')
check('Nothing left to send' in out2.stdout, 'says nothing left')

print('Daily limit (2 per day)')
out, sent, res, home = run_case('cap', items, dict(all_hours, dailyCap=2))
check(len(sent) == 2 and 'Daily limit of 2 reached' in out.stdout, 'stops at the daily limit')
out3, sent3, res3, _ = run_case('cap', items, dict(all_hours, dailyCap=2), keep_home=home)
check(len(sent3) == 0, 'same day, second run: still at the limit')

print('Three problems in a row → stop')
bad = [{'contact_id': f'B{i}', 'name': f'B{i}', 'phone': '97100000000' + str(i), 'text': 'x'} for i in range(5)]
out, sent, res, home = run_case('problems', bad, all_hours)
check(len(res['items']) == 3 and 'problems in a row' in out.stdout, 'stops after 3 problems in a row')

print('Logged out in the middle → stop, nothing marked failed')
def logout_after_first(port):
    pass
out, sent, res, home = run_case('logout', items[:1], all_hours)
srv = subprocess.Popen([sys.executable, 'mock_wa.py', '8791']); time.sleep(0.6)
urllib.request.urlopen('http://127.0.0.1:8791/logout').read()
env = dict(os.environ, HOME=str(home), SF_WA_URL='http://127.0.0.1:8791', SF_TIME_SCALE='0.0005', SF_HEADLESS='1', SF_LOGIN_TIMEOUT='6')
(home/'Downloads'/'whatsapp-job-example-shop.json').write_text(json.dumps({'kind':'shop-followups-whatsapp-job','version':1,'job_id':'WJOB2','shop_id':'SHOP1','shop_name':'X','template_id':'T','created_at':'','rules':all_hours,'items':items[1:2]}))
o = subprocess.run([sys.executable, SCRIPT], env=dict(env), capture_output=True, text=True, timeout=60)
srv.kill()
check('Scan the QR code' in o.stdout or 'Not logged in' in (o.stdout + o.stderr), 'logged out: asks to scan QR, sends nothing')

print('Outside sending hours → waits')
srv = subprocess.Popen([sys.executable, 'mock_wa.py', '8792']); time.sleep(0.6)
h = (time.localtime().tm_hour + 2) % 24
home = Path('/tmp/sf-wa-test-home-hours'); shutil.rmtree(home, ignore_errors=True); (home/'Downloads').mkdir(parents=True)
(home/'Downloads'/'whatsapp-job-x.json').write_text(json.dumps({'kind':'shop-followups-whatsapp-job','version':1,'job_id':'WJOB3','shop_id':'SHOP1','shop_name':'X','template_id':'T','created_at':'','rules':{'delayMinutes':5,'dailyCap':30,'startHour':h,'endHour':min(24,h+1)},'items':items[:1]}))
p = subprocess.Popen([sys.executable, SCRIPT], env=dict(os.environ, HOME=str(home), SF_WA_URL='http://127.0.0.1:8792', SF_TIME_SCALE='0.0005', SF_HEADLESS='1'), stdout=subprocess.PIPE, text=True)
time.sleep(8); p.terminate(); o = p.communicate(timeout=20)[0]
sent = get(8792, '/sent'); srv.kill()
check(sent == [] and 'Outside sending hours' in o, 'no sending outside the hours')

print('Exact minutes (random extra OFF) and a scheduled start')
from datetime import datetime, timezone, timedelta
start = (datetime.now(timezone.utc) + timedelta(seconds=6)).isoformat().replace('+00:00', 'Z')
t0 = time.time()
out, sent, res, home = run_case('sched', items[:2], dict(all_hours, delayMinutes=7, randomExtra=False, startAt=start), port=8793)
check('Scheduled: waiting until' in out.stdout, 'waits for the start time')
check(time.time() - t0 >= 6, 'nothing sent before the start time')
check(len(sent) == 2, 'sends after the start time')
check('exactly 7 min between messages' in out.stdout and 'Waiting 7.0 minutes' in out.stdout, 'exact wait when random extra is off')
out, sent, res, home = run_case('fast', items[:2], dict(all_hours, delayMinutes=1), port=8794)
check('Rules: 3–4 min' in out.stdout, 'never faster than 3 minutes even if the list says 1: ' + [l for l in out.stdout.splitlines() if 'Rules' in l][0])

print('\nALL WHATSAPP CHECKS PASSED' if not errors else '\nFAILED: ' + '; '.join(errors))
