# Functional acceptance — 2026-11-02

This report separates deterministic authored outcomes, actual official Twitch CLI mock delivery, and evidence that still requires a live stream. No paid provider request, live Twitch output, clip download, or cloud mutation was made by this acceptance run. No browser screenshots or human-comprehension claims were added: this work changed backend boundaries and has functional evidence only.

## Reproduce

From `project` with dependencies installed and Node 22.13 or newer:

```powershell
node scripts/verify/acceptance.mjs --fixtures
node scripts/verify/acceptance.mjs --cli
npx tsc --noEmit
```

The runner defaults to both phases when no flag is supplied. It resolves the installed CLI at `../tools/twitch/twitch-cli_1.1.24_Windows_x86_64/twitch.exe`; set `TWITCH_CLI_PATH` for another installation. It fails if CLI is missing rather than silently skipping. Run CLI tests sequentially: official CLI 1.1.24 uses fixed loopback RPC port 44747. The test checks that port is free, chooses an ephemeral WebSocket port, spawns hidden on Windows, and stops only its own processes. No `.env` file or production OAuth token is loaded by the acceptance helpers.

The acceptance runner passed **83 tests across 13 files** after bounded chat batching. The final gap-drain correction passed **10 focused batch, cap, privacy and lifecycle tests**, and the affected official CLI rerun passed in **21.95 seconds**. The latest whole-project typecheck passed. The [intake report](chat-intake-2026-11-02.md) records the paced 20/second and independent-producer 200/second measurements and their different load conditions.

## Boundary matrix

| Scenario | Evidence and result | Scope |
| --- | --- | --- |
| RU speech → EN, EN speech → RU | WAV intake → STT adapter outcome → safety → SQLite → story/review/presentation adapters → public projection; original source wording/language preserved | Authored transcript, grounding and translation outcomes. This verifies wiring, language selection and publication gating, not model translation quality |
| Silence | Actual zero-PCM WAV through the production transcription silence gate, then intake/repository; no source, story job or claim; no network call | Real local signal gate |
| Music | Authored 440 Hz tone plus explicitly authored empty transcript outcome; no source or claim | Does **not** establish real provider music recognition |
| Harmful or unavailable moderation | Safety result blocked/unavailable prevents accepted speech evidence and downstream story jobs; raw WAV removed | Deterministic provider outcomes |
| Email, phone, secret filename | Pattern removal precedes SQLite evidence and story packet; sensitive spans absent from public projection | Authored text; contextual name/address classification remains separately fixture-tested |
| Provider outage / malformed structured output | Production transport/story adapter with injected unavailable or invalid responses; bounded repair, old safe published chapter retained, delayed status | No external requests; malformed case uses two attempts |
| Owner correction vs late generation | Real owner service edits a published chapter while a story request is pending; late result cannot overwrite correction; correction stays held until owner safety review completes | Runtime/repository race |
| Forget before model returns | Owner privacy mutation during deferred story proposal; deleted source cannot produce a chapter on return | Runtime/repository race |
| Pause / capture takeover during STT | Actual intake lease/pause or replacement acquisition while STT waits; late source rejected; no downstream generation; raw WAV removed | Runtime/repository race; browser track stopping is outside this test |
| Wrong owner or overlay capability | Existing owner/overlay HTTP tests reject absent, wrong-role, wrong-channel, expired, forged or malformed contexts | HTTP and service authorization |
| Public projection leak | Existing overlay projection tests inject raw/private fields and reject unknown plan data; pending and withdrawn chapters absent from public projection | API/domain evidence, not pixels |
| Clip unavailable | Existing effects tests preserve unavailable/timecode state on disabled, timeout or ambiguous creation; no fabricated media | Authored Helix responses |
| Chat/clip outbox restart | Two distinct Node processes use one temporary SQLite file. First sends once and creates once; second sends/creates zero, resumes one pending poll, prepares once, and retains echo/command dedupe | Actual process restart with authored external adapters |
| Signed cloud publication and Forget | Existing live-pipeline test crosses signed cloud HTTP handler with memory store, publishes after hold, then removes public and local media derivatives | In-process cloud fixture, not a deployed mutation |

The publication boundary is checked separately from cloud acknowledgement: a source ending at virtual +1 second is absent at +75.999 seconds and published at +76 seconds (75-second configured hold). The existing 20-second pipeline case publishes at +95 seconds. These are virtual-clock boundary assertions, not measured STT/model latency. Cloud ACK/revision correctness is covered by the cloud integration suite; no new live cloud ACK latency was measured here. Do not add these intervals into a claimed end-to-end SLA.

## Official CLI mock transport

`acceptance-cli.test.ts` connects the real `TwitchEventSub` to the official CLI server, uses durable SQLite controls, and passes received mock envelopes into `StoryEngine`. A real CLI-generated raid produces exactly one preparing playback with the delivered viewer count. This verifies scheduler state, not visible OBS playback.

