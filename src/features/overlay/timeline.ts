import { MONTAGE_INTRO_MS, MONTAGE_OUTRO_MS, planMontage, type MontageSegment } from '../../shared/montage.js';
import type { SceneScript } from './script.js';

/**
 * TV-style "Previously on" timeline: welcome the raiders, the title lockup becomes a lower third while the
 * picture opens to full frame, the chapters play as a cut of their own clips (title cards where there is no clip),
 * the present closes the cut, and the picture contracts into the P mark with the chat command.
 */
export type Timeline = {
  duration: number;
  welcomeOnly: boolean;
  aAt: number; bAt: number | null; viewersAt: number | null;
  raidersOutAt: number;
  morphAt: number | null;
  /** The picture grows from behind the lockup to full frame; the lockup docks as the lower third. */
  openAt: number; openedAt: number;
  segments: MontageSegment[];
  /** The cut ends (or the owner skipped): the picture contracts into the mark. */
  exitAt: number;
  leaveAt: number;
  goneAt: number;
  skipped: boolean;
};

export { MONTAGE_INTRO_MS, MONTAGE_OUTRO_MS };

export function buildTimeline(script: SceneScript, duration: number, clipMs: (id: string | null) => number | null, skipAtMs?: number): Timeline {
  const welcomeOnly = script.welcomeOnly;
  const aAt = 0, bAt = script.guests ? 300 : null, viewersAt = script.viewers !== null && bAt !== null ? 620 : null;
  const raidersOutAt = welcomeOnly ? 2600 : 1020;
  const morphAt = welcomeOnly ? null : 1100;
  let segments: MontageSegment[] = [];
  let exitAt: number;
  if (welcomeOnly) exitAt = Math.max(2600, duration - MONTAGE_OUTRO_MS);
  else {
    // The same planner the plan builder used, so the cut fills the plan's length exactly.
    const plan = planMontage({ durationMs: duration, chapters: script.chapters.map((c, i) => ({ clipMs: clipMs(c.mediaId), keep: script.moment?.chapterIndex === i })),
      ...(script.now ? { now: { clipMs: clipMs(script.now.mediaId) } } : {}) });
    segments = plan.segments;
    exitAt = Math.min(duration - MONTAGE_OUTRO_MS, plan.outroAt);
    segments = segments.filter(s => s.at < exitAt).map(s => ({ ...s, ms: Math.min(s.ms, exitAt - s.at) }));
  }
  let skipped = false;
  if (skipAtMs !== undefined && skipAtMs < exitAt) {
    skipped = true;
    exitAt = Math.max(0, skipAtMs);
    segments = segments.filter(s => s.at < exitAt).map(s => ({ ...s, ms: Math.min(s.ms, exitAt - s.at) }));
  }
  const openAt = MONTAGE_INTRO_MS - 1150, openedAt = MONTAGE_INTRO_MS - 350;
  return { duration, welcomeOnly, aAt, bAt, viewersAt, raidersOutAt, morphAt, openAt, openedAt, segments, exitAt, leaveAt: exitAt + 1700, goneAt: exitAt + 2100, skipped };
}
