import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('réservation atomique des automatisations', () => {
  it('ne laisse qu’une connexion SQLite réserver le même snapshot dû', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cortex-automation-claim-'));
    roots.push(root);
    const filename = path.join(root, 'connector.sqlite');
    const first = new Store(filename);
    const second = new Store(filename);
    stores.push(first, second);

    const due: {
      id: string;
      projectId: string;
      schedule: 'once';
      enabled: boolean;
      nextRun: string | undefined;
      updatedAt: string;
    } = {
      id: 'automation-1',
      projectId: 'project-1',
      schedule: 'once',
      enabled: true,
      nextRun: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
    };
    first.put('automations', due, due.projectId);

    // Both scheduler processes may have read this same due snapshot before either claims it.
    const firstSnapshot = first.get<typeof due>('automations', due.id)!;
    const secondSnapshot = second.get<typeof due>('automations', due.id)!;
    const firstClaim = { ...firstSnapshot, enabled: false, nextRun: undefined, updatedAt: '2026-11-15T10:00:01.000Z' };
    const secondClaim = { ...secondSnapshot, enabled: false, nextRun: undefined, updatedAt: '2026-11-15T10:00:01.000Z' };

    const claims = await Promise.all([
      Promise.resolve().then(() => first.compareAndSwap('automations', firstSnapshot, firstClaim, due.projectId)),
      Promise.resolve().then(() => second.compareAndSwap('automations', secondSnapshot, secondClaim, due.projectId)),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(first.get<typeof due>('automations', due.id)).toMatchObject({ enabled: false, updatedAt: '2026-11-15T10:00:01.000Z' });
  });
});
