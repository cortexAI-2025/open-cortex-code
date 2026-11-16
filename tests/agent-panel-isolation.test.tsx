/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentPanelModule from '../client/components/AgentPanel';

vi.mock('../client/state', () => ({
  useConnection: () => ({ api: null, connected: true }),
  useBootstrap: () => ({ bootstrap: null }),
  useWorkspace: () => ({ projectId: 'project-test' }),
  useAgent: () => ({
    profileId: '',
    setProfileId: vi.fn(),
    mode: 'ask',
    setMode: vi.fn(),
    session: null,
    setSession: vi.fn(),
  }),
  useNavigationActions: () => ({ setView: vi.fn() }),
  useAppActions: () => ({
    act: async (action: () => Promise<unknown>) => action(),
    confirm: async () => true,
  }),
}));

vi.mock('../client/api', () => ({
  dateLabel: () => '',
  projectRoute: (projectId: string, resource: string) => `/projects/${projectId}/${resource}`,
  useResource: () => ({ data: null, error: '', loading: false, refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('isolation du composeur Agent', () => {
  it('met à jour le brouillon sans rappeler la fonction AgentPanel', () => {
    const agentPanelRender = vi.spyOn(agentPanelModule, 'AgentPanel');
    render(<agentPanelModule.AgentPanel expanded={false} />);
    const textarea = screen.getByRole('textbox', { name: 'Message de la session' }) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(agentPanelRender).toHaveBeenCalledTimes(1);

    fireEvent.change(textarea, { target: { value: 'corriger le test' } });

    expect(textarea.value).toBe('corriger le test');
    expect(agentPanelRender).toHaveBeenCalledTimes(1);
  });
});
