import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSourcePath = path.join(projectRoot, 'client', 'App.tsx');
const settingsSourcePath = path.join(projectRoot, 'client', 'views', 'Settings.tsx');
const connectionPanelSourcePath = path.join(projectRoot, 'client', 'components', 'ConnectionPanel.tsx');
const baseUrl = process.env.CONTEXT_PROFILE_URL || 'http://127.0.0.1:3000';
const iterations = Number(process.env.CONTEXT_PROFILE_ITERATIONS || 12);
const connectionProbePort = 49151;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

async function assertLoopbackProbePortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error(`Impossible de vérifier que 127.0.0.1:${port} est fermé.`));
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Le port de stimulus 127.0.0.1:${port} est utilisé; essai annulé.`));
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

function chromiumPath() {
  const candidates = process.env.CHROMIUM_PATH
    ? [process.env.CHROMIUM_PATH]
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Chromium introuvable. Installez Chromium ou définissez CHROMIUM_PATH.');
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
  const result = await devtools.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(devtools, expression, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(devtools, expression);
      if (value) return value;
    } catch { /* A navigation or Vite module transform may replace the execution context. */ }
    await sleep(50);
  }
  let bodyText = '';
  try { bodyText = String(await evaluate(devtools, 'document.body.innerText')).slice(0, 500); }
  catch { /* La page peut ne plus avoir de contexte JavaScript. */ }
  throw new Error(`Délai dépassé en attendant : ${description}${bodyText ? `; DOM: ${bodyText}` : ''}`);
}

function createProfileSources(id, appSource, settingsSource, connectionPanelSource) {
  const hookImport = "import { useConnection, useBootstrap, useWorkspace, useAgent, useNavigation, useNavigationActions, useNotice, useAppActions, viewLabels, type View } from './state';";
  const legacyImport = "import { useApp, useNotice, useAppActions, viewLabels, type View } from './state';";
  const settingsImport = "import('./views/Settings').then(({ Settings }) => ({ default: Settings }))";
  const connectionPanelImport = "import { ConnectionPanel } from '../components/ConnectionPanel';";
  const connectionPanelExport = 'export function ConnectionPanel() {';
  const connectionPanelElement = '<ConnectionPanel />';
  const hookBlock = `    const { connected } = useConnection();\n    const { bootstrap } = useBootstrap();\n    const { project, projectId, setProjectId } = useWorkspace();\n    const { mode } = useAgent();\n    const { view } = useNavigation();\n    const { setView } = useNavigationActions();`;
  const legacyBlock = '    const { connected, bootstrap, project, projectId, setProjectId, mode, view, setView } = useApp();';
  const componentMarker = 'function App() {';
  const exportMarker = 'export default memo(App);';

  assert.ok(appSource.includes(hookImport), 'Import des hooks spécialisés inattendu dans client/App.tsx.');
  assert.ok(appSource.includes(hookBlock), 'Bloc des abonnements spécialisés inattendu dans client/App.tsx.');
  assert.ok(appSource.includes(componentMarker) && appSource.includes(exportMarker), 'Déclaration App inattendue.');
  assert.ok(appSource.includes(settingsImport), 'Import lazy de Settings inattendu dans client/App.tsx.');
  assert.ok(settingsSource.includes(connectionPanelImport) && settingsSource.includes(connectionPanelElement), 'Structure Settings/ConnectionPanel inattendue.');
  assert.ok(connectionPanelSource.includes(connectionPanelExport), 'Déclaration ConnectionPanel inattendue.');

  const makeApp = (side, legacy) => {
    let source = appSource;
    if (legacy) {
      source = source.replace(hookImport, legacyImport);
      source = source.replace(hookBlock, legacyBlock);
    }
    source = source.replace(settingsImport, `import('./views/${sideSettingsFile(side).replace(/\.tsx$/, '')}').then(({ Settings }) => ({ default: Settings }))`);
    source = source.replace(componentMarker, `function ${side === 'current' ? 'FocusedProfileApp' : 'AggregateProfileApp'}() {\n    window.__contextProfile.appRender('${side}');`);
    source = source.replace(exportMarker, `export default memo(${side === 'current' ? 'FocusedProfileApp' : 'AggregateProfileApp'});`);
    return source;
  };

  const currentFile = `App.context-profile-current-${id}.tsx`;
  const legacyFile = `App.context-profile-aggregate-${id}.tsx`;
  const sideSettingsFile = side => `Settings.context-profile-${side}-${id}.tsx`;
  const sideConnectionPanelFile = side => `ConnectionPanel.context-profile-${side}-${id}.tsx`;
  const runnerFile = `context-profile-runner-${id}.tsx`;
  const htmlFile = `context-profile-${id}.html`;
  const makeConnectionPanel = side => {
    const marker = connectionPanelExport;
    const replacement = `${marker}\n    window.__contextProfile.panelRender('${side}');`;
    return connectionPanelSource.replace(marker, replacement);
  };
  const makeSettings = side => {
    const panelModule = `../components/${sideConnectionPanelFile(side).replace(/\.tsx$/, '')}`;
    const profiler = `<Profiler id="connectionPanel.${side}" onRender={(_id, phase, actualDuration) => window.__contextProfile.onRender('connectionPanel.${side}', phase, actualDuration)}><ConnectionPanel /></Profiler>`;
    return `import { Profiler } from 'react';\n${settingsSource}`
      .replace(connectionPanelImport, `import { ConnectionPanel } from '${panelModule}';`)
      .replace(connectionPanelElement, profiler);
  };
  const runner = `
import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider, useAgent, useAppActions, useConnection, useNavigation, useNavigationActions, useUnsaved, useUnsavedActions, useWorkspace } from './state';
import FocusedApp from './${currentFile.replace(/\.tsx$/, '')}';
import AggregateApp from './${legacyFile.replace(/\.tsx$/, '')}';
import './styles.css';
import './responsive.css';

