import { describe, expect, it } from 'vitest';
import { canonicalLanguageTag, eagerPresentationLanguages, isRecapLanguage, nativeLanguageName, resolveLanguageInput, COMMON_RECAP_LANGUAGES } from '../../src/shared/languages.js';
import { LanguageSchema } from '../../src/shared/contracts/index.js';
import { catalogLanguage, countText, hasOwnCatalog, messagesFor, CATALOG_LANGUAGES } from '../../src/i18n/index.js';
import { composeReply } from '../../src/shared/chat-commands.js';
import { sceneScript } from '../../src/features/overlay/script.js';
import { labPlan } from '../../src/features/overlay/lab/plans.js';

describe('recap languages are BCP 47 tags', () => {
  it('canonicalizes input at the edges and accepts only canonical tags in contracts', () => {
    expect(canonicalLanguageTag('pt-br')).toBe('pt-BR');
    expect(canonicalLanguageTag(' zh_hant ')).toBe('zh-Hant');
    expect(canonicalLanguageTag('iw')).toBe('he');
    expect(canonicalLanguageTag('es-419')).toBe('es-419');
    for (const bad of ['', 'english', 'x-private', 'und', 'en-u-ca-gregory', '123']) expect(canonicalLanguageTag(bad)).toBeNull();
    expect(LanguageSchema.safeParse('pt-BR').success).toBe(true);
    expect(LanguageSchema.safeParse('pt-br').success).toBe(false);
    expect(isRecapLanguage('ja')).toBe(true);
    expect(COMMON_RECAP_LANGUAGES.every(isRecapLanguage)).toBe(true);
  });
  it('resolves the picker text by native name, English name or code', () => {
    expect(resolveLanguageInput('Español')).toBe('es');
    expect(resolveLanguageInput('spanish')).toBe('es');
    expect(resolveLanguageInput('日本語')).toBe('ja');
    expect(resolveLanguageInput('sw')).toBe('sw');
    expect(resolveLanguageInput('Klingonese')).toBeNull();
    expect(nativeLanguageName('de')).toBe('Deutsch');
  });
  it('presents new chapters in the chosen language and English only', () => {
    expect(eagerPresentationLanguages('en')).toEqual(['en']);
    expect(eagerPresentationLanguages('es')).toEqual(['es', 'en']);
  });
});

describe('fixed wording catalogs', () => {
  it('covers the major streaming languages and falls back to English for the rest', () => {
    for (const tag of ['en', 'ru', 'es', 'pt', 'de', 'fr', 'it', 'pl', 'tr', 'uk', 'ja', 'ko', 'zh', 'zh-Hant']) expect(CATALOG_LANGUAGES).toContain(tag);
    expect(catalogLanguage('pt-BR')).toBe('pt');
    expect(catalogLanguage('zh-TW')).toBe('zh-Hant');
    expect(catalogLanguage('zh-Hans-CN')).toBe('zh');
    expect(catalogLanguage('sw')).toBe('en');
    expect(hasOwnCatalog('sw')).toBe(false);
    expect(hasOwnCatalog('en-GB')).toBe(true);
    expect(messagesFor('sw')).toBe(messagesFor('en'));
  });
  it('uses each language’s own plural rules', () => {
    const ru = messagesFor('ru').scene.viewers;
    expect([1, 3, 5, 11, 21, 22].map(n => countText('ru', n, ru))).toEqual(['1 зритель', '3 зрителя', '5 зрителей', '11 зрителей', '21 зритель', '22 зрителя']);
    expect(countText('pl', 5, messagesFor('pl').scene.messages)).toBe('5 wiadomości');
    expect(countText('en', 1, messagesFor('en').scene.window)).toBe('in 1 second');
  });
  it('answers the chat bot fallback in the recap language', () => {
    expect(composeReply({ kind: 'previously' }, null, 'es')).toBe('El resumen confirmado aún se está preparando.');
    expect(composeReply({ kind: 'lore', term: 'brick' }, null, 'sw')).toBe('The origin of that joke is not confirmed yet.');
  });
  it('labels the raid scene from the catalog while the story text stays as written', () => {
    const plan = { ...labPlan('full'), language: 'es' };
    const script = sceneScript(plan, { channel: 'Foxlight Dev' });
    expect(script.titleLead).toBe('Anteriormente');
    expect(script.titleRest).toBe('en Foxlight Dev');
    expect(script.command).toMatchObject({ before: 'Escribe', after: 'en el chat' });
    expect(script.viewersLabel(1)).toBe('1 espectador');
    const russian = sceneScript({ ...labPlan('full'), language: 'ru' }, { channel: 'Foxlight Dev' });
    expect(russian.titleRest).toBe('на канале Foxlight Dev');
    expect(russian.countLine(5)).toEqual({ big: '5 сообщений', small: expect.stringMatching(/^за \d+ секунд/u) });
    const swahili = sceneScript({ ...labPlan('full'), language: 'sw' });
    expect(swahili.titleLead).toBe('Previously');
  });
  it('places the chat reaction at the plan’s measured burst inside the clip', () => {
    const plan = labPlan('full');
    const moment = plan.scene!.moment!, clip = plan.media.find(media => media.id === moment.mediaId)!;
    expect(sceneScript(plan).moment?.reactionMs).toBeNull();
    const timed = { ...plan, scene: { ...plan.scene!, moment: { ...moment, burstMs: clip.captureStartMs + clip.inMs + 3300 } } };
    expect(sceneScript(timed).moment?.reactionMs).toBe(3300);
    const outside = { ...plan, scene: { ...plan.scene!, moment: { ...moment, burstMs: clip.captureStartMs + clip.outMs + 1 } } };
    expect(sceneScript(outside).moment?.reactionMs).toBeNull();
  });
});
