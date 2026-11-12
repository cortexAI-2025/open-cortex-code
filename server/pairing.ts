import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './security.js';

export type PairingState = 'pending' | 'approved' | 'paired' | 'denied' | 'expired' | 'revoked';
interface PairingRecord {
  id: string;
  origin: string;
  state: PairingState;
  createdAt: number;
  expiresAt: number;
  deliveryUntil?: number;
  removeAfter?: number;
  token?: string;
  tokenHash?: string;
}
export interface PairingSummary {
  id: string;
  origin: string;
  state: PairingState;
  createdAt: string;
  expiresAt: string;
}

const requestTtlMs = 2 * 60_000;
const tokenTtlMs = 30 * 60_000;
const deliveryTtlMs = 60_000;
const originCooldownMs = 10_000;
const enableWindowMs = 5 * 60_000;
const maximumRequests = 32;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Volatile pairing registry. Neither pending requests nor grants survive connector restart. */
export class PairingManager {
  private readonly records = new Map<string, PairingRecord>();
  private readonly lastRequestByOrigin = new Map<string, number>();
  private readonly recentRequests: number[] = [];
  private enabledUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  control(): { enabled: boolean; enabledUntil: string | null } {
    const enabled = this.enabledUntil > this.now();
    return { enabled, enabledUntil: enabled ? new Date(this.enabledUntil).toISOString() : null };
  }

  enableFor(): void { this.enabledUntil = this.now() + enableWindowMs; }
  disable(): void { this.enabledUntil = 0; }

  request(origin: string): { id: string; state: 'pending'; expiresAt: string } {
    const exact = this.validateOrigin(origin);
    this.prune();
    if (!this.control().enabled) throw new HttpError(403, 'Le pairing distant est désactivé. Activez-le temporairement depuis l’interface locale.', 'PAIRING_DISABLED');
    const existing = [...this.records.values()].find((entry) => entry.origin === exact && entry.state === 'pending');
    if (existing) return { id: existing.id, state: 'pending', expiresAt: new Date(existing.expiresAt).toISOString() };
    if ([...this.records.values()].some((entry) => entry.origin === exact && (entry.state === 'approved' || entry.state === 'paired'))) throw new HttpError(409, 'Une session de cette origine existe déjà; révoquez-la localement avant un nouveau pairing.', 'PAIRING_ALREADY_ACTIVE');
    const last = this.lastRequestByOrigin.get(exact);
    if (last !== undefined && this.now() - last < originCooldownMs) throw new HttpError(429, 'Nouvelle demande de pairing trop rapprochée.', 'PAIRING_RATE_LIMIT');
    const createdAt = this.now();
    while (this.recentRequests.length && this.recentRequests[0]! <= createdAt - 60_000) this.recentRequests.shift();
    if (this.recentRequests.length >= 10) throw new HttpError(429, 'Trop de demandes de pairing récentes sur ce connecteur.', 'PAIRING_GLOBAL_RATE_LIMIT');
    if (this.records.size >= maximumRequests) throw new HttpError(429, 'Trop de demandes de pairing en attente.', 'PAIRING_CAPACITY');
    const record: PairingRecord = { id: randomUUID(), origin: exact, state: 'pending', createdAt, expiresAt: createdAt + requestTtlMs };
    this.records.set(record.id, record);
    this.lastRequestByOrigin.set(exact, createdAt);
    this.recentRequests.push(createdAt);
    return { id: record.id, state: 'pending', expiresAt: new Date(record.expiresAt).toISOString() };
  }

  list(): PairingSummary[] {
    this.prune();
    return [...this.records.values()].map(({ id, origin, state, createdAt, expiresAt }) => ({ id, origin, state, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() }));
  }

  hasOrigin(origin: string): boolean {
    this.prune();
    return [...this.records.values()].some((entry) => entry.origin === origin && (entry.state === 'approved' || entry.state === 'paired'));
  }

  acceptsOrigin(origin: string): boolean {
    try { return this.validateOrigin(origin) === origin; } catch { return false; }
  }

  canReadRequest(id: string, origin: string): boolean {
    this.prune();
    const entry = this.records.get(id);
    return Boolean(entry && entry.origin === origin && ['pending', 'approved', 'paired', 'denied', 'expired', 'revoked'].includes(entry.state));
  }

