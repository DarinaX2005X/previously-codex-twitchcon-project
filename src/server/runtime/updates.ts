import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Principal } from './security.js';
import { ApiError } from './errors.js';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const updateSchema = z.object({
  channelId: identifier, runId: identifier,
  event: z.enum(['snapshot.changed', 'privacy.invalidated', 'source.status', 'publication.synced', 'playback.prepare', 'playback.start', 'playback.cancel']),
  data: z.object({sessionId: identifier, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), affectedIds: z.array(identifier).max(100).optional()}).strict(),
}).strict();
export type RevisionUpdate = z.infer<typeof updateSchema>;
type Client = {principal: Principal; response: Response; authorize: () => Promise<boolean>};
const sameScope = (event: RevisionUpdate, principal: Principal) => event.channelId === principal.channelId && event.runId === principal.runId;

/** Contains identifiers and revision numbers only, never story text or provider payloads. */
export class RevisionStream {
  private readonly records: RevisionUpdate[] = [];
  private readonly clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly capacity = 1000, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid revision stream capacity.');
  }
  publish(input: RevisionUpdate): void {
    const event = updateSchema.parse(input);
    const previous = this.records.findLast(record => record.channelId === event.channelId && record.runId === event.runId);
    if (previous && event.data.revision <= previous.data.revision) throw new Error('Revision updates must be strictly increasing within scope.');
    this.records.push(event);
    if (this.records.length > this.capacity) this.records.shift();
    for (const client of this.clients) if (sameScope(event, client.principal)) this.write(client, event);
  }
  catchUp(principal: Principal, cursor: number | undefined): {reset: boolean; records: RevisionUpdate[]} {
    const scoped = this.records.filter(record => sameScope(record, principal));
    if (cursor === undefined || !scoped.some(record => record.data.revision === cursor)) return {reset: true, records: []};
    return {reset: false, records: scoped.filter(record => record.data.revision > cursor)};
  }
  private write(client: Client, event: RevisionUpdate): void {
    // Authorization is checked on every heartbeat. Revocation adapters should also call revoke().
    if (client.principal.expiresAtMs <= this.now()) { client.response.end(); this.clients.delete(client); return; }
    if (!client.response.write(`id: ${event.data.revision}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)) {
      client.response.end(); this.clients.delete(client);
    }
  }
  handler(authorize: (principal: Principal) => boolean | Promise<boolean> = () => false): RequestHandler {
    return (req, res, next) => {
      const principal = res.locals.principal as Principal | undefined;
      if (!principal) { next(new ApiError(401, 'session_required', 'Sign in to continue.')); return; }
      if (this.clients.size >= 32) { next(new ApiError(429, 'stream_capacity', 'Too many active update streams.', true)); return; }
      const raw = req.headers['last-event-id'];
      const cursor = typeof raw === 'string' && /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
      const backlog = this.catchUp(principal, cursor);
      res.status(200).set({'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'});
      res.flushHeaders();
      const client: Client = {principal, response: res, authorize: async () => authorize(principal)};
      if (backlog.reset) res.write('event: snapshot.reset\ndata: {}\n\n');
      else for (const event of backlog.records) this.write(client, event);
      if (!res.writableEnded) this.clients.add(client);
      req.on('close', () => { this.clients.delete(client); this.stopHeartbeatIfEmpty(); });
      this.startHeartbeat();
    };
  }
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        void client.authorize().then(authorized => {
          if (!authorized || client.principal.expiresAtMs <= this.now() || !client.response.write(': heartbeat\n\n')) {
            client.response.end(); this.clients.delete(client); this.stopHeartbeatIfEmpty();
          }
        }).catch(() => {client.response.end(); this.clients.delete(client); this.stopHeartbeatIfEmpty();});
      }
    }, 2000);
    this.heartbeat.unref();
  }
  private stopHeartbeatIfEmpty(): void { if (!this.clients.size && this.heartbeat) {clearInterval(this.heartbeat); this.heartbeat = undefined;} }
  revoke(predicate: (principal: Principal) => boolean): void {
    for (const client of this.clients) if (predicate(client.principal)) {client.response.end(); this.clients.delete(client);}
    this.stopHeartbeatIfEmpty();
  }
  close(): void { this.revoke(() => true); }
}
