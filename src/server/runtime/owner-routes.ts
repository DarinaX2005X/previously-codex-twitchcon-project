import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  IdSchema, IsoTimeSchema, OffsetSchema, PrivacyTargetSchema, RevisionSchema, SettingsSchema,
  type Chapter, type InvalidationReceipt, type Lore, type Moment, type OwnerSnapshot, type OwnerHistoryQuery, type OwnerHistoryPage,
  type PlaybackRef, type PrivacyTarget, type RecapPlan, type Session, type Settings, type Source,
} from '../../shared/contracts/index.js';
import { ApiError } from './errors.js';
import { isMutation, type Principal } from './security.js';

type Awaitable<T> = T | Promise<T>;
export type OwnerPage<T> = {items: T[]; nextCursor: string | null};
export type OwnerMutation = {principal: Principal; idempotencyKey: string};
export type OwnerRevisionMutation = OwnerMutation & {baseRevision: number};
export type SessionQuery = {limit: number; cursor?: string};
export type SourceQuery = {sessionId: string; limit: number; cursor?: string; fromMs?: number; toMs?: number};
export type ChapterPatch = {title?: string; summary?: string; pinned?: boolean};
export type LorePatch = {term?: string; explanation?: string; aliases?: string[]; originMs?: number | null};
export type SettingsPatch = Partial<Omit<Settings, 'revision'>>;
export type PlaybackAck = {state: 'prepared' | 'started' | 'ended' | 'error'; timestamp: string};

/** Methods must enforce scoped IDs, optimistic revisions, and persistent idempotency atomically. */
export interface OwnerService {
  bootstrap(principal: Principal): Awaitable<OwnerSnapshot>;
  listSessions(principal: Principal, query: SessionQuery): Awaitable<OwnerPage<Session>>;
  getSession(principal: Principal, id: string): Awaitable<OwnerSnapshot>;
  listSources(principal: Principal, query: SourceQuery): Awaitable<OwnerPage<Source>>;
  listHistory(principal: Principal, query: OwnerHistoryQuery): Awaitable<OwnerHistoryPage>;
  setSettings(context: OwnerRevisionMutation, patch: SettingsPatch): Awaitable<Settings>;
  editChapter(context: OwnerRevisionMutation, id: string, patch: ChapterPatch): Awaitable<Chapter>;
  deleteChapter(context: OwnerRevisionMutation, id: string): Awaitable<InvalidationReceipt>;
  privacy(context: OwnerMutation, input: {target: PrivacyTarget; reason: string}): Awaitable<InvalidationReceipt>;
  editLore(context: OwnerRevisionMutation, id: string, patch: LorePatch): Awaitable<Lore>;
  deleteLore(context: OwnerRevisionMutation, id: string): Awaitable<InvalidationReceipt>;
  confirmLore(context: OwnerRevisionMutation, id: string): Awaitable<Lore>;
  blockLore(context: OwnerRevisionMutation, id: string, blocked: boolean): Awaitable<Lore>;
  saveMoment(context: OwnerMutation, input: {sessionId: string; label?: string}): Awaitable<Moment>;
  previewRecap(principal: Principal, sessionId: string): Awaitable<RecapPlan | null>;
  triggerRecap(context: OwnerMutation, input: {sessionId: string; reason: 'manual' | 'hotkey'}): Awaitable<PlaybackRef>;
  cancelRecap(context: OwnerMutation, id: string): Awaitable<void>;
  acknowledgeRecap(context: OwnerMutation, id: string, input: PlaybackAck): Awaitable<void>;
}