declare global {
  interface Window {
    __contextProfile: {
      ready: boolean;
      action: string;
      appCounts: Record<string, number>;
      panelFunctionCounts: Record<string, number>;
      events: Array<{ id: string; phase: string; actualDuration: number; action: string }>;
      errors: string[];
      connectionResults: Record<string, boolean | null>;
      appRender: (side: string) => void;
      panelRender: (side: string) => void;
      onRender: (id: string, phase: string, actualDuration: number) => void;
      reset: (action: string) => void;
    };
  }
}

window.__contextProfile = {
  ready: false,
  action: 'mount',
  appCounts: { current: 0, legacy: 0 },
  panelFunctionCounts: { current: 0, legacy: 0 },
  events: [],
  errors: [],
  connectionResults: { current: null, legacy: null },
  appRender(side) { this.appCounts[side] = (this.appCounts[side] || 0) + 1; },
  panelRender(side) { this.panelFunctionCounts[side] = (this.panelFunctionCounts[side] || 0) + 1; },
  onRender(id, phase, actualDuration) {
    this.events.push({ id, phase, actualDuration, action: this.action });
  },
  reset(action) {
    this.action = action;
    this.appCounts = { current: 0, legacy: 0 };
    this.panelFunctionCounts = { current: 0, legacy: 0 };
    this.events = [];
    this.errors = [];
  },
};

function Controls({ side }: { side: 'current' | 'legacy' }) {
  const { connect } = useConnection();
  const unsaved = useUnsaved();
  const { setUnsaved } = useUnsavedActions();
  const { mode, setMode } = useAgent();
  const { view } = useNavigation();
  const { setView } = useNavigationActions();
  const { notify, clearNotice } = useAppActions();
  let sequence = 0;
  const triggerConnect = () => {
    window.__contextProfile.connectionResults[side] = null;
    void connect('http://127.0.0.1:${connectionProbePort}', 'profilage-local-nonsecret')
      .then(ok => { window.__contextProfile.connectionResults[side] = ok; })
      .catch(() => { window.__contextProfile.connectionResults[side] = false; });
  };
  return <div className="context-profile-controls" aria-hidden="true">
    <button id={side + '-notice'} onClick={() => notify('notification de profilage ' + side + ' ' + (++sequence), 'success')}>notice</button>
    <button id={side + '-navigation'} onClick={() => setView(view === 'dashboard' ? 'projects' : 'dashboard')}>navigation</button>
    <button id={side + '-agent'} onClick={() => setMode(mode === 'ask' ? 'plan' : 'ask')}>agent</button>
    <button id={side + '-workspace'} onClick={() => setUnsaved(!unsaved)}>workspace</button>
    <button id={side + '-settings'} onClick={() => setView('settings')}>settings</button>
    <button id={side + '-clear-notice'} onClick={clearNotice}>clear</button>
    <button id={side + '-connection'} onClick={triggerConnect}>connection</button>
  </div>;
}

function onProfileRender(id: string, phase: string, actualDuration: number) {
  window.__contextProfile.onRender(id, phase, actualDuration);
}

