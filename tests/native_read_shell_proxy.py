"""Usage: SHELL_DIR=<wizard-ux web dir> python tests/native_read_shell_proxy.py <stage state.json> <port>
Same-origin host for the evidence screenshots: /__host?skin=<id> is a Wizard shell host page (real Appearance v1 skin
tokens from SHELL_DIR/core/skins.js, real appearance-host.js) framing Messenger; /wizard-os-home/* serves the shell files;
everything else is proxied to the staged Messenger with its owner session. Synthetic data only."""
import base64, http.client, json, os, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SHELL = os.environ['SHELL_DIR']
state = json.load(open(sys.argv[1])); port = int(sys.argv[2])
JS = ("const fs=require('fs'),vm=require('vm');const src=fs.readFileSync(process.argv[1]+'/core/skins.js','utf8');"
      "const table=src.slice(src.indexOf('  const SKINS = ['),src.indexOf('  // Each skin'));"
      "console.log(JSON.stringify(vm.runInNewContext('const T=o=>o;'+table+';SKINS').filter(s=>['nebula','signal'].includes(s.id)).map(s=>({id:s.id,t:s.t}))))")
PALETTES = subprocess.run(['node', '-e', JS, SHELL], capture_output=True, text=True, check=True).stdout.strip()
TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2'}


def host(skin):
    b64 = base64.b64encode(PALETTES.encode()).decode()
    return ('<!doctype html><html data-skin="%s"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<link rel="stylesheet" href="/wizard-os-home/core/skins.css"><script>window.WizCore={apps:()=>({APPS:[{url:"/messenger/"}]})};'
            'window.setFixtureSkin=id=>{const s=JSON.parse(atob("%s")).find(s=>s.id===id);for(const[k,v]of Object.entries(s.t))document.documentElement.style.setProperty("--"+k,v);'
            'document.documentElement.dataset.skin=id;window.WizAppearance?.sync()};setFixtureSkin("%s")</script>'
            '<script src="/wizard-os-home/core/appearance-host.js" defer></script><style>html,body{margin:0;height:100%%;background:var(--bg)}'
            'iframe{width:100%%;height:100%%;border:0;display:block}</style></head><body><div class="win" style="height:100%%"><iframe src="/messenger/" title="Messenger"></iframe></div></body></html>' % (skin, b64, skin)).encode()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a): pass

    def send(self, status, ctype, body):
        self.send_response(status); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def handle_any(self):
        url = urlsplit(self.path)
        if url.path == '/__host':
            return self.send(200, 'text/html', host((parse_qs(url.query).get('skin') or ['nebula'])[0]))
        if url.path.startswith('/wizard-os-home/'):
            f = os.path.join(SHELL, url.path[len('/wizard-os-home/'):])
            if os.path.isfile(f):
                return self.send(200, TYPES.get(os.path.splitext(f)[1], 'application/octet-stream'), open(f, 'rb').read())
            return self.send(404, 'text/plain', b'')
        if url.path.startswith('/messenger/'):
            self.path = '/' + url.path[len('/messenger/'):] + ('?' + url.query if url.query else '')
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n) if n else None
        conn = http.client.HTTPConnection('127.0.0.1', state['port'], timeout=40)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'cookie', 'connection')}
        headers['Cookie'] = 'wizard_messenger_session=' + state['cookie']; headers['Host'] = '127.0.0.1:%d' % state['port']
        headers['Origin'] = state['origin']
        conn.request(self.command, self.path, body=body, headers=headers)
        r = conn.getresponse(); data = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ('content-length', 'transfer-encoding', 'connection', 'set-cookie'): self.send_header(k, v)
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
