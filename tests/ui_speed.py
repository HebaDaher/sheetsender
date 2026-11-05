"""Speed: with a slow server (2.5 s per call, like Google on a bad day) the app shows what it already has at once."""
import subprocess, time, os
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(__file__)
srv = subprocess.Popen(['node', os.path.join(HERE, 'server.js')], env=dict(os.environ, RPC_DELAY='2500'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
errors = []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: errors.append(msg)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 1100, 'height': 900})
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('dialog', lambda d: d.accept())
        page.goto('http://127.0.0.1:8765/'); page.wait_for_selector('.shop-card', timeout=20000)
        size = page.evaluate('document.documentElement.outerHTML.length')
        check(size < 250000, 'page is light (Excel reader not in it): %d characters' % size)
        check(not page.evaluate('!!window.XLSX'), 'Excel reader not loaded until needed')
        time.sleep(6)  # background: shop data fetched ahead
        t0 = time.time(); page.click('.shop-card'); page.wait_for_selector('#drop'); dt = time.time() - t0
        check(dt < 1.0, 'opening a shop is instant thanks to the background load: %.2f s' % dt)
        page.click('#backHome'); t0 = time.time(); page.wait_for_selector('.shop-card'); dt = time.time() - t0
        check(dt < 1.0, 'back to all shops is instant: %.2f s' % dt)
        t0 = time.time(); page.reload(); page.wait_for_selector('.shop-card', timeout=20000); dt = time.time() - t0
        check(dt < 2.0, 'reloading the page shows the shops at once (saved copy), refreshed after: %.2f s' % dt)
        page.click('.shop-card'); page.wait_for_selector('#drop')
        page.set_input_files('#file', os.path.join(HERE, '..', 'sample-contacts.xlsx'))
        page.wait_for_selector('#doImport', timeout=30000)
        check(page.evaluate('!!window.XLSX'), 'Excel reader loaded when a file was chosen')
        page.click('#doImport'); page.wait_for_selector('text=Import finished', timeout=60000)
        page.click('#backHome'); page.wait_for_selector('.shop-card'); page.click('.shop-card'); page.wait_for_selector('#historyCard', timeout=5000)
        check('Contacts for this shop (12)' in page.inner_text('main'), 'reopened shop shows the new data (not an old copy)')
        page.click('text=Sign out'); page.wait_for_selector('text=Sign in with Google', timeout=20000)
        check(page.evaluate("localStorage.getItem('sf_boot')") is None, 'signing out forgets the saved copy')
        b.close()
finally:
    srv.terminate()
print('\nALL SPEED CHECKS PASSED' if not errors else '\nFAILED:\n' + '\n'.join(errors))
if errors: raise SystemExit(1)
