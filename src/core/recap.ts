import { MOMENT_CLIP_LEAD_MS, safetyAllowsPublication } from '../shared/contracts/index.js';
import type { OverlayLayout, PublicChapter, PublicLore, PublicSnapshot, RecapPlan, RecapScene, RecapTrigger, VersionRef } from '../shared/contracts/index.js';
import type { DomainMedia, DomainState } from './types.js';
import { canonical, isRefActive, normalizeTerm, sourceAllowed, uniqueRefs } from './evidence.js';
import { safeLorePresentation } from './lore-presentations.js';
import { messagesFor } from '../i18n/index.js';
import { planMontage } from '../shared/montage.js';

/** Every public consumer uses this projection; this selector never falls back to drafts. */
export const selectPublicSnapshot = (state: DomainState): PublicSnapshot | null => state.published;

/** `burst`: stream offset where chat peaked inside the moment's window, with the messages that establish it. */
export type MomentLineage = { count: number; messages: { ref: VersionRef; text: string }[]; burst?: { atMs: number; refs: VersionRef[] } };
export type RecapLineage = { currentRefs?: VersionRef[]; loreRefs?: Record<string, VersionRef[]>; moments?: Record<string, MomentLineage> };
export type RecapCompileOptions = RecapLineage & {
  media?: DomainMedia[];
  durationMs?: number;
  welcomeOnly?: boolean;
  generatedAt?: string;
  narrationEnabled?: boolean;
};

/** PublicLore omits its private revision. Adapters supply the actual approved graph references. */
export function recapLineage(state: DomainState): RecapLineage {
  const snapshot = state.published;
  if (!snapshot) return {};
  const currentCandidate = state.candidates.find(candidate => candidate.status === 'published'
    && candidate.language === snapshot.language && canonical(candidate.current) === canonical(snapshot.current)
    && candidate.inputRefs.every(ref => isRefActive(state, ref)));
  const currentRefs = currentCandidate ? [
    { id: currentCandidate.id, revision: 1 },
    ...(currentCandidate.currentNodeId ? [{ id: currentCandidate.currentNodeId, revision: 1 }] : []),
  ] : undefined;
  const loreRefs: Record<string, VersionRef[]> = {};
  for (const item of snapshot.lore) {
    const lore = state.lore.find(lore => lore.id === item.id);
    if (!lore) continue;
    const presentation = safeLorePresentation(state, lore, snapshot.language);
    if (!presentation || presentation.term !== item.term || presentation.explanation !== item.explanation) continue;
    const node = state.nodes[presentation.id];
    if (node) loreRefs[item.id] = [{ id: lore.id, revision: lore.revision }, { id: node.id, revision: node.revision }];
  }
  return { currentRefs, loreRefs, moments: momentLineage(state) };
}

const SCENE_MESSAGE_LIMIT = 14;
const SCENE_MESSAGE_LENGTH = 32;
/** Short chat lines from a published moment's window. Only active, moderation-allowed, untombstoned
 * messages from unbanned chatters qualify; redacted text, mentions and links never reach the broadcast. */
export function sceneChatMessages(state: DomainState, moment: { startMs: number; endMs: number }): MomentLineage['messages'] {
  const blocked = state.blockedTerms.filter(Boolean);
  const repeats = new Map<string, number>();
  const result: MomentLineage['messages'] = [];
  const candidates = state.sources.filter(source => source.kind === 'chat' && source.moderation === 'allowed' && sourceAllowed(state, source)
    && source.startMs >= moment.startMs && source.startMs <= moment.endMs)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  for (const source of candidates) {
    const text = (source.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || Array.from(text).length > SCENE_MESSAGE_LENGTH || /@|https?:|www\.|\.(com|net|org|tv|gg)\b/i.test(text)) continue;
    const key = normalizeTerm(text);
    if (blocked.some(term => key.includes(term))) continue;
    const seen = repeats.get(key) ?? 0;
    if (seen >= 2) continue;
    repeats.set(key, seen + 1);
    result.push({ ref: { id: source.id, revision: source.revision }, text });
    if (result.length >= SCENE_MESSAGE_LIMIT) break;
  }
  return result;
}
/** Width of the sliding window that finds chat's peak. */
export const CHAT_BURST_WINDOW_MS = 2000;
/**
 * Where chat actually reacted: the first message of the earliest busiest CHAT_BURST_WINDOW_MS stretch of the
 * moment's window. Uses only messages that may still be shown (active, moderated, not forgotten, not banned).
 */
