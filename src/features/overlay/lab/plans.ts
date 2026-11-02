import type { RecapPlan } from '../../../shared/contracts/index.js';

/**
 * Development-only stand-in plans for the scene lab. They mirror the Foxlight example recording
 * (authored example data, not a real broadcast). The real plan comes from fixtures/foxlight.ts via ?plan=foxlight.
 */
export const LAB_MEDIA: Record<string, string> = {
  'fx-media-run': '/demo/foxlight/clip-run.mp4',
  'fx-media-moon': '/demo/foxlight/clip-moon.mp4',
  'fx-media-fixed': '/demo/foxlight/clip-fixed.mp4',
  'fx-media-lanterns': '/demo/foxlight/clip-lanterns.mp4',
};
const media = (id: string, captureStartMs: number, captureEndMs: number, inMs = 0): RecapPlan['media'][number] =>
  ({ id, kind: 'video', inMs, outMs: Math.min(captureEndMs - captureStartMs, inMs + 12000), captureStartMs, captureEndMs, previousSession: false });

export function labPlan(variant: string): RecapPlan {
  const base: RecapPlan = {
    id: `recap:lab-${variant}`, sessionId: 'foxlight-session', revision: 12, privacyEpoch: 0, language: 'en', variant: 'full', durationMs: 47000,
    dependencyRefs: [{ id: 'chapter:moon', revision: 2 }],
    layout: { preset: 'lower', protectedRects: [{ x: 1376, y: 64, width: 480, height: 270 }] },
    arrivals: [{ triggerId: 'fx-raid-pixelmoth', fromLogin: 'pixelmoth', viewers: 37 }],
    overflowArrivals: { channels: 0, viewers: 0 },
    beats: [
      { id: 'b0', kind: 'context', text: 'The moon jump', atMs: 0, untilMs: 6000, sourceRange: { startMs: 100000, endMs: 200000 }, sourceIds: [], mediaId: 'fx-media-moon' },
      { id: 'b1', kind: 'now', text: 'Making the lantern behind the waterfall reachable', atMs: 6000, untilMs: 12000, sourceRange: { startMs: 320000, endMs: 400000 }, sourceIds: [], mediaId: null },
    ],
    media: [media('fx-media-run', 20000, 30000), media('fx-media-moon', 100000, 110500), media('fx-media-fixed', 210000, 219500), media('fx-media-lanterns', 320000, 331000)],
    audio: null, soundEvents: [], generatedAt: '2026-11-02T00:07:10.300Z',
    scene: {
      channelName: 'Foxlight Dev', streamTitle: 'Building a tiny cave platformer',
      chapters: [
        { id: 'chapter:jump', title: 'Fox learns to jump', summary: 'The streamer starts a tiny cave platformer: the fox can run and jump, and tonight the lanterns should light up the cave.', startMs: 5000, mediaId: 'fx-media-run' },
        { id: 'chapter:moon', title: 'The moon jump', summary: 'The spring launched the fox through the ceiling and chat named it the moon jump.', startMs: 100000, mediaId: 'fx-media-moon' },
        { id: 'chapter:spring', title: 'Spring gets a speed limit', summary: 'The spring speed is capped, so the fox lands on the ledge; the moon jump stays as a secret cheat.', startMs: 210000, mediaId: 'fx-media-fixed' },
      ],
      moment: { id: 'moment:moon', chapterId: 'chapter:moon', startMs: 101000, windowSeconds: 10, count: 45, mediaId: 'fx-media-moon',
        messages: ['MOON JUMP', 'he is gone', 'fox to the moon', 'LUL', 'o7 fox', 'the fox has left the cave', 'MOON JUMP MOON JUMP', 'clip it', 'where did he go', 'MOON JUMP', 'to the moon', 'o7', 'speed limit when', 'fox in orbit'] },
      lore: { term: 'moon jump', explanation: 'The spring launched the fox through the ceiling.', originMs: 125000 },
      now: { text: 'Making the lantern behind the waterfall reachable', mediaId: 'fx-media-lanterns' },
      command: '!previously',
    },
  };
  const plan = structuredClone(base);
  switch (variant) {
    case '30': plan.durationMs = 30000; break;
    case '120': plan.durationMs = 120000; break;
    case '10': plan.durationMs = 10000; break;
    case 'welcome': plan.variant = 'welcome'; plan.durationMs = 5000; plan.media = []; plan.scene = { ...plan.scene!, chapters: [], moment: null, lore: null, now: null }; plan.beats = [{ ...plan.beats[1]!, text: 'Building a tiny cave platformer' }]; break;
    case 'queue': plan.variant = 'welcome'; plan.durationMs = 5000; plan.media = []; plan.arrivals.push({ triggerId: 'r2', fromLogin: 'cozycat', viewers: 12 }, { triggerId: 'r3', fromLogin: 'lanternfan', viewers: 5 }); plan.scene = { ...plan.scene!, chapters: [], moment: null, lore: null, now: null }; break;
    case 'nochat': plan.scene = { ...plan.scene!, moment: null, lore: null }; break;
    case 'nomedia': plan.media = []; break;
    case 'manual': plan.arrivals = []; break;
    case 'nowonly': plan.scene = { ...plan.scene!, chapters: [], moment: null, lore: null }; break;
    case 'compact': plan.layout = { preset: 'lower', protectedRects: [{ x: 1240, y: 0, width: 680, height: 1080 }] }; break;
    case 'ru': plan.language = 'ru'; plan.arrivals = [{ triggerId: 'r', fromLogin: 'pixelmoth', viewers: 37 }];
      plan.scene = { ...plan.scene!, chapters: [
        { id: 'chapter:jump', title: 'Лис учится прыгать', startMs: 5000, mediaId: 'fx-media-run' },
        { id: 'chapter:moon', title: 'Прыжок на луну', startMs: 100000, mediaId: 'fx-media-moon' },
        { id: 'chapter:spring', title: 'Пружине ограничили скорость', startMs: 210000, mediaId: 'fx-media-fixed' }],
        lore: { term: 'прыжок на луну', explanation: 'Пружина пробивала лисом потолок.', originMs: 125000 },
        now: { text: 'Делаю путь к фонарю за водопадом', mediaId: 'fx-media-lanterns' } }; break;
  }
  return plan;
}
