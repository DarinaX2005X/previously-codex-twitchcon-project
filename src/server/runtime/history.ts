import { ChapterSchema, LoreSchema, safetyAllowsPublication, type Chapter, type Lore, type OwnerHistoryQuery } from '../../shared/contracts/index.js';
import { canonical as canonicalValue, createDomainState, isRefActive, safeLorePresentation, type DomainEvent, type DomainState, type LorePresentation } from '../../core/index.js';
import type { SqliteRepository } from '../storage/index.js';
import { ApiError } from './errors.js';

type EntityGraph = NonNullable<ReturnType<SqliteRepository['getEntityGraph']>>;

export function historyEventEntity(event: DomainEvent): string | null {
  switch (event.type) {
    case 'owner.edit': case 'owner.review': case 'owner.pin': case 'presentation': return event.entityId;
    case 'lore.edit': case 'lore.review': case 'lore.confirm': case 'lore.presentation': return event.id;
    case 'privacy': return event.target.kind === 'entity' ? event.target.id : null;
    default: return null;
  }
}

function includeBounded<T extends {id: string}>(values: T[], value: T, limit: number, protectedId?: string | null): T[] {
  const result = values.filter(item => item.id !== value.id);
  while (result.length >= limit) {
    const index = result.findIndex(item => item.id !== protectedId);
    if (index < 0) throw new ApiError(409, 'history_capacity', 'This item cannot be loaded while its active context is in use.');
    result.splice(index, 1);
  }
  return [...result, value];
}

/** Adds one authoritative record, never the session archive, to the bounded working set. */
export function withHistoryEntity(previous: DomainState, graph: EntityGraph): DomainState {
  const state = structuredClone(previous), root = graph.root;
  if (!root.active || state.suppressedIds.includes(root.id)) throw new ApiError(404, 'not_found', 'This item is unavailable.');
  for (const node of graph.entities) {
    state.nodes[node.id] = structuredClone(node);
    state.ownerRevisions[node.id] = node.ownerRevision;
    if (node.ownerLocked && !state.ownerLocks.includes(node.id)) state.ownerLocks.push(node.id);
  }
  for (const source of graph.sources) {
    // Historical source text stays in SQLite; provenance metadata is enough to validate graph references.
    const {text: _text, ...evidenceMetadata} = source;
    if (!state.sources.some(item => item.id === source.id)) state.nodes[source.id] = {
      id: source.id, revision: source.revision, kind: 'provider_cache', supports: [], exposedTo: [],
      startMs: source.startMs, endMs: source.endMs, active: source.status === 'active', body: {evidenceMetadata},
    };
  }
  if (root.kind === 'chapter') {
    const value = ChapterSchema.parse(root.body);
    if (value.sessionId !== state.session.id) throw new ApiError(404, 'not_found', 'This item is unavailable.');
    state.chapters = includeBounded(state.chapters, {...value, revision: root.revision, ownerEditRevision: root.ownerRevision, pinned: root.pinned}, 300, state.activeChapterId);
  } else if (root.kind === 'lore') {
    const value = LoreSchema.parse(root.body);
    if (value.sessionId !== state.session.id) throw new ApiError(404, 'not_found', 'This item is unavailable.');
    state.lore = includeBounded(state.lore, {...value, revision: root.revision}, 50);
  } else throw new ApiError(404, 'not_found', 'This item is unavailable.');
  const candidates = new Map(state.candidates.map(candidate => [candidate.id, candidate]));
  for (const candidate of graph.candidates) candidates.set(candidate.id, structuredClone(candidate));
  if (candidates.size > 1200) throw new ApiError(409, 'history_capacity', 'Too many pending versions are in use to load this item.');
  state.candidates = [...candidates.values()];
  const presentations = new Map(state.lorePresentations.map(value => [value.id, value]));
  for (const node of graph.entities) if (node.kind === 'presentation' && node.body && typeof node.body === 'object' && 'kind' in node.body && node.body.kind === 'lore') {
    const value = node.body as LorePresentation; presentations.set(value.id, structuredClone(value));
  }
  state.lorePresentations = [...presentations.values()].filter(value => state.lore.some(lore => lore.id === value.entityId && lore.revision === value.entityRevision)).slice(-100);
  return state;
}

export function loadHistoryEntity(repository: SqliteRepository, scope: DomainState['session'], previous: DomainState, id: string): DomainState {
  if (previous.chapters.some(item => item.id === id) || previous.lore.some(item => item.id === id)) return previous;
  const graph = repository.getEntityGraph(scope, previous.session.id, id);
  if (!graph) {
    const stub = repository.controlGet<{id: string; sessionId: string; revision: number; term: string; aliases: string[]; firstSeenMs: number; status: 'blocked'|'observed'}>(scope, `blocked-lore:${id}`);
    if (stub?.id === id && stub.sessionId === previous.session.id) {
      const state = structuredClone(previous), lore = LoreSchema.parse({...stub, explanation: '', originMs: null, originKind: 'unknown', momentId: null, maxDependencyEndMs: 0, dependencyRefs: [], safety: {moderation: 'unavailable', pii: 'review', checkedAt: null, reason: null}});
      state.lore = includeBounded(state.lore, lore, 50); return state;
    }
    throw new ApiError(404, 'not_found', 'This item or its source context is unavailable.');
  }
  return withHistoryEntity(previous, graph);
}

/** History is an owner projection. Published wording requires the selected language and approved lineage. */
export function historyItem(repository: SqliteRepository, state: Pick<DomainState, 'channel'|'session'|'settings'>, id: string,
  filter: NonNullable<OwnerHistoryQuery['filter']>, nowMs: number): Chapter | Lore | null {
  const graph = repository.getEntityGraph(state.session, state.session.id, id);
  if (!graph) return null;
  const context = withHistoryEntity(createDomainState({channel: state.channel, session: state.session, settings: state.settings}), graph);
  if (graph.root.kind === 'chapter') {
    const canonical = context.chapters[0]!;
    const candidate = context.candidates.find(value => value.entityId === id && (value.revision === canonical.revision
      || value.revision < canonical.revision && canonicalValue(value.chapter.claimIds) === canonicalValue(canonical.claimIds) && canonicalValue(value.chapter.dependencyRefs) === canonicalValue(canonical.dependencyRefs))
      && value.ownerRevision === canonical.ownerEditRevision && value.language === state.settings.recapLanguage
      && value.status === 'published' && value.eligibleAtMs <= nowMs && safetyAllowsPublication(value.safety)
      && value.inputRefs.every(ref => isRefActive(context, ref)));
    const item: Chapter = candidate ? {...canonical, title: candidate.chapter.title, summary: candidate.chapter.summary, safety: candidate.safety, publicationState: 'published'}
      : {...canonical, publicationState: canonical.publicationState === 'published' ? 'held' : canonical.publicationState};
    if (filter !== 'all' && item.publicationState !== filter) return null;
    return item;
  }
  const canonical = context.lore[0]!, presentation = safeLorePresentation(context, canonical, state.settings.recapLanguage);
  const ready = presentation && presentation.eligibleAtMs <= nowMs;
  const item: Lore = ready ? {...canonical, term: presentation.term, explanation: presentation.explanation, safety: presentation.safety, status: 'published'}
    : {...canonical, status: ['published', 'confirmed'].includes(canonical.status) ? 'held' : canonical.status};
  if (filter === 'published' && !ready || filter === 'draft' || filter === 'held' && !['held', 'observed'].includes(item.status)) return null;
  return item;
}
