/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as integrationsModule from '../client/views/Integrations';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('../client/state', () => ({
  useConnection: () => ({ api: null, remote: false }),
  useWorkspace: () => ({ projectId: '', project: null }),
  useAppActions: () => ({
    act: async (action: () => Promise<unknown>) => action(),
    confirm: async () => true,
    notify: vi.fn(),
    clearNotice: vi.fn(),
  }),
}));

vi.mock('../client/api', () => ({
  projectRoute: (projectId: string, resource: string) => `/projects/${projectId}/${resource}`,
  useResource: () => ({ data: [], error: '', loading: false, refresh: refreshMock }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('isolation du formulaire Integrations', () => {
  it('actualise le brouillon sans rerendre la vue Integrations parente', () => {
    const integrationsRender = vi.spyOn(integrationsModule, 'Integrations');
    render(<integrationsModule.Integrations/>);

    const name = screen.getByRole('textbox', { name: 'Nom (slug minuscules)' }) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    expect(integrationsRender).toHaveBeenCalledTimes(1);

    fireEvent.change(name, { target: { value: 'integration-profilage' } });

    expect(name.value).toBe('integration-profilage');
    expect(integrationsRender).toHaveBeenCalledTimes(1);
  });
});
