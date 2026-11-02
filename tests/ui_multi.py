# Browser test of the multi-user features: a new person's own workspace, Settings (shops, people, WhatsApp
# Business API), WhatsApp tab (API mode and "Set up a Mac"), and switching workspaces.
import subprocess, time, json, urllib.request, os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(__file__)
SHOTS = os.path.join(HERE, 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
env = dict(os.environ, WEBUSER='sara@gmail.com', TICK='3')
srv = subprocess.Popen(['node', os.path.join(HERE, 'server.js')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
time.sleep(1.2)
errors = []
def get(u): return json.loads(urllib.request.urlopen('http://127.0.0.1:8765' + u).read())
def post(u, body):
    r = urllib.request.Request('http://127.0.0.1:8765' + u, data=json.dumps(body).encode(), method='POST')
    return json.loads(urllib.request.urlopen(r).read())
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: errors.append(msg)

META = {'pnid': '1112223334445', 'waba': '5556667778889', 'token': 'EAAGtest_token_abcdefghijklmnopqrstuvwxyz0123'}  # fake values of the test harness

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 1200, 'height': 900})
        page.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('dialog', lambda d: d.accept())

        # 1. A new person opens the link
        page.goto('http://127.0.0.1:8765/')
        page.wait_for_selector('#wCreate')
        check('Create my workspace' in page.inner_text('main'), 'new person: welcome with "Create my workspace"')
        check('Example Shop' not in page.inner_text('body'), 'sees nothing of the owner\'s shops')
        page.screenshot(path=SHOTS + '/m1-welcome.png')
        page.click('#notYou'); page.wait_for_selector('#acctHelp')
        check('first Google account' in page.inner_text('#acctHelp') and 'sara@gmail.com' in page.inner_text('#acctHelp'), '"Not you?" explains how to use another account')
        page.screenshot(path=SHOTS + '/m0-not-you.png')
        page.click('#acctHelpClose')
        page.click('#wCreate')
        page.wait_for_selector('.banner.error')
        check('first shop' in page.inner_text('#banner'), 'shop name is required')
        page.fill('#wName', 'Sara Shops'); page.fill('#wShop', 'Sara Bakery')
        page.click('#wCreate')
        page.wait_for_selector('.shop-card')
        check('Sara Bakery' in page.inner_text('main'), 'workspace created with the first shop')
        check('Sara Shops' in page.inner_text('#who') and page.query_selector('#openSettings'), 'top bar: workspace name + Settings')
        check('Emails may not be going out' not in page.inner_text('main'), 'no scary sender warning on a new workspace')

        # 2. Settings: add a shop, a person, the WhatsApp Business API
        page.click('#openSettings'); page.wait_for_selector('#shopAdd')
        txt = page.inner_text('main')
        check('Google sign-in (app administrator' not in txt, 'sign-in client section hidden for non-admins')
        check('Share the app' in txt and 'People who can use this workspace' in txt and 'WhatsApp Business API' in txt, 'sections: share, people, WhatsApp API')
        page.click('#shopAdd'); page.fill('#sfName', 'Sara Cafe'); page.fill('#sfReply', 'sara@gmail.com'); page.click('#sfSave')
        page.wait_for_selector('text=Added Sara Cafe')
        page.wait_for_selector('[data-shopedit] >> nth=1')
        check('Sara Cafe' in page.inner_text('main'), 'shop added from Settings')
        page.fill('#mEmail', 'dad@gmail.com'); page.click('#mAdd')
        page.wait_for_selector('[data-mremove="dad@gmail.com"]')
        check(True, 'person added')
        page.fill('#waPnid', META['pnid']); page.fill('#waWaba', META['waba']); page.fill('#waTok', 'EAAGwrong_token_value_1234567890')
        page.click('#waSave'); page.wait_for_selector('.banner.error')
        check('access token is wrong' in page.inner_text('#banner'), 'wrong token explained')
        page.fill('#waTok', META['token']); page.click('#waSave')
        page.wait_for_selector('text=✓ Connected:')
        page.wait_for_selector('text=Templates you can use')
        check('shop_followup' in page.inner_text('#waTplList'), 'approved templates listed')
        check(META['token'] not in page.content(), 'token never shown on the page')
        page.screenshot(path=SHOTS + '/m2-settings.png', full_page=True)

        # 3. Import people into Sara Bakery
        page.click('#setBack'); page.wait_for_selector('.shop-card')
        page.click('.shop-card >> text=Sara Bakery'); page.wait_for_selector('#drop')
        page.set_input_files('#file', os.path.join(HERE, '..', 'sample-contacts.xlsx'))
        page.wait_for_selector('#doImport'); page.click('#doImport'); page.wait_for_selector('text=Last import')

        # 4. WhatsApp tab, Business API mode
        page.click('[data-view="whatsapp"]'); page.wait_for_selector('[data-wamode="api"]')
        page.click('[data-wamode="api"]'); page.wait_for_selector('#apiTpl')
        greets = page.inner_text('#apiGreets')
        check('this is about Sara Bakery' in greets, 'preview fills {{1}} name and {{2}} shop: ' + greets[:60])
        page.select_option('[data-pgroup="b"][data-pkey="2"]', 'text:')
        page.fill('[data-ptext="b|2"]', 'our bakery')
        check('this is about our bakery' in page.inner_text('#apiGreets'), 'fixed text for a blank')
        page.click('#apiCheck'); page.wait_for_selector('#apiReview .notice')
        rv = page.inner_text('#apiReview')
        check('will get it' in rv, 'check shows who will receive: ' + rv[:80])
        page.screenshot(path=SHOTS + '/m3-wa-api.png', full_page=True)
        page.fill('#asMin', '1')
        page.click('#apiStart')
        page.wait_for_selector('text=Started. Messages go out automatically from Meta')
        page.wait_for_selector('#cRefresh')
        check('WhatsApp Business API template: shop_followup' in page.inner_text('main'), 'progress opens for the new send')
        n0 = len(get('/meta')['sent'])
        get('/tick')
        check(len(get('/meta')['sent']) > n0, 'messages go out through Meta from the owner\'s trigger')
        page.click('#cRefresh'); page.wait_for_selector('.stat')
        check(page.inner_text('[data-f="sent"] .n') != '0', 'progress shows sent')
        check('Phone' in page.inner_text('table'), 'progress list shows phone numbers for WhatsApp')

        # 5. Mac mode: set up a Mac
        page.click('[data-view="whatsapp"]'); page.wait_for_selector('[data-wamode="mac"]')
        page.click('[data-wamode="mac"]'); page.wait_for_selector('#waHelper')
        page.wait_for_selector('text=No Mac is set up for this workspace yet')
        page.click('#waLink'); page.wait_for_selector('#macCmd')
        cmd = page.input_value('#macCmd')
        check(cmd.startswith("curl -fsSL https://hebadaher.github.io/sheetsender/mac/install.sh | bash -s -- 'https://script.google.com/macros/s/"), 'one-line Mac command: ' + cmd[:70])
        token = cmd.rsplit("'", 2)[-2]
        post('/bridge', {'token': token, 'action': 'poll', 'status': {'wa': 'connected', 'version': 2}})
        page.wait_for_selector('text=WhatsApp connected on the Mac', timeout=15000)
        check(page.is_enabled('#waStart'), 'Start enabled once the Mac is connected')
        page.screenshot(path=SHOTS + '/m4-wa-mac.png', full_page=True)

        # 6. Dad: two workspaces, switch
        get('/as/dad%40gmail.com')
        page.goto('http://127.0.0.1:8765/'); page.wait_for_selector('#wsSel')
        opts = page.eval_on_selector_all('#wsSel option', 'os => os.map(o => o.textContent)')
        check(len(opts) == 3 and any('Sara Shops' in o for o in opts) and 'My shops' in opts[0], 'dad sees both workspaces (family one first) + create: ' + str(opts))
        check(page.query_selector('#openSettings') is None, 'no Settings for dad in the owner\'s workspace')
        sara = page.eval_on_selector_all('#wsSel option', 'os => os.filter(o => o.textContent.indexOf("Sara") === 0)[0].value')
        page.select_option('#wsSel', sara)
        page.wait_for_selector('text=Sara Bakery')
        check('Example Shop' not in page.inner_text('main'), 'switched to Sara\'s shops')
        page.reload(); page.wait_for_selector('.shop-card')
        check('Sara Bakery' in page.inner_text('main'), 'the choice is remembered')

        # 7. Phone size
        page.set_viewport_size({'width': 375, 'height': 800})
        page.click('.shop-card >> text=Sara Bakery'); page.wait_for_selector('#drop')
        page.click('[data-view="whatsapp"]'); page.wait_for_selector('.modes')
        sw = page.evaluate('document.documentElement.scrollWidth')
        check(sw <= 380, 'no sideways scrolling on a phone: ' + str(sw))
        page.screenshot(path=SHOTS + '/m5-phone.png', full_page=True)
        b.close()
finally:
    srv.terminate()

if errors:
    print('\nFAILED:\n  ' + '\n  '.join(errors)); raise SystemExit(1)
print('\nALL MULTI-USER UI CHECKS PASSED')
