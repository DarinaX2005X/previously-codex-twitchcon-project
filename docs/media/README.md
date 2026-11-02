# Product media

This folder supplies source assets for a separate gallery or film. It does not contain a finished submission video, thumbnail or presentation.

## Identity

The [brand folder](brand/) contains SVG and PNG versions of the outlined wordmark for light and dark surfaces, a monochrome mark, and the framed README logo. These are copies of the production assets in [public/brand](../../public/brand/). Rebuild them from the same outlined master with `public/brand/export_brand.py`; do not retype the wordmark with a substitute font.

The interface uses [Onest Variable](../../public/fonts/Onest-Variable.ttf), with its [SIL Open Font License](../../public/fonts/OFL-Onest.txt). Main weights are 400 for reading, 550 for controls, and 650 or 700 for headings. Use tabular sans figures for times and counts.

| Role | Color |
| --- | --- |
| Ink stage | `#14171B` |
| Raised ink surface | `#1E232A` |
| Paper card | `#F4EFE6` |
| Paper underside | `#CFC5B3` |
| Vermilion, action and the present | `#FF5A36` |
| Vermilion underside | `#C93F22` |
| Lime, chat energy and the live state | `#C8F560` |
| Muted text on ink | `#A9B1BC` |
| Muted text on paper | `#4A4F57` |

[The production tokens](../../src/styles/tokens.css) are authoritative, including dark-surface text and state colors.

## Existing interface evidence

[Visual review captures](../testing/visual/) show the authored example and isolated owner fixtures. Their scope is described in [the review notes](../testing/visual/experience-review.md). They must retain the authored/example disclosure when reused. They are not footage of the owner, a real raid, or evidence of model quality.

## Example and live source material

The example recording uses real gameplay footage of Foxlight, a small original browser game made for it (`tools/foxlight`, clips in `public/demo/foxlight`). Its speech, chat, raid and model outcomes are authored. No owner live stream has been recorded, so do not present the example under a live caption.

Keep raw private captures outside Git until their actual screen and audio content have been reviewed. Encode approved MP4 footage with `h264_nvenc`. H.264 has no alpha channel: for compositing, supply aligned fill and matte files with the same dimensions, frame rate, frame count and timestamps, together with the transparent OBS Browser Source. Record encoder, source session, export revision and timing beside each approved capture.

If a later Forget affects a published media asset, withdraw it and replace affected source material before sharing again. Previously cannot recall already-downloaded files or copies embedded in Git history.