const revision = RevisionSchema.max(Number.MAX_SAFE_INTEGER);
const revisionBody = z.object({baseRevision: revision.optional()}).strict();
const cursor = z.string().min(1).max(512);
const queryInteger = (maximum: number) => z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().min(0).max(maximum));
const sessionQuery = z.object({limit: queryInteger(50).pipe(z.number().min(1)).default(25), cursor: cursor.optional()}).strict();
const historyQuery = z.object({sessionId: IdSchema, kind: z.enum(['chapter','lore']), filter: z.enum(['all','published','draft','held']).default('all'), limit: queryInteger(50).pipe(z.number().min(1)).default(20), cursor: cursor.optional()}).strict();
const sourceQuery = z.object({
  sessionId: IdSchema, limit: queryInteger(100).pipe(z.number().min(1)).default(50), cursor: cursor.optional(),
  fromMs: queryInteger(172_800_000).optional(), toMs: queryInteger(172_800_000).optional(),
}).strict().refine(value => (value.fromMs === undefined) === (value.toMs === undefined), 'Supply both interval boundaries.')
  .refine(value => value.fromMs === undefined || value.toMs === undefined || value.toMs >= value.fromMs, 'The interval must be ordered.');
const chapterPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(), summary: z.string().trim().min(1).max(700).optional(),
  pinned: z.boolean().optional(), baseRevision: revision.optional(),
}).strict().refine(value => value.title !== undefined || value.summary !== undefined || value.pinned !== undefined, 'Provide a chapter change.');
const lorePatch = z.object({
  term: z.string().trim().min(1).max(120).optional(), explanation: z.string().trim().min(1).max(700).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(16).optional(), originMs: OffsetSchema.nullable().optional(),
  baseRevision: revision.optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== 'baseRevision'), 'Provide a lore change.');
const settingsPatch = SettingsSchema.omit({revision: true}).partial().extend({baseRevision: revision.optional()}).strict()
  .refine(value => Object.keys(value).some(key => key !== 'baseRevision'), 'Provide a settings change.');
const privacyInput = z.object({target: PrivacyTargetSchema, reason: z.string().trim().min(1).max(500)}).strict()
  .refine(value => value.target.kind !== 'interval' || value.target.toMs >= value.target.fromMs, 'The interval must be ordered.');
const momentInput = z.object({sessionId: IdSchema, label: z.string().trim().min(1).max(160).optional()}).strict();
const recapInput = z.object({sessionId: IdSchema, reason: z.enum(['manual', 'hotkey']).default('manual')}).strict();
const ackInput = z.object({state: z.enum(['prepared', 'started', 'ended', 'error']), timestamp: IsoTimeSchema}).strict();
const emptyInput = z.object({}).strict();

