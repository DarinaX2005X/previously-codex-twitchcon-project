import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Scope } from '../../shared/contracts/index.js';
import { StorageDatabase, StorageError, integer, json } from './database.js';

export const hashOpaqueId = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Only give this object to the authentication adapter. Never attach it to a public repository. */
export class TokenVault {
  private readonly key: Buffer;
  constructor(private readonly db: StorageDatabase, key: Uint8Array, private readonly keyVersion = 1) {
    if (key.byteLength !== 32) throw new StorageError('key_setup', 'TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
    this.key = Buffer.from(key);
    const check = db.get('SELECT * FROM key_check WHERE id=1');
    if (check) {
      this.decrypt(check, 'key-check');
    } else {
      const sealed = this.encrypt('previously-storage-key', 'key-check');
      db.run('INSERT INTO key_check VALUES(1,?,?,?,?)', keyVersion, sealed.nonce, sealed.ciphertext, sealed.tag);
    }
  }
  private encrypt(plaintext: string, context: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    return {nonce, ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]), tag: cipher.getAuthTag()};
  }
  private decrypt(row: Record<string, unknown>, context: string): string {
    try {
      if (Number(row.key_version) !== this.keyVersion) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, row.nonce as Uint8Array);
      cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(row.tag as Uint8Array);
      return Buffer.concat([cipher.update(row.ciphertext as Uint8Array), cipher.final()]).toString('utf8');
    } catch { throw new StorageError('key_setup', 'Stored credentials cannot be decrypted. Restore the configured encryption key and version.'); }
  }
  put(scope: Scope, provider: string, credentials: unknown): void {
    if (scope.runId !== 'live') throw new StorageError('inaccessible', 'Provider credentials are available only in live scope.');
    const sealed = this.encrypt(json(credentials, 32_768), JSON.stringify([scope.channelId, scope.runId, provider]));
    this.db.run(`INSERT INTO tokens VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,run_id,provider)
      DO UPDATE SET key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag`,
    scope.channelId, scope.runId, provider, this.keyVersion, sealed.nonce, sealed.ciphertext, sealed.tag);
  }
  get<T = unknown>(scope: Scope, provider: string): T | null {
    if (scope.runId !== 'live') return null;
    const row = this.db.get('SELECT * FROM tokens WHERE channel_id=? AND run_id=? AND provider=?', scope.channelId, scope.runId, provider);
    return row ? JSON.parse(this.decrypt(row, JSON.stringify([scope.channelId, scope.runId, provider]))) as T : null;
  }
  disconnect(scope: Scope): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM tokens WHERE channel_id=? AND run_id=?', scope.channelId, scope.runId);
      this.db.run('DELETE FROM auth_sessions WHERE channel_id=? AND run_id=?', scope.channelId, scope.runId);
    });
  }
}

export class SessionStore {
  constructor(private readonly db: StorageDatabase, private readonly now: () => number) {}
  issue(scope: Scope, actorId: string, role: 'owner'|'overlay'|'demo', ttlMs = 7 * 86_400_000): string {
    if ((role === 'demo') !== (scope.runId !== 'live')) throw new StorageError('inaccessible', 'Session role does not match its scope.');
    integer(ttlMs, 1);
    if (ttlMs > 7 * 86_400_000) throw new StorageError('invalid_input', 'Session lifetime exceeds seven days.');
    const id = randomBytes(32).toString('base64url');
    this.db.run('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,1)', scope.channelId, scope.runId, hashOpaqueId(id), actorId, role, this.now() + ttlMs);
    return id;
  }
  verify(scope: Scope, opaqueId: string, role: 'owner'|'overlay'|'demo') {
    const row = this.db.get(`SELECT actor_id,expires_at_ms,version FROM auth_sessions
      WHERE channel_id=? AND run_id=? AND id_hash=? AND role=? AND expires_at_ms>?`,
    scope.channelId, scope.runId, hashOpaqueId(opaqueId), role, this.now());
    return row ? {actorId: String(row.actor_id), expiresAtMs: Number(row.expires_at_ms), version: Number(row.version)} : null;
  }
  logout(scope: Scope, opaqueId: string): void {
    this.db.run('DELETE FROM auth_sessions WHERE channel_id=? AND run_id=? AND id_hash=?', scope.channelId, scope.runId, hashOpaqueId(opaqueId));
  }
  revokeRole(scope: Scope, role: 'owner'|'overlay'|'demo'): void {
    this.db.run('DELETE FROM auth_sessions WHERE channel_id=? AND run_id=? AND role=?', scope.channelId, scope.runId, role);
  }
}
