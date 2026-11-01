import { safetyAllowsPublication } from '../shared/contracts/index.js';
import type { OverlayLayout, PublicChapter, PublicLore, PublicSnapshot, RecapPlan, RecapTrigger, VersionRef } from '../shared/contracts/index.js';
import type { DomainMedia, DomainState } from './types.js';
import { canonical, isRefActive, normalizeTerm, uniqueRefs } from './evidence.js';
import { safeLorePresentation } from './lore-presentations.js';

/** Every public consumer uses this projection; this selector never falls back to drafts. */
export const selectPublicSnapshot = (state: DomainState): PublicSnapshot | null => state.published;

export type RecapLineage = { currentRefs?: VersionRef[]; loreRefs?: Record<string, VersionRef[]> };
export type RecapCompileOptions = RecapLineage & {
  media?: DomainMedia[];
  durationMs?: 10000 | 12000 | 15000;
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
  return { currentRefs, loreRefs };
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

/** Exact approved captions, used both to prepare narration and to match a prepared asset. */
export function narrationScript(input: Pick<RecapPlan, 'beats'> | RecapPlan['beats']): string {
  return (Array.isArray(input) ? input : input.beats).map(beat => beat.text).join(' ');
}

export function compileRecap(snapshot: PublicSnapshot, layout: OverlayLayout, trigger: RecapTrigger,
  options: RecapCompileOptions = {}): RecapPlan {
  const allMedia = options.media ?? [], duration = options.durationMs ?? 12000;
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
      ?? (snapshot.language === 'ru' ? 'Проверенный контекст эфира пока недоступен.' : 'Reviewed stream context is not available yet.');
    selected = [{ kind: 'now', text: welcomeText, refs: [], sourceRange: {
      startMs: snapshot.session.metadataMaxDependencyEndMs, endMs: snapshot.session.metadataMaxDependencyEndMs,
    }, sourceIds: [], momentIds: [] }];
  }
  const total = welcome ? 5000 : duration;
  let refs = uniqueRefs(selected.flatMap(beat => beat.refs));
  const permitted: DomainMedia[] = [];
  for (const media of visual.filter(media => welcome ? media.previousSession
    : !media.previousSession && selected.some(beat => !!media.momentId && beat.momentIds.includes(media.momentId)))) {
    if (permitted.length >= (welcome ? 1 : 3)) break;
    const nextRefs = uniqueRefs([...refs, { id: media.id, revision: media.revision }, ...media.refs]);
    if (nextRefs.length > 100) continue;
    refs = nextRefs; permitted.push(media);
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
    media: permitted.map(media => ({ id: media.id, kind: media.kind === 'image' ? 'image' : 'video',
      inMs: 0, outMs: Math.min(media.durationMs, total), captureStartMs: media.captureStartMs,
      captureEndMs: media.captureEndMs, previousSession: media.previousSession })),
    audio: null, soundEvents: [], generatedAt: options.generatedAt ?? trigger.occurredAt,
  };
  if (options.narrationEnabled) {
    const script = narrationScript(plan);
    const audio = allMedia.find(media => media.kind === 'audio' && media.state === 'ready' && media.ownerApproved
      && media.narration?.language === plan.language && media.narration.script === script
      && Number.isFinite(media.durationMs) && media.durationMs > 0 && media.durationMs <= total
      && uniqueRefs([...refs, { id: media.id, revision: media.revision }, ...media.refs]).length <= 100);
    if (audio) {
      plan.audio = { id: audio.id, startMs: 0, durationMs: audio.durationMs };
      plan.dependencyRefs = uniqueRefs([...refs, { id: audio.id, revision: audio.revision }, ...audio.refs]);
    }
  }
  return plan;
}

export function canDispatch(state: DomainState, input: { sessionId: string; privacyEpoch: number; dependencyRefs: VersionRef[] }): boolean {
  return input.sessionId === state.session.id && input.privacyEpoch === state.session.privacyEpoch && input.dependencyRefs.every(ref => {
    if (!isRefActive(state, ref)) return false;
    const node = state.nodes[ref.id];
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