The following controls were actually executed against the CLI server:

```text
twitch event websocket start-server --ip=127.0.0.1 --port=<ephemeral> --require-subscription
twitch event trigger channel.raid --transport=websocket --from-user=456 --to-user=123 --no-config
twitch event websocket reconnect
twitch event websocket keepalive --session=<mock-session> --enabled=false
twitch event websocket close --session=<mock-session> --reason=4006
```

- Graceful migration changes session ID while the subscription request count remains 10; there is no second subscription set.
- CLI server process termination/restart causes a hard gap and a new subscription set.
- Disabling keepalive causes `gap`, `quotesReady:false`, and `keepalive_timeout`; recovery subscribes afresh and retains the historical gap marker.
- Explicit close 4006 causes another gap and fresh subscriptions. Expected status sequence is gap → connecting → welcome → subscribing → active. It does not claim that messages missed during a hard gap were recovered.
- One received CLI raid frame is redelivered byte-for-byte at the client message boundary, then redelivered again after adapter/SQLite reopen. Both produce no second domain playback. **The duplicate is test redelivery of an actual CLI frame, not a second CLI-generated duplicate.**

CLI 1.1.24 does not support the four newer `channel.chat.*` subscriptions. Only those subscription responses are stubbed; their delete/clear behavior is fixture-tested. The existing `tests/twitch/cli.test.ts` separately covers the six CLI-supported event types. CLI migration locks other control RPCs for 30 seconds, so acceptance restarts the CLI server between the migration and keepalive scenarios rather than misreporting the CLI rejection as application failure.

All subscription URLs are redirected to loopback, authorization headers contain mock literals, and the test scope is `acceptance-cli` with `origin:mock`. The live Twitch effect sink is not constructed in the CLI test.

## Repaired privacy saturation defect

The independent reliability regression exposed an actual P1: one blocked ordinary ingest plus 99 queued chats caused the next already-received deletion to be dropped by the 100-item transport limit. The repaired transport persists supported privacy controls before scheduling work. It keeps only event/type/actor/message IDs and time cutoffs, never chat text or moderation reasons.

Privacy inbox pages contain at most 16 records and only one privacy drain task is placed on the promise chain. Ordinary ingress remains capped at 100. A 150-delete burst drains completely; the original saturated-chat deletion regression passes, and a separate 200-chat burst confirms the ordinary cap/gap behavior.

If the first durable write fails, exactly one accepted control is retained in memory. The failure path synchronously removes all socket message listeners before invoking status callbacks or terminating sockets. JavaScript cannot enter another message callback concurrently, so no additional frame is accepted into that emergency slot. Frames arriving after detachment belong to the explicit transport gap; this is not a promise of gap replay. Status callback storage failure cannot interrupt socket shutdown or retry scheduling. Reconnection and `quotesReady` stay blocked until retained/durable controls have applied.

An actual subprocess test dies during the first privacy ingest with three committed inbox records. A new process replays all three, including the first interrupted transport dedupe claim. Real-runtime fault injection also seeds an interrupted runtime-level processing claim; recovery reclaims only privacy work absent from the current instance's in-flight set, applies the deletion, and marks it done. Normal external-action ambiguity keeps its previous no-retry semantics.

The runtime integration test injects simultaneous privacy-inbox and ban-status persistence failures. `onPrivacyBlocked(true)` fires before status persistence; the socket stops; a seven-second failed-storage interval causes no reconnect; after recovery the source is deleted before callback false and a fresh welcome. Ban checking stops during this fault to avoid an independent timer continuing against broken storage.

MAIN connected that immediate callback to the output gate: local published/source/preview responses and overlay state are withheld, media visibility and effect authorization are denied, cloud requests are aborted, and heartbeats stop. Recovery cancels interrupted scene plans before resuming. MAIN reports 40 focused cloud/owner/overlay tests passing for those gates. Existing remote cloud content expires at its last 30-second lease deadline; a broken local SQLite store cannot promise instantaneous remote retraction. The acceptance agent did not perform a new deployed cloud or browser inspection of this fault path.

## Still requires live evidence

The later [chat batching/intake report](chat-intake-2026-11-02.md) records the bounded FIFO adapter integration, rollback/reconnect regressions and a 1,000-message paced 20/second measurement through the real local runtime and file-backed SQLite.

Real microphone speech and paid provider semantic behavior, real music/noise recognition, Twitch OAuth/scopes, second-account commands and incoming raid, actual clip download/alignment, visible/sounded OBS playback, deployed edit/Forget latency after cloud ACK, and owned EN/RU recording remain live-work dependencies. No synthetic or authored fixture is labelled as a recording of the user, and this report does not mark the entire live stage complete.
