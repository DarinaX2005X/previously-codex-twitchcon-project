# Publish the public recap

The public client runs on Vercel. Its server functions accept signed operations from the local collector and read a private Blob store. The browser receives current published content through gated API routes, never a private-store token or a direct Blob URL.

## Deploy the public client and functions

Import the repository into Vercel with the directory containing `package.json` as the project root. The checked-in [`vercel.json`](../../vercel.json) sets the build command to `npm run build:public`, the output directory to `dist-public`, and routes `/api/*` to the publication function. Use a Node.js runtime compatible with the repository's Node 22 requirement.

Create a **private** Vercel Blob store and connect it to the deployment. Configure these server environment variables in the same deployment environment:

| Variable | Value |
| --- | --- |
| `TWITCH_CHANNEL_LOGIN` | The broadcaster login the deployment is allowed to serve |
| `PUBLISH_SHARED_SECRET` | The same generated secret used by the local collector, at least 32 bytes |
| `BLOB_READ_WRITE_TOKEN` | Server token for the private Blob store |

Redeploy after changing server environment variables. Do not give any of these variables a `VITE_`, `NEXT_PUBLIC_`, or `PUBLIC_` prefix. Twitch client credentials and the OpenAI key stay on the local computer; public publication functions do not need them.

Set `RECAP_PUBLIC_ORIGIN` in the local `.env` to the deployment's HTTPS origin without a trailing slash, and set the matching `PUBLISH_SHARED_SECRET`. Restart the collector. Setup then supplies the public channel address in the form `/c/<channel-login>`.

The first signed publication binds the configured login to its numeric Twitch channel ID. Use the actual channel identity. Verification fixtures belong to a distinct login and must not be substituted for a broadcaster's history.

## Publish only current reviewed content

The local runtime sends snapshots and privacy retractions automatically through its durable outbox. A signature covers the method, path, timestamp, channel, sequence, and exact body hash. Cloud conditional writes prevent an old body or conflicting retry from replacing the current head. The collector records the acknowledgement before reporting a public change as synced.

An authored example can be registered explicitly with [`scripts/publish-authored-replay.mts`](../../scripts/publish-authored-replay.mts). It requires the public origin, shared secret, and administrative private-store token in the local process or its environment files. Supply the configured channel login and numeric channel ID as arguments. This is a publication action, so run it only for the deployment and identity you intend to change.

```powershell
$channelLogin = Read-Host 'Configured Twitch channel login'
$channelId = Read-Host 'Numeric Twitch channel ID'
npx tsx scripts/publish-authored-replay.mts $channelLogin $channelId
```

The script publishes the authored text example, not an own-stream recording. It leaves an existing registered example alone and refuses to restore a revoked export. A reviewed replacement needs a new revision through the publication contract. Ordinary replay page loads never republish or restore exports.

Open **Recordings** in the dock header. **Approve reviewed contents** and **Create private export** stage own-stream material locally. They do not upload it. **Publish recording** calls the authenticated `POST /api/owner/recordings/:id/publish` operation to queue signed publication. Keep the collector running until that exact export is acknowledged; only then does **Open published recording** appear. A newer unrelated snapshot acknowledgement cannot make the recording look published. **Retry publication** is available when confirmation fails. See [Replay and recordings](../replay/README.md) and the [publication adapter contract](../../src/server/publication/README.md) for the review and publication boundaries.

## Read, revoke, and recover

| Route | Purpose |
| --- | --- |
| `POST /api/publish` | Signed snapshot, retract, or export-manifest operation |
| `POST /api/publish/export-assets` | Signed bounded asset upload before its manifest becomes current |
| `GET /api/public/channels/:login` | Current published channel projection |
| `GET /api/public/sessions/:id` | A current permitted episode projection |
| `GET /api/public/replays/:id` | Current permitted manifest with a visibility lease |
| `GET /api/public/replays/:id/assets/:assetId?revision=...` | Asset read gated by that current manifest and revision |

Public responses use `no-store`. Asset reads, including Range requests, recheck the manifest. An old revision, revoked export, or unavailable export cannot be opened through a guessed old asset URL. The browser clears its replay and media when revalidation fails or its six-second visibility lease expires. A public page loading successfully does not by itself prove that a replay manifest is available.

A live recap needs the collector's heartbeat lease. A finalized episode can remain readable after the collector stops. Losing connectivity does not turn held or private material into a public fallback. A privacy change made offline remains pending until its retraction reaches the cloud; already downloaded external copies cannot be recalled.

**Withdraw recording** closes its local replay and ZIP downloads when the withdrawal is saved, and queues a separate signed cloud retraction. The dock reports **Withdrawn locally, public withdrawal pending** until that operation is acknowledged. During that interval an existing public copy may remain available; local success alone is not a remote deletion guarantee. Use **Retry withdrawal** if needed, and keep the collector running. Private capture removal stays disabled until the necessary acknowledgement. A private export that was never queued for publication can be removed after local withdrawal. This action withdraws the export, while the stream's published chapters remain; Forget is the underlying source privacy action.

The private-store and deployed HTTP checks are described in [cloud verification](../testing/cloud-storage.md). The probe scripts create and remove isolated authored test records and perform real cloud writes; they are not part of routine startup or the default test suite. Run them only against an explicitly designated verification identity.

Use the signed maintenance operation only for unreferenced immutable objects below the current head. Do not manually delete a current head or identity record to reset an error. Preserve publication sequences and privacy state when restoring the local database.
