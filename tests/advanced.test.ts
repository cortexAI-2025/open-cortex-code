import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ConnectorContext } from '../server/context.js';
import type { Project, Profile, CortexSession, HistoryEvent } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import { registerAdvancedRoutes, shutdownAdvanced } from '../server/routes-advanced.js';
import { AdvancedError, hash, owned, readSafe, relativePath, writeSafe, type Context } from '../server/advanced/common.js';
import { execute, gitOk, runCommand, safeEnvironment } from '../server/advanced/process.js';
import { createCheckpoint, gitView, restoreCheckpoint, type Checkpoint } from '../server/advanced/git.js';
import { chunkText, searchKnowledge, skillMarkdown, tokenize, type IndexedDocument } from '../server/advanced/knowledge-skills.js';
import { LocalScheduler, nextOccurrence, type LocalAutomation } from '../server/advanced/automations.js';
import { isPublicAddress, restTarget, testRest, validateHeaders, validateUrl, type RestProfile } from '../server/advanced/network.js';
import { connectMcp, localMcpCommand, runtimeMcpConfig, type McpConfig } from '../server/advanced/mcp.js';
import { createWorktreeAgent, deliveryReport, reviewDiff, githubStatus, type ParallelAgent } from '../server/advanced/agents-delivery.js';