export function chatBurst(state: DomainState, moment: { startMs: number; endMs: number }): MomentLineage['burst'] | undefined {
  const chat = state.sources.filter(source => source.kind === 'chat' && sourceAllowed(state, source) && source.startMs >= moment.startMs && source.startMs <= moment.endMs)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  if (chat.length < 3) return undefined;
  let best = 0, bestCount = 0;
  for (let i = 0, j = 0; i < chat.length; i++) {
    while (j < chat.length && chat[j]!.startMs < chat[i]!.startMs + CHAT_BURST_WINDOW_MS) j++;
    if (j - i > bestCount) { best = i; bestCount = j - i; }
  }
  const peak = chat.slice(best, best + bestCount);
  return { atMs: peak[0]!.startMs, refs: peak.slice(0, 10).map(source => ({ id: source.id, revision: source.revision })) };
}
function momentLineage(state: DomainState): Record<string, MomentLineage> {
  const result: Record<string, MomentLineage> = {};
  for (const item of state.published?.moments ?? []) {
    const moment = state.moments.find(moment => moment.id === item.id);
    if (!moment || !moment.dependencyRefs.every(ref => isRefActive(state, ref))) continue;
    const burst = chatBurst(state, item);
    result[item.id] = { count: moment.count, messages: sceneChatMessages(state, item), ...(burst ? { burst } : {}) };
  }
  return result;
}

type BeatKind = RecapPlan['beats'][number]['kind'];
type SelectedBeat = {
  kind: BeatKind;
  text: string;
  refs: VersionRef[];
  sourceRange: { startMs: number; endMs: number };
  sourceIds: string[];
  momentIds: string[];
  chapter?: PublicChapter;
  lore?: PublicLore;
};

// These are conservative selection preferences, not a substitute for actual font measurement.
// The overlay refuses text that still cannot fit its two-line caption at the configured geometry.
const CAPTION_WITH_VIDEO = 44;
const CAPTION_WITHOUT_VIDEO = 62;
const codepoints = (text: string) => Array.from(text).length;
const short = (text: string, limit: number) => text.trim().length > 0 && codepoints(text.trim()) <= limit;
const distinct = (items: string[]) => [...new Set(items)];
const chapterRef = (chapter: PublicChapter): VersionRef => ({ id: chapter.id, revision: chapter.revision });

function containsTerm(text: string, term: string): boolean {
  const haystack = normalizeTerm(text), needle = normalizeTerm(term);
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = haystack[index - 1] ?? '', after = haystack[index + needle.length] ?? '';
    if ((!/[\p{L}\p{N}]/u.test(needle[0]!) || !/[\p{L}\p{N}]/u.test(before))
      && (!/[\p{L}\p{N}]/u.test(needle.at(-1)!) || !/[\p{L}\p{N}]/u.test(after))) return true;
    from = index + needle.length;
  }
  return false;
}

/** Select an already-approved whole field. Never lift a fragment out of its qualifying sentence. */
function chapterCaption(chapter: PublicChapter, limit: number): string {
  const summary = chapter.summary.trim(), title = chapter.title.trim();
  if (short(summary, limit)) return summary;
  if (short(title, limit)) return title;
  // Keeping a whole title can intentionally cause text_too_long; silently slicing would change meaning.
  if (title) return title;
  if (summary.length <= 300) return summary;
  return '';
}

function chapterBeat(chapter: PublicChapter, kind: BeatKind, limit: number): SelectedBeat {
  return {
    kind, text: chapterCaption(chapter, limit), refs: [chapterRef(chapter)],
    sourceRange: { startMs: chapter.startMs, endMs: chapter.endMs },
    sourceIds: distinct(chapter.sourceLabels.map(label => label.id)), momentIds: chapter.momentIds,
    chapter,
  };
}

