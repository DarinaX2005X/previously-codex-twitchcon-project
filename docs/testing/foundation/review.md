# Foundation review

Scope: stage 01, local storage/runtime and shared interface controls. Authored examples are deliberately labeled. They are not a live Twitch recap, provider output, or a completed replay.

## Functional observations

- The stage-closing `npm run check` passed TypeScript, the functional suite and both builds. Two independent review rounds found six storage defects; targeted SQLite regressions now cover their repairs. Previous chapter context is retained as an immutable dependency, and obsolete pending candidates are cleared when privacy epochs change.

- The first integrated test run passed 33 checks across actual SQLite, server middleware/scheduling and public projection contracts. Additional targeted regressions were subsequently added by the owning packages; stage closure records the final run.
- The local and public Vite builds use separate entry points. The public JavaScript does not contain the setup route, API key setting name, or foundation interface text.
- HTTPS `/ready` returns 200 with storage ready and configuration incomplete when validated against the generated localhost certificate explicitly. No certificate validation was disabled.
- The owner confirmed the Windows CurrentUser trust dialog. A normal PowerShell HTTPS request and the existing in-app browser both loaded `/ready` successfully without a certificate exception. OBS certificate behavior remains unverified.

## Pixels and interaction

Reviewed the production shared controls at 1440 × 900 and 390 × 844 using the local Vite preview. The stable dark dock and larger paper reading plane have clear roles. The current statement is visually strongest in the reading surface; source text and time remain secondary. Cyrillic renders without missing glyphs, and the long current statement wraps into two readable lines on desktop.

At the narrow width, Preview sample wraps to two lines inside its enlarged button; neighboring Edit sample remains aligned and readable. The dock has an independently scrolling history. No horizontal clipping was observed in this state. The mobile edit sheet keeps its heading, fields and Save/Cancel actions visible; long single-line input content uses normal input scrolling. Focus has a clear vermilion outline. Escape and Cancel close the dialog and return focus to the opening Edit sample button.

Saved screenshots: `primitives-desktop.png` and `editor-mobile.png`. The first immediate viewport-resize capture had stale capture bounds; the saved desktop image was opened from disk and confirmed to show the complete intended viewport. There was no product CSS change for this capture issue.

These observations cover primitives, material, typography and dialog behavior. They do not verify live privacy enforcement in the UI, real clip playback, authored scene motion, sound, microphone capture in OBS, or human comprehension. Those remain assigned to later stages. This is agent evidence, not user approval.
