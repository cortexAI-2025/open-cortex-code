import { startConnector } from '../server/index.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Deterministic connector smoke test; no model, paid API, or untrusted execution. */
const root = await mkdtemp(join(tmpdir(), 'cortex-smoke-'));
const projectPath = join(root, 'project');
await mkdir(projectPath);
await writeFile(join(projectPath, 'hello.txt'), 'before\n');
let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
let failed = false;
try {
  connector = await startConnector({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), staticDir: resolve('dist'), quiet: true, logPairing: false });
  const base = `http://127.0.0.1:${connector.port}`;
  const auth = { Authorization: `Bearer ${connector.token}` };
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const anonymous = await fetch(base + '/api/bootstrap');
  if (anonymous.status !== 401) throw new Error(`Anonymous access: expected 401, got ${anonymous.status}`);
  const health = await request('/api/health');
  if (health.status !== 200 || health.body.healthy !== true) throw new Error('Health endpoint failed');
  const bootstrap = await request('/api/bootstrap');
  if (bootstrap.status !== 200 || bootstrap.body.capabilities?.sandbox !== false) throw new Error('Capabilities not reported safely');
  const project = await request('/api/projects', 'POST', { name: 'Smoke project', path: projectPath, trusted: false });
  if (project.status !== 201 || !project.body.id) throw new Error('Project creation failed');
  const filePath = `/api/projects/${project.body.id}/file`;
  const file = await request(filePath + '?path=hello.txt');
  if (file.status !== 200 || file.body.content !== 'before\n') throw new Error('File read failed');
  const untrustedWrite = await request(filePath, 'PUT', { path: 'hello.txt', content: 'after\n', hash: file.body.hash, confirm: true });
  if (untrustedWrite.status !== 403 || untrustedWrite.body.code !== 'UNTRUSTED_PROJECT') throw new Error(`Untrusted write was not rejected: ${untrustedWrite.status}`);
  const command = await request(`/api/projects/${project.body.id}/commands`, 'POST', { command: 'node --test', kind: 'test', confirm: true });
  if (command.status !== 403) throw new Error('Untrusted project command was not rejected');
  // Explicit user consent: re-submitting the same project path with trusted=true.
  const trusted = await request('/api/projects', 'POST', { name: 'Smoke project', path: projectPath, trusted: true });
  if (trusted.status !== 200 || trusted.body.id !== project.body.id || trusted.body.trusted !== true) throw new Error('Explicit project trust failed');
  const noConfirm = await request(filePath, 'PUT', { path: 'hello.txt', content: 'after\n', hash: file.body.hash });
  if (noConfirm.status !== 400) throw new Error('Unconfirmed write was not rejected');
  const written = await request(filePath, 'PUT', { path: 'hello.txt', content: 'after\n', hash: file.body.hash, confirm: true });
  if (written.status !== 200 || written.body.content !== 'after\n') throw new Error('Confirmed write failed');
  const stale = await request(filePath, 'PUT', { path: 'hello.txt', content: 'overwrite', hash: file.body.hash, confirm: true });
  if (stale.status !== 409) throw new Error('Stale hash did not produce conflict');
  console.log('PASS connector smoke: authentication, health, capabilities, project, untrusted write/command denial, explicit trust, file I/O, stale-hash conflict');
} catch (error) {
  failed = true;
  console.error('FAIL connector smoke:', error);
} finally {
  await connector?.close();
  await rm(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