function chooseStory(snapshot: PublicSnapshot, options: RecapCompileOptions, limit: number): SelectedBeat[] {
  const chapters = [...snapshot.chapters].sort((a, b) => Number(b.pinned) - Number(a.pinned)
    || b.endMs - a.endMs || a.id.localeCompare(b.id));
  const current = snapshot.current;
  const currentChapter = current ? [...snapshot.chapters]
    .filter(chapter => chapter.maxDependencyEndMs === current.maxDependencyEndMs)
    .sort((a, b) => b.startMs - a.startMs || b.revision - a.revision)[0] : undefined;
  const currentRefs = options.currentRefs?.length ? options.currentRefs : currentChapter ? [chapterRef(currentChapter)] : [];
  const selected: SelectedBeat[] = [];
  const add = (beat: SelectedBeat) => {
    if (!beat.text || selected.some(old => old.text === beat.text)) return;
    if (uniqueRefs([...selected.flatMap(old => old.refs), ...beat.refs]).length > 100) throw new Error('recap_dependency_capacity');
    selected.push(beat);
  };
  const currentBeat = (kind: 'attempt' | 'change' | 'now', text: string | null): SelectedBeat | null => {
    if (!text || !current || !currentRefs.length) return null;
    const original = text.trim();
    const equivalentChapter = chapters.find(chapter => chapter.summary.includes(text) || chapter.title === text);
    const replacement = !short(original, limit) && equivalentChapter && short(equivalentChapter.title, limit)
      && !selected.some(old => old.text === equivalentChapter.title.trim()) ? equivalentChapter : null;
    return {
      kind: replacement ? 'context' : kind, text: replacement?.title.trim() ?? original,
      refs: uniqueRefs([...currentRefs, ...(replacement ? [chapterRef(replacement)] : [])]),
      sourceRange: currentChapter ? { startMs: currentChapter.startMs, endMs: currentChapter.endMs }
        : { startMs: current.sourceTimeMs, endMs: current.maxDependencyEndMs },
      sourceIds: distinct(currentChapter?.sourceLabels.map(label => label.id) ?? currentRefs.map(ref => ref.id)),
      momentIds: distinct([...(currentChapter?.momentIds ?? []), ...(replacement?.momentIds ?? [])]),
      chapter: replacement ?? currentChapter,
    };
  };
  const pinned = chapters.find(chapter => chapter.pinned && short(chapterCaption(chapter, limit), limit));
  if (pinned) add(chapterBeat(pinned, 'context', limit));
  else {
    const goal = currentBeat('attempt', current?.goal ?? null);
    if (goal) add(goal);
  }
  const change = currentBeat('change', current?.change ?? null), now = currentBeat('now', current?.now ?? null);
  if (change) add(change);
  if (now) add(now);
  for (const chapter of chapters) {
    if (selected.length >= 2) break;
    add(chapterBeat(chapter, 'context', limit));
  }
  if (options.durationMs !== 10000) {
    const relevant = snapshot.lore.filter(lore => lore.originKind !== 'unknown' && lore.originMs !== null
      && options.loreRefs?.[lore.id]?.length && selected.some(beat =>
        !!lore.momentId && beat.momentIds.includes(lore.momentId)
        || containsTerm(beat.text, lore.term)
        || !!beat.chapter && containsTerm(`${beat.chapter.title} ${beat.chapter.summary}`, lore.term)))
      .sort((a, b) => Number(!!b.momentId && selected.some(beat => beat.momentIds.includes(b.momentId!)))
        - Number(!!a.momentId && selected.some(beat => beat.momentIds.includes(a.momentId!)))
        || (b.originMs ?? 0) - (a.originMs ?? 0) || a.id.localeCompare(b.id));
    const lore = relevant[0];
    if (lore && lore.explanation.trim().length <= 300) {
      const combined = `${lore.term}: ${lore.explanation}`;
      const text = short(combined, limit) ? combined : lore.explanation.trim();
      add({ kind: 'origin', text, refs: options.loreRefs![lore.id]!,
        sourceRange: { startMs: lore.originMs!, endMs: lore.originMs! },
        sourceIds: options.loreRefs![lore.id]!.map(ref => ref.id), momentIds: lore.momentId ? [lore.momentId] : [], lore });
    }
  }
  const order: Record<BeatKind, number> = { context: 0, attempt: 1, change: 2, origin: 3, now: 4 };
  return selected.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 4);
}

function currentChapterOf(snapshot: PublicSnapshot): PublicChapter | undefined {
  const current = snapshot.current;
  if (!current?.now) return undefined;
  const byStart = [...snapshot.chapters].sort((a, b) => b.startMs - a.startMs || b.revision - a.revision);
  return byStart.find(chapter => chapter.maxDependencyEndMs === current.maxDependencyEndMs) ?? byStart[0];
}

/** Scene material: earlier chapters (newest last), the loudest published chat moment with its own short
 * messages, the lore born there and the approved current statement. Every item adds its own lineage. */
