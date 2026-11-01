import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from './migrations.js';

export class StorageError extends Error {
  constructor(public readonly code: 'inaccessible'|'conflict'|'invalid_input'|'save_failed'|'key_setup'|'capacity'|'paid_disabled', message: string) {
    super(message); this.name = 'StorageError';
  }
}
export class StorageDatabase {
  readonly raw: DatabaseSync;
  constructor(path: string) {
    try { this.raw = new DatabaseSync(path); migrate(this.raw); }
    catch { throw new StorageError('save_failed', 'Storage could not be opened or migrated.'); }
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).run(...params); }
  get(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).get(...params); }
  all(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).all(...params); }
  transaction<T>(action: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (result instanceof Promise) throw new StorageError('invalid_input', 'Storage transactions must be synchronous.');
      this.raw.exec('COMMIT'); return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      if (error instanceof StorageError) throw error;
      throw new StorageError('save_failed', 'The change could not be saved.');
    }
  }
  close() { this.raw.close(); }
}

export function json(value: unknown, maxBytes = 1_000_000): string {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result) > maxBytes) throw new StorageError('invalid_input', 'Storage payload exceeds its limit.');
  return result;
}
export function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new StorageError('invalid_input', 'Expected a bounded integer.');
  return value;
}
