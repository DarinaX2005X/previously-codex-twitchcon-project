import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from './migrations.js';
import { overlaps } from '../../core/evidence.js';

export class StorageError extends Error {
  constructor(public readonly code: 'inaccessible'|'conflict'|'invalid_input'|'save_failed'|'key_setup'|'capacity'|'paid_disabled', message: string) {
    super(message); this.name = 'StorageError';
  }
}
export class StorageDatabase {
  readonly raw: DatabaseSync;
  private transactionDepth=0;
  private savepointSequence=0;
  private closed=false;
  constructor(path: string,maxBytes=2*1024*1024*1024) {
    let opened:DatabaseSync|undefined;
    try {
      integer(maxBytes,1);
      opened=new DatabaseSync(path);this.raw=opened;migrate(this.raw);
      this.raw.function('ranges_overlap',{deterministic:true},(a,b,c,d)=>Number(overlaps(Number(a),Number(b),Number(c),Number(d))));
      const pageSize=Number(this.raw.prepare('PRAGMA page_size').get()!.page_size);
      const pages=Math.floor(maxBytes/pageSize);
      if(pages<1) throw new StorageError('capacity','Configured database limit is smaller than one page.');
      const result=this.raw.prepare(`PRAGMA max_page_count=${pages}`).get()!;
      if(Number(result.max_page_count)>pages) throw new StorageError('capacity','Existing database exceeds its configured size limit.');
    } catch(error) {
      opened?.close();
      if(error instanceof StorageError)throw error;
      throw new StorageError('save_failed', 'Storage could not be opened or migrated.');
    }
  }
  run(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).run(...params); }
  get(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).get(...params); }
  all(sql: string, ...params: SQLInputValue[]) { return this.raw.prepare(sql).all(...params); }
  transaction<T>(action: () => T): T {
    const nested=this.transactionDepth>0,name=`storage_${++this.savepointSequence}`;
    this.raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = action();
      if (result instanceof Promise || (result && typeof result==='object' && 'then' in result)) throw new StorageError('invalid_input', 'Storage transactions must be synchronous.');
      this.raw.exec(nested ? `RELEASE ${name}` : 'COMMIT'); return result;
    } catch (error) {
      this.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name};` : 'ROLLBACK');
      if (error instanceof StorageError) throw error;
      throw new StorageError('save_failed', 'The change could not be saved.');
    } finally {this.transactionDepth--;}
  }
  close() {if(!this.closed){this.raw.close();this.closed=true;}}
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
