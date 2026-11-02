import { useEffect, useMemo, useState } from 'react';
import type { Moment, PublicChapter, PublicLore, PublicSnapshot, RecapPlan, Source } from '../../shared/contracts';
import { useRecording, type RecordedChat } from '../replay/useRecording';

/** Everything the landing shows, read from one recording after its raid. Nothing here is authored for the landing. */
export interface LandingStory {
  channel: { login: string; displayName: string };
  title: string | null;
  published: PublicSnapshot;
  plan: RecapPlan | null;
  /** The chapter that best shows how a chapter forms: the one with a chat moment, else the latest. */
  focus: { chapter: PublicChapter; speech: Source | null; moment: Moment | null; messages: string[]; clipUrl?: string; lore: PublicLore | null } | null;
  chatBeforeRaid: RecordedChat[];
  delaySeconds: number;
  correction: { title: string; summary: string; targetId?: string } | null;
  raider: { login: string; viewers: number } | null;
  /** Recording time of the raid, when the recording has one. */
  raidAtMs?: number;
  resolveMedia: (id: string) => string | undefined;
}

export function useLandingStory(manifestUrl?: string): { story: LandingStory | null; error: string | null } {
  const { client, view, error, resolveMedia, chat, mediaRanges } = useRecording(manifestUrl);
  const [plan, setPlan] = useState<RecapPlan | null>(null);
  const [speech, setSpeech] = useState<Source | null>(null);
  const [settled, setSettled] = useState(false);
  const snapshot = view?.snapshot;
  const milestones = view?.transport.milestones;
  // Move the recording to its raid (or its last milestone) once, then read the published state.
  useEffect(() => {
    if (!client || !milestones) return;
    let active = true;
    const target = milestones.find(m => m.id === 'raid') ?? milestones.at(-1);
    void (async () => {
      try {
        if (target) await client.controlReplay({ action: 'seek', milestone: target.id });
        const current = await client.getSnapshot();
        if (current.session) { const value = await client.previewRecap(current.session.id); if (active) setPlan(value); }
      } catch { /* the landing still renders the published state */ }
      if (active) setSettled(true);
    })();
    return () => { active = false; };
  }, [client, !!milestones]);
  const published = settled ? snapshot?.published ?? null : null;
  const focusChapter = useMemo(() => {
    if (!published?.chapters.length) return null;
    const sceneMomentChapter = plan?.scene?.moment?.chapterId;
    return published.chapters.find(c => c.id === sceneMomentChapter) ?? published.chapters.find(c => c.momentIds.length) ?? published.chapters.at(-1)!;
  }, [published?.revision, plan?.id]);
  useEffect(() => {
    if (!client || !focusChapter) return;
    let active = true;
    void client.getEvidence(focusChapter.id).then(sources => {
      if (!active) return;
      const spoken = sources.filter(s => s.kind === 'speech' && s.text && s.status === 'active');
      // Prefer the sentence that names what chat reacted to: the longest spoken source of the chapter.
      setSpeech(spoken.sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))[0] ?? null);
    }).catch(() => { if (active) setSpeech(null); });
    return () => { active = false; };
  }, [client, focusChapter?.id, focusChapter?.revision]);
  const story = useMemo<LandingStory | null>(() => {
    if (!snapshot || !published) return null;
    const moment = focusChapter ? snapshot.moments.find(m => focusChapter.momentIds.includes(m.id)) ?? null : null;
    const sceneMoment = plan?.scene?.moment && (!focusChapter || plan.scene.moment.chapterId === focusChapter.id) ? plan.scene.moment : null;
    const messages = sceneMoment?.messages.length ? sceneMoment.messages
      : moment ? chat.filter(c => c.atMs >= moment.startMs && c.atMs <= moment.endMs).map(c => c.text).filter(t => t.length <= 40).slice(0, 14) : [];
    const mediaId = (plan?.scene?.chapters.find(c => c.id === focusChapter?.id)?.mediaId) ?? sceneMoment?.mediaId ?? null;
    const rangeMedia = moment ? mediaRanges.find(m => m.startMs <= moment.endMs && m.endMs >= moment.startMs)?.id : undefined;
    const clipUrl = (mediaId ? resolveMedia(mediaId) : undefined) ?? (rangeMedia ? resolveMedia(rangeMedia) : undefined);
    const lore = published.lore.find(l => l.originKind !== 'unknown' && (!focusChapter || (l.firstSeenMs >= focusChapter.startMs && l.firstSeenMs <= focusChapter.endMs + 120000))) ?? published.lore[0] ?? null;
    const raidMs = view?.transport.milestones.find(m => m.id === 'raid')?.atMs ?? view?.transport.atMs ?? Infinity;
    const arrival = plan?.arrivals[0];
    return {
      channel: { login: snapshot.channel.login, displayName: snapshot.channel.displayName },
      title: published.session.title ?? null,
      published, plan,
      focus: focusChapter ? { chapter: focusChapter, speech, moment, messages, clipUrl, lore } : null,
      chatBeforeRaid: chat.filter(c => c.atMs < raidMs),
      delaySeconds: snapshot.settings.publicationDelaySeconds,
      correction: view?.transport.correction ? { title: view.transport.correction.title, summary: view.transport.correction.summary, targetId: view.transport.correction.targetId } : null,
      raider: arrival ? { login: arrival.fromLogin, viewers: arrival.viewers } : null,
      raidAtMs: view?.transport.milestones.find(m => m.id === 'raid')?.atMs,
      resolveMedia,
    };
  }, [snapshot?.revision, published?.revision, plan?.id, focusChapter?.id, speech?.id, chat, mediaRanges, resolveMedia]);
  return { story, error };
}
