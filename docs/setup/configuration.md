# Configuration and local data

The server reads `.env` from the project directory; process environment values take precedence. Restart after changes. Provider credentials never belong in browser-prefixed variables, public assets, screenshots, or a committed environment file. [`.env.example`](../../.env.example) supplies the local template; `npm run setup:local` fills missing local secrets.

## Effective local settings

| Variable | Purpose and behavior |
| --- | --- |
| `PORT` | Fixed to `4317`; another value is rejected by normal configuration loading. |
| `HOST` | `127.0.0.1` by default; only loopback `127.0.0.1` or `localhost` is accepted. |
| `LOCAL_ORIGIN` | Must be `https://localhost:4317`; used by origin and cookie checks. |
| `DATA_DIR` | Private database, temporary audio, media, and export storage. Defaults to `.data`, relative to the project directory. |
| `LOCAL_TLS_PFX` | Local certificate bundle, normally `.data/tls/localhost.pfx`. The setup script creates certificates inside `.data/tls`. |
| `LOCAL_TLS_PASSPHRASE` | Generated certificate passphrase, at least 32 bytes. Required to start HTTPS. Keep it with the matching PFX. |
| `SESSION_SECRET` | Generated secret of at least 32 bytes for local session and signed-control protection. Required for owner controls. |
| `TOKEN_ENCRYPTION_KEY` | Generated base64-encoded 32-byte key for persisted provider credentials. Preserve it with the database. |
| `TWITCH_CLIENT_ID` | Twitch application's client ID. Needed for the live integration. |
| `TWITCH_CLIENT_SECRET` | Twitch application's secret, kept server-side. Needed for the live integration. |
| `TWITCH_CHANNEL_LOGIN` | Broadcaster login without `@` or a URL. OAuth must use this broadcaster. |
| `TWITCH_REDIRECT_URI` | Must be `https://localhost:4317/auth/twitch/callback`. |
| `OPENAI_API_KEY` | Server-side API key. Missing or disabled access leaves new provider-dependent work held. Keyless replay does not use it. |
| `OPENAI_PAID_CALLS_ENABLED` | Explicit `true` or `false`, default `false`. A key alone cannot enable dispatch. Replay never enables live providers. |
| `RECAP_LANGUAGE` | Initial recap language, `en` or `ru`. The owner can change the persisted setting in the dock. It does not set the source recognition language. |
| `PUBLICATION_DELAY_SECONDS` | Initial source hold, from 60 to 90 seconds, default 75. Current safety and dependency checks remain required. |
| `RECAP_PUBLIC_ORIGIN` | HTTPS origin of the Vercel deployment. Omit for isolated local replay. |
| `PUBLISH_SHARED_SECRET` | At least 32 bytes, identical locally and in the cloud function. Authenticates publication writes. The setup script generates a local value when absent. |

Defaults for language and hold initialize fresh persisted settings. An existing channel keeps its saved settings. Use the dock to change them.

The cloud also requires `BLOB_READ_WRITE_TOKEN`, described in [public deployment](publication.md). The normal local publisher uses the signed cloud API and does not need that token. The explicit authored-export publishing script uses it for its administrative head lookup; do not expose it to the browser.

## Provider and budget defaults

The current adapters use `gpt-transcribe` for transcription, `gpt-6-luna` for structured proposals and contextual review, `omni-moderation-latest` for moderation, and `gpt-realtime-2.1-mini` for optional narration. These are source-level defaults, not proof that a particular API account has model access. See the [provider implementation notes](../../src/server/providers/README.md).

Model identifiers and the $4.50 persistent dispatch ceiling are fixed in the current provider/storage implementation. Narration is controlled through persisted owner settings and remains off by default. The environment template lists effective settings; models, budget, narration, alternate provider URLs, and a separate bot identity have no environment overrides.

Every paid attempt reserves budget before dispatch. Restarting does not reset reservations or committed usage. A timeout can retain its allowance because the provider may have received the request. Do not delete the database to reset this counter; it also holds private history, authorization, and privacy fences.

## Persistence and backup

`DATA_DIR/previously.sqlite` contains sessions, sources, derived history, checkpoints, settings, encrypted tokens, durable work, publication state, and budget records. SQLite migrations run at startup. The live token vault needs the original `TOKEN_ENCRYPTION_KEY`; changing it does not decrypt an existing authorization.

Other private subdirectories hold temporary audio, validated media, the local replay registry, and reviewed export work. None belongs in the public build. The authored replay registry is separate from live session history, and a revoked local export is not silently restored on restart.

Back up the database and its matching encryption configuration while the process is stopped. Treat that backup as private stream material. Keep it out of Git and public cloud asset directories. A backup restored from before a Forget action may contain material you intended to remove; do not publish or export it without reconciling the current privacy state.