function ProfileRoot({ side, AppComponent }: { side: 'current' | 'legacy'; AppComponent: React.ComponentType }) {
  return <AppProvider>
    <Profiler id={'app.' + side} onRender={onProfileRender}>
      <AppComponent />
    </Profiler>
    <Controls side={side} />
  </AppProvider>;
}

createRoot(document.getElementById('focused')!).render(<ProfileRoot side="current" AppComponent={FocusedApp} />);
createRoot(document.getElementById('aggregate')!).render(<ProfileRoot side="legacy" AppComponent={AggregateApp} />);
window.__contextProfile.ready = true;
`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profilage temporaire des contextes React</title><style>
html,body{margin:0;min-height:100%;overflow:hidden;background:#0a1018}.profile-mount{position:fixed;top:0;width:50vw;height:100vh;overflow:hidden}.profile-mount .app{height:100vh}.profile-controls{position:fixed;left:-10000px;top:0;display:none}.profile-label{position:fixed;z-index:100;top:4px;padding:3px 6px;background:#122034;color:#fff;font:12px monospace}.profile-label.left{left:4px}.profile-label.right{left:50vw}
</style></head><body><div class="profile-label left">hooks ciblés</div><div class="profile-label right">useApp agrégé</div><div id="focused" class="profile-mount"></div><div id="aggregate" class="profile-mount" style="left:50vw"></div><script type="module" src="/client/${runnerFile}"></script></body></html>`;
  return {
    currentFile,
    legacyFile,
    currentSettingsFile: sideSettingsFile('current'),
    legacySettingsFile: sideSettingsFile('legacy'),
    currentConnectionPanelFile: sideConnectionPanelFile('current'),
    legacyConnectionPanelFile: sideConnectionPanelFile('legacy'),
    runnerFile,
    htmlFile,
    currentSource: makeApp('current', false),
    legacySource: makeApp('legacy', true),
    currentSettingsSource: makeSettings('current'),
    legacySettingsSource: makeSettings('legacy'),
    currentConnectionPanelSource: makeConnectionPanel('current'),
    legacyConnectionPanelSource: makeConnectionPanel('legacy'),
    runner,
    html,
  };
}

