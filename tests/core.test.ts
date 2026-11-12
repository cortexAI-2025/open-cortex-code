import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../server/vault.js';
import { Store } from '../server/store.js';
import { HttpError, hashContent, isSensitivePath, resolveProjectPath, safeEnvironment } from '../server/security.js';
import { administratorConfig, isDangerousPermission, modePermissions } from '../server/engine.js';
import { relevantMemory, projectMessage } from '../server/context.js';
import { startConnector, type ConnectorHandle } from '../server/index.js';
import { PairingManager } from '../server/pairing.js';
import type { FileContent, Project, Profile, MemoryEntry } from '../shared/contracts.js';
import type { SessionMessageInfo } from '@opencode/client';
const roots: string[] = [];
const handles: ConnectorHandle[] = [];
const temp = (): string => { const root = mkdtempSync(path.join(os.tmpdir(), 'cortex-core-')); roots.push(root); return root; };
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => handle.close())); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
async function connector(): Promise<{ handle: ConnectorHandle; projectPath: string; api: (endpoint: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<Response> }> {
  const root = temp(); const projectPath = path.join(root, 'project'); mkdirSync(projectPath);
  writeFileSync(path.join(projectPath, 'hello.ts'), 'export const hello = 1;\n');
  const handle = await startConnector({ port: 0, host: '127.0.0.1', dataDir: path.join(root, 'data'), quiet: true }); handles.push(handle);
  const api = (endpoint: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => fetch(`http://127.0.0.1:${handle.port}${endpoint}`, { method, headers: { Authorization: `Bearer ${handle.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { handle, projectPath, api };
}

describe('pairing HTTPS explicite', () => {
  it('refuse les origines non HTTPS, locales, à chemin ou à credential', () => {
    const pairings = new PairingManager();
    for (const origin of ['http://cortex.example', 'https://localhost', 'https://127.0.0.1', 'https://cortex.example/path', 'https://user:pass@cortex.example', 'null']) {
      expect(() => pairings.request(origin)).toThrow();
    }
    expect(pairings.acceptsOrigin('https://cortex.example')).toBe(true);
  });

  it('approuve explicitement, délivre le jeton une seule fois et le lie à l’origine exacte', () => {
    const pairings = new PairingManager();
    const origin = 'https://cortex.example';
    pairings.enableFor();
    const request = pairings.request(origin);
    expect(pairings.canReadRequest(request.id, 'https://attacker.example')).toBe(false);
    expect(pairings.status(request.id, origin).state).toBe('pending');
    expect(pairings.authenticate('guess', origin)).toBe(false);
    expect(pairings.approve(request.id).origin).toBe(origin);
    const issued = pairings.status(request.id, origin);
    expect(issued.state).toBe('paired'); expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pairings.status(request.id, origin).token).toBeUndefined();
    expect(pairings.authenticate(issued.token!, origin)).toBe(true);
    expect(pairings.authenticate(issued.token!, 'https://attacker.example')).toBe(false);
    expect(pairings.hasOrigin(origin)).toBe(true);
    pairings.revoke(request.id);
    expect(pairings.authenticate(issued.token!, origin)).toBe(false);
    expect(pairings.hasOrigin(origin)).toBe(false);
  });

  it('expire les demandes et les jetons sans persistance', () => {
    let now = 1_800_000_000_000;
    const pairings = new PairingManager(() => now);
    pairings.enableFor();
    const pending = pairings.request('https://cortex.example');
    now += 120_001;
    expect(pairings.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.id, state: 'expired' })]));
    expect(() => pairings.approve(pending.id)).toThrow();
    now += 10_001;
    const next = pairings.request('https://cortex.example');
    pairings.approve(next.id);
    const token = pairings.status(next.id, 'https://cortex.example').token!;
    now += 30 * 60_000 + 1;
    expect(pairings.authenticate(token, 'https://cortex.example')).toBe(false);
  });

  it('exige l’activation locale temporaire avant de créer des pairings', () => {
    let now = 1_800_000_000_000;
    const pairings = new PairingManager(() => now);
    expect(pairings.control()).toEqual({ enabled: false, enabledUntil: null });
    expect(() => pairings.request('https://cortex.example')).toThrowError(/désactivé/u);
    pairings.enableFor();
    expect(pairings.control().enabled).toBe(true);
    expect(pairings.request('https://cortex.example').state).toBe('pending');
    pairings.disable();
    expect(pairings.control().enabled).toBe(false);
    expect(() => pairings.request('https://another.example')).toThrowError(/désactivé/u);
    pairings.enableFor();
    now += 5 * 60_000 + 1;
    expect(pairings.control().enabled).toBe(false);
  });

  it('limite à dix nouvelles origines par minute puis réouvre la fenêtre', () => {
    let now = 1_800_000_000_000;
    const pairings = new PairingManager(() => now);
    pairings.enableFor();
    for (let index = 0; index < 10; index++) {
      pairings.request(`https://site-${index}.example`);
      now += 1_000;
    }
    expect(() => pairings.request('https://site-over-limit.example')).toThrowError(/Trop de demandes/u);
    now += 60_001;
    expect(pairings.request('https://site-after-window.example').state).toBe('pending');
  });

  it('plafonne à 32 demandes ou sessions temporaires simultanées', () => {
    let now = 1_800_000_000_000;
    const pairings = new PairingManager(() => now);
    pairings.enableFor();
    for (let index = 0; index < 32; index++) {
      const origin = `https://capacity-${index}.example`;
      const request = pairings.request(origin);
      pairings.approve(request.id);
      pairings.status(request.id, origin);
      now += 6_001;
    }
    now += 60_001;
    expect(() => pairings.request('https://capacity-over-limit.example')).toThrowError(/en attente/u);
  });

  it('applique preflight sans authentification, approbation locale, scope d’origine et révocation sur un serveur réel', async () => {
    const { handle, api } = await connector();
    const root = `http://127.0.0.1:${handle.port}/api`;
    const origin = 'https://cortex.example';
    const hostile = 'https://attacker.example';
    const preflight = await fetch(`${root}/pair/requests`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const pnaPreflight = await fetch(`${root}/pair/requests`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' } });
    expect(pnaPreflight.status).toBe(204);
    expect(pnaPreflight.headers.get('access-control-allow-private-network')).toBe('true');

    const disabledCreate = await fetch(`${root}/pair/requests`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(disabledCreate.status).toBe(403);
    expect((await disabledCreate.json() as { code: string }).code).toBe('PAIRING_DISABLED');
    const remoteControl = await fetch(`${root}/pair/control`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, confirm: true }) });
    expect(remoteControl.status).toBe(403);
    const localControl = await api('/api/pair/control', 'POST', { enabled: true, confirm: true });
    expect((await localControl.json() as { enabled: boolean }).enabled).toBe(true);

    const created = await fetch(`${root}/pair/requests`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(created.status).toBe(202);
    const request = await created.json() as { id: string };
    const pending = await api('/api/pair/requests');
    expect(await pending.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: request.id, origin, state: 'pending' })]));

    const approved = await api(`/api/pair/requests/${request.id}/approve`, 'POST', { confirm: true });
    expect(approved.status).toBe(200);
    const delivered = await fetch(`${root}/pair/requests/${request.id}`, { headers: { Origin: origin } });
    expect(delivered.status).toBe(200);
    const grant = await delivered.json() as { state: string; token: string };
    expect(grant.state).toBe('paired'); expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await (await fetch(`${root}/pair/requests/${request.id}`, { headers: { Origin: origin } })).json() as { token?: string }).token).toBeUndefined();

    const remotePreflight = await fetch(`${root}/bootstrap`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect(remotePreflight.status).toBe(204);
    const bootstrap = await fetch(`${root}/bootstrap`, { headers: { Origin: origin, Authorization: `Bearer ${grant.token}` } });
    expect(bootstrap.status).toBe(200);
    expect(Array.isArray((await bootstrap.json() as { projects: unknown[] }).projects)).toBe(true);

    const stolenAcrossOrigins = await fetch(`${root}/bootstrap`, { headers: { Origin: hostile, Authorization: `Bearer ${grant.token}` } });
    expect(stolenAcrossOrigins.status).toBe(403);
    const withoutOrigin = await fetch(`${root}/bootstrap`, { headers: { Authorization: `Bearer ${grant.token}` } });
    expect(withoutOrigin.status).toBe(401);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: handle.port, path: '/api/bootstrap', headers: { Host: `attacker.example:${handle.port}`, Origin: origin, Authorization: `Bearer ${grant.token}` } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject); request.end();
    });
    expect(wrongHost).toBe(403);
    const localProfileResponse = await api('/api/profiles', 'POST', { name: 'local fixture', providerId: 'fixture', modelId: 'fixture/model', apiKey: 'LOCAL_FIXTURE_SECRET' });
    const localProfile = await localProfileResponse.json() as { id: string };
    const remoteProfilesResponse = await fetch(`${root}/profiles`, { headers: { Origin: origin, Authorization: `Bearer ${grant.token}` } });
    const remoteProfilesBody = await remoteProfilesResponse.text();
    expect(remoteProfilesResponse.status).toBe(200);
    expect(remoteProfilesBody).toContain('"hasSecret":true');
    expect(remoteProfilesBody).not.toContain('LOCAL_FIXTURE_SECRET');
    const remoteProfileSecret = await fetch(`${root}/profiles/${localProfile.id}/secret`, { method: 'PUT', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'remote-secret-attempt' }) });
    expect(remoteProfileSecret.status).toBe(403);
    const remoteMcpSecret = await fetch(`${root}/projects/00000000-0000-4000-8000-000000000000/mcp`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'remote-mcp', type: 'remote', url: 'https://mcp.example', secretHeaders: { Authorization: 'Bearer remote' }, confirm: true }) });
    expect(remoteMcpSecret.status).toBe(403);
    const remoteRestSecret = await fetch(`${root}/projects/00000000-0000-4000-8000-000000000000/apis`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'remote-api', baseUrl: 'https://api.example', apiKey: 'remote' }) });
    expect(remoteRestSecret.status).toBe(403);
    const remoteSecretWrite = await fetch(`${root}/profiles`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'no', providerId: 'x', modelId: 'x', apiKey: 'must-not-cross' }) });
    expect(remoteSecretWrite.status).toBe(403);
    expect((await remoteSecretWrite.json() as { code: string }).code).toBe('REMOTE_SECRET_DENIED');

    const otherOrigin = 'https://another-cortex.example';
    const otherCreate = await fetch(`${root}/pair/requests`, { method: 'POST', headers: { Origin: otherOrigin, 'Content-Type': 'application/json' }, body: '{}' });
    const otherRequest = await otherCreate.json() as { id: string };
    await api(`/api/pair/requests/${otherRequest.id}/approve`, 'POST', { confirm: true });
    const otherGrant = await (await fetch(`${root}/pair/requests/${otherRequest.id}`, { headers: { Origin: otherOrigin } })).json() as { token: string };
    const revokeOther = await fetch(`${root}/pair/sessions/${otherRequest.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    expect(revokeOther.status).toBe(403);
    const selfRevokePreflight = await fetch(`${root}/pair/sessions/${request.id}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(selfRevokePreflight.status).toBe(204);
    expect(selfRevokePreflight.headers.get('access-control-allow-credentials')).toBeNull();
    const revoke = await fetch(`${root}/pair/sessions/${request.id}`, { method: 'DELETE', headers: { Origin: origin, Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    expect(revoke.status).toBe(200);
    const afterRevoke = await fetch(`${root}/bootstrap`, { headers: { Origin: origin, Authorization: `Bearer ${grant.token}` } });
    expect(afterRevoke.status).toBe(403);
    expect((await (await fetch(`${root}/bootstrap`, { headers: { Origin: otherOrigin, Authorization: `Bearer ${otherGrant.token}` } })).json() as { projects: unknown[] }).projects).toBeDefined();
    expect((await api(`/api/pair/sessions/${otherRequest.id}`, 'DELETE', { confirm: true })).status).toBe(200);
  });
});

