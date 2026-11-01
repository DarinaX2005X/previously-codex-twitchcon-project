import type { DatabaseSync } from 'node:sqlite';

/** DELETE journaling permits a consistent backup only while the instance is stopped. */
export function migrate(db: DatabaseSync): boolean {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);`);
  const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
  if (version && Number(version) > 3) throw new Error('Storage schema is newer than this application.');
  if (version === 3) return false;
  if (version === 2) { upgrade3(db); return true; }
  if (version === 1) { upgrade2(db); upgrade3(db); return true; }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE channels(channel_id TEXT NOT NULL, run_id TEXT NOT NULL, login TEXT NOT NULL,
      privacy_revision INTEGER NOT NULL DEFAULT 0, publish_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id,run_id));
    CREATE TABLE sessions(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,
      stream_id TEXT,started_at TEXT NOT NULL,ended_at TEXT,status TEXT NOT NULL DEFAULT 'live',
      privacy_epoch INTEGER NOT NULL DEFAULT 0,publication_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id,run_id,id), UNIQUE(channel_id,run_id,stream_id),
      FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    CREATE INDEX sessions_time ON sessions(channel_id,run_id,started_at,id);
    CREATE TABLE events(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT,
      external_id TEXT NOT NULL,origin TEXT NOT NULL,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,offset_ms INTEGER,payload TEXT,
      PRIMARY KEY(channel_id,run_id,id),UNIQUE(channel_id,run_id,origin,external_id),
      FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    CREATE INDEX events_session_time ON events(channel_id,run_id,session_id,occurred_at,id);
    CREATE TABLE sources(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,
      event_id TEXT,revision INTEGER NOT NULL,kind TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,
      actor_id TEXT,external_message_id TEXT,status TEXT NOT NULL,text TEXT,metadata TEXT NOT NULL,
      PRIMARY KEY(channel_id,run_id,id),FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id),
      FOREIGN KEY(channel_id,run_id,event_id) REFERENCES events(channel_id,run_id,id));
    CREATE INDEX sources_time ON sources(channel_id,run_id,session_id,start_ms,id);
    CREATE UNIQUE INDEX sources_external ON sources(channel_id,run_id,external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE INDEX sources_actor ON sources(channel_id,run_id,session_id,actor_id,end_ms);
    CREATE TABLE source_tombstones(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,
      session_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT,from_ms INTEGER,to_ms INTEGER,reason TEXT NOT NULL,
      PRIMARY KEY(channel_id,run_id,id),FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE INDEX tombstones_lookup ON source_tombstones(channel_id,run_id,session_id,kind,target_id);
    CREATE TABLE entities(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,
      kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,owner_revision INTEGER NOT NULL DEFAULT 0,
      owner_locked INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',
      body TEXT,start_ms INTEGER,end_ms INTEGER,PRIMARY KEY(channel_id,run_id,id),
      FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE INDEX entities_session ON entities(channel_id,run_id,session_id,kind,status);
    CREATE TABLE dependencies(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,parent_id TEXT NOT NULL,parent_revision INTEGER NOT NULL,
      child_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('supports','exposed_to')),
      PRIMARY KEY(channel_id,run_id,parent_id,child_id,kind));
    CREATE INDEX dependencies_child ON dependencies(channel_id,run_id,child_id);
    CREATE TABLE generation_jobs(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,ticket TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'registered',
      PRIMARY KEY(channel_id,run_id,id),FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE TABLE generation_inputs(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,job_id TEXT NOT NULL,
      input_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(channel_id,run_id,job_id,input_id),
      FOREIGN KEY(channel_id,run_id,job_id) REFERENCES generation_jobs(channel_id,run_id,id));
    CREATE TABLE jobs(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,
      kind TEXT NOT NULL,business_key TEXT NOT NULL,payload TEXT,privacy_epoch INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,next_at_ms INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_until_ms INTEGER,PRIMARY KEY(channel_id,run_id,id),UNIQUE(channel_id,run_id,business_key),
      FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE INDEX jobs_eligible ON jobs(channel_id,run_id,state,next_at_ms,priority);
    CREATE TABLE publication_candidates(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,
      session_id TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,
      privacy_epoch INTEGER NOT NULL,eligible_at_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      safe INTEGER NOT NULL DEFAULT 0,body TEXT,PRIMARY KEY(channel_id,run_id,id),
      FOREIGN KEY(channel_id,run_id,entity_id) REFERENCES entities(channel_id,run_id,id));
    CREATE INDEX candidates_eligible ON publication_candidates(channel_id,run_id,entity_id,status,eligible_at_ms,revision);
    CREATE TABLE public_pointers(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,entity_id TEXT NOT NULL,candidate_id TEXT NOT NULL,
      PRIMARY KEY(channel_id,run_id,entity_id),FOREIGN KEY(channel_id,run_id,candidate_id) REFERENCES publication_candidates(channel_id,run_id,id));
    CREATE TABLE outbox(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id TEXT NOT NULL,session_id TEXT NOT NULL,
      kind TEXT NOT NULL,business_key TEXT NOT NULL,payload TEXT,privacy_epoch INTEGER NOT NULL,publish_seq INTEGER,
      state TEXT NOT NULL DEFAULT 'queued',priority INTEGER NOT NULL DEFAULT 0,next_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until_ms INTEGER,outcome TEXT,
      PRIMARY KEY(channel_id,run_id,id),UNIQUE(channel_id,run_id,business_key),
      FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE INDEX outbox_eligible ON outbox(channel_id,run_id,state,next_at_ms,priority);
    CREATE TABLE publication_sync(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,ack_seq INTEGER NOT NULL DEFAULT 0,
      ack_hash TEXT,last_synced_at_ms INTEGER,pending_privacy INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id,run_id),FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    CREATE TABLE privacy_receipts(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(channel_id,run_id,idempotency_key));
    CREATE TABLE capture_leases(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,
      actor_id TEXT,epoch INTEGER NOT NULL DEFAULT 0,expires_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id,run_id),FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    CREATE TABLE auth_sessions(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,id_hash TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,role TEXT NOT NULL,expires_at_ms INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    CREATE INDEX auth_scope ON auth_sessions(channel_id,run_id,role,expires_at_ms);
    CREATE TABLE tokens(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,provider TEXT NOT NULL,
      key_version INTEGER NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,
      PRIMARY KEY(channel_id,run_id,provider),FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    CREATE TABLE key_check(id INTEGER PRIMARY KEY CHECK(id=1),key_version INTEGER NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL);
    CREATE TABLE budget_reservations(id TEXT PRIMARY KEY,amount_microusd INTEGER NOT NULL,state TEXT NOT NULL,
      actual_microusd INTEGER,created_at_ms INTEGER NOT NULL);
    CREATE TABLE budget_policy(id INTEGER PRIMARY KEY CHECK(id=1),limit_microusd INTEGER NOT NULL,paid_enabled INTEGER NOT NULL DEFAULT 0);
    INSERT INTO budget_policy VALUES(1,4500000,0);
    INSERT INTO schema_migrations VALUES(1);
    COMMIT;`);
  upgrade2(db);
  upgrade3(db);
  return false;
}

function upgrade2(db: DatabaseSync):void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE blocked_terms(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,term TEXT NOT NULL,
      PRIMARY KEY(channel_id,run_id,session_id,term),FOREIGN KEY(channel_id,run_id,session_id) REFERENCES sessions(channel_id,run_id,id));
    ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN category TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN metadata_end_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN finalized_at TEXT;
    ALTER TABLE sessions ADD COLUMN final_snapshot_ack_at TEXT;
    INSERT INTO schema_migrations VALUES(2); COMMIT;`);
}

function upgrade3(db:DatabaseSync):void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE blocked_terms RENAME TO blocked_terms_session;
    CREATE TABLE blocked_terms(channel_id TEXT NOT NULL,run_id TEXT NOT NULL,term TEXT NOT NULL,
      PRIMARY KEY(channel_id,run_id,term),FOREIGN KEY(channel_id,run_id) REFERENCES channels(channel_id,run_id));
    INSERT INTO blocked_terms SELECT DISTINCT channel_id,run_id,term FROM blocked_terms_session;
    DROP TABLE blocked_terms_session;
    INSERT INTO schema_migrations VALUES(3); COMMIT;`);
}