function buildScene(snapshot: PublicSnapshot, options: RecapCompileOptions, welcome: boolean, visual: DomainMedia[],
  baseRefs: VersionRef[]): { value: RecapScene; refs: VersionRef[]; media: DomainMedia[] } {
  let refs = baseRefs;
  const take = (extra: VersionRef[]): boolean => {
    const next = uniqueRefs([...refs, ...extra]);
    if (next.length > 100) return false;
    refs = next; return true;
  };
  const mediaFor = (momentIds: string[]) => visual.find(media => !media.previousSession && !!media.momentId && momentIds.includes(media.momentId));
  const title = snapshot.session.title.trim();
  const value: RecapScene = { channelName: snapshot.channel.displayName, streamTitle: title || null, chapters: [], moment: null, lore: null, now: null, command: '!previously' };
  const media: DomainMedia[] = [];
  if (welcome) return { value, refs, media };
  const currentChapter = currentChapterOf(snapshot);
  const earlier = [...snapshot.chapters].filter(chapter => chapter.id !== currentChapter?.id && chapter.title.trim())
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  // The montage tells the stream in story order; the plan's length decides how many of these are shown.
  const chapters = earlier.slice(-10);
  for (const chapter of chapters) {
    if (!take([chapterRef(chapter)])) break;
    const clip = mediaFor(chapter.momentIds);
    if (clip) media.push(clip);
    const summary = chapter.summary.trim();
    value.chapters.push({ id: chapter.id, title: chapter.title.trim(), ...(summary && summary !== chapter.title.trim() ? { summary } : {}), startMs: chapter.startMs, mediaId: clip?.id ?? null });
  }
  const current = snapshot.current;
  if (current?.now?.trim() && options.currentRefs?.length && take(options.currentRefs)) {
    const clip = currentChapter ? mediaFor(currentChapter.momentIds) : undefined;
    if (clip) media.push(clip);
    value.now = { text: current.now.trim(), mediaId: clip?.id ?? null };
  }
  const shown = chapters.filter(chapter => value.chapters.some(item => item.id === chapter.id));
  const moment = snapshot.moments.filter(item => options.moments?.[item.id] && shown.some(chapter => chapter.momentIds.includes(item.id)))
    .sort((a, b) => options.moments![b.id]!.count - options.moments![a.id]!.count || a.startMs - b.startMs)[0];
  if (moment) {
    const lineage = options.moments![moment.id]!;
    const messages: string[] = [];
    for (const message of lineage.messages) if (take([message.ref])) messages.push(message.text);
    const chapter = shown.find(item => item.momentIds.includes(moment.id));
    if (messages.length >= 3 || lineage.count >= 5) value.moment = {
      id: moment.id, chapterId: chapter?.id ?? null, startMs: moment.startMs,
      windowSeconds: Math.max(1, Math.min(600, Math.round((moment.endMs - moment.startMs) / 1000))),
      count: Math.max(lineage.count, messages.length), mediaId: mediaFor([moment.id])?.id ?? null, messages: messages.length >= 3 ? messages : [],
      ...(lineage.burst && take(lineage.burst.refs) ? { burstMs: lineage.burst.atMs } : {}),
    };
  }
  const lore = snapshot.lore.filter(item => item.originKind !== 'unknown' && item.originMs !== null && item.term.trim()
    && options.loreRefs?.[item.id]?.length && item.explanation.trim().length <= 300
    && (!!moment && item.momentId === moment.id || shown.some(chapter => containsTerm(`${chapter.title} ${chapter.summary}`, item.term))))
    .sort((a, b) => Number(!!moment && b.momentId === moment.id) - Number(!!moment && a.momentId === moment.id) || (a.originMs ?? 0) - (b.originMs ?? 0))[0];
  if (lore && take(options.loreRefs![lore.id]!)) value.lore = { term: lore.term.trim(), explanation: lore.explanation.trim(), originMs: lore.originMs! };
  return { value, refs, media };
}

/** Exact approved captions, used both to prepare narration and to match a prepared asset. */
export function narrationScript(input: Pick<RecapPlan, 'beats'> | RecapPlan['beats']): string {
  return (Array.isArray(input) ? input : input.beats).map(beat => beat.text).join(' ');
}

/** A spoken summary of the beats stays short, whatever the montage length. */
export const NARRATION_MAX_MS = 12000;

