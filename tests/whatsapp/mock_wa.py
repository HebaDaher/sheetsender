# Fake WhatsApp Web for tests: "/" chat list; "/send?phone=&text=" opens a chat with the text in the box.
import http.server, urllib.parse, json, sys
SENT = []
STATE = {'logged_out': False}
PAGE = """<!doctype html><html><body>%s</body></html>"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send_html(self, html):
        b = (PAGE % html).encode(); self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == '/sent':
            b = json.dumps(SENT).encode(); self.send_response(200); self.end_headers(); self.wfile.write(b); return
        if u.path == '/logout':
            STATE['logged_out'] = True; self.send_response(200); self.end_headers(); return
        if STATE['logged_out']:
            return self.send_html('<div data-ref="x"><canvas aria-label="Scan this QR code"></canvas></div>')
        if u.path == '/send':
            phone = q.get('phone', [''])[0]; text = q.get('text', [''])[0]
            if phone.startswith('9710000'):
                return self.send_html('<div id="pane-side"></div><div role="dialog">Phone number shared via url is invalid.</div>')
            if phone.startswith('9719999'):  # chat never opens
                return self.send_html('<div id="pane-side"></div>')
            esc = text.replace('&', '&amp;').replace('<', '&lt;')
            return self.send_html('''<div id="pane-side"></div><div id="main"></div>
<footer><div contenteditable="true" data-tab="10" id="box" style="white-space:pre-wrap">%s</div></footer>
<script>
var box=document.getElementById('box');
box.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault();
  fetch('/record',{method:'POST',body:JSON.stringify({phone:%s,text:box.innerText})}).then(function(){ box.innerText=''; }); }});
</script>''' % (esc, json.dumps(phone)))
        return self.send_html('<div id="pane-side">chats</div>')
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); d = json.loads(self.rfile.read(n))
        SENT.append(d); self.send_response(200); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
