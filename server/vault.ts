import { HttpError } from './security.js';

/** Volatile BYOK vault. Deleted/rotated values remain redaction-only until shutdown. */
export class Vault {
  private readonly secrets = new Map<string, string>();
  private readonly redactions = new Set<string>();
  set(id: string, secret: string): void {
    if (!id || typeof secret !== 'string' || !secret.trim() || secret.length > 16_384 || /[\r\n\0]/u.test(secret)) {
      throw new HttpError(400, 'Secret invalide.', 'INVALID_SECRET');
    }
    this.secrets.set(id, secret);
    this.redactions.add(secret);
    try {
      const visit = (value: unknown): void => {
        if (typeof value === 'string' && value) this.redactions.add(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(JSON.parse(secret) as unknown);
    } catch { /* Ordinary API keys are not JSON. */ }
  }
  get(id: string): string | undefined { return this.secrets.get(id); }
  delete(id: string): void { this.secrets.delete(id); }
  redact(text: string): string {
    let result = text;
    for (const secret of [...this.redactions].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join('[REDACTED]');
      result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/giu, '$1 [REDACTED]')
      .replace(/((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"';}]+/giu, '$1[REDACTED]');
  }
  redactValue<T>(value: T): T {
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') return this.redact(item);
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, /^(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|credentials)$/iu.test(key) && child !== undefined && child !== null && child !== '' ? '[REDACTED]' : visit(child)]));
      return item;
    };
    return visit(value) as T;
  }
  clear(): void { this.secrets.clear(); this.redactions.clear(); }
}