// These fixtures use real SQLite/Git/OS processes and local HTTP, BUT a mock OpenCode engine.
// Session/MCP tests prove contracts and permission requests, NOT real provider/MCP E2E availability.
let root: string, ctx: ConnectorContext, p: Project, p2: Project, store: Store, vault: Vault;
let app: ReturnType<typeof express>, server: Server, url: string;
let createSession: ReturnType<typeof vi.fn>, prompt: ReturnType<typeof vi.fn>, engineRequest: ReturnType<typeof vi.fn>;
const others: Server[] = [];
async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const address = s.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(s: Server): Promise<void> { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); }
async function http(endpoint: string, method = 'GET', body?: unknown): Promise<{status: number; body: any}> {
  const response = await fetch(url + endpoint, { method, headers: { authorization: 'Bearer fixture-pairing', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const routeBase = () => `/api/projects/${p.id}`;
const profileId = 'fixture-profile';
async function initGit(project: Project): Promise<void> {
  await gitOk(project, ['init', '-b', 'main']); await gitOk(project, ['config', 'user.email', 'fixture@example.invalid']); await gitOk(project, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(project.path, 'README.md'), 'original\n'); await gitOk(project, ['add', 'README.md']); await gitOk(project, ['commit', '-m', 'fixture initial']);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cortex-advanced-'));
  const projectPath = path.join(root, 'project'); await mkdir(projectPath);
  const otherPath = path.join(root, 'other'); await mkdir(otherPath);
  p = { id: 'project-one', path: projectPath, name: 'Fixture', trusted: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  p2 = { ...p, id: 'project-two', path: otherPath, name: 'Other' };
  vault = new Vault(); vault.set(profileId, 'fixture-secret-not-a-real-service-key');
  store = new Store(path.join(root, 'data', 'cortex.sqlite'), (json) => JSON.stringify(vault.redactValue(JSON.parse(json))));
  store.put('projects', p); store.put('projects', p2);
  const profile: Profile = { id: profileId, name: 'Mock ONLY', providerId: 'mock', modelId: 'mock', hasSecret: true, createdAt: p.createdAt };
  store.put('profiles', profile);
  createSession = vi.fn(async (projectId: string, input: any) => {
    const session: CortexSession = { id: randomUUID(), projectId, ...input, status: 'idle', createdAt: p.createdAt, updatedAt: p.updatedAt };
    store.put('sessions', session, projectId); return session;
  });
  prompt = vi.fn(async () => ({ accepted: true }));
  const states = new Map<string, {status: string}>();
  engineRequest = vi.fn(async (_projectId: string, method: string, endpoint: string) => {
    if (method === 'GET' && endpoint === '/api/mcp') return { location: {}, data: [...states].map(([name, status]) => ({name, status})) };
    const name = endpoint.split('/')[4]!;
    if (method === 'PUT') states.set(name, {status: 'disabled'});
    if (method === 'POST') states.set(name, {status: 'connected'});
    if (method === 'DELETE') states.delete(name);
  });
  ctx = { store, vault, engine: { request: engineRequest }, project: (projectId: string) => { const item = store.get<Project>('projects', projectId); if (!item) throw new AdvancedError(404, 'NOT_FOUND', 'Project not found'); return item; }, createSession, prompt, history: (projectId: string, kind: string, title: string, detail: string) => { const event: HistoryEvent = { id: randomUUID(), projectId, kind, title, detail, createdAt: new Date().toISOString() }; return store.put('history', event, projectId); } } as unknown as ConnectorContext;
  app = express(); app.use(express.json({limit: '1mb'}));
  // Fixture auth middleware: proves route ordering only, not the core pairing/Host/Origin E2E.
  app.use((req, res, next) => { if (req.headers.authorization !== 'Bearer fixture-pairing') { res.status(401).json({error: 'Pairing required'}); return; } next(); });
  registerAdvancedRoutes(app, ctx); server = createServer(app); url = await listen(server);
});
afterEach(async () => {
  shutdownAdvanced(app); await close(server); for (const s of others.splice(0)) await close(s);
  store.close(); vault.clear(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks();
});

describe('path validation and project ownership (unit/fixture)', () => {
  it.each(['../outside', '/etc/passwd', '.git/index', 'src/../../secret', 'C:\\x', 'a\\b', 'a//b', 'a/./b', 'a\0b'])('rejects unsafe relative path %s', (value) => { expect(() => relativePath(value)).toThrow(); });
  it('refuses reading/writing symlinks and never modifies the external file', async () => {
    const outside = path.join(root, 'outside'); await writeFile(outside, 'outside'); await symlink(outside, path.join(p.path, 'escape'));
    await expect(readSafe(p, 'escape')).rejects.toMatchObject({code: 'SYMLINK_BLOCKED'});
    await expect(writeSafe(p, 'escape', Buffer.from('bad'), null)).rejects.toMatchObject({code: 'SYMLINK_BLOCKED'});
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });
  it('rejects hardlinks to other files', async () => {
    const outside = path.join(root, 'outside'); await writeFile(outside, 'outside'); await link(outside, path.join(p.path, 'hard'));
    await expect(readSafe(p, 'hard')).rejects.toMatchObject({code: 'FILE_TYPE_DENIED'});
    await expect(writeSafe(p, 'hard', Buffer.from('bad'), hash('outside'))).rejects.toMatchObject({code: 'FILE_TYPE_DENIED'});
  });
  it('writes by current hash and refuses stale writes', async () => {
    await writeSafe(p, 'src/new.txt', Buffer.from('one'), null);
    await expect(writeSafe(p, 'src/new.txt', Buffer.from('two'), null)).rejects.toMatchObject({code: 'FILE_CONFLICT'});
    await writeSafe(p, 'src/new.txt', Buffer.from('two'), hash('one'));
    await expect(writeSafe(p, 'src/new.txt', Buffer.from('three'), hash('one'))).rejects.toMatchObject({code: 'FILE_CONFLICT'});
    expect(await readFile(path.join(p.path, 'src/new.txt'), 'utf8')).toBe('two');
  });
  it('requires fixture pairing middleware before advanced routes', async () => { const response = await fetch(url + routeBase() + '/knowledge'); expect(response.status).toBe(401); });
  it('rejects a foreign entity id even when it is valid', () => {
    store.put('skills', {id: 'foreign', projectId: p2.id, name: 'other'}, p2.id);
    expect(() => owned(ctx, 'skills', 'foreign', p.id)).toThrowError('Élément introuvable dans ce projet.');
  });
});

describe('real local Git fixtures', () => {
  beforeEach(async () => { await initGit(p); });
  it('returns actual status/log/diff and preserves index in checkpoint', async () => {
    await writeFile(path.join(p.path, 'README.md'), 'staged\n'); await gitOk(p, ['add', 'README.md']); await writeFile(path.join(p.path, 'README.md'), 'unstaged\n');
    const indexBefore = await readFile(path.join(p.path, '.git/index'));
    const checkpoint = await createCheckpoint(ctx, p);
    expect(checkpoint.files).toHaveLength(1);
    expect(await readFile(path.join(p.path, '.git/index'))).toEqual(indexBefore);
    const view = await gitView(ctx, p); expect(view.branch).toBe('main'); expect(view.log[0]?.message).toBe('fixture initial'); expect(view.diff).toContain('+unstaged'); expect(view.diff).toContain('+staged');
  });
  it('returns public metadata only, requires confirmation and no secret copies', async () => {
    await writeFile(path.join(p.path, '.env'), 'api_key=should-not-be-stored');
    await writeFile(path.join(p.path, 'secret-source.txt'), 'fixture-secret-not-a-real-service-key');
    const missing = await http(routeBase() + '/git/checkpoint', 'POST', {}); expect(missing.status).toBe(403);
    const result = await http(routeBase() + '/git/checkpoint', 'POST', {confirm: true}); expect(result.status).toBe(200);
    expect(result.body.files[0].content).toBeUndefined(); expect(result.body.excluded).toEqual(expect.arrayContaining(['.env', 'secret-source.txt']));
  });
  it('excludes npm credentials from diff, snapshots and native engine snapshots', async () => {
    const npmAuth = '//registry.npmjs.org/:_authToken=npm_NEVER_SHARE_FIXTURE';
    await writeFile(path.join(p.path, '.npmrc'), npmAuth);
    const view = await gitView(ctx, p);
    expect(view.diff).not.toContain(npmAuth);
    const snapshot = await createCheckpoint(ctx, p);
    expect(snapshot.excluded).toContain('.npmrc');
    expect(JSON.stringify(store.all('checkpoint-blobs', p.id))).not.toContain(npmAuth);
  });
  it('restore requires examined hashes, catches concurrency, preserves index and new files', async () => {
    const checkpoint = await createCheckpoint(ctx, p);
    await writeFile(path.join(p.path, 'README.md'), 'changed\n'); await writeFile(path.join(p.path, 'new.txt'), 'preserve');
    const indexBefore = await readFile(path.join(p.path, '.git/index'));
    const preview = await http(routeBase() + '/git/restore', 'POST', {checkpointId: checkpoint.id, confirm: true}); expect(preview.status).toBe(409); expect(preview.body.code).toBe('RESTORE_PREVIEW_REQUIRED');
    await writeFile(path.join(p.path, 'README.md'), 'concurrent\n');
    const stale = await http(routeBase() + '/git/restore', 'POST', {checkpointId: checkpoint.id, confirm: true, expectedHashes: preview.body.expectedHashes}); expect(stale.status).toBe(409);
    const restored = await http(routeBase() + '/git/restore', 'POST', {checkpointId: checkpoint.id, confirm: true, expectedHashes: {'README.md': hash('concurrent\n')}}); expect(restored.status).toBe(200);
    expect(await readFile(path.join(p.path, 'README.md'), 'utf8')).toBe('original\n'); expect(await readFile(path.join(p.path, 'new.txt'), 'utf8')).toBe('preserve'); expect(await readFile(path.join(p.path, '.git/index'))).toEqual(indexBefore);
  });
  it('restore validates checkpoint ownership', async () => {
    const checkpoint = await createCheckpoint(ctx, p);
    await expect(restoreCheckpoint(ctx, p2, {checkpointId: checkpoint.id, confirm: true})).rejects.toMatchObject({code: 'NOT_FOUND'});
  });
  it('rejects malicious checkpoint paths before any mutation', async () => {
    const checkpoint = await createCheckpoint(ctx, p); checkpoint.files[0]!.path = '../escape'; store.put('checkpoints', checkpoint, p.id);
    await expect(restoreCheckpoint(ctx, p, {checkpointId: checkpoint.id, confirm: true})).rejects.toMatchObject({code: 'INVALID_PATH'});
  });
  it('creates a real branch without checking it out; refuses invalid branches', async () => {
    expect((await http(routeBase() + '/git/branch', 'POST', {name: 'feature/actual', confirm: true})).status).toBe(200);
    expect((await gitOk(p, ['branch', '--show-current'])).trim()).toBe('main'); expect(await gitOk(p, ['branch', '--list', 'feature/actual'])).toContain('feature/actual');
    expect((await http(routeBase() + '/git/branch', 'POST', {name: '-bad', confirm: true})).status).toBe(400);
  });
  it('refuses symlink-backed checkpoint files', async () => {
    await symlink(path.join(root, 'outside'), path.join(p.path, 'link'));
    await expect(createCheckpoint(ctx, p)).rejects.toMatchObject({code: 'SYMLINK_BLOCKED'});
  });
  it('supports more than the Store 4MiB aggregate by separate snapshot blobs', async () => {
    await writeFile(path.join(p.path, 'a.bin'), Buffer.alloc(1_500_000, 1)); await writeFile(path.join(p.path, 'b.bin'), Buffer.alloc(1_500_000, 2));
    const checkpoint = await createCheckpoint(ctx, p); expect(checkpoint.files).toHaveLength(3); expect(store.all('checkpoint-blobs', p.id)).toHaveLength(3);
  });
});

describe('real bounded OS command executions', () => {
  it('does not execute without explicit confirm or on an untrusted project', async () => {
    await expect(runCommand(ctx, p, {command: 'touch denied'})).rejects.toMatchObject({code: 'CONFIRM_REQUIRED'});
    await expect(runCommand(ctx, {...p, trusted: false}, {command: 'touch denied', confirm: true})).rejects.toMatchObject({code: 'UNTRUSTED_PROJECT'});
    expect(await readFile(path.join(p.path, 'denied')).catch(() => null)).toBeNull();
  });
  it('records real exit codes and redacts output and stored logs', async () => {
    const result = await runCommand(ctx, p, {command: 'printf "fixture-secret-not-a-real-service-key\\n"; exit 7', confirm: true, kind: 'test'});
    expect(result.exitCode).toBe(7); expect(result.output).toContain('[REDACTED]'); expect(result.command).not.toContain('fixture-secret-not-a-real-service-key');
    expect(store.get<any>('commands', result.id).exitCode).toBe(7); expect(JSON.stringify(store.all('history'))).not.toContain('fixture-secret-not-a-real-service-key');
  });
  it('does not pass ambient provider/engine/API credentials', async () => {
    process.env.CORTEX_PROVIDER_KEY = 'ambient-key'; process.env.OPENAI_API_KEY = 'ambient-openai';
    try { const result = await runCommand(ctx, p, {command: 'printf "%s|%s|%s" "$CORTEX_PROVIDER_KEY" "$OPENAI_API_KEY" "$HOME"', confirm: true}); expect(result.output).toBe('||/nonexistent'); }
    finally { delete process.env.CORTEX_PROVIDER_KEY; delete process.env.OPENAI_API_KEY; }
    expect(safeEnvironment()).not.toHaveProperty('NODE_OPTIONS');
  });
  it('kills timed-out process groups and returns actual null exit/signal', async () => {
    const result = await execute('/bin/bash', ['-c', 'sleep 10'], {cwd: p.path, timeoutMs: 80}); expect(result.timedOut).toBe(true); expect(result.exitCode).toBeNull(); expect(result.signal).toBe('SIGKILL'); expect(result.durationMs).toBeLessThan(1500);
  });
  it('caps excessive output and kills the process', async () => {
    const result = await execute('/usr/bin/yes', [], {cwd: p.path, timeoutMs: 1000, maxOutput: 1024}); expect(result.truncated).toBe(true); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024); expect(result.exitCode).not.toBe(0);
  });
  it('keeps commands independent by project and delivery does not invent tests', async () => {
    await initGit(p); await runCommand(ctx, p, {command: 'printf command-only', confirm: true});
    const report = await deliveryReport(ctx, p) as any; expect(report.tests).toEqual([]); expect(report.problems.join(' ')).toContain('Aucun test');
    await runCommand(ctx, p, {command: 'exit 3', confirm: true, kind: 'test'});
    const tested = await deliveryReport(ctx, p) as any; expect(tested.tests[0].exitCode).toBe(3); expect(tested.problems.join(' ')).toContain('exit=3');
    expect((await http(`/api/projects/${p2.id}/commands`)).body).toEqual([]);
  });
});

describe('knowledge lexical index, correction, deletion and SQLite persistence', () => {
  it('tokenizes accents and ranks relevant multi-term passages', () => {
    expect(tokenize('Sécurité Mémoire')).toEqual(['securite', 'memoire']);
    const docs = [
      {id: 'a', projectId: p.id, name: 'security.md', chunks: chunkText('La sécurité du coffre concerne les secrets et clés API.')},
      {id: 'b', projectId: p.id, name: 'ui.md', chunks: chunkText('La sécurité visuelle des boutons. Le thème est graphite.')},
    ] as IndexedDocument[];
    const results = searchKnowledge(docs, 'securite coffre secrets'); expect(results[0].documentId).toBe('a'); expect(results[0].score).toBeGreaterThan(results[1].score); expect(searchKnowledge(docs, 'unrelatednothing')).toEqual([]);
  });
  it('chunks long text with overlap rather than a single full document hit', () => { const chunks = chunkText('paragraph memory token\n'.repeat(300)); expect(chunks.length).toBeGreaterThan(3); expect(chunks.every((c) => c.text.length <= 1400)).toBe(true); });
  it('persists documents/index in actual SQLite and does not leak other projects', async () => {
    const created = await http(routeBase() + '/knowledge', 'POST', {name: 'context.md', content: 'Persistent knowledge about secure API credentials.'}); expect(created.status).toBe(201);
    const second = new Store(store.filename); try { expect(second.get<IndexedDocument>('knowledge', created.body.id)?.chunks.length).toBe(1); } finally { second.close(); }
    expect((await http(routeBase() + '/knowledge/search?q=secure%20API')).body[0].documentId).toBe(created.body.id);
    expect((await http(`/api/projects/${p2.id}/knowledge/search?q=secure%20API`)).body).toEqual([]);
  });
  it('requires confirmation/hash for correction and confirmation for deletion', async () => {
    const created = (await http(routeBase() + '/knowledge', 'POST', {name: 'context.txt', content: 'old term'})).body;
    expect((await http(routeBase() + '/knowledge/' + created.id, 'PUT', {name: 'context.txt', content: 'new term'})).status).toBe(403);
    expect((await http(routeBase() + '/knowledge/' + created.id, 'PUT', {name: 'context.txt', content: 'new term', confirm: true, expectedHash: hash('bad')})).status).toBe(409);
    expect((await http(routeBase() + '/knowledge/' + created.id, 'PUT', {name: 'context.txt', content: 'new changedword', confirm: true, expectedHash: created.hash})).status).toBe(200);
    expect((await http(routeBase() + '/knowledge/search?q=changedword')).body).toHaveLength(1);
    expect((await http(`/api/projects/${p2.id}/knowledge/${created.id}`, 'DELETE', {confirm: true})).status).toBe(404);
    expect((await http(routeBase() + '/knowledge/' + created.id, 'DELETE', {})).status).toBe(403);
    expect((await http(routeBase() + '/knowledge/' + created.id, 'DELETE', {confirm: true})).status).toBe(200);
    expect((await http(routeBase() + '/knowledge/search?q=changedword')).body).toEqual([]);
  });
  it('rejects non-text document formats', async () => { expect((await http(routeBase() + '/knowledge', 'POST', {name: 'file.pdf', content: 'no parser'})).status).toBe(400); });
});

describe('OpenCode Skill format and mocked engine contracts', () => {
  it('renders valid scalar frontmatter and rejects traversal/inconsistent YAML', () => {
    const rendered = skillMarkdown('test-skill', 'Useful skill', '## Steps\nRead the tests.'); expect(rendered).toContain('name: "test-skill"'); expect(rendered).toContain('description: "Useful skill"');
    expect(() => skillMarkdown('../escape', 'desc', 'body')).toThrow(); expect(() => skillMarkdown('valid', 'desc', '---\nname: wrong\ndescription: desc\n---\nbody')).toThrow();
  });
  it('writes SKILL.md only after confirmation and detects existing-file conflicts', async () => {
    const skill = (await http(routeBase() + '/skills', 'POST', {name: 'test-skill', description: 'A test skill', content: 'Read project context.'})).body;
    const endpoint = routeBase() + '/skills/' + skill.id + '/export';
    expect((await http(endpoint, 'POST', {})).status).toBe(403);
    expect((await http(endpoint, 'POST', {confirm: true})).status).toBe(200);
    expect(await readFile(path.join(p.path, '.opencode/skills/test-skill/SKILL.md'), 'utf8')).toBe(skill.content);
    expect((await http(endpoint, 'POST', {confirm: true})).status).toBe(409);
    expect((await http(endpoint, 'POST', {confirm: true, expectedHash: hash(skill.content)})).status).toBe(200);
  });
  it('validates project ownership for edit/export/deletion', async () => {
    const skill = (await http(routeBase() + '/skills', 'POST', {name: 'owned-skill', description: 'desc', content: 'body'})).body;
    expect((await http(`/api/projects/${p2.id}/skills/${skill.id}/export`, 'POST', {confirm: true})).status).toBe(404);
    expect((await http(`/api/projects/${p2.id}/skills/${skill.id}`, 'DELETE', {confirm: true})).status).toBe(404);
  });
  it('does not generate without a profile secret; actual execution is explicitly mocked here', async () => {
    vault.delete(profileId); const denied = await http(routeBase() + '/skills/generate', 'POST', {request: 'generate skill', profileId}); expect(denied.status).toBe(503); expect(createSession).not.toHaveBeenCalled();
    vault.set(profileId, 'fixture-new-secret'); const created = await http(routeBase() + '/skills/generate', 'POST', {request: 'generate skill', profileId}); expect(created.status).toBe(201); expect(created.body.mode).toBe('ask'); expect(prompt).toHaveBeenCalledOnce(); expect((await http(routeBase() + '/skills')).body).toEqual([]);
  });
});

describe('local scheduler consent and mock read-only engine contract', () => {
  it('calculates daily/weekly/once dates and validates format', () => {
    const after = new Date('2026-11-11T10:30:00Z');
    expect(new Date(nextOccurrence({schedule: 'daily', time: '11:00'}, after)!) > after).toBe(true);
    expect(new Date(nextOccurrence({schedule: 'weekly', time: '11:00', dayOfWeek: 3}, after)!).getDay()).toBe(3);
    expect(nextOccurrence({schedule: 'once', time: '2026-11-12T12:00:00Z'}, after)).toBe('2026-11-12T12:00:00.000Z');
    expect(() => nextOccurrence({schedule: 'daily', time: '99:99'}, after)).toThrow(); expect(() => nextOccurrence({schedule: 'once', time: '2020-01-01T00:00:00Z'}, after)).toThrow();
  });
  it('defaults disabled and requires both enable consent and explicit confirmation', async () => {
    const basic = {name: 'daily task', prompt: 'Read files', profileId, schedule: 'daily', time: '10:00'};
    const created = await http(routeBase() + '/automations', 'POST', basic); expect(created.body.enabled).toBe(false);
    expect((await http(routeBase() + '/automations', 'POST', {...basic, enabled: true})).status).toBe(403);
    expect((await http(routeBase() + '/automations', 'POST', {...basic, enabled: true, confirm: true, consent: true, mode: 'agent'})).status).toBe(403);
    expect((await http(routeBase() + '/automations', 'POST', {...basic, enabled: true, confirm: true, consent: true, mode: 'ask'})).status).toBe(201);
  });
  it('runs once using Ask only and has no permission-approval call', async () => {
    const task: LocalAutomation = {id: 'due', projectId: p.id, name: 'Due', prompt: 'Read', profileId, mode: 'ask', schedule: 'once', time: '2026-11-11T00:00:00Z', enabled: true, nextRun: '2026-11-11T00:00:00Z', createdAt: p.createdAt, updatedAt: p.updatedAt};
    store.put('automations', task, p.id); const scheduler = new LocalScheduler(ctx);
    await scheduler.tick(new Date('2026-11-12T00:00:00Z')); await scheduler.tick(new Date('2026-11-12T00:00:01Z'));
    expect(createSession).toHaveBeenCalledOnce(); expect(createSession.mock.calls[0]?.[1].mode).toBe('ask'); expect(prompt.mock.calls[0]?.[1].text).toContain('LECTURE SEULE'); expect(engineRequest).not.toHaveBeenCalled(); expect(store.get<LocalAutomation>('automations', task.id)?.enabled).toBe(false); scheduler.stop();
  });
  it('does not run disabled/sensitive tasks and stops timers on app shutdown', async () => {
    const task: LocalAutomation = {id: 'disabled', projectId: p.id, name: 'No run', prompt: 'Run shell', profileId, mode: 'agent', schedule: 'daily', time: '00:00', enabled: false, nextRun: '2020-01-01T00:00:00Z', createdAt: p.createdAt, updatedAt: p.updatedAt};
    store.put('automations', task, p.id); const scheduler = new LocalScheduler(ctx); scheduler.start(); expect(scheduler.active).toBe(true); await scheduler.tick(); expect(createSession).not.toHaveBeenCalled(); scheduler.stop(); expect(scheduler.active).toBe(false); await expect(scheduler.run(task)).rejects.toMatchObject({code: 'SCHEDULER_STOPPED'});
    shutdownAdvanced(app); expect(typeof app.locals.shutdownAdvanced).toBe('function');
  });
  it('manual runs require confirmation and correct project ownership', async () => {
    const task = (await http(routeBase() + '/automations', 'POST', {name: 'manual', prompt: 'Read', profileId})).body;
    expect((await http(routeBase() + '/automations/' + task.id + '/run', 'POST', {})).status).toBe(403);
    expect((await http(`/api/projects/${p2.id}/automations/${task.id}/run`, 'POST', {confirm: true})).status).toBe(404);
    expect((await http(routeBase() + '/automations/' + task.id + '/run', 'POST', {confirm: true})).status).toBe(201);
  });
});

describe('REST validation and real loopback HTTP tests (no external service)', () => {
  it('refuses HTTP outside approved loopback, embedded secrets and private networks', () => {
    expect(() => validateUrl('http://example.com')).toThrow(); expect(() => validateUrl('http://127.0.0.1')).toThrow(); expect(validateUrl('http://127.0.0.1', true).protocol).toBe('http:');
    expect(() => validateUrl('https://user:password@example.com')).toThrow(); expect(() => validateUrl('https://example.com?api_key=bad')).toThrow(); expect(() => validateUrl('https://10.1.2.3')).toThrow();
    expect(isPublicAddress('192.168.1.1')).toBe(false); expect(isPublicAddress('169.254.169.254')).toBe(false); expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false); expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
  it('public header allowlist rejects authorization/host/cookies/newlines', () => {
    expect(validateHeaders({Accept: 'application/json'})).toEqual({accept: 'application/json'});
    for (const name of ['Authorization', 'Host', 'Cookie', 'x-api-key']) expect(() => validateHeaders({[name]: 'bad'})).toThrow(); expect(() => validateHeaders({accept: 'foo\r\nHost: evil'})).toThrow();
  });
  it('stores credentials separately and performs actual confirmed GET/HEAD only', async () => {
    const seen: string[] = [];
    const endpoint = createServer((req, res) => { seen.push(req.method!); expect(req.headers.authorization).toBe('Bearer api-fixture-secret'); res.setHeader('content-type', 'text/plain'); res.end('api-fixture-secret response'); }); others.push(endpoint); const baseUrl = await listen(endpoint);
    const created = await http(routeBase() + '/apis', 'POST', {name: 'local API', baseUrl, method: 'GET', path: '/', apiKey: 'api-fixture-secret', allowLoopback: true}); expect(created.status).toBe(201); expect(JSON.stringify(store.get('apis', created.body.id))).not.toContain('api-fixture-secret'); expect(created.body.apiKey).toBeUndefined();
    const test = routeBase() + '/apis/' + created.body.id + '/test'; expect((await http(test, 'POST', {})).status).toBe(403);
    const result = await http(test, 'POST', {confirm: true}); expect(result.status).toBe(200); expect(result.body.status).toBe(200); expect(result.body.detail).toContain('[REDACTED]'); expect(seen).toEqual(['GET']);
    expect((await http(`/api/projects/${p2.id}/apis/${created.body.id}/test`, 'POST', {confirm: true})).status).toBe(404);
    const api = store.get<RestProfile>('apis', created.body.id)!; await testRest(ctx, {...api, method: 'HEAD'}); expect(seen).toEqual(['GET', 'HEAD']);
    expect((await http(routeBase() + '/apis', 'POST', {name: 'destructive', baseUrl, method: 'DELETE', allowLoopback: true})).status).toBe(400);
  });
  it('refuses redirect and limits response bytes in actual loopback calls', async () => {
    const endpoint = createServer((req, res) => { if (req.url === '/redirect') { res.writeHead(302, {location: '/secret'}); res.end(); } else { res.end('x'.repeat(100_000)); } }); others.push(endpoint); const baseUrl = await listen(endpoint);
    const api: RestProfile = {id: 'r', projectId: p.id, name: 'r', baseUrl, method: 'GET', path: '/redirect', headers: {}, allowLoopback: true, hasSecret: false, createdAt: p.createdAt};
    await expect(testRest(ctx, api)).rejects.toMatchObject({code: 'REDIRECT_DENIED'});
    const result = await testRest(ctx, {...api, path: '/large'}); expect(result.truncated).toBe(true); expect(result.detail.length).toBeLessThanOrEqual(65536);
  });
  it('blocks origin-changing or secret-bearing endpoint paths', () => {
    const api: RestProfile = {id: 'r', projectId: p.id, name: 'r', baseUrl: 'https://example.com', method: 'GET', path: '//evil.com/', headers: {}, allowLoopback: false, hasSecret: false, createdAt: p.createdAt};
    expect(() => restTarget(api)).toThrow(); expect(() => restTarget({...api, path: '/?token=key'})).toThrow();
  });
});

describe('MCP V2 exact mocked transport contract; not external MCP E2E', () => {
  it('uses PUT experimental registration, disabled config, POST connect and GET actual status', async () => {
    const created = await http(routeBase() + '/mcp', 'POST', {name: 'local-test', type: 'local', command: ['/usr/bin/true'], confirm: true}); expect(created.status).toBe(201); expect(created.body.status.status).toBe('disabled');
    expect(engineRequest.mock.calls[0]?.slice(1, 3)).toEqual(['PUT', '/api/experimental/mcp/local-test']); expect(engineRequest.mock.calls[0]?.[3].config.disabled).toBe(true);
    const connected = await http(routeBase() + '/mcp/local-test/connect', 'POST', {confirm: true}); expect(connected.status).toBe(200); expect(connected.body.status.status).toBe('connected'); expect(engineRequest.mock.calls.some((c) => c[1] === 'POST' && c[2] === '/api/experimental/mcp/local-test/connect')).toBe(true);
  });
  it('keeps environment secrets in vault, not public config or argv, and cleans inherited env', async () => {
    const created = await http(routeBase() + '/mcp', 'POST', {name: 'secret-test', type: 'local', command: ['/bin/bash', '-c', 'printf "%s|%s|%s" "$SERVICE_TOKEN" "$CORTEX_PROVIDER_KEY" "$OPENCODE_PASSWORD"'], secretEnvironment: {SERVICE_TOKEN: 'mcp-fixture-secret'}, confirm: true}); expect(created.status).toBe(201);
    const config = store.get<McpConfig>('mcp', created.body.id)!; expect(JSON.stringify(config)).not.toContain('mcp-fixture-secret');
    const runtime = runtimeMcpConfig(ctx, p, config) as any; expect(JSON.stringify(runtime.command)).not.toContain('mcp-fixture-secret');
    const [executable, ...args] = runtime.command;
    const execution = await execute(executable, args, {cwd: p.path, env: {...safeEnvironment(), SERVICE_TOKEN: 'mcp-fixture-secret', CORTEX_PROVIDER_KEY: 'forbidden-provider', OPENCODE_PASSWORD: 'forbidden-engine'}});
    expect(execution.output).toBe('mcp-fixture-secret||'); expect(execution.exitCode).toBe(0);
  });
  it('requires trusted project/confirmation, blocks argv secrets and dangerous env variables', async () => {
    expect((await http(routeBase() + '/mcp', 'POST', {name: 'a', type: 'local', command: ['true']})).status).toBe(403);
    expect((await http(routeBase() + '/mcp', 'POST', {name: 'a', type: 'local', command: ['true'], secretEnvironment: {NODE_OPTIONS: '--bad'}, confirm: true})).status).toBe(400);
    expect((await http(routeBase() + '/mcp', 'POST', {name: 'a', type: 'local', command: ['true', 'fixture-secret-not-a-real-service-key'], confirm: true})).status).toBe(400);
    store.put('projects', {...p, trusted: false}); expect((await http(routeBase() + '/mcp')).status).toBe(403); expect(engineRequest).not.toHaveBeenCalled();
  });
  it('does not fabricate connection status on engine failure and validates ownership', async () => {
    const config: McpConfig = {id: 'foreign', projectId: p2.id, name: 'foreign', type: 'local', command: ['true'], headers: {}, hasSecret: false, createdAt: p.createdAt};
    await expect(connectMcp(ctx, p, config)).rejects.toMatchObject({code: 'NOT_FOUND'});
    engineRequest.mockRejectedValue(new AdvancedError(503, 'ENGINE_UNAVAILABLE', 'fixture-secret-not-a-real-service-key unavailable'));
    const result = await http(routeBase() + '/mcp'); expect(result.status).toBe(503); expect(result.body.error).not.toContain('fixture-secret-not-a-real-service-key');
  });
});

describe('parallel agents and review: real Git worktrees, mock engine only', () => {
  beforeEach(async () => { await initGit(p); });
  it('creates unique real branches/worktrees and distinct projects/sessions without merge', async () => {
    const one = await createWorktreeAgent(ctx, p, {name: 'one', task: 'Read', profileId, mode: 'ask', confirm: true});
    const two = await createWorktreeAgent(ctx, p, {name: 'two', task: 'Read', profileId, mode: 'plan', confirm: true});
    expect(one.branch).not.toBe(two.branch); expect(one.worktreePath).not.toBe(two.worktreePath); expect(one.isolatedProjectId).not.toBe(two.isolatedProjectId); expect(one.sessionId).not.toBe(two.sessionId);
    expect((await gitOk({...p, path: one.worktreePath}, ['branch', '--show-current'])).trim()).toBe(one.branch);
    expect((await gitOk(p, ['branch', '--show-current'])).trim()).toBe('main'); expect((await gitOk(p, ['worktree', 'list'])).split('\n').filter(Boolean)).toHaveLength(3);
    expect(one.warning).toContain('PAS sandbox');
    const list = (await http(routeBase() + '/agents')).body; expect(list).toHaveLength(2); expect((await http(`/api/projects/${p2.id}/agents`)).body).toEqual([]);
  });
  it('records engine failure honestly while preserving the created worktree', async () => {
    createSession.mockRejectedValue(new Error('mock engine offline'));
    await expect(createWorktreeAgent(ctx, p, {name: 'failed', task: 'Read', profileId, confirm: true})).rejects.toMatchObject({code: 'AGENT_START_FAILED'});
    const record = store.all<ParallelAgent>('agents', p.id)[0]!; expect(record.state).toBe('error'); expect(record.sessionId).toBeUndefined(); expect(await readFile(path.join(record.worktreePath, 'README.md'), 'utf8')).toBe('original\n');
  });
  it('refuses review without diff and requests confirmed/hypotheses structured Ask on actual diff', async () => {
    await expect(reviewDiff(ctx, p, {profileId})).rejects.toMatchObject({code: 'NO_DIFF'});
    await writeFile(path.join(p.path, 'README.md'), 'review changed\n'); const session = await reviewDiff(ctx, p, {profileId}); expect(session.mode).toBe('ask');
    const submitted = prompt.mock.calls[0]?.[1].text; expect(submitted).toContain('+review changed'); expect(submitted).toContain('confirmed'); expect(submitted).toContain('hypotheses'); expect(submitted).toContain('testsActuallyObserved:[]'); expect(engineRequest).not.toHaveBeenCalled();
  });
  it('does not use gh or external authentication on an untrusted project', async () => { await expect(githubStatus(ctx, {...p, trusted: false})).rejects.toMatchObject({code: 'UNTRUSTED_PROJECT'}); });
});