  status(id: string, origin: string): { state: PairingState; token?: string; expiresAt: string } {
    this.prune();
    const entry = this.records.get(id);
    if (!entry || entry.origin !== origin) throw new HttpError(404, 'Demande de pairing introuvable.', 'PAIRING_NOT_FOUND');
    if (entry.state === 'approved' && entry.token && entry.deliveryUntil && entry.deliveryUntil > this.now()) {
      const token = entry.token;
      entry.token = undefined;
      entry.state = 'paired';
      return { state: 'paired', token, expiresAt: new Date(entry.expiresAt).toISOString() };
    }
    return { state: entry.state, expiresAt: new Date(entry.expiresAt).toISOString() };
  }

  approve(id: string): { state: 'approved'; origin: string; expiresAt: string } {
    this.prune();
    const entry = this.records.get(id);
    if (!entry || entry.state !== 'pending') throw new HttpError(409, 'Cette demande n’est plus en attente.', 'PAIRING_NOT_PENDING');
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    entry.state = 'approved';
    entry.token = token;
    entry.tokenHash = digest(token);
    entry.expiresAt = issuedAt + tokenTtlMs;
    entry.deliveryUntil = issuedAt + deliveryTtlMs;
    return { state: 'approved', origin: entry.origin, expiresAt: new Date(entry.expiresAt).toISOString() };
  }

  deny(id: string): void {
    this.prune();
    const entry = this.records.get(id);
    if (!entry || entry.state !== 'pending') throw new HttpError(409, 'Cette demande n’est plus en attente.', 'PAIRING_NOT_PENDING');
    entry.state = 'denied'; entry.removeAfter = this.now() + 60_000;
  }

  revoke(id: string): void {
    const entry = this.records.get(id);
    if (!entry || !['approved', 'paired'].includes(entry.state)) throw new HttpError(404, 'Pairing actif introuvable.', 'PAIRING_NOT_FOUND');
    entry.state = 'revoked';
    entry.token = undefined;
    entry.tokenHash = undefined;
    entry.removeAfter = this.now() + 60_000;
  }

  authenticate(token: string, origin: string): boolean {
    return Boolean(this.authenticatedRecord(token, origin));
  }

  canRevoke(token: string, origin: string, id: string): boolean {
    return this.authenticatedRecord(token, origin)?.id === id;
  }

  private authenticatedRecord(token: string, origin: string): PairingRecord | undefined {
    this.prune();
    const candidate = digest(token);
    for (const entry of this.records.values()) {
      if (!entry.tokenHash || entry.state !== 'paired' || entry.origin !== origin || entry.expiresAt <= this.now()) continue;
      const expected = Buffer.from(entry.tokenHash, 'hex');
      const actual = Buffer.from(candidate, 'hex');
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) return entry;
    }
    return undefined;
  }

  private validateOrigin(origin: string): string {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(400, 'Origin HTTPS exacte requise.', 'PAIRING_ORIGIN_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || isIP(parsed.hostname) !== 0) {
      throw new HttpError(400, 'Le pairing distant exige une origine HTTPS publique exacte, sans identifiants, chemin, query ni fragment.', 'PAIRING_ORIGIN_INVALID');
    }
    return parsed.origin;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.records) {
      if (entry.expiresAt <= now && !['denied', 'revoked', 'expired'].includes(entry.state)) { entry.state = 'expired'; entry.token = undefined; entry.tokenHash = undefined; entry.removeAfter = now + 60_000; }
      if (entry.state === 'approved' && entry.deliveryUntil !== undefined && entry.deliveryUntil <= now) { entry.state = 'expired'; entry.token = undefined; entry.tokenHash = undefined; entry.removeAfter = now + 60_000; }
      if (['denied', 'revoked', 'expired'].includes(entry.state) && (entry.removeAfter ?? now + 60_000) <= now) this.records.delete(id);
    }
    for (const [origin, requestedAt] of this.lastRequestByOrigin) if (now - requestedAt > requestTtlMs + originCooldownMs) this.lastRequestByOrigin.delete(origin);
  }
}
