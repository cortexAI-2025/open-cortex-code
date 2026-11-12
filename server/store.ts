import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './security.js';

function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNoSecrets); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization|cookie|private[_-]?key|credentials)$/iu.test(key) && child !== undefined && child !== null && child !== '' && child !== '[REDACTED]') {
      throw new HttpError(400, 'Credential interdit dans le stockage durable.', 'SECRET_PERSISTENCE_DENIED');
    }
    assertNoSecrets(child);
  }
}
export class Store {
  private readonly db: DatabaseSync;
  constructor(public readonly filename: string, private readonly redact: (text: string) => string = (text) => text) {
    const dir = path.dirname(filename);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || (existsSync(filename) && lstatSync(filename).isSymbolicLink())) throw new Error('SQLite path must not be a symlink');
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_project ON records(kind,project_id);');
  }
  all<T>(kind: string, projectId?: string): T[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid LIMIT 5000').all(kind)
      : this.db.prepare('SELECT value FROM records WHERE kind=? AND project_id=? ORDER BY rowid LIMIT 5000').all(kind, projectId);
    return rows.map((row) => JSON.parse(String(row.value)) as T);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=? LIMIT 1').get(kind, id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  put<T extends { id: string }>(kind: string, value: T, projectId?: string): T {
    assertNoSecrets(value);
    if (!kind || !value.id) throw new HttpError(400, 'Identifiant stockage requis.', 'INVALID_RECORD');
    const json = this.redact(JSON.stringify(value));
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new HttpError(413, 'Entrée trop volumineuse.', 'RECORD_TOO_LARGE');
    // A JSON parse verifies redaction never corrupted serialization.
    const clean = JSON.parse(json) as T;
    this.db.prepare('INSERT INTO records(kind,id,project_id,value) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET project_id=excluded.project_id,value=excluded.value').run(kind, value.id, projectId ?? null, json);
    return clean;
  }
  remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  close(): void { this.db.close(); }
}
