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
| `TWITCH_MARKERS_ENABLED` | Optional `true` or `false`, default `false`. Enables attempts to add VOD markers for saved moments. Restart and reconnect Twitch after enabling to grant `channel:manage:broadcast`. Unavailable markers leave the saved moment and its timecode intact. |
| `OPENAI_API_KEY` | Server-side API key from a project with credit and access to the models below. Missing or disabled access leaves new provider-dependent work held; key, model-access and billing failures print one diagnostic line in the server terminal. Keyless replay does not use it. |
| `OPENAI_PAID_CALLS_ENABLED` | Explicit `true` or `false`, default `false`. A key alone cannot enable dispatch. Replay never enables live providers. |
| `RECAP_LANGUAGE` | Initial recap language as a BCP 47 tag, default `en`: for example `es`, `pt-BR`, `ja` or `zh-Hant`. Case is normalized (`pt-br` becomes `pt-BR`); a value that does not name a written language is rejected at startup. The owner can change the persisted setting in the dock. It does not set the source recognition language. See [recap languages](#recap-languages). |
| `PUBLICATION_DELAY_SECONDS` | Initial source hold, from 60 to 90 seconds, default 75. Current safety and dependency checks remain required. |
| `RECAP_PUBLIC_ORIGIN` | Optional HTTPS origin of the Vercel deployment. Without it, `!previously`, `!lore` and the raid welcome reply in chat with the published context only; with it, the public recap link is appended. |
| `PUBLISH_SHARED_SECRET` | At least 32 bytes, identical locally and in the cloud function. Authenticates publication writes. The setup script generates a local value when absent. |

Defaults for language and hold initialize fresh persisted settings. An existing channel keeps its saved settings. Use the dock to change them.

## Recap languages

The recap can be written in any language. The dock's **Recap language** field lists common streaming languages by their own names (type to search, for example `esp` or `日本`), and any other language can be entered by its BCP 47 code, such as `sw` or `es-419`. Speech and chat are recognized in whatever language they are spoken; this setting only chooses the output language.

What follows the setting:

- **Story text** (chapter titles and summaries, the current state, lore explanations, the chat bot's recap and the narration script) is written by the model in the chosen language from the same checked claims, then safety-checked and reviewed for faithfulness in that language. One published version feeds the public page, the chat bot and the raid scene.
- **Fixed scene labels and chat bot fallbacks** ("Previously on", "Right now", "Type !previously in chat", "A confirmed recap is still being prepared", the raid welcome) come from built-in catalogs for English, Russian, Ukrainian, Spanish, Portuguese, German, French, Italian, Polish, Turkish, Japanese, Korean, Simplified Chinese and Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-HK`). Regional variants use their base language (`pt-BR` uses Portuguese). Any other language shows these few labels in English while its story text stays in the chosen language; the dock says so under the field.
- **The public recap page's own interface** (buttons, headings such as "The story so far") stays English in every language, as it was for Russian. Its chapters, summaries and lore are in the chosen language.
- **The streamer dock** stays English.

New chapters are presented right away in the chosen language and in English. Switching to a language the published chapters do not have yet asks the model to present those same chapters in it first; the switch can take a little while and the previous language stays published until every published chapter and lore entry has checked wording. If any of them cannot be prepared (a provider outage or a held translation), the dock reports that and nothing changes. Forget and other privacy actions invalidate the wording in every language, because each one depends on the same sources.

The keyless example replay holds recorded English and Russian outcomes only, so its language control offers exactly those two. A replay never asks a model for a new language.

The cloud also requires `BLOB_READ_WRITE_TOKEN`, described in [public deployment](publication.md). The normal local publisher uses the signed cloud API and does not need that token. The explicit authored-export publishing script uses it for its administrative head lookup; do not expose it to the browser.

## Provider and budget defaults

The current adapters use `gpt-transcribe` for transcription, `gpt-6-luna` for structured proposals and contextual review, `omni-moderation-latest` for moderation, and `gpt-realtime-2.1-mini` for optional narration. These are source-level defaults, not proof that a particular API account has model access. See the [provider implementation notes](../../src/server/providers/README.md).

Model identifiers and the $4.50 persistent dispatch ceiling are fixed in the current provider/storage implementation. Narration is controlled through persisted owner settings and remains off by default. The environment template lists effective settings; models, budget, narration, alternate provider URLs, and a separate bot identity have no environment overrides.

Every paid attempt reserves budget before dispatch. Restarting does not reset reservations or committed usage. A timeout can retain its allowance because the provider may have received the request. Do not delete the database to reset this counter; it also holds private history, authorization, and privacy fences.

## Persistence and backup

`DATA_DIR/previously.sqlite` contains sessions, sources, derived history, checkpoints, settings, encrypted tokens, durable work, publication state, and budget records. SQLite migrations run at startup. The live token vault needs the original `TOKEN_ENCRYPTION_KEY`; changing it does not decrypt an existing authorization.

Other private subdirectories hold temporary audio, validated media, the local replay registry, and reviewed export work. Private recordings live in `DATA_DIR/exports/private-recordings`; their reviewed packages live in `DATA_DIR/exports/reviewed-recordings`. No path belongs in the public build or a static download directory. The authored replay registry is separate from live session history, and a revoked local export is not silently restored on restart.

Recording is explicitly armed in the owner dock, not through an environment flag. At most twenty private recordings are retained. Remove unwanted unexported captures through the dock; exported ones must first be withdrawn, with cloud acknowledgement when publication was queued. Active recordings are marked interrupted after restart and cannot be exported. The [recording guide](../replay/README.md) explains review and ZIP limits.

Back up the database and its matching encryption configuration while the process is stopped. Treat that backup as private stream material. Keep it out of Git and public cloud asset directories. A backup restored from before a Forget action may contain material you intended to remove; do not publish or export it without reconciling the current privacy state.
