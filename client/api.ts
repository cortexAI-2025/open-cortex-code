import { useCallback, useEffect, useState } from 'react';
export interface Connection {
    url: string;
    token: string;
    remote?: boolean;
    pairingId?: string;
}
export interface DesktopBridge {
    getConnection(): Promise<Connection>;
    chooseDirectory(): Promise<string | null>;
    vaultStatus?(): Promise<{
        available: boolean;
        backend: string;
    }>;
    saveSecret?(id: string, secret: string): Promise<unknown>;
    loadSecret?(id: string): Promise<string | null>;
    deleteSecret?(id: string): Promise<unknown>;
}
declare global {
    interface Window {
        cortexDesktop?: DesktopBridge;
    }
}
export const isLoopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
export function parseConnection(raw: string, suppliedToken: string, remote = false, pairingId?: string): Connection {
    const url = new URL(raw);
    const exactRemote = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash;
    if (remote ? (typeof location === 'undefined' || location.protocol !== 'https:' || !exactRemote || url.username || url.password) : (!isLoopback(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)) {
        throw new Error('Connexion refusée : choisissez une URL HTTP(S) loopback (localhost, 127.0.0.1 ou [::1]). Aucun proxy cloud de secrets.');
    }
    const token = remote ? suppliedToken : new URLSearchParams(url.hash.slice(1)).get('token') || suppliedToken;
    if (!token.trim())
        throw new Error('Le jeton de pairing fourni par votre connecteur est requis.');
    return { url: url.origin, token: token.trim(), ...(remote ? { remote: true, ...(pairingId ? { pairingId } : {}) } : {}) };
}
export class RequestError extends Error {
    constructor(message: string, readonly status: number, readonly payload: Record<string, unknown>) { super(message); }
}
export async function sha256(content: string): Promise<string> {
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export class LocalApi {
    constructor(readonly connection: Connection) { }
    async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (path !== '/health' || this.connection.remote)
            headers.Authorization = `Bearer ${this.connection.token}`;
        if (body !== undefined)
            headers['Content-Type'] = 'application/json';
        let response: Response;
        try {
            response = await fetch(`${this.connection.url}/api${path}`, {
                method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
                mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
            });
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError')
                throw error;
            throw new Error('Connecteur inaccessible. Vérifiez son lancement, l’URL, les autorisations réseau local du navigateur et CORS. Aucun relais distant n’est utilisé.');
        }
        const text = await response.text();
        let data: unknown;
        try {
            data = JSON.parse(text);
        }
        catch {
            throw new Error(`Réponse non JSON du connecteur (HTTP ${response.status}). Vérifiez l’URL de votre moteur local.`);
        }
        if (!response.ok) {
            const issue = data as {
                error?: string;
                code?: string;
            };
            const sensitive = body && typeof body === 'object' && ['apiKey', 'secretHeaders', 'secretEnvironment'].some(key => key in body);
            throw new RequestError(sensitive ? `Opération de secret refusée (HTTP ${response.status}${issue.code ? ` · ${issue.code}` : ''}). Vérifiez le connecteur local.` : `${issue.error || 'API indisponible'} (HTTP ${response.status}${issue.code ? ` · ${issue.code}` : ''})`, response.status, sensitive ? { code: issue.code } : data as Record<string, unknown>);
        }
        return data as T;
    }
}
export function useResource<T>(api: LocalApi | null, path: string | null, poll = 0) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision(n => n + 1), []);
    useEffect(() => {
        setData(null);
        setError('');
        if (!api || !path) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let first = true;
        const load = async () => {
            if (first)
                setLoading(true);
            try {
                const result = await api.request<T>(path, 'GET', undefined, controller.signal);
                if (!controller.signal.aborted) {
                    setData(result);
                    setError('');
                }
            }
            catch (e) {
                if (!controller.signal.aborted)
                    setError(errorText(e));
            }
            finally {
                first = false;
                if (!controller.signal.aborted) {
                    setLoading(false);
                    if (poll)
                        timer = setTimeout(load, poll);
                }
            }
        };
        void load();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [api, path, poll, revision]);
    return { data, error, loading, refresh };
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'Erreur inattendue du connecteur.';
export const projectRoute = (id: string, resource: string) => `/projects/${encodeURIComponent(id)}/${resource}`;
export const dateLabel = (date?: string) => date ? new Date(date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'Non communiqué';
