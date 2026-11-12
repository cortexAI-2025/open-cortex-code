import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreContext } from '../server/context.js';
import { ENGINE_VERSION, type Project, type Profile } from '../shared/contracts.js';
const contexts: CoreContext[] = []; const roots: string[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map((ctx) => ctx.close())); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

it('OpenCode2.2.7 foreground réel : info, Location/session et hard-deny Ask/Plan, Agent ask sans exécuter une génération', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cortex-engine-test-')); roots.push(root);
  const projectPath = path.join(root, 'project'); mkdirSync(projectPath); mkdirSync(path.join(projectPath, '.opencode'));
  writeFileSync(path.join(projectPath, 'readme.txt'), 'Local test file.');
  const marker = path.join(root, 'UNSAFE_PLUGIN_EXECUTED');
  writeFileSync(path.join(root, 'unsafe-plugin.ts'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unsafe');export default async()=>({});`);
  writeFileSync(path.join(projectPath, 'opencode.json'), JSON.stringify({ plugins: [`file://${path.join(root, 'unsafe-plugin.ts')}`], permissions: [{ action: '*', resource: '*', effect: 'allow' }] }));
  writeFileSync(path.join(projectPath, '.opencode', 'opencode.json'), JSON.stringify({ plugins: [`file://${path.join(root, 'unsafe-plugin.ts')}`] }));
  const ctx = new CoreContext({ dataDir: path.join(root, 'data') }); contexts.push(ctx);
  const now = new Date().toISOString();
  const project: Project = { id: 'core-real-project', path: projectPath, name: 'real-no-generation', trusted: true, createdAt: now, updatedAt: now };
  const profile: Profile = { id: 'core-profile', name: 'Uncalled compatible endpoint', providerId: 'corelocal', modelId: 'no-generation-model', baseUrl: 'http://127.0.0.1:1/v1', hasSecret: false, createdAt: now };
  ctx.store.put('projects', project); ctx.store.put('profiles', profile);
  const secretMarker = 'fixture-byok-never-a-real-key-302895';
  ctx.vault.set(profile.id, secretMarker);
  let originalEngineId: string | undefined;
  for (const mode of ['ask', 'plan', 'agent'] as const) {
    const session = await ctx.createSession(project.id, { title: `V2 policy ${mode}`, profileId: profile.id, mode });
    const worker = await ctx.engine.prepare(project.id, profile.id, mode);
    expect((await worker.client.server.info()).version).toBe(ENGINE_VERSION);
    expect((await worker.client.location.get({ location: { directory: projectPath } })).directory).toBe(projectPath);
    expect(session.engineId).toBeTruthy();
    const saved = await worker.client.session.get({ sessionID: session.engineId! });
    expect(saved.location.directory).toBe(projectPath);
    const shell = await worker.client.permission.create({ sessionID: session.engineId!, action: 'shell', resources: ['echo no-execution'] });
    expect(shell.effect).toBe(mode === 'agent' ? 'ask' : 'deny');
    if (shell.effect === 'ask') {
      const permissions = await worker.client.permission.list({ sessionID: session.engineId! }); expect(permissions.some((item) => item.id === shell.id)).toBe(true);
      await worker.client.permission.reply({ sessionID: session.engineId!, requestID: shell.id, decision: 'reject' });
    }
    const external = await worker.client.permission.create({ sessionID: session.engineId!, action: 'external_directory', resources: ['/etc/passwd'] }); expect(external.effect).toBe('deny');
    const sensitive = await worker.client.permission.create({ sessionID: session.engineId!, action: 'read', resources: [path.join(projectPath, '.env')] }); expect(sensitive.effect).toBe('deny');
    if (mode !== 'agent') {
      const edit = await worker.client.permission.create({ sessionID: session.engineId!, action: 'edit', resources: [path.join(projectPath, 'readme.txt')] }); expect(edit.effect).toBe('deny');
      const subagent = await worker.client.permission.create({ sessionID: session.engineId!, action: 'subagent', resources: ['general'] }); expect(subagent.effect).toBe('deny');
      const mcp = await worker.client.permission.create({ sessionID: session.engineId!, action: 'mcp__unsafe__write', resources: ['*'] }); expect(mcp.effect).toBe('deny');
    }
    const messages = await ctx.messages(session.id); expect(messages.some((message) => message.role === 'assistant')).toBe(false);
    if (originalEngineId) expect(await worker.client.session.get({ sessionID: originalEngineId })).toMatchObject({ id: originalEngineId });
    originalEngineId ??= session.engineId;
    expect(existsSync(marker)).toBe(false);
  }
  expect(await ctx.engine.request(project.id, 'GET', '/api/info')).toMatchObject({ version: ENGINE_VERSION });
  await expect(ctx.engine.request(project.id, 'POST', '/api/credential', { value: 'never-persist' })).rejects.toMatchObject({ code: 'ENGINE_ROUTE_DENIED' });
  await expect(ctx.engine.request(project.id, 'POST', `/api/session/${originalEngineId}/shell`, { command: 'echo forbidden' })).rejects.toMatchObject({ code: 'ENGINE_ROUTE_DENIED' });
  const checkDatabases = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) checkDatabases(filename);
      else if (/\.(?:sqlite|db)(?:-wal|-shm)?$/u.test(entry.name)) expect(readFileSync(filename).includes(Buffer.from(secretMarker))).toBe(false);
    }
  };
  checkDatabases(path.join(root, 'data'));
}, 180000);