describe('coffre et stockage SQLite réels', () => {
  it('redacte rotation, suppression, quotes et valeurs JSON sans altérer les clés', () => {
    const vault = new Vault(); vault.set('profile', 'test-secret-"-with-quote');
    expect(vault.get('profile')).toBe('test-secret-"-with-quote');
    expect(vault.redactValue({ apiKey: 'test-secret-"-with-quote', name: 'normal' })).toEqual({ apiKey: '[REDACTED]', name: 'normal' });
    vault.set('profile', 'next-secret-value'); vault.delete('profile');
    expect(vault.get('profile')).toBeUndefined();
    expect(vault.redact('test-secret-"-with-quote next-secret-value Bearer opaque-value')).toBe('[REDACTED] [REDACTED] Bearer [REDACTED]');
  });
  it('persiste all/get/put/remove avec namespaces et ownership après réouverture', () => {
    const file = path.join(temp(), 'private', 'db.sqlite'); let store = new Store(file);
    store.put('memory', { id: 'a', projectId: 'p1', content: 'alpha' }, 'p1');
    store.put('memory', { id: 'b', projectId: 'p2', content: 'beta' }, 'p2');
    expect(store.all('memory', 'p1')).toEqual([{ id: 'a', projectId: 'p1', content: 'alpha' }]);
    store.put('memory', { id: 'a', projectId: 'p1', content: 'updated' }, 'p1'); store.close(); store = new Store(file);
    expect(store.get<{ content: string }>('memory', 'a')?.content).toBe('updated');
    store.remove('memory', 'a'); expect(store.get('memory', 'a')).toBeUndefined(); store.close();
  });
  it('refuse les credentials même imbriqués et les chemins SQLite symlink', () => {
    const root = temp(); const store = new Store(path.join(root, 'db.sqlite'));
    expect(() => store.put('profile', { id: 'x', apiKey: 'forbidden' })).toThrow('Credential interdit');
    expect(() => store.put('api', { id: 'x', headers: { Authorization: 'Bearer forbidden' } })).toThrow('Credential interdit');
    store.close(); symlinkSync(path.join(root, 'db.sqlite'), path.join(root, 'linked.sqlite'));
    expect(() => new Store(path.join(root, 'linked.sqlite'))).toThrow('symlink');
  });
});

