# Product media

This folder supplies source assets for a separate gallery or film. It does not contain a finished submission video, thumbnail or presentation.

## Identity

The [brand folder](brand/) contains SVG and PNG versions of the outlined wordmark for light and dark surfaces, a monochrome mark, and the framed README logo. These are copies of the production assets in [public/brand](../../public/brand/). Rebuild them from the same outlined master with `public/brand/export_brand.py`; do not retype the wordmark with a substitute font.

The interface uses [Onest Variable](../../public/fonts/Onest-Variable.ttf), with its [SIL Open Font License](../../public/fonts/OFL-Onest.txt). Main weights are 400 for reading, 550 for controls, and 650 or 700 for headings. Use tabular sans figures for times and counts.

| Role | Color |
| --- | --- |
| Canvas | `#E9EBE6` |
| Paper | `#F5F4EC` |
| Source plane | `#D5DAD2` |
| Charcoal / primary text | `#252B2C` |
| Raised dark surface | `#3A4440` |
| Action / meaningful emphasis | `#F26844` |
| Border | `#66716E` |
| Success | `#286345` |
| Warning | `#795214` |
| Error | `#A93130` |

[The production tokens](../../src/styles/tokens.css) are authoritative, including dark-surface text and state colors.

## Existing interface evidence

[Visual review captures](../testing/visual/) show the authored example and isolated owner fixtures. Their scope is described in [the review notes](../testing/visual/experience-review.md). They must retain the authored/example disclosure when reused. They are not footage of the owner, a real raid, or evidence of model quality.

## Live source material

Owned microphone, Twitch and OBS material is pending the agreed live session. The remaining source set is the actual raid, a clean overlay pass, an overlay pass over the owner's screen, and dock/public recap screenshots from that stream. Do not substitute the authored example under a live caption.

Keep raw private captures outside Git until their actual screen and audio content have been reviewed. Encode approved MP4 footage with `h264_nvenc`. H.264 has no alpha channel: for compositing, supply aligned fill and matte files with the same dimensions, frame rate, frame count and timestamps, together with the transparent OBS Browser Source. Record encoder, source session, export revision and timing beside each approved capture.

If a later Forget affects a published media asset, withdraw it and replace affected source material before sharing again. Previously cannot recall already-downloaded files or copies embedded in Git history.
