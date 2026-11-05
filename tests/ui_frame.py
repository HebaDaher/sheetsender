"""The app refuses to be shown inside someone else's website (it may only be shown by Google's page or the app's own site)."""
import subprocess, time, os, sys, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
srv = subprocess.Popen(['node', os.path.join(HERE, 'server.js')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('content-type', 'text/html'); self.end_headers()
        self.wfile.write(b'<html><body><h1>Other site</h1><iframe id="f" src="http://127.0.0.1:8765/" style="width:800px;height:600px"></iframe></body></html>')
    def log_message(self, *a): pass
other = socketserver.TCPServer(('127.0.0.1', 8771), H); threading.Thread(target=other.serve_forever, daemon=True).start()
time.sleep(1.2)
errors = []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: errors.append(msg)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox'])
        page = b.new_page()
        page.goto('http://127.0.0.1:8771/'); time.sleep(2.5)
        fr = [f for f in page.frames if '8765' in f.url][0]
        txt = fr.inner_text('body')
        check('Open the app at its own address' in txt, 'inside another website: the app does not open')
        check('Sign in with Google' not in txt, 'no sign-in button inside another website')
        direct = b.new_page(); direct.goto('http://127.0.0.1:8765/')
        direct.wait_for_function("!document.querySelector('.loading-page')", timeout=20000)
        check('Open the app at its own address' not in direct.inner_text('body'), 'opened directly: works as usual')
        b.close()
finally:
    srv.terminate(); other.shutdown()
print('\nALL FRAME CHECKS PASSED' if not errors else '\nFAILED:\n' + '\n'.join(errors))
if errors: raise SystemExit(1)
