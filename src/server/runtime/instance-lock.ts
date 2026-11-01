import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class InstanceLockError extends Error {
  constructor(message: string) { super(message); this.name = 'InstanceLockError'; }
}
type LockRecord = {pid: number; instanceId: string};
function readLock(path: string): LockRecord {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('pid' in value) || !('instanceId' in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.instanceId !== 'string') throw new Error();
    return {pid: Number(value.pid), instanceId: value.instanceId};
  } catch { throw new InstanceLockError('The instance lock cannot be verified. Inspect it while the application is stopped.'); }
}
function processExists(pid: number): boolean {
  try {process.kill(pid, 0); return true;} catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}
/** Stale recovery is explicit. Never remove a lock owned by a live or unverified process. */
export function acquireInstanceLock(dataDirectory: string, recoverStale = false): {release(): void} {
  mkdirSync(dataDirectory, {recursive: true});
  const path = resolve(realpathSync(dataDirectory), 'instance.lock');
  const acquisition = resolve(realpathSync(dataDirectory), 'instance-acquiring');
  try {mkdirSync(acquisition);} catch {throw new InstanceLockError('Another startup is checking this data directory. If it crashed, inspect the instance-acquiring directory while all instances are stopped.');}
  let record: LockRecord;
  try {
  if (existsSync(path)) {
    const old = readLock(path);
    if (processExists(old.pid)) throw new InstanceLockError('Another Previously instance already owns this data directory.');
    if (!recoverStale) throw new InstanceLockError('A stopped instance left a lock. Retry with --recover-stale-lock after confirming it is stopped.');
    if (readLock(path).instanceId !== old.instanceId) throw new InstanceLockError('The instance lock changed. Try again.');
    unlinkSync(path);
  }
  record = {pid: process.pid, instanceId: randomUUID()};
  let fd: number;
  try {fd = openSync(path, 'wx', 0o600);} catch {throw new InstanceLockError('Another Previously instance acquired this data directory.');}
  try {writeFileSync(fd, JSON.stringify(record), 'utf8');} finally {closeSync(fd);}
  } finally {rmdirSync(acquisition);}
  let released = false;
  return {release() {
    if (released) return;
    released = true;
    if (existsSync(path) && readLock(path).instanceId === record.instanceId) unlinkSync(path);
  }};
}
