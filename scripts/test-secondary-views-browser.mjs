import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const indexPath = path.join(distRoot, 'index.html');
const viewNames = ['Integrations', 'Models', 'Automations', 'Skills', 'Memory'];
const lazyChunkNames = [...viewNames, 'Settings', 'CommandPanel', 'GitPanel'];
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

async function assertViewChunks() {
  await stat(indexPath).catch(() => {
    throw new Error('dist/index.html absent : exécutez `pnpm build:web` avant ce test.');
  });
  const assets = await readdir(path.join(distRoot, 'assets'));
  for (const chunkName of lazyChunkNames) {
    assert.ok(assets.some(file => file.startsWith(`${chunkName}-`) && file.endsWith('.js')),
      `Le build doit émettre un chunk JavaScript distinct pour ${chunkName}.`);
  }
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
      if (pathname.startsWith('/api/')) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end('{"error":"Aucun connecteur de test"}');
        return;
      }
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

  close() { this.socket.close(); }
}

async function evaluate(devtools, expression) {
  const result = await devtools.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
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
    return [{ url: url.pathname, decodedBytes: entry.decodedBodySize, encodedBytes: entry.encodedBodySize }];
  } catch { return []; }
})`;

async function main() {
  const executable = await chromiumPath();
  await assertViewChunks();
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Impossible d’obtenir le port du serveur de test.');
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'open-cortex-secondary-views-cdp-'));
  let chrome;
  let devtools;
  try {
    chrome = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
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
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');
    await devtools.send('Network.enable');
    await devtools.send('Network.setCacheDisabled', { cacheDisabled: true });
    await devtools.send('Page.navigate', { url: appUrl });
    await waitFor(devtools, `Boolean(document.querySelector('.rail'))`, 'interface principale');
    await sleep(250);

    const initial = await evaluate(devtools, jsResources);
    const initialBytes = initial.reduce((sum, resource) => sum + resource.decodedBytes, 0);
    for (const chunkName of lazyChunkNames) {
      assert.equal(initial.some(resource => resource.url.includes(`/${chunkName}-`)), false,
        `${chunkName} ne doit pas être téléchargé au démarrage.`);
    }

    const modelStart = Date.now();
    await evaluate(devtools, `document.querySelector('button[aria-label="Modèles & clés"]')?.click()`);
    await waitFor(devtools, `performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.includes('/Models-'))`, 'téléchargement différé de Models');
    const viewLoadMs = Date.now() - modelStart;
    const afterModels = await evaluate(devtools, jsResources);
    const initialUrls = new Set(initial.map(resource => resource.url));
    const additional = afterModels.filter(resource => !initialUrls.has(resource.url));
    const modelChunk = additional.find(resource => resource.url.includes('/Models-'));
    assert.ok(modelChunk, 'Le chunk Models doit être demandé après le clic de navigation.');
    assert.ok(initialBytes < afterModels.reduce((sum, resource) => sum + resource.decodedBytes, 0),
      'Le chargement de Models doit être différé après le démarrage à froid.');

    const settingsStart = Date.now();
    await evaluate(devtools, `document.querySelector('button[aria-label="Connexion et paramètres"]')?.click()`);
    await waitFor(devtools, `performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.includes('/Settings-'))`, 'téléchargement différé de Settings');
    await waitFor(devtools, `document.querySelector('.section-heading h1')?.textContent.includes('Connexion & paramètres')`, 'affichage de Settings');
    const settingsLoadMs = Date.now() - settingsStart;
    const afterSettings = await evaluate(devtools, jsResources);
    const beforeSettingsUrls = new Set(afterModels.map(resource => resource.url));
    const settingsAdditional = afterSettings.filter(resource => !beforeSettingsUrls.has(resource.url));
    const settingsChunk = settingsAdditional.find(resource => resource.url.includes('/Settings-'));
    assert.ok(settingsChunk, 'Le chunk Settings doit être demandé après l’ouverture de sa vue.');
    const trayPanelsRemainDeferred = ['CommandPanel', 'GitPanel'].every(name =>
      !afterSettings.some(resource => resource.url.includes(`/${name}-`)));
    assert.ok(trayPanelsRemainDeferred, 'Les panneaux du tiroir ne doivent pas être demandés par la navigation vers Settings.');

    const browserVersion = await devtools.send('Browser.getVersion');
    console.log(JSON.stringify({
      browser: browserVersion.product,
      emittedLazyChunks: lazyChunkNames,
      coldStart: { javascriptFiles: initial.length, decodedBytes: initialBytes, urls: initial.map(resource => resource.url) },
      firstModelsView: { elapsedMs: viewLoadMs, additionalFiles: additional.length, additionalDecodedBytes: additional.reduce((sum, resource) => sum + resource.decodedBytes, 0), chunk: modelChunk },
      settingsView: { elapsedMs: settingsLoadMs, additionalFiles: settingsAdditional.length, additionalDecodedBytes: settingsAdditional.reduce((sum, resource) => sum + resource.decodedBytes, 0), chunk: settingsChunk },
      trayPanels: { absentFromColdStart: true, absentAfterSettingsNavigation: trayPanelsRemainDeferred, note: 'Le test ne simule pas de connecteur/projet: ProjectGate empêche le montage de CommandPanel et GitPanel. Leurs chunks distincts et leur absence au chargement à froid sont vérifiés.' },
      note: 'Les vues Integrations, Automations, Skills et Memory restent protégées par ProjectGate; leurs chunks sont émis et absents du démarrage, mais aucun connecteur/projet réel n’est fabriqué pour le test.'
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
