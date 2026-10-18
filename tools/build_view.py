#!/usr/bin/env python3
"""Validate the editable, unbundled view; no generated or vendored UI framework."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
ROOT=Path(__file__).resolve().parent.parent
STATIC=ROOT/'static'
required=['index.html','app.css','app.js','unified.css','unified.js','qr.js']
for name in required:
    path=STATIC/name
    if not path.is_file() or not path.stat().st_size:
        raise SystemExit('Missing view source: '+name)
html=(STATIC/'index.html').read_text()
if 'app.css' not in html or 'app.js' not in html:
    raise SystemExit('The view must load its own stylesheet and script')
if shutil.which('node'):
    for name in ['app.js','unified.js','qr.js']:
        subprocess.run(['node','--input-type=module','--check'],input=(STATIC/name).read_text(),text=True,check=True)
print(json.dumps({'view':'static','source_equals_dist':True,'files':{name:hashlib.sha256((STATIC/name).read_bytes()).hexdigest() for name in required}},indent=2))
