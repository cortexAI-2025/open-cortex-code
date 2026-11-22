/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Team } from '../client/views/Team';

const hoisted = vi.hoisted(() => ({ data: {} as Record<string, unknown>, request: vi.fn(), confirm: vi.fn(async () => true) }));
vi.mock('../client/state', () => ({
  useConnection: () => ({ api: { request: hoisted.request }, remote: false }),
  useWorkspace: () => ({ projectId: 'p1', project: { id: 'p1', name: 'repo', path: '/r', trusted: true } }),
  useAppActions: () => ({ act: async (action: () => Promise<unknown>) => action(), confirm: hoisted.confirm, notify: vi.fn(), clearNotice: vi.fn() }),
}));
vi.mock('../client/api', () => ({
  projectRoute: (projectId: string, resource: string) => `/projects/${projectId}/${resource}`,
  dateLabel: (d?: string) => d ?? '',
  useResource: (_api: unknown, path: string | null) => ({ data: path ? hoisted.data[path] ?? null : null, error: '', loading: false, refresh: vi.fn() }),
}));

const agents = ['architect', 'backend', 'qa', 'security'].map((role, i) => ({ role, label: ['Architecte', 'Backend', 'QA', 'Sécurité'][i], capabilities: ['x'], readOnly: role !== 'backend', maxBudgetUsd: 1, state: 'idle', runningTasks: [] }));
const link = { id: 'm1', projectId: 'p1', repo: 'o/r', objective: 'Ajouter slugify', acceptanceCriteria: [], scope: ['src'], budgetUsd: 3, localState: 'linked', ctoMissionId: 'c1', status: 'awaiting_owner', pendingApprovals: ['architecture'], blockers: [], spentUsd: 0.07, estimatedUsd: 0, createdAt: '', updatedAt: '' };

beforeEach(() => {
  hoisted.request.mockReset(); hoisted.request.mockResolvedValue({}); hoisted.confirm.mockClear();
  hoisted.data = {
    '/cto/team': { supervisor: { id: 'cto-ia', name: 'CTO IA', role: 'supervisor', registered: true, connection: 'connected', accessRole: 'owner', endpoint: 'http://127.0.0.1:3000' }, runtime: { status: 'READY', blockers: [], isolation: 'bubblewrap-namespaces', containerCertified: false, checks: [{ name: 'bubblewrap_isolation', ok: true, detail: '' }] }, agents },
    '/projects/p1/cto/missions': [link],
    '/projects/p1/cto/missions/m1': { link, tasks: [{ id: 't1', role: 'architect', status: 'done', attempts: 1, corrections: 0, failures: 0, instruction: '' }], reports: [], events: [], report: { mission: {}, costByRole: { architect: 0.07 }, reviews: [], tests: null, acceptanceTests: null, git: { branch: 'cto/abc/backend-1', commit: 'a'.repeat(40), baseCommit: null, files: ['src/slug.js'], diffstat: '1 file', pushed: false, merged: false }, pullRequestBody: '## Objective', corrections: 0, reworkRounds: 0 } },
  };
});
afterEach(cleanup);

describe('vue Équipe IA', () => {
  it('montre le CTO connecté, ses quatre agents, l’isolation réelle (jamais « certifiée ») et la mission', async () => {
    render(<Team/>);
    expect(screen.getByText('CONNECTÉ')).toBeTruthy();
    for (const label of ['Architecte', 'Backend', 'QA', 'Sécurité']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText(/ce n’est pas un conteneur Docker certifié/)).toBeTruthy();
    fireEvent.click(screen.getByText('Ajouter slugify'));
    expect(await screen.findByText('Validation humaine requise')).toBeTruthy();
    expect(screen.getByText('cto/abc/backend-1', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Poussée : non · fusionnée : non/)).toBeTruthy();
  });
  it('n’envoie l’approbation qu’après confirmation explicite, avec confirm:true', async () => {
    render(<Team/>);
    fireEvent.click(screen.getByText('Ajouter slugify'));
    fireEvent.click(await screen.findByText('Approuver'));
    await waitFor(() => expect(hoisted.request).toHaveBeenCalled());
    expect(hoisted.confirm).toHaveBeenCalledTimes(1);
    expect(hoisted.request).toHaveBeenCalledWith('/projects/p1/cto/missions/m1/approvals', 'POST', expect.objectContaining({ kind: 'architecture', decision: 'approve', confirm: true }));
  });
  it('refus de confirmation : aucune requête', async () => {
    hoisted.confirm.mockResolvedValueOnce(false);
    render(<Team/>);
    fireEvent.click(screen.getByText('Ajouter slugify'));
    fireEvent.click(await screen.findByText('Refuser'));
    await waitFor(() => expect(hoisted.confirm).toHaveBeenCalled());
    expect(hoisted.request).not.toHaveBeenCalled();
  });
  it('isolation BLOCKED : création désactivée, raison affichée', () => {
    (hoisted.data['/cto/team'] as { runtime: unknown }).runtime = { status: 'BLOCKED', blockers: ['bubblewrap_isolation: bwrap not found'], isolation: 'unavailable', containerCertified: false, checks: [] };
    render(<Team/>);
    expect(screen.getByText(/BLOCKED : bubblewrap_isolation: bwrap not found/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Transmettre au CTO IA/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
