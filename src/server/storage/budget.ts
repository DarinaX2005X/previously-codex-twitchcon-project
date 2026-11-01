import { StorageDatabase, StorageError, integer } from './database.js';

/** Application-wide ceiling, persisted across sessions and process restarts. Values are micro USD. */
export class BudgetStore {
  constructor(private readonly db: StorageDatabase, private readonly now: () => number) {}
  setPaidEnabled(enabled: boolean) { this.db.run('UPDATE budget_policy SET paid_enabled=? WHERE id=1', Number(enabled)); }
  status() {
    const policy = this.db.get('SELECT * FROM budget_policy WHERE id=1')!;
    const used = this.db.get(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_microusd ELSE 0 END),0) AS committed,
      COALESCE(SUM(CASE WHEN state='reserved' THEN amount_microusd ELSE 0 END),0) AS reserved FROM budget_reservations`)!;
    const committedMicroUsd=Number(used.committed),reservedMicroUsd=Number(used.reserved);
    return {enabled: Boolean(policy.paid_enabled), limitMicroUsd: Number(policy.limit_microusd), usedMicroUsd: committedMicroUsd+reservedMicroUsd,committedMicroUsd,reservedMicroUsd};
  }
  reserve(id: string, amountMicroUsd: number, runId: string): boolean {
    integer(amountMicroUsd, 1);
    if (runId !== 'live') throw new StorageError('paid_disabled', 'Replay cannot reserve paid provider work.');
    return this.db.transaction(() => {
      const existing = this.db.get('SELECT * FROM budget_reservations WHERE id=?', id);
      if (existing) {
        if (Number(existing.amount_microusd) !== amountMicroUsd) throw new StorageError('conflict', 'Reservation ID already has a different amount.');
        return existing.state === 'reserved';
      }
      const status = this.status();
      if (!status.enabled) throw new StorageError('paid_disabled', 'Paid provider work is disabled until the final test.');
      if (status.usedMicroUsd + amountMicroUsd > status.limitMicroUsd) return false;
      this.db.run('INSERT INTO budget_reservations VALUES(?,?,\'reserved\',NULL,?)', id, amountMicroUsd, this.now());
      return true;
    });
  }
  settle(id: string, actualMicroUsd: number): void {
    integer(actualMicroUsd);
    this.db.transaction(() => {
      const row = this.db.get('SELECT * FROM budget_reservations WHERE id=?', id);
      if (!row) throw new StorageError('inaccessible', 'Reservation is unavailable.');
      if (row.state === 'settled' && Number(row.actual_microusd) === actualMicroUsd) return;
      if (row.state !== 'reserved') throw new StorageError('conflict', 'Reservation is already closed.');
      this.db.run('UPDATE budget_reservations SET state=\'settled\',actual_microusd=? WHERE id=?', actualMicroUsd, id);
      if (actualMicroUsd > Number(row.amount_microusd)) this.db.run('UPDATE budget_policy SET paid_enabled=0 WHERE id=1');
    });
  }
  /** Only release a request known not to have reached a provider; unknown outcomes stay reserved. */
  releaseUnsent(id: string): void { this.db.run('UPDATE budget_reservations SET state=\'released\' WHERE id=? AND state=\'reserved\'', id); }
}
