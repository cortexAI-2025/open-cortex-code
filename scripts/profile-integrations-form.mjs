import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.CONTEXT_PROFILE_URL || 'http://127.0.0.1:3000';
const appSourcePath = path.join(projectRoot, 'client', 'App.tsx');
const integrationsSourcePath = path.join(projectRoot, 'client', 'views', 'Integrations.tsx');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const require = createRequire(import.meta.url);

function chromiumPath() {
  const candidates = process.env.CHROMIUM_PATH ? [process.env.CHROMIUM_PATH] : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
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
      const timer = setTimeout(() => reject(new Error('Timeout DevTools')), 8000);
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout DevTools: ${method}`)); }, 10000);
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
  const result = await devtools.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(devtools, expression, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(devtools, expression);
      if (value) return value;
    } catch { /* Vite can replace the execution context during module loading. */ }
    await sleep(50);
  }
  let detail = '';
  try { detail = String(await evaluate(devtools, 'document.body.innerText')).slice(0, 500); } catch { /* Navigation may have removed the context. */ }
  let state = '';
  try {
    state = String(await evaluate(devtools, `JSON.stringify({renders:window.__integrationsProfile?.componentRenders, forms:document.querySelectorAll('form').length, inputs:[...document.querySelectorAll('input,textarea')].map(x=>({tag:x.tagName,type:x.type,pattern:x.getAttribute('pattern'),label:x.getAttribute('aria-label')})), text:document.body.innerText.slice(-1200)})`));
  } catch { /* Keep the original timeout if the execution context disappeared. */ }
  throw new Error(`Délai dépassé (${description})${detail ? `; DOM: ${detail}` : ''}${state ? `; diagnostic: ${state}` : ''}`);
}

function profileSources(id, appSource, integrationsSource) {
  const lazyImport = "import('./views/Integrations').then(({ Integrations }) => ({ default: Integrations }))";
  const gatedView = 'case \'integrations\': return <ViewLoading><ProjectGate><Integrations /></ProjectGate></ViewLoading>;';
  const componentMarker = 'export function Integrations() {';
  const formBodyMarker = '}: IntegrationFormProps) {';
  const remoteGate = 'const { api, remote } = useConnection();';
  assert.ok(appSource.includes(lazyImport), 'Import lazy de Integrations inattendu dans App.tsx.');
  assert.ok(appSource.includes(gatedView), 'Point de montage de Integrations inattendu dans App.tsx.');
  assert.ok(integrationsSource.includes(componentMarker), 'Déclaration de Integrations inattendue.');
  assert.ok(integrationsSource.includes(formBodyMarker), 'Déclaration du formulaire Integrations inattendue.');
  assert.ok(integrationsSource.includes(remoteGate), 'Garde d’origine distante inattendu dans Integrations.');

  const appFile = `App.integrations-profile-${id}.tsx`;
  const integrationsFile = `Integrations.profile-${id}.tsx`;
  const runnerFile = `integrations-profile-runner-${id}.tsx`;
  const htmlFile = `integrations-profile-${id}.html`;
  let instrumentedApp = appSource
    .replace("import { lazy, memo, Suspense, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';", "import { Profiler, lazy, memo, Suspense, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';")
    .replace(lazyImport, `import('./views/${integrationsFile.replace(/\.tsx$/, '')}').then(({ Integrations }) => ({ default: Integrations }))`)
    .replace(gatedView, "case 'integrations': return <ViewLoading><Profiler id=\"integrations\" onRender={(_id, phase, actualDuration) => window.__integrationsProfile.onRender(phase, actualDuration)}><Integrations /></Profiler></ViewLoading>;");
  assert.notEqual(instrumentedApp, appSource, 'Aucune instrumentation de App n’a été appliquée.');

  const instrumentedIntegrations = integrationsSource
    .replace(remoteGate, 'const { api } = useConnection();\n    const remote = false;')
    .replace(componentMarker, `${componentMarker}\n    window.__integrationsProfile.componentRender();`)
    .replace(formBodyMarker, `${formBodyMarker}\n    window.__integrationsProfile.formRender();`);
  assert.notEqual(instrumentedIntegrations, integrationsSource, 'Le compteur Integrations n’a pas été installé.');

  const runner = `
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './${appFile.replace(/\.tsx$/, '')}';
import { AppProvider, useNavigationActions } from './state';
import './styles.css';
import './responsive.css';

declare global {
  interface Window {
    __integrationsProfile: {
      ready: boolean;
      componentRenders: number;
      formRenders: number;
      events: Array<{ phase: string; actualDuration: number }>;
      errors: string[];
      componentRender: () => void;
      formRender: () => void;
      onRender: (phase: string, actualDuration: number) => void;
      reset: () => void;
    };
  }
}

window.__integrationsProfile = {
  ready: false,
  componentRenders: 0,
  formRenders: 0,
  events: [],
  errors: [],
  componentRender() { this.componentRenders += 1; },
  formRender() { this.formRenders += 1; },
  onRender(phase, actualDuration) { this.events.push({ phase, actualDuration }); },
  reset() { this.componentRenders = 0; this.formRenders = 0; this.events = []; this.errors = []; },
};

function OpenIntegrations() {
  const { setView } = useNavigationActions();
  useEffect(() => { setView('integrations'); }, [setView]);
  return null;
}

createRoot(document.getElementById('root')!).render(<AppProvider><OpenIntegrations/><App/></AppProvider>);
window.__integrationsProfile.ready = true;
`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profilage local Integrations</title></head><body><div id="root"></div><script type="module" src="/client/${runnerFile}"></script></body></html>`;
  return { appFile, integrationsFile, runnerFile, htmlFile, app: instrumentedApp, integrations: instrumentedIntegrations, runner, html };
}