describe('frontières et fichiers réels', () => {
  it('whitelist enfant exclut les variables secrètes ambiantes', () => {
    process.env.CORTEX_UNIT_AMBIENT_SECRET = 'never-inherit';
    const env = safeEnvironment('/tmp/private-cortex');
    expect(env.CORTEX_UNIT_AMBIENT_SECRET).toBeUndefined(); expect(env.OPENCODE_PASSWORD).toBeUndefined();
    expect(env.HOME).toBe('/tmp/private-cortex'); expect(env.XDG_DATA_HOME).toBe('/tmp/private-cortex/data');
    expect(env).not.toHaveProperty('HTTP_PROXY'); delete process.env.CORTEX_UNIT_AMBIENT_SECRET;
  });
  it('bloque traversal, sensibles et symlinks internes/externes/dangling', () => {
    const root = temp(); writeFileSync(path.join(root, 'file.txt'), 'ok');
    symlinkSync(path.join(root, 'file.txt'), path.join(root, 'inside')); symlinkSync('/etc/passwd', path.join(root, 'outside')); symlinkSync('/nonexistent', path.join(root, 'dangling'));
    for (const relative of ['../etc/passwd', '/etc/passwd', '.env', '.env.local', '.ssh/id_rsa', 'credentials.json', 'inside', 'outside', 'dangling']) expect(() => resolveProjectPath(root, relative)).toThrow(HttpError);
    expect(resolveProjectPath(root, 'file.txt')).toBe(path.join(root, 'file.txt'));
    expect(isSensitivePath('src/.env.production')).toBe(true);
  });
  it('protège toutes API hors health avec Bearer, Host et Origin exacts', async () => {
    const { handle, api } = await connector();
    expect((await api('/api/health', 'GET', undefined, { Authorization: '' })).status).toBe(200);
    expect((await api('/api/bootstrap', 'GET', undefined, { Authorization: '' })).status).toBe(401);
    expect((await api('/api/bootstrap', 'GET', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
    const evilHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${handle.port}/api/health`, { headers: { Host: 'evil.test' } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(evilHostStatus).toBe(403);
    expect((await api('/api/bootstrap', 'GET', undefined, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await api('/api/bootstrap', 'GET', undefined, { Origin: 'null' })).status).toBe(403);
    expect((await api('/api/bootstrap', 'GET', undefined, { Origin: `http://127.0.0.1:${handle.port}` })).status).toBe(200);
    expect((await api('/api/unknown')).status).toBe(404);
  });
  it('sauvegarde optimiste réelle avec checkpoint et refuse hash obsolète', async () => {
    const { projectPath, api, handle } = await connector();
    const project = await (await api('/api/projects', 'POST', { name: 'temp', path: projectPath, trusted: true })).json() as Project;
    const prefix = `/api/projects/${project.id}`;
    const file = await (await api(`${prefix}/file?path=hello.ts`)).json() as FileContent;
    expect(file.hash).toBe(hashContent('export const hello = 1;\n'));
    expect((await api(`${prefix}/file`, 'PUT', { path: 'hello.ts', content: 'changed\n', hash: file.hash })).status).toBe(400);
    const written = await api(`${prefix}/file`, 'PUT', { path: 'hello.ts', content: 'changed\n', hash: file.hash, confirm: true });
    expect(written.status).toBe(200); expect(readFileSync(path.join(projectPath, 'hello.ts'), 'utf8')).toBe('changed\n');
    expect(handle.context.store.all('file-checkpoints', project.id)).toHaveLength(1);
    expect((await api(`${prefix}/file`, 'PUT', { path: 'hello.ts', content: 'stale', hash: file.hash, confirm: true })).status).toBe(409);
    expect(readFileSync(path.join(projectPath, 'hello.ts'), 'utf8')).toBe('changed\n');
  });
  it('liste et restaure un checkpoint fichier réel avec confirmation et hash optimiste', async () => {
    const { projectPath, api } = await connector();
    const project = await (await api('/api/projects', 'POST', { name: 'restore-file', path: projectPath, trusted: true })).json() as Project;
    const prefix = `/api/projects/${project.id}`;
    const before = await (await api(`${prefix}/file?path=hello.ts`)).json() as FileContent;
    const saved = await api(`${prefix}/file`, 'PUT', { path: 'hello.ts', content: 'changed\n', hash: before.hash, confirm: true }); expect(saved.status).toBe(200);
    const checkpoints = await (await api(`${prefix}/file-checkpoints?path=hello.ts`)).json() as { id: string; preview: string; hash: string }[];
    expect(checkpoints).toHaveLength(1); expect(checkpoints[0]?.preview).toBe(before.content);
    const missingConsent = await api(`${prefix}/file-checkpoints/${checkpoints[0]!.id}/restore`, 'POST', { path: 'hello.ts', expectedHash: hashContent('changed\n') }); expect(missingConsent.status).toBe(400);
    const stale = await api(`${prefix}/file-checkpoints/${checkpoints[0]!.id}/restore`, 'POST', { path: 'hello.ts', expectedHash: hashContent('some other edit'), confirm: true }); expect(stale.status).toBe(409);
    const restored = await api(`${prefix}/file-checkpoints/${checkpoints[0]!.id}/restore`, 'POST', { path: 'hello.ts', expectedHash: hashContent('changed\n'), confirm: true });
    expect(restored.status).toBe(200); expect(readFileSync(path.join(projectPath, 'hello.ts'), 'utf8')).toBe(before.content);
    expect((await api(`${prefix}/file-checkpoints?path=.npmrc`)).status).toBe(403);
  });
  it('explorateur masque secrets/liens et refuse binary, hardlink et fichier volumineux', async () => {
    const { projectPath, api } = await connector();
    writeFileSync(path.join(projectPath, '.env'), 'SECRET=value'); writeFileSync(path.join(projectPath, 'binary'), Buffer.from([0, 1]));
    writeFileSync(path.join(projectPath, 'huge'), Buffer.alloc(2 * 1024 * 1024 + 1));
    symlinkSync('/etc/passwd', path.join(projectPath, 'outside')); linkSync(path.join(projectPath, 'hello.ts'), path.join(projectPath, 'hardlink'));
    const p = await (await api('/api/projects', 'POST', { name: 'temp', path: projectPath, trusted: true })).json() as Project;
    const files = await (await api(`/api/projects/${p.id}/files`)).json() as { name: string }[];
    expect(files.map((file) => file.name)).not.toContain('.env'); expect(files.map((file) => file.name)).not.toContain('outside');
    for (const [name, status] of [['.env', 403], ['outside', 403], ['hardlink', 403], ['binary', 415], ['huge', 413]] as const) expect((await api(`/api/projects/${p.id}/file?path=${name}`)).status).toBe(status);
  });
  it('refuse mutations et session moteur non isolée sur untrusted', async () => {
    const { projectPath, api } = await connector();
    const p = await (await api('/api/projects', 'POST', { name: 'temp', path: projectPath, trusted: false })).json() as Project;
    const profile = await (await api('/api/profiles', 'POST', { name: 'local', providerId: 'ollama', modelId: 'qwen3:1.7b', baseUrl: 'http://127.0.0.1:11434/v1' })).json() as Profile;
    expect(profile.hasSecret).toBe(false);
    expect((await api(`/api/projects/${p.id}/file`, 'PUT', { path: 'hello.ts', content: 'bad', hash: hashContent('export const hello = 1;\n'), confirm: true })).status).toBe(403);
    const session = await api(`/api/projects/${p.id}/sessions`, 'POST', { title: 'no execution', profileId: profile.id, mode: 'agent' });
    expect(session.status).toBe(403); expect((await session.json() as { code: string }).code).toBe('UNTRUSTED_PROJECT');
  });
  it('ne persiste pas le secret profil et redaction après suppression', async () => {
    const { handle, api } = await connector(); const secret = 'core-test-secret-private-897123';
    const p = await (await api('/api/profiles', 'POST', { name: 'private', providerId: 'openai', modelId: 'not-called', apiKey: secret })).json() as Profile;
    expect(p.hasSecret).toBe(true); expect(p).not.toHaveProperty('apiKey');
    const stored = handle.context.store.get<Profile>('profiles', p.id); expect(stored?.hasSecret).toBe(false);
    const files = readdirSync(path.dirname(handle.context.store.filename)).filter((name) => name.startsWith('cortex.sqlite'));
    for (const file of files) expect(readFileSync(path.join(path.dirname(handle.context.store.filename), file)).includes(Buffer.from(secret))).toBe(false);
    expect((await api(`/api/profiles/${p.id}/secret`, 'DELETE')).status).toBe(200);
    const profiles = await (await api('/api/profiles')).json() as Profile[]; expect(profiles[0]?.hasSecret).toBe(false);
    expect(handle.context.vault.redact(secret)).toBe('[REDACTED]');
  });
  it('isole les entrées mémoire entre projets et ne prétend pas tester un profil sans clé', async () => {
    const { projectPath, api } = await connector();
    const p = await (await api('/api/projects', 'POST', { name: 'p', path: projectPath, trusted: true })).json() as Project;
    const entry = await (await api(`/api/projects/${p.id}/memory`, 'POST', { kind: 'decision', title: 'SQLite', content: 'Utiliser SQLite local.' })).json() as MemoryEntry;
    expect(entry.projectId).toBe(p.id); expect((await api(`/api/projects/${p.id}/memory/not-owned`, 'PUT', { kind: 'note', title: 'x', content: 'x' })).status).toBe(404);
    const profile = await (await api('/api/profiles', 'POST', { name: 'remote', providerId: 'custom', modelId: 'uncalled', baseUrl: 'https://example.com/v1' })).json() as Profile;
    expect((await api(`/api/profiles/${profile.id}/test`, 'POST')).status).toBe(409);
  });
});

describe('policies et projections V2', () => {
  it('Ask/Plan ont hard-deny administrateur et Agent reste ask sans always', () => {
    for (const mode of ['ask', 'plan'] as const) {
      const policies = administratorConfig(mode).policies as { action: string; resource: string; effect: string }[];
      expect(policies).toContainEqual({ action: 'tool.use', resource: '*', effect: 'deny' });
      expect(policies).toContainEqual({ action: 'mcp.use', resource: '*', effect: 'deny' });
      expect(modePermissions(mode)[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    }
    expect(modePermissions('agent')[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
    expect(JSON.stringify(administratorConfig('agent'))).not.toContain('always');
    expect(isDangerousPermission('shell', ['git push origin main'])).toBe(true);
    expect(isDangerousPermission('shell', ['pnpm test'])).toBe(false);
  });
  it('projette les vrais content/tool/error/token/cost V2, sans succès fictif', () => {
    const vault = new Vault(); vault.set('key', 'secret-output');
    const message: SessionMessageInfo = { id: 'm1', type: 'assistant', time: { created: 1000 }, agent: 'cortex-ask', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text: 'Analyse réelle' }, { type: 'tool', id: 't1', name: 'read', time: { created: 1000 }, state: { status: 'completed', input: { filePath: 'file.ts' }, content: [{ type: 'text', text: 'secret-output' }] } }, { type: 'tool', id: 't2', name: 'shell', time: { created: 1001 }, state: { status: 'error', input: { command: 'denied' }, error: { type: 'Denied', message: 'Action réellement refusée' } } }], cost: 0, tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } };
    const result = projectMessage(message, vault);
    expect(result.text).toBe('Analyse réelle'); expect(result.tools?.[0]?.output).toBe('[REDACTED]'); expect(result.tools?.[1]?.status).toBe('error'); expect(result.tools?.[1]?.output).toContain('réellement refusée'); expect(result.tokens).toEqual({ input: 5, output: 7 }); expect(result.cost).toBe(0);
  });
  it('injecte seulement la mémoire pertinente et les instructions locales', () => {
    const entries: MemoryEntry[] = [{ id: '1', projectId: 'p', kind: 'instruction', title: 'Policy', content: 'Tests obligatoires.', updatedAt: '' }, { id: '2', projectId: 'p', kind: 'decision', title: 'SQLite', content: 'Stockage SQLite local.', updatedAt: '' }, { id: '3', projectId: 'p', kind: 'note', title: 'Unrelated', content: 'Mars mission.', updatedAt: '' }];
    const result = relevantMemory(entries, [], 'Améliorer SQLite'); expect(result).toContain('Tests obligatoires'); expect(result).toContain('Stockage SQLite'); expect(result).not.toContain('Mars');
  });
  it('refuse le binding externe avant de lancer un service', async () => { await expect(startConnector({ host: '0.0.0.0', port: 0 })).rejects.toMatchObject({ code: 'NONLOCAL_BIND_DENIED' }); });
});
