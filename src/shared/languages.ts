/**
 * Recap languages are BCP 47 tags (`en`, `es`, `pt-BR`, `zh-Hant`). The model writes every presentation in
 * the chosen language; fixed product wording comes from the catalogs in `src/i18n`.
 */
export type RecapLanguage = string;

export const DEFAULT_RECAP_LANGUAGE: RecapLanguage = 'en';

/** language[-Script][-REGION], the part of BCP 47 that names a written language. Extensions and private use are refused. */
const SHAPE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u;

/** The canonical tag for `value` (`pt-br` becomes `pt-BR`, `iw` becomes `he`), or null when it does not name a language. */
export function canonicalLanguageTag(value: string): RecapLanguage | null {
  const trimmed = value.trim().replaceAll('_', '-');
  if (!trimmed || trimmed.length > 35) return null;
  let tag: string | undefined;
  try { [tag] = Intl.getCanonicalLocales(trimmed); } catch { return null; }
  if (!tag || !SHAPE.test(tag) || tag.startsWith('und')) return null;
  return tag;
}

export const isRecapLanguage = (value: unknown): value is RecapLanguage => typeof value === 'string' && canonicalLanguageTag(value) === value;

/** Common streaming languages offered first in the picker. Any other valid tag can be entered by code. */
export const COMMON_RECAP_LANGUAGES: readonly RecapLanguage[] = [
  'en', 'es', 'pt-BR', 'pt', 'fr', 'de', 'it', 'ru', 'uk', 'pl', 'tr', 'nl', 'sv', 'cs', 'ja', 'ko', 'zh', 'zh-Hant',
  'ar', 'hi', 'id', 'vi', 'th', 'fil', 'ms', 'he', 'el', 'ro', 'hu', 'fi', 'da', 'no',
];

function displayName(locale: string, tag: string): string | null {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? null; } catch { return null; }
}

/** The language's own name for itself, for example `español` or `日本語`. Falls back to the tag. */
export function nativeLanguageName(tag: RecapLanguage): string {
  const name = displayName(tag, tag);
  return name && name !== tag ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag;
}

/** English name, used in prompts and owner-facing English interface text. */
export function englishLanguageName(tag: RecapLanguage): string {
  const name = displayName('en', tag);
  return name && name !== tag ? name : tag;
}

/** Languages a new chapter is presented in right away: the chosen one, plus English as the ready fallback. */
export function eagerPresentationLanguages(recapLanguage: RecapLanguage): RecapLanguage[] {
  return recapLanguage === DEFAULT_RECAP_LANGUAGE ? [recapLanguage] : [recapLanguage, DEFAULT_RECAP_LANGUAGE];
}

/**
 * Reads what the owner typed in the language picker: a listed language's native or English name, its code,
 * or any other BCP 47 tag. Returns the canonical tag, or null when nothing matches.
 */
export function resolveLanguageInput(text: string): RecapLanguage | null {
  const wanted = text.trim().toLocaleLowerCase();
  if (!wanted) return null;
  const listed = COMMON_RECAP_LANGUAGES.find(tag => [tag, nativeLanguageName(tag), englishLanguageName(tag)].some(name => name.toLocaleLowerCase() === wanted));
  return listed ?? canonicalLanguageTag(text);
}
