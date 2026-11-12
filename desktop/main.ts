import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let connector: { port: number; token: string; close: () => Promise<void> | void } | null = null;
let origin = '';
const require = createRequire(import.meta.url);
const smoke = process.argv.includes('--smoke-test');

function senderAllowed(event: Electron.IpcMainInvokeEvent): boolean {
  try { return !!origin && new URL(event.senderFrame?.url ?? '').origin === origin; }
  catch { return false; }
}
function guard(event: Electron.IpcMainInvokeEvent): void {
  if (!senderAllowed(event)) throw new Error('IPC non autorisé');
}
function vaultAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}
function keyPath(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Identifiant de secret invalide');
  return join(app.getPath('userData'), 'vault', `${id}.bin`);
}
function openCodeBinary(): string {
  if (!app.isPackaged) return require.resolve('@opencode/cli/bin/opencode.exe');
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const executable = platform === 'windows' ? 'opencode.exe' : 'opencode';
  const suffix = `${platform}-${process.arch}`;
  const packages = platform === 'linux' ? [`cli-${suffix}`, `cli-${suffix}-musl`, `cli-${suffix}-baseline`, `cli-${suffix}-baseline-musl`] : [`cli-${suffix}`];
  const unpackedPackages = resolve(here, '../../app.asar.unpacked/node_modules/@opencode');
  const binary = packages.map(name => join(unpackedPackages, name, 'bin', executable)).find(existsSync);
  if (!binary) throw new Error(`Binaire OpenCode natif absent pour ${platform}-${process.arch} dans l’installation Desktop.`);
  return binary;
}

async function start(): Promise<void> {
  await app.whenReady();
  const connectorModule = await import(pathToFileURL(resolve(here, '../dist-server/server/index.js')).href);
  if (typeof connectorModule.startConnector !== 'function') throw new Error('Connecteur local absent : exécuter pnpm build');
  const cli = openCodeBinary();
  connector = await connectorModule.startConnector({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(app.getPath('userData'), 'data'),
    staticDir: resolve(here, '../dist'),
    cliPath: cli,
    quiet: true,
  });
  if (!connector) throw new Error('Le connecteur local ne démarre pas');
  origin = `http://127.0.0.1:${connector.port}`;
  ipcMain.handle('cortex:connection', (event) => {
    guard(event);
    return { url: origin, token: connector!.token };
  });
  ipcMain.handle('cortex:directory', async (event) => {
    guard(event);
    const result = await dialog.showOpenDialog(window!, { title: 'Ouvrir un projet local', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('cortex:vault-status', (event) => { guard(event); return { available: vaultAvailable(), backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform }; });
  ipcMain.handle('cortex:vault-save', async (event, id: unknown, value: unknown) => {
    guard(event);
    if (!vaultAvailable()) throw new Error('Aucun coffre OS sécurisé disponible. Utiliser la mémoire de session.');
    if (typeof value !== 'string' || !value || value.length > 16384) throw new Error('Secret invalide');
    const path = keyPath(id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, safeStorage.encryptString(value), { mode: 0o600 });
    return { saved: true };
  });
  ipcMain.handle('cortex:vault-load', async (event, id: unknown) => {
    guard(event);
    if (!vaultAvailable()) throw new Error('Coffre OS sécurisé indisponible');
    try { return safeStorage.decryptString(await readFile(keyPath(id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  });
  ipcMain.handle('cortex:vault-delete', async (event, id: unknown) => {
    guard(event);
    await unlink(keyPath(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { deleted: true };
  });

  window = new BrowserWindow({
    width: 1540, height: 980, minWidth: 800, minHeight: 550,
    title: 'Open Cortex Coder', backgroundColor: '#121416', show: false,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('ready-to-show', () => window?.show());
  await window.loadURL(origin);
  if (smoke) {
    const health = await fetch(`${origin}/api/health`).then(r => r.json());
    const content = await window.webContents.executeJavaScript('({title:document.title, body:document.body.innerText.length, nodeExposed:typeof process !== "undefined"})');
    const bootstrap = await window.webContents.executeJavaScript('window.cortexDesktop.getConnection().then(c => fetch(c.url + "/api/bootstrap", {headers:{Authorization:"Bearer " + c.token}})).then(r => {if(!r.ok)throw new Error("Pairing failed");return r.json()}).then(b => ({version:b.version,engineVersion:b.engineVersion,advanced:b.capabilities.advanced}))');
    const nativeEngineVersionOutput = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    const nativeEngineVersion = nativeEngineVersionOutput.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1] ?? nativeEngineVersionOutput;
    if (!health.healthy || content.body < 50 || content.nodeExposed) throw new Error('Smoke Desktop échoué');
    if (nativeEngineVersion !== '2.2.7' || !bootstrap.advanced) throw new Error(`Smoke moteur embarqué/liaison avancée échoué (engine=${nativeEngineVersion}, advanced=${String(bootstrap.advanced)}).`);
    console.log(JSON.stringify({ desktopSmoke: 'passed', packaged: app.isPackaged, health, renderer: content, bootstrap, nativeEngineVersion, vaultAvailable: vaultAvailable() }));
    app.quit();
  }
}

let exiting = false;
app.on('before-quit', event => {
  if (!exiting && connector) {
    event.preventDefault(); exiting = true;
    Promise.resolve(connector.close()).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (window && !window.isDestroyed()) window.show(); });
start().catch(async error => {
  console.error('Échec Desktop:', error instanceof Error ? error.message : 'Erreur inconnue');
  if (!smoke) await dialog.showMessageBox({ type: 'error', title: 'Open Cortex Coder', message: 'Le connecteur local n’a pas démarré.', detail: error instanceof Error ? error.message : 'Erreur inconnue' });
  app.exit(1);
});
