import sys
"""Upload history in the browser: several files at once, the history, send to one file, show people, rename, remove."""
import subprocess, time, json, urllib.request, os, tempfile
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reveal import patch

HERE = os.path.dirname(__file__)
SHOTS = os.path.join(HERE, 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
srv = subprocess.Popen(['node', os.path.join(HERE, 'server.js')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
errors = []
def get(u): return json.loads(urllib.request.urlopen('http://127.0.0.1:8765' + u).read())
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: errors.append(msg)

tmp = tempfile.mkdtemp()
def csv(name, rows):
    p = os.path.join(tmp, name)
    with open(p, 'w') as f:
        f.write('Name,Email,Mobile,Consent\n')
        for r in rows: f.write(','.join(r) + '\n')
    return p
ramadan = csv('ramadan.csv', [('Rana One', 'rana1@ex.com', '0501110001', 'yes'), ('Rana Two', 'rana2@ex.com', '0501110002', 'yes')])
eid = csv('eid.csv', [('Eid One', 'eid1@ex.com', '0501110003', 'yes'), ('Rana Two', 'rana2@ex.com', '0501110002', 'yes'), ('Eid Three', 'eid3@ex.com', '0501110004', 'yes')])

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox'])
        page = patch(b.new_page(viewport={'width': 1200, 'height': 900}))
        page.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        PROMPT = {'text': None}
        def on_dialog(d):
            if d.type == 'prompt' and PROMPT['text'] is not None: d.accept(PROMPT['text']); PROMPT['text'] = None
            else: d.accept()
        page.on('dialog', on_dialog)
        page.goto('http://127.0.0.1:8765/')
        page.wait_for_selector('.shop-card'); page.click('.shop-card'); page.wait_for_selector('#drop')
        check(page.get_attribute('#file', 'multiple') is not None, 'file chooser takes several files')

        page.set_input_files('#file', [ramadan, eid])
        page.wait_for_selector('#doImport')
        check('file 1 of 2' in page.inner_text('main'), 'shows file 1 of 2')
        check(page.is_visible('#skipUpload'), '"Skip this file" while more files wait')
        page.click('#doImport')
        page.wait_for_selector('text=file 2 of 2')
        check('eid.csv' in page.inner_text('main'), 'second file is shown next')
        page.click('#doImport')
        page.wait_for_selector('text=Import finished')
        txt = page.inner_text('main')
        check('Import finished (2 files): 4 new' in page.inner_text('#banner'), 'one summary for both files: ' + page.inner_text('#banner'))
        check('Upload history (2)' in txt, 'history lists both files')
        rows = page.query_selector_all('.list-row')
        check('eid.csv' in rows[0].inner_text() and '3 people' in rows[0].inner_text(), 'newest first, with people count')
        check('2 people' in rows[1].inner_text(), 'ramadan: 2 people')
        page.screenshot(path=SHOTS + '/lists-1-history.png', full_page=True)

        # Show people of one file
        page.click('.list-row:nth-child(2) [data-lshow]')
        page.wait_for_selector('#cListAll')
        check('People in “ramadan.csv” (2)' in page.inner_text('#contactsCard'), 'shows only that file\'s people')
        page.click('#cListAll'); page.wait_for_selector('text=Contacts for this shop')

        # Same file name again: choose update or keep both
        page.set_input_files('#file', ramadan)
        page.wait_for_selector('#doImport')
        check('was uploaded before' in page.inner_text('main'), 'warns that the file name was uploaded before')
        page.check('input[name="sameMode"][value="new"]')
        page.click('#doImport'); page.wait_for_selector('text=Upload history (3)')
        check('ramadan.csv (2)' in page.inner_text('#historyCard'), '"keep both" saves a second entry')
        page.click('.list-row:nth-child(1) [data-ldel]')
        page.wait_for_selector('text=Upload history (2)')
        check('Removed from the upload history' in page.inner_text('#banner'), 'remove works and keeps contacts')

        # Send an email to the ramadan file only
        page.click('.list-row:nth-child(2) [data-lsend]')
        page.wait_for_selector('#seAud')
        check(page.is_checked('input[name="seAudMode"][value="pick"]'), 'send page opens with "only these files" chosen')
        check('2 people in the chosen files' in page.inner_text('#seAud'), 'says how many people are chosen')
        page.select_option('#seTpl', '')
        page.fill('#sSubject', 'Ramadan visit'); page.fill('#sBody', 'Hello {first_name},\n\nThe shop is still available for a visit this week. Reply here.')
        page.click('#sReview'); page.wait_for_selector('#sStart')
        rtxt = page.inner_text('#reviewBox')
        check('Only people from: ramadan.csv' in rtxt and '2\nwill get the email' in rtxt, 'review: only the file\'s 2 people')
        page.screenshot(path=SHOTS + '/lists-2-send.png', full_page=True)
        page.click('#sStart'); page.wait_for_selector('text=Sending has started')
        st = get('/state')
        k = [c for c in st['campaigns'] if c['campaign_name'].startswith('Ramadan visit')][0]
        check(len(k['list_ids'].split(',')) == 1, 'campaign remembers the file')

        # untick everything -> clear problem
        page.click('[data-view="send"]'); page.wait_for_selector('#seAud')
        page.click('[data-aud="se"]:checked'); page.wait_for_selector('text=Tick at least one file')
        page.click('#sReview')
        check('Tick at least one uploaded file' in page.inner_text('#reviewBox'), 'no file ticked: clear message')

        # WhatsApp tab: same picker; manual list only shows chosen people
        page.click('input[name="seAudMode"][value="all"]')
        page.click('[data-view="contacts"]'); page.wait_for_selector('#historyCard')
        check('Sent to this file 1 time' in page.inner_text('#historyCard'), 'history shows what was sent to the file')
        page.click('.list-row:nth-child(1) [data-lwa]')
        page.wait_for_selector('#whAud')
        check(page.is_checked('input[name="whAudMode"][value="pick"]'), 'WhatsApp tab opens with the file chosen')
        page.click('[data-wasub="manual"]'); page.wait_for_selector('#wTpl')
        check('3 people can be messaged' in page.inner_text('main'), 'one-by-one list shows only the file\'s people')
        page.screenshot(path=SHOTS + '/lists-3-whatsapp.png', full_page=True)

        # Rename
        page.click('[data-view="contacts"]'); page.wait_for_selector('#historyCard')
        PROMPT['text'] = 'Eid buyers 2026'
        page.click('.list-row:nth-child(1) [data-lren]')
        page.wait_for_selector('text=Eid buyers 2026')
        check('(eid.csv)' in page.inner_text('#historyCard'), 'renamed; the original file name is still shown')
        b.close()
finally:
    srv.terminate()
print('\nALL LIST UI CHECKS PASSED' if not errors else '\nFAILED:\n' + '\n'.join(errors))
if errors: raise SystemExit(1)
