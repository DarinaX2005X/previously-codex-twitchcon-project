import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Principal } from './security.js';
import { ApiError } from './errors.js';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const updateSchema = z.object({
  channelId: identifier, runId: identifier,
  event: z.enum(['snapshot.changed', 'privacy.invalidated', 'source.status', 'publication.synced', 'playback.prepare', 'playback.start', 'playback.cancel']),
  data: z.object({sessionId: identifier.nullable(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), affectedIds: z.array(identifier).max(100).optional()}).strict(),
}).strict();
export type RevisionUpdate = z.infer<typeof updateSchema>;
export type StoredRevisionUpdate = RevisionUpdate & {id: number};
export type RevisionConnectionEvent =
  | {type: 'activity' | 'disconnected'; principal: Principal}
  | {type: 'revoked'; matches: (principal: Principal) => boolean}
  | {type: 'closed'};
type Client = {principal: Principal; response: Response; authorize: () => Promise<boolean>; pending: Promise<void>; queued: number; checkingHeartbeat: boolean};
const sameScope = (event: RevisionUpdate, principal: Principal) => event.channelId === principal.channelId && event.runId === principal.runId;

/** Contains identifiers and revision numbers only, never story text or provider payloads. */
export class RevisionStream {
  private readonly records: StoredRevisionUpdate[] = [];
  private cursor = 0;
  private readonly clients = new Set<Client>();
  private readonly connectionObservers = new Set<(event: RevisionConnectionEvent) => void>();
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly capacity = 1000, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid revision stream capacity.');
  }
  publish(input: RevisionUpdate): void {
    if (this.closed) return;
    const event = {...updateSchema.parse(input), id: ++this.cursor};
    this.records.push(event);
    if (this.records.length > this.capacity) this.records.shift();
    for (const client of this.clients) if (sameScope(event, client.principal)) this.enqueue(client, event);
  }
  /** Internal lifecycle only: principals never enter an SSE payload. */
  observeConnections(listener: (event: RevisionConnectionEvent) => void): () => void {
    if (this.closed) {listener({type: 'closed'}); return () => {};}
    this.connectionObservers.add(listener);
    return () => {this.connectionObservers.delete(listener);};
  }
  private connection(event: RevisionConnectionEvent): void {
    for (const observer of this.connectionObservers) {try {observer(event);} catch { /* A status observer cannot keep a revoked stream open. */ }}
  }
  private disconnect(client: Client): void {
    const existed = this.clients.delete(client);
    if (!client.response.writableEnded && !client.response.destroyed) client.response.end();
    if (existed) this.connection({type: 'disconnected', principal: client.principal});
    this.stopHeartbeatIfEmpty();
  }
  catchUp(principal: Principal, cursor: number | undefined): {reset: boolean; records: StoredRevisionUpdate[]} {
    const scoped = this.records.filter(record => sameScope(record, principal));
    if (cursor === undefined || !scoped.some(record => record.id === cursor)) return {reset: true, records: []};
    return {reset: false, records: scoped.filter(record => record.id > cursor)};
  }
  private enqueue(client: Client, event: StoredRevisionUpdate): void {
    if (++client.queued > 100) {this.disconnect(client); return;}
    client.pending = client.pending.then(async () => {
      if (client.response.writableEnded || !this.clients.has(client)) return;
      if (!await client.authorize()) {this.disconnect(client); return;}
      if (!this.clients.has(client)) return;
      this.write(client, event);
    }).catch(() => {this.disconnect(client);}).finally(() => {client.queued--; this.stopHeartbeatIfEmpty();});
  }
  private write(client: Client, event: StoredRevisionUpdate): void {
    if (client.principal.expiresAtMs <= this.now()) {this.disconnect(client); return;}
    if (!client.response.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)) {
      this.disconnect(client);
    }
  }
  handler(authorize: (principal: Principal) => boolean | Promise<boolean> = () => false): RequestHandler {
    return async (req, res, next) => {
      const principal = res.locals.principal as Principal | undefined;
      if (!principal) { next(new ApiError(401, 'session_required', 'Sign in to continue.')); return; }
      try {
      if (this.closed) {next(new ApiError(503, 'shutting_down', 'The application is stopping.', true)); return;}
      if (principal.expiresAtMs <= this.now() || !await authorize(principal)) {next(new ApiError(401, 'session_required', 'Sign in to continue.')); return;}
      if (res.destroyed) return;
      if (this.closed) {next(new ApiError(503, 'shutting_down', 'The application is stopping.', true)); return;}
      if (this.clients.size >= 32) { next(new ApiError(429, 'stream_capacity', 'Too many active update streams.', true)); return; }
      const raw = req.headers['last-event-id'];
      const cursor = typeof raw === 'string' && /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
      const backlog = this.catchUp(principal, cursor);
      res.status(200).set({'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
      res.flushHeaders();
      const client: Client = {principal, response: res, authorize: async () => authorize(principal), pending: Promise.resolve(), queued: 0, checkingHeartbeat: false};
      this.clients.add(client);
      res.once('close', () => this.disconnect(client));
      if (backlog.reset) res.write('event: snapshot.reset\ndata: {}\n\n');
      else for (const event of backlog.records) this.enqueue(client, event);
      if (this.clients.has(client) && !res.writableEnded) this.connection({type: 'activity', principal});
      this.startHeartbeat();
      } catch (error) {next(error);}
    };
  }
  private startHeartbeat(): void {
    if (this.heartbeat || !this.clients.size || this.closed) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.checkingHeartbeat) continue;
        client.checkingHeartbeat = true;
        void client.authorize().then(authorized => {
          if (!this.clients.has(client)) return;
          if (!authorized || client.principal.expiresAtMs <= this.now() || !client.response.write(': heartbeat\n\n')) {
            this.disconnect(client);
          } else this.connection({type: 'activity', principal: client.principal});
        }).catch(() => {this.disconnect(client);}).finally(() => {client.checkingHeartbeat = false;});
      }
    }, 2000);
    this.heartbeat.unref();
  }
  private stopHeartbeatIfEmpty(): void { if (!this.clients.size && this.heartbeat) {clearInterval(this.heartbeat); this.heartbeat = undefined;} }
  revoke(predicate: (principal: Principal) => boolean): void {
    for (const client of this.clients) if (predicate(client.principal)) this.disconnect(client);
    this.connection({type: 'revoked', matches: predicate});
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.revoke(() => true);
    this.connection({type: 'closed'});
    this.connectionObservers.clear();
  }
}