function summarize(events) {
  const samples = events.map(event => event.actualDuration).sort((a, b) => a - b);
  if (!samples.length) return { commits: 0, totalMs: 0, medianMs: 0, p95Ms: 0 };
  const median = samples.length % 2 ? samples[(samples.length - 1) / 2] : (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
  return {
    commits: samples.length,
    totalMs: Number(samples.reduce((sum, value) => sum + value, 0).toFixed(3)),
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
  };
}

async function main() {
  const chromium = chromiumPath();
  const reactVersion = require('react/package.json').version;
  const reactDomVersion = require('react-dom/package.json').version;
  assert.equal(reactVersion, reactDomVersion, 'react/react-dom versions must match.');
  const [appSource, integrationsSource] = await Promise.all([readFile(appSourcePath, 'utf8'), readFile(integrationsSourcePath, 'utf8')]);
  const id = randomUUID().replaceAll('-', '');
  const source = profileSources(id, appSource, integrationsSource);
  const generated = [
    [path.join(projectRoot, 'client', source.appFile), source.app],
    [path.join(projectRoot, 'client', 'views', source.integrationsFile), source.integrations],
    [path.join(projectRoot, 'client', source.runnerFile), source.runner],
    [path.join(projectRoot, source.htmlFile), source.html],
  ];
  const written = [];
  const profile = await mkdtemp(path.join(os.tmpdir(), 'open-cortex-integrations-profile-'));
  let chrome;
  let devtools;
  try {
    for (const [file, contents] of generated) {
      try { await stat(file); throw new Error(`Refus d’écraser un fichier existant: ${file}`); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await writeFile(file, contents, { flag: 'wx' });
      written.push(file);
    }

    const rootResponse = await fetch(baseUrl).catch(() => null);
    const viteResponse = await fetch(`${baseUrl}/@vite/client`).catch(() => null);
    assert.ok(rootResponse?.ok && viteResponse?.ok, `Vite indisponible sur ${baseUrl}; démarrez-le avant le profilage.`);

    chrome = spawn(chromium, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    let debugPort;
    const deadline = Date.now() + 15000;
    while (!debugPort && Date.now() < deadline) {
      if (chrome.exitCode !== null) throw new Error(`Chromium s’est arrêté (${chrome.exitCode}).`);
      try { debugPort = Number((await readFile(portFile, 'utf8')).split('\n')[0]); }
      catch { await sleep(50); }
    }
    if (!debugPort) throw new Error('Chromium n’a pas exposé son port DevTools en 15 secondes.');
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
    const page = targets.find(target => target.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl, 'Page DevTools introuvable.');
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
    await waitFor(devtools, 'Boolean(window.__integrationsProfile?.ready)', 'initialisation du runner');
    await waitFor(devtools, 'Boolean(window.__integrationsProfile.componentRenders > 0 && window.__integrationsProfile.formRenders > 0 && document.querySelector("form input[pattern]"))', 'montage de la vue Integrations et de son formulaire');
    await evaluate(devtools, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await sleep(500);
    await evaluate(devtools, 'window.__integrationsProfile.reset()');
    await evaluate(devtools, 'document.querySelector("form input[pattern]").focus()');

    const typed = 'integration-profilage';
    const rendersPerCharacter = [];
    let previous = { componentRenders: 0, formRenders: 0, commits: 0 };
    for (const character of typed) {
      await devtools.send('Input.insertText', { text: character });
      await evaluate(devtools, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const current = await evaluate(devtools, 'JSON.stringify({componentRenders:window.__integrationsProfile.componentRenders, formRenders:window.__integrationsProfile.formRenders, commits:window.__integrationsProfile.events.length})').then(JSON.parse);
      rendersPerCharacter.push({
        character,
        parentRenders: current.componentRenders - previous.componentRenders,
        formRenders: current.formRenders - previous.formRenders,
        commits: current.commits - previous.commits,
      });
      previous = current;
    }
    const profileData = await evaluate(devtools, 'JSON.parse(JSON.stringify(window.__integrationsProfile))');
    assert.equal(profileData.componentRenders, 0, 'La vue Integrations parente ne doit pas rerendre pendant la saisie isolée.');
    assert.ok(profileData.formRenders >= typed.length, 'Le sous-composant de formulaire doit être exécuté au moins une fois par frappe contrôlée.');
    assert.ok(profileData.events.length >= typed.length, 'React Profiler doit enregistrer au moins un commit par frappe contrôlée.');
    assert.equal(await evaluate(devtools, 'document.querySelector("form input[pattern]").value'), typed, 'Le champ contrôlé n’a pas conservé la saisie attendue.');
    assert.equal(browserErrors.length, 0, `Erreurs JavaScript navigateur: ${browserErrors.join(' | ')}`);
    const browserVersion = await devtools.send('Browser.getVersion');
    console.log(JSON.stringify({
      browser: browserVersion.product,
      react: reactVersion,
      reactDom: reactDomVersion,
      scenario: `Vue Integrations réelle, projet/connecteur absents; gates de projet et origine distante neutralisées uniquement dans la copie de profilage pour rendre le formulaire local; api reste null; ${typed.length} caractères saisis dans Nom MCP; aucun formulaire soumis.`,
      characters: typed.length,
      fieldValue: typed,
      componentFunctionRenders: { Integrations: profileData.componentRenders, IntegrationForm: profileData.formRenders },
      rendersPerCharacter,
      reactProfiler: summarize(profileData.events),
      browserErrors,
      interpretation: 'Le parent Integrations reste stable pendant la saisie; seul IntegrationForm traite les mises à jour du brouillon. Le Profiler mesure les commits du sous-arbre visible.',
      limitations: [
        'Mesure React/Vite en développement; actualDuration exclut le layout/paint et n’est pas une mesure de production.',
        'Le profilage n’envoie aucune requête métier : api reste null et le formulaire n’est ni validé ni soumis. Au chargement, AppProvider exécute toutefois son GET /api/health local sans jeton; Vite ne configure aucun proxy API.',
        'Aucun projet/connecteur associé signifie que les listes MCP/REST sont vides; le coût d’une frappe avec des listes réellement remplies peut être supérieur.',
        'La copie de profilage retire ProjectGate et le garde remote uniquement pour afficher le formulaire local alors qu’aucun connecteur/projet n’est associé; api reste null et le code du produit est non modifié.',
      ],
    }, null, 2));
  } finally {
    try { await devtools?.send('Browser.close'); } catch { /* Chromium peut déjà être arrêté. */ }
    devtools?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3000)]);
      if (chrome.exitCode === null) {
        chrome.kill('SIGKILL');
        await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
      }
    }
    for (const file of written) await rm(file, { force: true });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
