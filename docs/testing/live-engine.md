# Live engine verification

Stage 02 integrates the pure reducer with SQLite, owner and overlay routes, capture intake, provider adapters, Twitch workers, and cloud publication.

The authored end-to-end test accepts a complete 20-second PCM WAV, commits its fixture transcript, runs a fixture story provider, verifies namespaced claim references, waits through the 75-second gate, publishes through the signed cloud HTTP handler, switches both chapter and current text to Russian, and applies Forget. The forgotten story is absent after hydration, the public projection is empty, and a local media Range request returns 410. This is functional fixture evidence, not measured transcription quality or a recorded stream.

Other focused tests cover durable owner review after SQLite restart; deletion before and during a review; same-key mutation conflicts; adjacent privacy intervals; unrelated deletion while a candidate waits; source checks during closing; bilingual lore; stale overlay acknowledgements; two queued raids; channel-scoped previous-clip approval before any stream; private media aliases; and revoked media after cleanup failure. Live composition with no token and paid mode off makes no external requests.

The independent review found and prompted repairs for interval boundary rollback, finalization with unchecked speech, lost owner review work, and unrelated privacy changes blocking a tombstone. Regression cases use the actual reducer and repository.

The local HTTPS health/readiness endpoints respond using the trusted localhost certificate. [Cloud verification](cloud-storage.md) records the separate real private-store and deployed HTTP checks. The Twitch CLI test is opt-in; its earlier successful transport run covers the six event types supported by the installed CLI, while the newer chat types remain fixture-tested.

No paid OpenAI requests have been made. Actual Twitch OAuth, the production subscriptions, a second account's chat and incoming raid, microphone/OBS behavior, model access and semantic quality, and authorized clip alignment/playback still require the live test. Narration is optional and remains off; a safe plan-to-audio binding is required before enabling it. The public and owner interfaces are built in stage 03. This backend review made no new pixel or human-comprehension claims.
