#!/usr/bin/env python3
"""Produit une archive source reproductible par liste autorisée, sans données locales."""
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
out = root / 'artifacts' / 'open-cortex-coder-source-0.1.0.zip'
out.parent.mkdir(exist_ok=True)
folders = {'client', 'server', 'desktop', 'shared', 'tests', 'scripts', 'public', 'docs'}
files = {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.desktop.json', 'vite.config.ts', 'index.html', 'LICENSE', 'README.md', '.env.example', '.gitignore', 'plan.md', 'TODO.md', 'specification.txt', 'app.config.ts', 'vitest.config.ts'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if not path.is_file() or path.is_symlink():
            continue
        if rel.parts[0] not in folders and str(rel) not in files:
            continue
        if any(p in {'node_modules', '.git', '.cortex', '__pycache__', 'artifacts'} for p in rel.parts):
            continue
        if path.suffix in {'.db', '.log', '.bin'} or path.name.endswith('-results.txt') or path.name.startswith('.env') and path.name != '.env.example':
            continue
        archive.write(path, f'open-cortex-coder/{rel}')
print(out)
print(f'{out.stat().st_size} bytes')