export function compileRecap(snapshot: PublicSnapshot, layout: OverlayLayout, trigger: RecapTrigger,
  options: RecapCompileOptions = {}): RecapPlan {
  // 10–15 s settings belong to the earlier short scene; the montage treats them as the standard one minute.
  const allMedia = options.media ?? [], duration = Math.min(120_000, options.durationMs === undefined || options.durationMs < 30000 ? 60000 : options.durationMs);
  const visual = allMedia.filter(media => media.kind !== 'audio' && media.state === 'ready' && media.ownerApproved
    && Number.isFinite(media.durationMs) && media.durationMs > 0 && (media.previousSession
      || snapshot.moments.some(moment => moment.id === media.momentId && moment.mediaState === 'ready'
        && media.captureEndMs <= moment.maxDependencyEndMs)));
  let selected = options.welcomeOnly ? [] : chooseStory(snapshot, options,
    visual.some(media => !media.previousSession) ? CAPTION_WITH_VIDEO : CAPTION_WITHOUT_VIDEO);
  const welcome = !!options.welcomeOnly || selected.length === 0;
  if (welcome) {
    const fields = [snapshot.session.title.trim(), snapshot.session.category.trim()].filter(Boolean);
    const welcomeText = fields.find(field => short(field, CAPTION_WITHOUT_VIDEO)) ?? fields[0]
      ?? messagesFor(snapshot.language).story.contextUnavailable;
    selected = [{ kind: 'now', text: welcomeText, refs: [], sourceRange: {
      startMs: snapshot.session.metadataMaxDependencyEndMs, endMs: snapshot.session.metadataMaxDependencyEndMs,
    }, sourceIds: [], momentIds: [] }];
  }
  let total = welcome ? 5000 : duration;
  let refs = uniqueRefs(selected.flatMap(beat => beat.refs));
  const permitted: DomainMedia[] = [];
  for (const media of visual.filter(media => welcome ? media.previousSession
    : !media.previousSession && selected.some(beat => !!media.momentId && beat.momentIds.includes(media.momentId)))) {
    if (permitted.length >= (welcome ? 1 : 3)) break;
    const nextRefs = uniqueRefs([...refs, { id: media.id, revision: media.revision }, ...media.refs]);
    if (nextRefs.length > 100) continue;
    refs = nextRefs; permitted.push(media);
  }
  const scene = buildScene(snapshot, options, welcome, visual, refs);
  refs = scene.refs;
  for (const media of scene.media) if (!permitted.some(item => item.id === media.id) && permitted.length < 12) {
    const nextRefs = uniqueRefs([...refs, { id: media.id, revision: media.revision }, ...media.refs]);
    if (nextRefs.length > 100) continue;
    refs = nextRefs; permitted.push(media);
  }
  const permittedIds = new Set(permitted.map(media => media.id));
  const keep = (id: string | null) => id && permittedIds.has(id) ? id : null;
  const sceneValue: RecapScene = {
    ...scene.value,
    chapters: scene.value.chapters.map(chapter => ({ ...chapter, mediaId: keep(chapter.mediaId) })),
    moment: scene.value.moment ? { ...scene.value.moment, mediaId: keep(scene.value.moment.mediaId) } : null,
    now: scene.value.now ? { ...scene.value.now, mediaId: keep(scene.value.now.mediaId) } : null,
  };
  const clipMs = (id: string | null) => { const m = id ? permitted.find(item => item.id === id) : undefined; if (!m) return null;
    const moment = snapshot.moments.find(item => item.id === m.momentId);
    const lead = moment && !m.previousSession ? moment.startMs - m.captureStartMs - MOMENT_CLIP_LEAD_MS : 0;
    return Math.max(0, m.durationMs - Math.max(0, Math.min(Math.round(lead), Math.max(0, m.durationMs - 1000)))); };
  if (!welcome) {
    const montage = planMontage({ durationMs: duration, chapters: sceneValue.chapters.map(c => ({ clipMs: clipMs(c.mediaId), keep: !!sceneValue.moment && sceneValue.moment.chapterId === c.id })),
      ...(sceneValue.now ? { now: { clipMs: clipMs(sceneValue.now.mediaId) } } : {}) });
    total = Math.max(5000, Math.min(duration, montage.totalMs));
  }
  const plan: RecapPlan = {
    id: `recap:${trigger.id}`, sessionId: snapshot.session.id, revision: snapshot.revision, privacyEpoch: snapshot.privacyEpoch,
    language: snapshot.language, variant: welcome ? 'welcome' : permitted.length ? 'full' : 'compact', durationMs: total,
    dependencyRefs: refs, layout,
    arrivals: trigger.reason === 'raid' && trigger.fromLogin?.trim() && Number.isInteger(trigger.viewers) && trigger.viewers! >= 0
      ? [{ triggerId: trigger.id, fromLogin: trigger.fromLogin.trim().slice(0, 25), viewers: trigger.viewers! }] : [],
    overflowArrivals: { channels: 0, viewers: 0 },
    beats: selected.map((beat, index) => ({
      id: `beat:${trigger.id}:${index}`, kind: beat.kind, text: beat.text,
      atMs: Math.round(index * total / selected.length), untilMs: Math.round((index + 1) * total / selected.length),
      sourceRange: beat.sourceRange, sourceIds: distinct(beat.sourceIds).slice(0, 20),
      mediaId: welcome ? permitted[0]?.id ?? null : permitted.find(media => !!media.momentId && beat.momentIds.includes(media.momentId))?.id ?? null,
    })),
    media: permitted.map(media => {
      // A moment clip starts just before the reaction it documents, never outside its canonical capture.
      const moment = snapshot.moments.find(item => item.id === media.momentId);
      const lead = moment && !media.previousSession ? moment.startMs - media.captureStartMs - MOMENT_CLIP_LEAD_MS : 0;
      const inMs = Math.max(0, Math.min(Math.round(lead), Math.max(0, media.durationMs - 1000)));
      return { id: media.id, kind: media.kind === 'image' ? 'image' as const : 'video' as const,
        inMs, outMs: media.durationMs, captureStartMs: media.captureStartMs,
        captureEndMs: media.captureEndMs, previousSession: media.previousSession };
    }),
    audio: null, soundEvents: [], generatedAt: options.generatedAt ?? trigger.occurredAt,
    scene: sceneValue,
  };
  if (options.narrationEnabled) {
    const script = narrationScript(plan);
    const audio = allMedia.find(media => media.kind === 'audio' && media.state === 'ready' && media.ownerApproved
      && media.narration?.language === plan.language && media.narration.script === script
      && Number.isFinite(media.durationMs) && media.durationMs > 0 && media.durationMs <= NARRATION_MAX_MS
      && uniqueRefs([...refs, { id: media.id, revision: media.revision }, ...media.refs]).length <= 100);
    if (audio) {
      plan.audio = { id: audio.id, startMs: 0, durationMs: audio.durationMs };
      // Narration plays to its end; the plan lasts at least as long.
      plan.durationMs = Math.max(plan.durationMs, audio.durationMs);
      plan.dependencyRefs = uniqueRefs([...refs, { id: audio.id, revision: audio.revision }, ...audio.refs]);
    }
  }
  return plan;
}

