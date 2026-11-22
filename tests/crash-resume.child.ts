import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/vault.js';
import type { Context } from '../server/advanced/common.js';
import { beginExternal } from '../server/advanced/resilience.js';
import { completeStep, holdStep } from '../server/advanced/mission-integrity.js';

const dir = process.env.CRASH_DIR;
if (!dir) throw new Error('CRASH_DIR absent');
const projectPath = path.join(dir, 'repo');
mkdirSync(projectPath, { recursive: true });
const store = new Store(path.join(dir, 'cortex.sqlite'));
const project: Project = { id: 'crash-project', path: projectPath, name: 'Crash', trusted: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
store.put('projects', project);
store.put('missions', {
  id: 'crash-mission', projectId: project.id, title: 'Reprise', goal: 'Corriger la taxe', profileId: 'local', status: 'active',
  steps: [], claims: [], conflicts: [], evidence: [], createdAt: project.createdAt, updatedAt: project.createdAt, resumeCount: 0,
}, project.id);
const ctx = {
  store, vault: new Vault(),
  project: (id: string) => {
    const found = store.get<Project>('projects', id);
    if (!found) throw new Error('projet absent');
    return found;
  },
  history: () => ({ id: 'h', projectId: project.id, kind: 'note', title: 'n', detail: '', createdAt: project.createdAt }),
} as unknown as Context;
completeStep(ctx, project.id, 'crash-mission', 'analyze');
beginExternal(ctx, project.id, 'external-ack', () => undefined);
holdStep(ctx, project.id, 'crash-mission', 'edit', 300);
writeFileSync(path.join(dir, 'ready'), '1');
setInterval(() => undefined, 1_000);