function summarize(events, action, side, component = 'app') {
  const profileId = component === 'app' ? `app.${side}` : `${component}.${side}`;
  const samples = events.filter(event => event.action === action && event.id === profileId).map(event => event.actualDuration).sort((a, b) => a - b);
  if (!samples.length) return { commits: 0, totalMs: 0, medianMs: 0, p95Ms: 0, samplesMs: [] };
  const median = samples.length % 2
    ? samples[(samples.length - 1) / 2]
    : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
  return {
    commits: samples.length,
    totalMs: Number(samples.reduce((sum, value) => sum + value, 0).toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
    samplesMs: samples.map(value => Number(value.toFixed(3))),
  };
}

async function main() {
  const chromium = chromiumPath();
  const reactVersion = require('react/package.json').version;
  const reactDomVersion = require('react-dom/package.json').version;
  assert.equal(reactVersion, reactDomVersion, 'react/react-dom versions must match.');
  assert.ok(Number.isInteger(iterations) && iterations >= 3 && iterations <= 100, 'CONTEXT_PROFILE_ITERATIONS must be 3–100.');

  await assertLoopbackProbePortClosed(connectionProbePort);
  const rootResponse = await fetch(baseUrl).catch(() => null);
  const viteResponse = await fetch(`${baseUrl}/@vite/client`).catch(() => null);
  assert.ok(rootResponse?.ok && viteResponse?.ok, `Vite dev server indisponible sur ${baseUrl}; démarrez-le avant le profilage.`);

  const [appSource, settingsSource, connectionPanelSource] = await Promise.all([
    readFile(appSourcePath, 'utf8'),
    readFile(settingsSourcePath, 'utf8'),
    readFile(connectionPanelSourcePath, 'utf8'),
  ]);
  const id = randomUUID().replaceAll('-', '');
  const source = createProfileSources(id, appSource, settingsSource, connectionPanelSource);
  const generated = [
    [path.join(projectRoot, 'client', source.currentFile), source.currentSource],
    [path.join(projectRoot, 'client', source.legacyFile), source.legacySource],
    [path.join(projectRoot, 'client', 'views', source.currentSettingsFile), source.currentSettingsSource],
    [path.join(projectRoot, 'client', 'views', source.legacySettingsFile), source.legacySettingsSource],
    [path.join(projectRoot, 'client', 'components', source.currentConnectionPanelFile), source.currentConnectionPanelSource],
    [path.join(projectRoot, 'client', 'components', source.legacyConnectionPanelFile), source.legacyConnectionPanelSource],
    [path.join(projectRoot, 'client', source.runnerFile), source.runner],
    [path.join(projectRoot, source.htmlFile), source.html],
  ];
  for (const [file] of generated) {
    try { await stat(file); throw new Error(`Refus d’écraser un fichier existant: ${file}`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  for (const [file, contents] of generated) await writeFile(file, contents, { flag: 'wx' });

  const profile = await mkdtemp(path.join(os.tmpdir(), 'open-cortex-context-profile-'));
  let chrome;
  let devtools;
  try {
    chrome = spawn(chromium, [
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
    assert.ok(page?.webSocketDebuggerUrl, 'Page Chromium DevTools introuvable.');
    devtools = new DevTools(page.webSocketDebuggerUrl);
    await devtools.connect();
    const browserErrors = [];
    devtools.on('Runtime.exceptionThrown', event => browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Exception JavaScript'));
    devtools.on('Runtime.consoleAPICalled', event => {
      if (event.type === 'error') browserErrors.push(event.args?.map(arg => arg.value || arg.description || '').join(' '));
    });
    await devtools.send('Page.enable');
    await devtools.send('Runtime.enable');
    await devtools.send('Network.enable');
    await devtools.send('Network.setCacheDisabled', { cacheDisabled: true });
    await devtools.send('Page.navigate', { url: `${baseUrl}/${source.htmlFile}` });
    await waitFor(devtools, 'Boolean(window.__contextProfile?.ready)', 'montage des deux variantes App');
    try {
      await waitFor(devtools, 'Boolean(document.querySelector(".app.theme-dark"))', 'rendu de l’interface');
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}; erreurs JS: ${browserErrors.join(' | ') || 'aucune capturée'}`);
    }
    await sleep(300);

    const runAction = async (action, repetitions = iterations) => {
      if (action === 'connection') {
        for (const side of ['current', 'legacy']) {
          await evaluate(devtools, `document.querySelector('#${side}-clear-notice').click()`);
          await evaluate(devtools, `document.querySelector('#${side}-settings').click()`);
        }
        await waitFor(devtools, 'window.__contextProfile.panelFunctionCounts.current > 0 && window.__contextProfile.panelFunctionCounts.legacy > 0', 'montage réel de ConnectionPanel dans Settings');
        await evaluate(devtools, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      }
      await evaluate(devtools, `window.__contextProfile.reset(${JSON.stringify(action)})`);
      for (let index = 0; index < repetitions; index += 1) {
        const order = index % 2 === 0 ? ['current', 'legacy'] : ['legacy', 'current'];
        for (const side of order) {
          await evaluate(devtools, `document.querySelector('#${side}-${action}').click()`);
          if (action === 'connection') {
            await waitFor(devtools, `window.__contextProfile.connectionResults.${side} !== null`, `résultat de l’essai local ${side}`, 10000);
          } else {
            await evaluate(devtools, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          }
        }
      }
      await sleep(100);
      return evaluate(devtools, 'JSON.parse(JSON.stringify(window.__contextProfile))');
    };

    // Warm up both app trees, Vite modules and state transitions before collecting samples.
    for (const action of ['notice', 'navigation', 'agent', 'workspace']) {
      await runAction(action, 2);
    }
    for (const side of ['current', 'legacy']) {
      await evaluate(devtools, `document.querySelector('#${side}-clear-notice').click()`);
    }
    await evaluate(devtools, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

    const results = {};
    for (const action of ['notice', 'navigation', 'agent', 'workspace']) {
      const profileData = await runAction(action, iterations);
      results[action] = {
        iterationsPerVariant: iterations,
        appFunctionRenders: { focusedHooks: profileData.appCounts.current, aggregateUseApp: profileData.appCounts.legacy },
        reactProfiler: {
          focusedHooks: summarize(profileData.events, action, 'current'),
          aggregateUseApp: summarize(profileData.events, action, 'legacy'),
        },
      };
    }

    // This makes a real failed HTTP attempt to a verified closed loopback port; no connector is mocked and no token is sent on /api/health.
    const connectionData = await runAction('connection', 1);
    results.connectionFailureStimulus = {
      outcome: connectionData.connectionResults,
      appFunctionRenders: { focusedHooks: connectionData.appCounts.current, aggregateUseApp: connectionData.appCounts.legacy },
      connectionPanelFunctionRenders: { focusedHooks: connectionData.panelFunctionCounts.current, aggregateUseApp: connectionData.panelFunctionCounts.legacy },
      reactProfiler: {
        focusedHooks: summarize(connectionData.events, 'connection', 'current'),
        aggregateUseApp: summarize(connectionData.events, 'connection', 'legacy'),
      },
      connectionPanelProfiler: {
        focusedHooks: summarize(connectionData.events, 'connection', 'current', 'connectionPanel'),
        aggregateUseApp: summarize(connectionData.events, 'connection', 'legacy', 'connectionPanel'),
      },
      caveat: 'Settings et le vrai ConnectionPanel sont montés avant l’échec HTTP loopback sur un port vérifié fermé; ce n’est ni un test de connexion OpenCode réussie ni un test d’intégration du connecteur.',
    };

    for (const action of ['notice', 'navigation', 'agent']) {
      assert.ok(results[action].reactProfiler.focusedHooks.commits > 0, `React Profiler n’a pas enregistré de commit focused pour ${action}.`);
      assert.ok(results[action].reactProfiler.aggregateUseApp.commits > 0, `React Profiler n’a pas enregistré de commit agrégé pour ${action}.`);
    }
    assert.equal(results.notice.appFunctionRenders.focusedHooks, 0, 'Une notification ne devrait pas faire rerendre la fonction App abonnée aux seuls domaines pertinents.');
    assert.equal(results.notice.appFunctionRenders.aggregateUseApp, iterations, 'Le consommateur App agrégé devrait rerendre à chaque notification.');
    assert.equal(results.workspace.appFunctionRenders.focusedHooks, 0, 'Une mise à jour isolée de unsaved ne devrait pas faire rerendre App avec les hooks ciblés.');
    assert.equal(results.workspace.appFunctionRenders.aggregateUseApp, iterations, 'Le consommateur agrégé devrait rerendre pour une mise à jour de unsaved.');
    assert.equal(results.workspace.reactProfiler.aggregateUseApp.commits, iterations, 'Le sous-arbre App agrégé devrait recevoir un commit par mise à jour de unsaved.');
    assert.equal(results.connectionFailureStimulus.appFunctionRenders.focusedHooks, 0, 'Les transitions connecting ne devraient pas faire rerendre App avec les hooks ciblés.');
    assert.equal(results.connectionFailureStimulus.appFunctionRenders.aggregateUseApp, 2, 'Les transitions connecting devraient encore faire rerendre le consommateur useApp agrégé.');
    assert.ok(results.connectionFailureStimulus.connectionPanelFunctionRenders.focusedHooks >= 2, 'ConnectionPanel ciblé doit recevoir les transitions connecting dans Settings.');
    assert.ok(results.connectionFailureStimulus.connectionPanelFunctionRenders.aggregateUseApp >= 2, 'ConnectionPanel agrégé doit recevoir les transitions connecting dans Settings.');
    assert.ok(browserErrors.length === 0, `Erreurs JavaScript navigateur: ${browserErrors.join(' | ')}`);

    const browserVersion = await devtools.send('Browser.getVersion');
    console.log(JSON.stringify({
      browser: browserVersion.product,
      react: reactVersion,
      reactDom: reactDomVersion,
      mode: 'Vite development / React Profiler; deux variantes rendues en parallèle sous deux AppProvider indépendants; Settings et ConnectionPanel instrumentés dans des copies temporaires',
      comparison: 'Même App.tsx, Settings et ConnectionPanel actuels; la variante agrégée remplace uniquement les hooks spécialisés de la racine App par useApp().',
      iterationsPerDomain: iterations,
      results,
      browserErrors,
      limitations: [
        'React Profiler mesure le temps de rendu React en développement, pas le coût DOM/layout/paint ni le comportement de production.',
        'Le scénario de connexion navigue réellement vers Settings, attend le montage de ConnectionPanel, puis provoque un échec loopback; ce n’est pas une intégration au moteur OpenCode.',
        'Le résultat quantifie le coût/rerendu de la racine App et de son sous-arbre; il ne remplace pas un profilage de toutes les interactions d’un grand workspace réel.',
      ],
    }, null, 2));
  } finally {
    try { await devtools?.send('Browser.close'); }
    catch { /* Chromium a pu fermer la session DevTools pendant sa terminaison. */ }
    devtools?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3000)]);
      if (chrome.exitCode === null) {
        chrome.kill('SIGKILL');
        await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
      }
    }
    for (const [file] of generated) await rm(file, { force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
