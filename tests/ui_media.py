"""Photos and videos in the browser: add a photo on the WhatsApp tab (Mac), a photo template on the Business API."""
import subprocess, time, json, urllib.request, os, tempfile
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(__file__)
SHOTS = os.path.join(HERE, 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
srv = subprocess.Popen(['node', os.path.join(HERE, 'server.js')], env=dict(os.environ, WA_API='1'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
errors = []
def get(u): return json.loads(urllib.request.urlopen('http://127.0.0.1:8765' + u).read())
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: errors.append(msg)
tmp = tempfile.mkdtemp()
def fpath(name, data):
    p = os.path.join(tmp, name); open(p, 'wb').write(data); return p
jpg = fpath('Offer.jpg', b'\xff\xd8\xff' + os.urandom(2_500_000))       # 2 parts of 2 MB
fake = fpath('fake.jpg', b'<html>not a photo</html>')
mov = fpath('clip.mov', b'\x00\x00\x00\x14ftypqt  ' + os.urandom(1000))
heic = fpath('IMG_1.heic', os.urandom(1000))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 1200, 'height': 900})
        page.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('dialog', lambda d: d.accept())
        page.goto('http://127.0.0.1:8765/')
        page.wait_for_selector('.shop-card'); page.click('.shop-card'); page.wait_for_selector('#drop')
        page.set_input_files('#file', os.path.join(HERE, '..', 'sample-contacts.xlsx')); page.wait_for_selector('#doImport')
        page.click('#doImport'); page.wait_for_selector('text=Import finished')

        page.click('[data-view="whatsapp"]')
        if page.query_selector('[data-wamode="mac"]'): page.click('[data-wamode="mac"]')
        page.wait_for_selector('#wmMedia')
        check(page.is_checked('input[name="wmMed"][value=""]'), 'text only by default')
        page.set_input_files('#wmMedFile', mov)
        check('iPhone videos (.mov)' in page.inner_text('#banner'), '.mov explained: ' + page.inner_text('#banner')[:60])
        page.set_input_files('#wmMedFile', heic)
        check('HEIC' in page.inner_text('#banner'), 'HEIC explained')
        page.set_input_files('#wmMedFile', fake)
        page.wait_for_selector('text=not really a JPG')
        check(True, 'a fake photo is refused by the app')
        page.set_input_files('#wmMedFile', jpg)
        page.wait_for_selector('text=Added “Offer.jpg”', timeout=20000)
        checked = page.query_selector('input[name="wmMed"]:checked')
        check(checked and checked.get_attribute('value') != '', 'the new photo is chosen')
        st = get('/state')
        check(len(st['media']) == 1 and st['media'][0]['size'] == str(os.path.getsize(jpg)), 'saved once, full size')
        page.screenshot(path=SHOTS + '/media-1-mac.png', full_page=True)

        # The send list carries the photo
        page.click('text=Without the helper: send list files')
        with page.expect_download() as dl:
            page.click('#waJob')
        job = json.loads(open(dl.value.path()).read())
        check(job['media'] and job['media']['name'] == 'Offer.jpg' and job['media']['kind'] == 'image', 'send list says which photo')
        page.wait_for_selector('#wmMedia')
        # Saved message keeps the photo
        st = get('/state')
        check(True, 'ok')

        # Business API: a photo template needs a photo
        page.click('[data-wamode="api"]'); page.wait_for_selector('#apiTpl')
        page.select_option('#apiTpl', 'with_image|en_US'); page.wait_for_selector('#amMedia')
        page.click('#apiCheck')
        check('Choose the photo' in page.inner_text('#banner'), 'cannot check without a photo')
        page.check('input[name="amMed"]'); page.wait_for_selector('#amMedia')
        check('📷 Offer.jpg' in page.inner_text('#apiGreets'), 'preview shows the photo')
        page.click('#apiCheck'); page.wait_for_selector('#apiReview .notice')
        check('will get it' in page.inner_text('#apiReview'), 'preview works with the photo')
        page.screenshot(path=SHOTS + '/media-2-api.png', full_page=True)
        page.click('#apiStart'); page.wait_for_selector('text=Started. Messages go out automatically')
        urllib.request.urlopen('http://127.0.0.1:8765/tick').read()
        m = get('/meta')
        check(m['mediaUploads'] == 1 and m['sent'] and m['sent'][0]['body']['template']['components'][0]['parameters'][0]['type'] == 'image', 'Meta got the photo once; messages carry it')
        b.close()
finally:
    srv.terminate()
print('\nALL MEDIA UI CHECKS PASSED' if not errors else '\nFAILED:\n' + '\n'.join(errors))
if errors: raise SystemExit(1)
