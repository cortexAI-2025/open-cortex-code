import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalApi, parseConnection } from '../client/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('transport client HTTPS vers loopback', () => {
  it('n’accepte que l’IP 127.0.0.1 depuis un contexte HTTPS et refuse token en fragment', () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    expect(parseConnection('http://127.0.0.1:4100', 'volatile-token', true, 'f5f75456-981a-4de6-b5d2-40782444f5a1')).toEqual({
      url: 'http://127.0.0.1:4100', token: 'volatile-token', remote: true, pairingId: 'f5f75456-981a-4de6-b5d2-40782444f5a1',
    });
    for (const url of ['http://localhost:4100', 'https://127.0.0.1:4100', 'http://192.168.1.2:4100', 'http://127.0.0.1:4100/#token=fragment']) {
      expect(() => parseConnection(url, 'volatile-token', true)).toThrow();
    }
    vi.stubGlobal('location', { protocol: 'http:' });
    expect(() => parseConnection('http://127.0.0.1:4100', 'volatile-token', true)).toThrow();
  });

  it('envoie le bearer même sur health, sans cookies ni redirection', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ healthy: true, localOnly: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const api = new LocalApi({ url: 'http://127.0.0.1:4100', token: 'volatile-token', remote: true, pairingId: 'pair-id' });
    await api.request('/health');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4100/api/health');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer volatile-token');
    expect(init.credentials).toBe('omit');
    expect(init.mode).toBe('cors');
    expect(init.redirect).toBe('error');
  });
});
