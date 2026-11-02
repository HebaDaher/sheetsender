import json, os, subprocess, sys, time, urllib.request, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
HERE = Path(__file__).resolve().parent
TEST = os.environ.get('TEST_DIR', str(HERE.parent))
WA = os.environ.get('WA_DIR', str(HERE.parents[1] / 'whatsapp'))
MOCK = os.environ.get('MOCK', str(HERE / 'mock_wa.py'))
SAMPLE = os.environ.get('SAMPLE', str(HERE.parents[1] / 'sample-contacts.xlsx'))
errors = []
def check(c, m): print(('  ok   ' if c else '  FAIL ') + m, flush=True); (None if c else errors.append(m))
home = Path('/tmp/sf-e2e-home'); shutil.rmtree(home, ignore_errors=True); home.mkdir()
procs = []
try:
    procs.append(subprocess.Popen(['node', os.path.join(TEST, 'server.js')], env=dict(os.environ, REAL_CLOCK='1'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    procs.append(subprocess.Popen([sys.executable, MOCK, '8796'], cwd=os.path.dirname(MOCK)))
    time.sleep(1.5)
    helper_log = open('/tmp/sf-e2e-helper.log', 'w')
    helper = subprocess.Popen([sys.executable, os.path.join(WA, 'whatsapp_helper.py')], stdout=helper_log, stderr=subprocess.STDOUT,
        env=dict(os.environ, HOME=str(home), SF_BRIDGE_URL='http://127.0.0.1:8765/bridge', SF_BRIDGE_TOKEN='test-token',
                 SF_WA_URL='http://127.0.0.1:8796', SF_TIME_SCALE=os.environ.get('E2E_SCALE', '0.002'), SF_HEADLESS='1', SF_POLL_S='1', SF_TICK_S='0.3'))
    procs.append(helper)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1200, 'height': 900}); pg.on('dialog', lambda d: d.accept())
        pg.goto('http://127.0.0.1:8765/'); pg.wait_for_selector('.shop-card'); pg.click('.shop-card'); pg.wait_for_selector('#drop')
        pg.set_input_files('#file', SAMPLE); pg.wait_for_selector('#doImport'); pg.click('#doImport'); pg.wait_for_selector('text=Last import')
        pg.click('[data-view="whatsapp"]'); pg.wait_for_selector('#waHelper')
        pg.wait_for_selector('text=The WhatsApp Sender is running', timeout=15000)
        check(True, 'page sees the helper running on the Mac')
        check(pg.is_visible('#waOpen'), '"Open WhatsApp on the Mac" button shown')
        pg.click('#waOpen')
        pg.wait_for_selector('text=✓ WhatsApp connected on the Mac', timeout=20000)
        check(True, 'page shows ✓ WhatsApp connected')
        check(not pg.is_disabled('#waStart'), 'Start button enabled')
        pg.fill('#waBody', 'Hello {first_name}, the shop is still available.')
        pg.select_option('#wsH1', '0'); pg.select_option('#wsH2', '24'); pg.fill('#wsMin', '3')
        pg.click('#waStart')
        pg.wait_for_selector('text=Started for 8 people', timeout=10000)
        check(True, 'Start accepted for 8 people')
        pg.wait_for_selector('text=0 left of 8', timeout=120000)
        check(True, 'page shows progress until 0 left of 8')
        pg.wait_for_selector('text=finished', timeout=20000)
        check(True, 'page shows the send finished')
        pg.screenshot(path='/tmp/sf-e2e-done.png', full_page=True)
        if os.environ.get('E2E_STOP'):
            pg.fill('#waBody', 'Second message for {first_name}.')
            pg.click('#waStart'); pg.wait_for_selector('text=Started for 8 people', timeout=10000)
            pg.wait_for_selector('text=1 sent, 7 left of 8', timeout=60000)
            pg.click('#waStop'); pg.wait_for_selector('text=stopped', timeout=30000)
            txt = pg.inner_text('#waHelper')
            check('Stopped from the app' in txt, 'Stop works: ' + txt.replace(chr(10), ' ')[:90])
            check(not pg.is_disabled('#waStart'), 'can start again after stopping')
        b.close()
    sent = json.loads(urllib.request.urlopen('http://127.0.0.1:8796/sent').read())
    check(len(sent) == (9 if os.environ.get('E2E_STOP') else 8) or len(sent) == (10 if os.environ.get('E2E_STOP') else 8), 'WhatsApp messages sent: %d' % len(sent))
    check(any(m['text'] == 'Hello Fatima, the shop is still available.' for m in sent), 'personal text arrived')
    state = json.loads(urllib.request.urlopen('http://127.0.0.1:8765/state').read())
    wa_log = [l for l in state['log'] if l['channel'] == 'whatsapp' and l['status'] == 'sent']
    check(len(wa_log) == len(sent), 'every sent message saved in the Sheet automatically: %d of %d' % (len(wa_log), len(sent)))
finally:
    for pr in procs: pr.kill()
print(open('/tmp/sf-e2e-helper.log').read()[-1500:])
print('\nE2E PASSED' if not errors else '\nE2E FAILED: ' + '; '.join(errors))
