// All copy and numbers of the film in one place. Numbers come from evidence files (see BEATS.md).
// FACTS: the example recording's real data (review/replay-data/foxlight-raid.json, fixtures/foxlight.ts).
export const FACTS = {
  channel: 'Foxlight Dev', title: 'Building a tiny cave platformer',
  raid: { from: 'pixelmoth', viewers: 37 },
  moment: { count: 45, messages: ["MOON JUMP", "he's gone", "fox to the moon", "LUL", "o7 fox", "the fox has left the cave", "MOON JUMP MOON JUMP", "clip it", "where did he go", "LUL LUL", "bye fox", "lol", "moon jump any%", "o7"] },
  lore: { term: "moon jump", origin: '2:05' },
};
// CODEX: mined from the Codex session transcript by tools/mine-codex.py (tools/codex-facts.json),
// test counts from docs/testing/functional/release-preflight.md, load numbers from the submission journal.
export const CODEX = {
  workers: 27, toolCalls: 4798, duration: '9 h 34 min',
  workerNames: ["twitch_research", "story_engine_research", "product_challenge", "architecture_proposal", "visual_direction", "install_twitch_cli", "storage_build", "shared_ui_build", "runtime_foundation", "foundation_review", "foundation_review_final", "story_domain", "twitch_engine", "providers_engine", "publication_engine", "owner_service", "live_engine_review", "dock_experience", "public_experience", "overlay_experience", "replay_experience", "experience_review", "documentation", "release_audit", "experience_review_two", "engine_write_probe", "source_recovery"],
  bugs: [
    { t0: 110.9, label: 'Reproduced, then fixed', text: 'When the chat queue was full, a deletion that had already arrived was dropped', stamp: 'fixed' },
    { t0: 114.2, label: 'Found in a long load run, reproduced, then fixed', text: 'After a provider outage, chat pushed out recent speech and the story stopped updating', stamp: 'fixed' },
  ],
  question: { label: 'The owner, translated from Russian', text: 'Is a test this long really needed?', answer: 'Codex ended the run early and recorded it as partial: 280,780 chats over 3.80 virtual hours' },
  stats: [
    { n: '29', label: 'commits from the Codex session' },
    { n: '609', label: 'tests across 67 files when the session ended; 656 pass today' },
    { n: '1,000', label: 'chat messages at 20 per second with no gaps' },
  ],
};
