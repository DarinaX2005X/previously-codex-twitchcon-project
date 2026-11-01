# Private storage verification

The authorized Vercel project has a private Blob store in Frankfurt. The opt-in `scripts/verify/blob-probe.mts` creates a unique authored probe, exercises the real SDK, and removes only that probe afterward.

Verified with `@vercel/blob` 2.4.0: authenticated read, rejected anonymous URL read, one winner from two writes using the same ETag, and uncached reading of the winning value.

The separate `scripts/verify/publication-probe.mts` also passed application publication/read, conditional-write conflict, current-head read, replay asset gating and revocation with 410, rejection of an old publication, live-lease expiry and finalized-episode availability. It uses an isolated authored verification channel. Its final retract/maintenance removes the probe objects while keeping the protected channel binding and empty head. Deployed HTTP behavior is still unverified.

The first application probe reproduced a conditional-write failure after reading a larger compressed head. The SDK read now requests an identity encoding so the ETag matches the representation used for conditional writes. The repaired path passed against the real private store.

The SDK is pinned to 2.4.0 because the newer 2.8.2 dependency chain included a bundled vulnerable Zod version through its optional OIDC support. The selected SDK supplies the required private storage and conditional-write API without that chain; the install audit reported no known vulnerabilities.
