import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { canDispatch } from '../../core/recap.js';
import type { DomainEvent, DomainState } from '../../core/types.js';
import { IdSchema, IsoTimeSchema, RecapPlanSchema, type Clock, type PlaybackRef, type Scope } from '../../shared/contracts/index.js';
import { ApiError } from './errors.js';
import type { Principal } from './security.js';

export interface OverlayEnginePort {
  readonly scope: Scope;
  activeSessionId(): string | null;
  state(sessionId: string): DomainState;
  /** The coordinator persists the transition and publishes its revision/playback updates. */
  dispatch(sessionId: string, event: DomainEvent): Promise<DomainState>;
}
export type OverlayState = {
  sessionId: string | null; privacyEpoch: number; revision: number; serverNow: string;
  active: PlaybackRef | null; queued: PlaybackRef[];
};
export type OverlayRouterOptions = {engine: OverlayEnginePort; clock: Clock};

const ackSchema = z.object({state: z.enum(['prepared', 'started', 'ended', 'error']), timestamp: IsoTimeSchema}).strict();
const noQuery = z.object({}).strict();
const liveStatus = new Set<PlaybackRef['status']>(['preparing', 'playing', 'queued']);
const ackAction = {prepared: 'prepared', started: 'start', ended: 'end', error: 'error'} as const;
const gone = () => new ApiError(410, 'playback_unavailable', 'This playback is no longer available.');

function authorize(response: Response, options: OverlayRouterOptions): Principal {
  const principal = response.locals.principal as Principal | undefined;
  if (!principal || principal.expiresAtMs <= options.clock.now()) throw new ApiError(401, 'session_required', 'Reconnect the overlay to continue.');
  if (principal.role !== 'overlay' || principal.runId !== 'live' || principal.channelId !== options.engine.scope.channelId || principal.runId !== options.engine.scope.runId) throw new ApiError(403, 'role_forbidden', 'This session cannot access that resource.');
  return principal;
}
function currentState(engine: OverlayEnginePort): DomainState | null {
  const sessionId = engine.activeSessionId();
  if (!sessionId) return null;
  const state = engine.state(sessionId);
  if (state.session.id !== sessionId || state.session.channelId !== engine.scope.channelId || state.session.runId !== engine.scope.runId) throw new ApiError(403, 'wrong_scope', 'This session cannot access that resource.');
  return state;
}
/** Explicit projection: the rest of DomainState can contain private evidence and owner drafts. */
function safePlayback(state: DomainState, playback: PlaybackRef, now: number): PlaybackRef | null {
  if (!liveStatus.has(playback.status) || !state.published || playback.plan === null) return null;
  const parsed = RecapPlanSchema.safeParse(playback.plan);
  if (!parsed.success || !canDispatch(state, parsed.data) || parsed.data.revision > state.published.revision) return null;
  if (playback.startAt !== null) {
    const start = Date.parse(playback.startAt);
    if (!Number.isFinite(start)) return null;
    if (playback.status === 'preparing' && now - start > 3000) return null;
    if (playback.status === 'playing' && now >= start + parsed.data.durationMs) return null;
  } else if (playback.status === 'playing') return null;
  return {id: IdSchema.parse(playback.id), status: playback.status, plan: parsed.data, startAt: playback.startAt};
}
function snapshot(state: DomainState | null, clock: Clock): OverlayState {
  const output: OverlayState = {sessionId: state?.session.id ?? null, privacyEpoch: state?.session.privacyEpoch ?? 0, revision: state?.revision ?? 0, serverNow: clock.iso(), active: null, queued: []};
  if (!state) return output;
  for (const playback of state.playbacks) {
    const safe = safePlayback(state, playback, clock.now());
    if (!safe) continue;
    if (safe.status === 'queued') {if (!output.queued.length) output.queued.push(safe);}
    else if (!output.active) output.active = safe;
    if (output.active && output.queued.length) break;
  }
  return output;
}
function resolvePlayback(state: DomainState | null, id: string): {state: DomainState; playback: PlaybackRef} {
  const playback = state?.playbacks.find(value => value.id === id);
  if (!state || !playback) throw new ApiError(404, 'not_found', 'This playback is unavailable.');
  return {state, playback};
}

/** Mount at /api/overlay behind the application overlay session, origin and CSRF guards. */
export function createOverlayRouter(options: OverlayRouterOptions): Router {
  const router = Router();
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  function serialize(action: () => Promise<void>): Promise<void> {
    if (pending >= 16) return Promise.reject(new ApiError(429, 'ack_capacity', 'Too many playback acknowledgements are pending.', true));
    pending++;
    const result = tail.then(action).finally(() => {pending--;});
    tail = result.catch(() => undefined);
    return result;
  }
  const handle = (action: (request: Request, response: Response) => void | Promise<void>) => async (request: Request, response: Response, next: (error?: unknown) => void) => {
    try {authorize(response, options); noQuery.parse(request.query); response.setHeader('Cache-Control', 'no-store'); await action(request, response);}
    catch (error) {next(error instanceof z.ZodError ? new ApiError(400, 'invalid_input', 'The request does not match the expected format.') : error);}
  };
  router.get('/state', handle((_request, response) => {response.json(snapshot(currentState(options.engine), options.clock));}));
  router.get('/recaps/:id', handle((request, response) => {
    const {state, playback} = resolvePlayback(currentState(options.engine), IdSchema.parse(request.params.id));
    const safe = safePlayback(state, playback, options.clock.now());
    if (!safe) throw gone();
    response.json(safe);
  }));
  router.post('/recaps/:id/ack', handle(async (request, response) => {
    const input = ackSchema.parse(request.body), id = IdSchema.parse(request.params.id);
    await serialize(async () => {
      authorize(response, options);
      const now = options.clock.now(), timestamp = Date.parse(input.timestamp);
      if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 30_000) throw new ApiError(400, 'invalid_timestamp', 'The acknowledgement timestamp is outside the allowed window.');
      const {state, playback} = resolvePlayback(currentState(options.engine), id);
      if (!liveStatus.has(playback.status)) throw gone();
      if (!state.published || !playback.plan || !RecapPlanSchema.safeParse(playback.plan).success || !canDispatch(state, playback.plan) || playback.plan.revision > state.published.revision) throw gone();
      if (playback.status === 'queued') throw new ApiError(409, 'playback_not_active', 'This playback is still queued.');
      if (input.state === 'prepared') {
        if (playback.status !== 'preparing') throw new ApiError(409, 'playback_state_conflict', 'This playback has already started.');
        if (playback.startAt !== null) {
          if (now - Date.parse(playback.startAt) > 3000) throw gone();
          return; // Duplicate prepared must not schedule another start time.
        }
      }
      if (input.state === 'started') {
        if (playback.status === 'playing') {
          if (!safePlayback(state, playback, now)) throw gone();
          return;
        }
        if (!playback.startAt || now < Date.parse(playback.startAt)) throw new ApiError(409, 'playback_not_scheduled', 'Wait for the scheduled playback start.');
        if (now - Date.parse(playback.startAt) > 3000) {
          await options.engine.dispatch(state.session.id, {type: 'playback', id, action: 'start'});
          throw gone(); // The reducer records skipped, so a reconnect cannot restart this ID.
        }
      }
      if (input.state === 'ended' && playback.status !== 'playing') throw new ApiError(409, 'playback_state_conflict', 'This playback has not started.');
      await options.engine.dispatch(state.session.id, {type: 'playback', id, action: ackAction[input.state]});
    });
    response.status(204).end();
  }));
  return router;
}
