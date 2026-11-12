#!/usr/bin/env python3
"""Télécharge un modèle Ollama local. Aucun fournisseur facturé ni clé API."""
import json
import sys
import time
import urllib.request

model = sys.argv[1] if len(sys.argv) > 1 else 'qwen3:1.7b'
req = urllib.request.Request('http://127.0.0.1:11434/api/pull', data=json.dumps({'model': model, 'stream': True}).encode(), headers={'Content-Type': 'application/json'})
last = 0.0
with urllib.request.urlopen(req, timeout=1200) as response:
    for line in response:
        info = json.loads(line)
        if 'error' in info:
            raise RuntimeError(info['error'])
        now = time.monotonic()
        if now - last > 5 or info.get('status') == 'success':
            print(json.dumps(info), flush=True)
            last = now
with urllib.request.urlopen('http://127.0.0.1:11434/api/tags', timeout=20) as response:
    print(response.read().decode(), flush=True)
