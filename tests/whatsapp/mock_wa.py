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
            # Like real WhatsApp Web: numbers starting 97155 reload the page once right after the chat appears;
            # numbers starting 97156 ignore Enter (only the Send button works).
            reload_js = ''
            if phone.startswith('97155') and 'reloaded' not in q:
                reload_js = "setTimeout(function(){ location.replace(location.href + '&reloaded=1'); }, 700);"
            enter_ok = 'false' if phone.startswith('97156') else 'true'
            # numbers starting 97158: WhatsApp reloads right after Enter, before the box is cleared (the risky case)
            if phone.startswith('97158') and 'reloaded' not in q:
                reload_js = "box.addEventListener('keydown',function(e){ if(e.key==='Enter'){ setTimeout(function(){ location.replace(location.href + '&reloaded=1'); }, 5); }}, true);"

            history = ''.join('<div class="message-out">%s</div>' % m['text'].replace('&', '&amp;').replace('<', '&lt;') for m in SENT if m['phone'] == phone)
            # Photos/videos like WhatsApp Web: + button -> file box -> preview with a caption box -> Enter or Send.
            # 97157…: Enter in the caption is ignored (only the Send button works); 97159…: reloads right after Enter.
            media_js = '''
document.getElementById('att').addEventListener('click', function(){ document.getElementById('menu').style.display='block'; });
document.getElementById('mf').addEventListener('change', function(){
  var f=this.files[0]; if(!f) return;
  var p=document.createElement('div'); p.id='prev';
  p.innerHTML='<div contenteditable="true" aria-label="Add a caption" id="cap" style="white-space:pre-wrap"></div><div role="button" aria-label="Send" id="msend"><span data-icon="wds-ic-send-filled"></span></div>';
  document.body.appendChild(p);
  var cap=document.getElementById('cap');
  function sendMedia(){ var t=cap.innerText.replace(/\\n$/,''); fetch('/record',{method:'POST',body:JSON.stringify({phone:PHONE,text:t,media:f.name,size:f.size,type:f.type}),keepalive:true}).then(function(){
      if(MEDIA_RELOAD){ location.replace(location.href + '&reloaded=1'); return; }
      setTimeout(function(){ p.remove(); var o=document.createElement('div'); o.className='message-out'; o.textContent=t; document.getElementById('main').appendChild(o); }, 80); }); }
  cap.addEventListener('keydown',function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); if(MEDIA_ENTER){ sendMedia(); } }});
  document.getElementById('msend').addEventListener('click', sendMedia);
});'''
            media_enter = 'false' if phone.startswith('97157') else 'true'
            media_reload = 'true' if phone.startswith('97159') and 'reloaded' not in q else 'false'
            return self.send_html('''<div id="pane-side"></div><div id="main">''' + history + '''</div>
<footer><div contenteditable="true" data-tab="10" id="box" style="white-space:pre-wrap">%s</div>
<button aria-label="Send" id="send"><span data-icon="send"></span></button>
<button aria-label="Attach" id="att"><span data-icon="plus-rounded">+</span></button>
<div id="menu" style="display:none"><input type="file" id="mf" accept="image/*,video/mp4,video/3gpp,video/quicktime" style="display:none"></div></footer>
<script>
var box=document.getElementById('box'), ENTER_OK=%s, PHONE=%s, MEDIA_ENTER=%s, MEDIA_RELOAD=%s;
function send(){ var t=box.innerText; fetch('/record',{method:'POST',body:JSON.stringify({phone:%s,text:t}),keepalive:true}).then(function(){ setTimeout(function(){ box.innerText=''; }, 50); }); }
box.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); if(ENTER_OK) send(); }});
document.getElementById('send').addEventListener('click', send);
%s
%s
</script>''' % (esc, enter_ok, json.dumps(phone), media_enter, media_reload, json.dumps(phone), reload_js, media_js))
        return self.send_html('<div id="pane-side">chats</div>')
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); d = json.loads(self.rfile.read(n))
        SENT.append(d); self.send_response(200); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
