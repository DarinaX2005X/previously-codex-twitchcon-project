import { ChapterSchema, LoreSchema, safetyAllowsPublication, type Chapter, type Lore, type OwnerHistoryQuery, type PublicChapter, type VersionRef } from '../../shared/contracts/index.js';
import { canonical as canonicalValue, createDomainState, evidencePacketBytes, EVIDENCE_PACKET_BYTE_CAP, isRefActive, safeLorePresentation, sourceAllowed, stateHash, uniqueRefs, type DerivedNode, type DomainEvent, type DomainState, type DomainTransition, type LorePresentation } from '../../core/index.js';
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
  return projectHistoryItem(state,graph,filter,nowMs);
}

function projectHistoryItem(state: Pick<DomainState, 'channel'|'session'|'settings'>, graph: EntityGraph,
  filter: NonNullable<OwnerHistoryQuery['filter']>, nowMs: number): Chapter | Lore | null {
  const id=graph.root.id;
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

/** Runs only when the reducer schedules a new request, before its immutable ticket is registered. */
export function enrichGenerationHistory(repository:SqliteRepository,transition:DomainTransition,nowMs:number):void {
  const effect=transition.effects.find(effect=>effect.type==='generation.request');if(!effect||effect.type!=='generation.request')return;
  const request=effect.request;let state=transition.state;
  const text=request.packet.sources.filter(source=>sourceAllowed(state,source)).map(source=>source.text!).join('\n');
  const ids=repository.findGenerationHistory(state.session,state.session.id,{text,limit:8});
  let added=false,addedNodes=0,addedBytes=0;
  for(const id of ids){
    if(id===request.entityId)continue;
    const graph=repository.getEntityGraph(state.session,state.session.id,id);if(!graph)continue;
    const item=projectHistoryItem(state,graph,'published',nowMs);if(!item)continue;
    const isChapter='claimIds' in item;
    if(isChapter&&request.packet.chapters.some(chapter=>chapter.id===id||chapter.id.startsWith(`context:${id}:`))||!isChapter&&request.packet.lore.some(lore=>lore.id===id))continue;
    const contextId=`history:${stateHash([id,graph.root.revision,state.settings.recapLanguage,isChapter?[item.title,item.summary]:[item.term,item.explanation]])}`;
    const selectedCandidate=isChapter?graph.candidates.find(candidate=>candidate.status==='published'&&candidate.language===state.settings.recapLanguage&&candidate.chapter.title===item.title&&candidate.chapter.summary===item.summary):undefined;
    const presentations=graph.entities.filter(node=>node.kind==='presentation'&&(isChapter?node.id===selectedCandidate?.id:node.body&&typeof node.body==='object'&&'kind' in node.body&&node.body.kind==='lore'&&'language' in node.body&&node.body.language===state.settings.recapLanguage&&'term' in node.body&&node.body.term===item.term&&'explanation' in node.body&&node.body.explanation===item.explanation));
    const refs:VersionRef[]=uniqueRefs([{id,revision:graph.root.revision},...presentations.map(node=>({id:node.id,revision:node.revision}))]);
    const allRefs=uniqueRefs([...request.ticket.inputRefs,{id:contextId,revision:1},...refs]);if(allRefs.length>100)continue;
    const packet=structuredClone(request.packet);
    let body:PublicChapter|Lore;
    if(isChapter){
      const {sessionId:_session,ownerEditRevision:_owner,publicationState:_publication,eligibleAt:_eligible,safety:_safety,dependencyRefs:_deps,...chapter}=item;
      body={...chapter,id:contextId,revision:1};packet.chapters=[body,...packet.chapters].slice(0,6);
    }else{body={...item,id:contextId,revision:1};packet.lore=[body,...packet.lore].slice(0,5);}
    // A retrieved record never displaces current safe evidence to make itself fit.
    if(evidencePacketBytes(packet)>EVIDENCE_PACKET_BYTE_CAP)continue;
    const graphBytes=Buffer.byteLength(JSON.stringify(graph)),graphNodes=[...graph.entities,...graph.sources].filter(node=>!state.nodes[node.id]&&!state.sources.some(source=>source.id===node.id)).length;
    if(addedNodes+graphNodes>512||addedBytes+graphBytes>1_000_000)continue;
    try{state=withHistoryEntity(state,graph);}catch(error){if(error instanceof ApiError&&error.code==='history_capacity')continue;throw error;}
    addedNodes+=graphNodes;addedBytes+=graphBytes;transition.state=state;
    const node:DerivedNode={id:contextId,revision:1,kind:'provider_cache',supports:refs,exposedTo:refs,startMs:isChapter?item.startMs:item.firstSeenMs,endMs:item.maxDependencyEndMs,active:true,body};
    state.nodes[contextId]=node;transition.effects.unshift({type:'entity.upsert',node:structuredClone(node)});
    request.packet=packet;request.ticket.inputRefs=allRefs;added=true;
  }
  if(added){
    request.ticket.inputHash=stateHash(request.packet);
    const endMs=Math.max(0,...request.ticket.inputRefs.map(ref=>state.sources.find(source=>source.id===ref.id)?.endMs??state.nodes[ref.id]?.endMs??0));
    request.ticket.eligibleAt=new Date(Date.parse(state.session.startedAt)+endMs+state.settings.publicationDelaySeconds*1000).toISOString();
    state.pendingGeneration=structuredClone(request);
  }
}
