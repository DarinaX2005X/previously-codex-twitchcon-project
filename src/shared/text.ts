/**
 * Locale-independent caseless form for comparing chat terms (lore, `!lore <term>`, blocked terms):
 * NFKC (full-width and ligature forms), then upper-then-lower case mapping, so `ß` matches `SS`, final `ς`
 * matches `Σ`, and Turkish dotted `İ` and dotless `ı` both match `i`. It never depends on the runtime's locale.
 */
export function foldCase(text: string): string {
  return text.normalize('NFKC').toUpperCase().toLowerCase().replace(/i\u0307/gu, 'i').normalize('NFKC');
}
/** `foldCase` with runs of whitespace collapsed and the ends trimmed: the identity of a term. */
export const normalizeTermText = (text: string): string => foldCase(text).replace(/\s+/gu, ' ').trim();