export function canDispatch(state: DomainState, input: { sessionId: string; privacyEpoch: number; dependencyRefs: VersionRef[] }): boolean {
  return input.sessionId === state.session.id && input.privacyEpoch === state.session.privacyEpoch && input.dependencyRefs.every(ref => {
    if (!isRefActive(state, ref)) return false;
    const node = state.nodes[ref.id];
    if (node?.kind === 'provider_cache') return [...node.supports, ...node.exposedTo].every(input => isRefActive(state, input));
    if (node?.kind === 'presentation') {
      const candidate = state.candidates.find(candidate => candidate.id === ref.id);
      if (candidate) return candidate.status === 'published' && candidate.ownerRevision === (state.ownerRevisions[candidate.entityId] ?? 0)
        && candidate.inputRefs.every(input => isRefActive(state, input));
      const presentation = state.lorePresentations.find(presentation => presentation.id === ref.id);
      const lore = presentation && state.lore.find(lore => lore.id === presentation.entityId && lore.revision === presentation.entityRevision);
      return !!presentation && !!lore && safetyAllowsPublication(presentation.safety)
        && safeLorePresentation(state, lore, presentation.language)?.id === presentation.id
        && !!state.published?.lore.some(item => item.id === lore.id && item.term === presentation.term && item.explanation === presentation.explanation);
    }
    if (node?.kind === 'media') {
      const media = state.media.find(media => media.id === ref.id);
      return !!media && media.state === 'ready' && media.ownerApproved;
    }
    return true;
  });
}
