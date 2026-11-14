import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const indexPath = path.join(distRoot, 'index.html');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chromiumPath() {
  const candidates = process.env.CHROMIUM_PATH
    ? [process.env.CHROMIUM_PATH]
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Chromium introuvable. Installez Chromium ou définissez CHROMIUM_PATH.');
}

function createStaticServer() {
  const mime = new Map([
    ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'], ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ]);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      let target = path.resolve(distRoot, `.${pathname}`);
      if (target !== distRoot && !target.startsWith(`${distRoot}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      try {
        if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      } catch {
        target = indexPath;
      }
      let body;
      try {
        body = await readFile(target);
      } catch {
        body = await readFile(indexPath);
        target = indexPath;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': body.length,
        'content-type': mime.get(path.extname(target)) || 'application/octet-stream',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : 'Static test server error');
    }
  });
}

class DevTools {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout de connexion au protocole DevTools')), 8000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Connexion DevTools refusée')); }, { once: true });
    });
    this.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout DevTools: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  close() { this.socket.close(); }
}

async function evaluate(devtools, expression) {
  let result;
  try {
    result = await devtools.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    throw new Error(`Runtime.evaluate(${expression.slice(0, 90)}): ${error instanceof Error ? error.message : error}`);
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(devtools, expression, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(devtools, expression);
      if (value) return value;
    } catch { /* A pending navigation may temporarily replace the execution context. */ }
    await sleep(50);
  }
  throw new Error(`Délai dépassé en attendant : ${description}`);
}

const jsResources = `performance.getEntriesByType('resource').flatMap(entry => {
  try {
    const url = new URL(entry.name);
    if (url.origin !== location.origin || !url.pathname.endsWith('.js')) return [];
    return [{ url: url.pathname, bytes: entry.decodedBodySize }];
  } catch { return []; }
})`;

async function main() {
  const executable = await chromiumPath();
  await stat(indexPath).catch(() => {
    throw new Error('dist/index.html absent : exécutez `pnpm build` avant ce test.');
  });

  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Impossible d’obtenir le port du serveur de test.');
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'open-cortex-monaco-cdp-'));
  let chrome;
  let devtools;
  try {
    chrome = spawn(executable, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    let debugPort;
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (!debugPort && Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error(`Chromium s’est arrêté prématurément (${chrome.exitCode}).`);
      try { debugPort = Number((await readFile(portFile, 'utf8')).split('\n')[0]); }
      catch { await sleep(50); }
    }
    if (!debugPort) throw new Error('Chromium n’a pas exposé son port DevTools dans les 15 secondes.');
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
    const page = targets.find(target => target.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('Page Chromium DevTools introuvable.');
    devtools = new DevTools(page.webSocketDebuggerUrl);
    await devtools.connect();
    const failedRequests = [];
    devtools.on('Network.loadingFailed', event => failedRequests.push(event));
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');
    await devtools.send('Network.enable');
    await devtools.send('Network.setCacheDisabled', { cacheDisabled: true });

    await devtools.send('Page.navigate', { url: appUrl });
    await waitFor(devtools, `Boolean(document.querySelector('.rail'))`, 'interface principale');
    await sleep(300);
    const initial = await evaluate(devtools, jsResources);
    const initialBytes = initial.reduce((sum, resource) => sum + resource.bytes, 0);
    assert.equal(await evaluate(devtools, `Boolean(document.querySelector('.workbench'))`), false,
      'Workbench ne doit pas être monté avant l’ouverture de l’éditeur.');

    const firstOpenStarted = Date.now();
    await evaluate(devtools, `document.querySelector('button[aria-label="Éditeur"]')?.click()`);
    await waitFor(devtools, `Boolean(document.querySelector('.workbench'))`, 'premier montage de Workbench');
    const firstOpenMs = Date.now() - firstOpenStarted;
    await sleep(250);
    const afterOpen = await evaluate(devtools, jsResources);
    const initialUrls = new Set(initial.map(resource => resource.url));
    const additional = afterOpen.filter(resource => !initialUrls.has(resource.url));
    const additionalBytes = additional.reduce((sum, resource) => sum + resource.bytes, 0);
    assert.ok(additional.length > 0, 'La première ouverture doit demander des modules JavaScript différés.');
    assert.ok(initialBytes < afterOpen.reduce((sum, resource) => sum + resource.bytes, 0),
      'Les modules de l’éditeur ne doivent pas tous faire partie du chargement à froid.');

    await evaluate(devtools, `(() => { window.__openCortexWorkbench = document.querySelector('.workbench'); return Boolean(window.__openCortexWorkbench); })()`);
    await evaluate(devtools, `document.querySelector('button[aria-label="Vue d’ensemble Open Cortex"]')?.click()`);
    await waitFor(devtools, `document.querySelector('.persistent-editor')?.hidden === true`, 'masquage de l’éditeur');
    const sameAfterHide = await evaluate(devtools, `document.querySelector('.workbench') === window.__openCortexWorkbench`);
    await evaluate(devtools, `document.querySelector('button[aria-label="Éditeur"]')?.click()`);
    await waitFor(devtools, `document.querySelector('.persistent-editor')?.hidden === false`, 'retour à l’éditeur');
    const sameAfterReturn = await evaluate(devtools, `document.querySelector('.workbench') === window.__openCortexWorkbench`);
    assert.equal(sameAfterHide, true, 'Workbench doit rester monté lorsque l’éditeur est masqué.');
    assert.equal(sameAfterReturn, true, 'Le retour à l’éditeur doit conserver la même instance Workbench.');

    await devtools.send('Page.reload', { ignoreCache: true });
    await waitFor(devtools, `performance.getEntriesByType('navigation')[0]?.type === 'reload' && Boolean(document.querySelector('.rail'))`, 'rechargement complet de l’interface');
    await sleep(200);
    const failuresBefore = failedRequests.length;
    await devtools.send('Network.setBlockedURLs', { urls: ['*.js'] });
    await evaluate(devtools, `document.querySelector('button[aria-label="Éditeur"]')?.click()`);
    await waitFor(devtools, `Boolean(document.querySelector('.editor-lazy-error[role="alert"]'))`, 'message d’échec du chargement différé');
    assert.ok(failedRequests.length > failuresBefore, 'Le test doit effectivement bloquer une requête de module.');
    await devtools.send('Network.setBlockedURLs', { urls: [] });
    await evaluate(devtools, `document.querySelector('.editor-lazy-error button[aria-label="Réessayer le chargement de l’éditeur"]')?.click()`);
    await waitFor(devtools, `Boolean(document.querySelector('.workbench'))`, 'reprise après nouvel essai du chargement');

    const browserVersion = await devtools.send('Browser.getVersion');
    console.log(JSON.stringify({
      browser: browserVersion.product,
      coldStart: { javascriptFiles: initial.length, decodedBytes: initialBytes },
      firstEditorOpen: { elapsedMs: firstOpenMs, additionalFiles: additional.length, additionalDecodedBytes: additionalBytes, files: additional },
      stateAcrossViews: { sameInstanceWhenHidden: sameAfterHide, sameInstanceOnReturn: sameAfterReturn },
      recovery: { blockedLoadDisplayedError: true, retrySucceeded: true, blockedModuleRequests: failedRequests.length - failuresBefore },
    }, null, 2));
  } finally {
    devtools?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3000)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
