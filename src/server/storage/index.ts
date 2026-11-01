import { StorageDatabase } from './database.js';
import { SqliteRepository } from './repository.js';
import { SessionStore, TokenVault } from './auth.js';
import { BudgetStore } from './budget.js';
export { StorageError } from './database.js';
export { SqliteRepository } from './repository.js';
export type { WorkInput, WorkLease, EntityInput, PrivacyOptions } from './repository.js';
export { TokenVault, SessionStore, hashOpaqueId } from './auth.js';
export { BudgetStore } from './budget.js';

export function createStorage(options:{path:string;now?:()=>number;encryptionKey?:Uint8Array;keyVersion?:number;maxBytes?:number}) {
  const db=new StorageDatabase(options.path,options.maxBytes),now=options.now ?? Date.now;
  try {
    const repository=new SqliteRepository(db,now);
    if(db.reconcileGlobalTerms)repository.reconcileLegacyTermBlocks();
    return {
      repository,
      sessions:new SessionStore(db,now),
      budget:new BudgetStore(db,now),
      tokenVault:options.encryptionKey ? new TokenVault(db,options.encryptionKey,options.keyVersion ?? 1) : null,
      close:()=>db.close(),
    };
  } catch(error) {db.close();throw error;}
}