function actor(response: Response): Principal {
  const value = response.locals.principal as Principal | undefined;
  if (!value) throw new ApiError(401, 'session_required', 'Sign in to continue.');
  if (value.role !== 'owner' || value.runId !== 'live') throw new ApiError(403, 'role_forbidden', 'This session cannot access that resource.');
  return value;
}
function mutation(request: Request, response: Response): OwnerMutation {
  const key = request.get('Idempotency-Key');
  if (!key || !/^[\w.-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_required', 'An idempotency key is required.');
  return {principal: actor(response), idempotencyKey: key};
}
function revisionMutation(request: Request, response: Response, bodyRevision?: number): OwnerRevisionMutation {
  const ifMatch = request.get('If-Match');
  let headerRevision: number | undefined;
  if (ifMatch !== undefined) {
    const match = /^(?:"(0|[1-9]\d*)"|(0|[1-9]\d*))$/.exec(ifMatch);
    if (!match) throw new ApiError(400, 'invalid_revision', 'If-Match must contain one numeric revision.');
    headerRevision = revision.parse(Number(match[1] ?? match[2]));
  }
  if (bodyRevision !== undefined && headerRevision !== undefined && bodyRevision !== headerRevision) throw new ApiError(400, 'invalid_revision', 'The supplied revisions disagree.');
  const baseRevision = bodyRevision ?? headerRevision;
  if (baseRevision === undefined) throw new ApiError(400, 'revision_required', 'A base revision or If-Match header is required.');
  return {...mutation(request, response), baseRevision};
}
const entityId = (request: Request) => IdSchema.parse(request.params.id);
function handle(action: (request: Request, response: Response) => Awaitable<void>): RequestHandler {
  return async (request, response, next) => {
    try {await action(request, response);} catch (error) {
      next(error instanceof z.ZodError ? new ApiError(400, 'invalid_input', 'The request does not match the expected format.') : error);
    }
  };
}

/** Mount only behind the application's owner authentication, origin and CSRF middleware. */
export function createOwnerRouter(service: OwnerService): Router {
  const router = Router();
  router.use((request, response, next) => {
    try {actor(response); if (isMutation(request.method)) mutation(request, response); response.setHeader('Cache-Control', 'no-store'); next();}
    catch (error) {next(error);}
  });
  router.get('/bootstrap', handle(async (request, response) => {emptyInput.parse(request.query); response.json(await service.bootstrap(actor(response)));}));
  router.get('/sessions', handle(async (request, response) => {response.json(await service.listSessions(actor(response), sessionQuery.parse(request.query)));}));
  router.get('/sessions/:id', handle(async (request, response) => {emptyInput.parse(request.query); response.json(await service.getSession(actor(response), entityId(request)));}));
  router.get('/sources', handle(async (request, response) => {response.json(await service.listSources(actor(response), sourceQuery.parse(request.query)));}));
  router.get('/history', handle(async (request, response) => {response.json(await service.listHistory(actor(response), historyQuery.parse(request.query)));}));
  router.patch('/settings', handle(async (request, response) => {
    const {baseRevision, ...patch} = settingsPatch.parse(request.body);
    response.json(await service.setSettings(revisionMutation(request, response, baseRevision), patch));
  }));
  router.patch('/chapters/:id', handle(async (request, response) => {
    const {baseRevision, ...patch} = chapterPatch.parse(request.body);
    response.json(await service.editChapter(revisionMutation(request, response, baseRevision), entityId(request), patch));
  }));
  router.delete('/chapters/:id', handle(async (request, response) => {
    const {baseRevision} = revisionBody.parse(request.body ?? {});
    response.json(await service.deleteChapter(revisionMutation(request, response, baseRevision), entityId(request)));
  }));
  router.post('/privacy', handle(async (request, response) => {response.json(await service.privacy(mutation(request, response), privacyInput.parse(request.body)));}));
  router.patch('/lore/:id', handle(async (request, response) => {
    const {baseRevision, ...patch} = lorePatch.parse(request.body);
    response.json(await service.editLore(revisionMutation(request, response, baseRevision), entityId(request), patch));
  }));
  router.delete('/lore/:id', handle(async (request, response) => {
    const {baseRevision} = revisionBody.parse(request.body ?? {});
    response.json(await service.deleteLore(revisionMutation(request, response, baseRevision), entityId(request)));
  }));
  router.post('/lore/:id/confirm', handle(async (request, response) => {
    const {baseRevision} = revisionBody.parse(request.body ?? {});
    response.json(await service.confirmLore(revisionMutation(request, response, baseRevision), entityId(request)));
  }));
  router.post('/lore/:id/block', handle(async (request, response) => {
    const {baseRevision, blocked} = revisionBody.extend({blocked: z.boolean()}).parse(request.body);
    response.json(await service.blockLore(revisionMutation(request, response, baseRevision), entityId(request), blocked));
  }));
  router.post('/moments', handle(async (request, response) => {response.status(202).json(await service.saveMoment(mutation(request, response), momentInput.parse(request.body)));}));
  router.get('/recaps/preview', handle(async (request, response) => {
    const {sessionId} = z.object({sessionId: IdSchema}).strict().parse(request.query);
    response.json(await service.previewRecap(actor(response), sessionId));
  }));
  router.post('/recaps', handle(async (request, response) => {response.status(202).json(await service.triggerRecap(mutation(request, response), recapInput.parse(request.body)));}));
  router.post('/recaps/:id/cancel', handle(async (request, response) => {emptyInput.parse(request.body ?? {}); await service.cancelRecap(mutation(request, response), entityId(request)); response.status(204).end();}));
  router.post('/recaps/:id/ack', handle(async (request, response) => {await service.acknowledgeRecap(mutation(request, response), entityId(request), ackInput.parse(request.body)); response.status(204).end();}));
  return router;
}
