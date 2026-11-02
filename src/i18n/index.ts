/**
 * Fixed product wording shown to viewers in the recap language: raid scene labels, chat bot fallbacks and the
 * domain's fallback sentences. Story text (titles, summaries, lore) is written by the model in the chosen language
 * and never comes from here. Owner-facing interface controls remain English.
 *
 * A recap language without its own catalog uses the English labels while its story text stays in that language.
 */
import type { RecapLanguage } from '../shared/languages.js';

/** Plural forms keyed by `Intl.PluralRules` category; `{n}` is replaced by the number. */
export type PluralForms = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };

export interface ProductMessages {
  scene: {
    welcomeRaid: string; welcomeIn: string;
    raidOne: string; raidTwo: string; raidMore: PluralForms;
    viewers: PluralForms;
    titleLead: string; titleRest: string;
    now: string; commandBefore: string; commandAfter: string;
    messages: PluralForms; window: PluralForms;
    summaryLabel: string;
    beat: { attempt: string; change: string; origin: string; now: string; context: string };
  };
  bot: { loreUnconfirmed: string; recapPreparing: string; raidWelcome: string };
  story: { contextUnavailable: string; originUnconfirmed: string };
}

const en: ProductMessages = {
  scene: {
    welcomeRaid: 'Welcome,', welcomeIn: 'Welcome in',
    raidOne: '{first} raiders', raidTwo: '{first} and {second} raiders', raidMore: { other: '{first} and {n} more raids' },
    viewers: { one: '{n} viewer', other: '{n} viewers' },
    titleLead: 'Previously', titleRest: 'on {channel}',
    now: 'Right now', commandBefore: 'Type', commandAfter: 'in chat',
    messages: { one: '{n} message', other: '{n} messages' }, window: { one: 'in {n} second', other: 'in {n} seconds' },
    summaryLabel: 'Stream recap',
    beat: { attempt: 'The goal', change: 'What changed', origin: 'Where it started', now: 'What matters now', context: 'Stream context' },
  },
  bot: { loreUnconfirmed: 'The origin of that joke is not confirmed yet.', recapPreparing: 'A confirmed recap is still being prepared.', raidWelcome: 'Welcome, raiders!' },
  story: { contextUnavailable: 'Reviewed stream context is not available yet.', originUnconfirmed: 'Its origin is not confirmed.' },
};

const ru: ProductMessages = {
  scene: {
    welcomeRaid: 'Добро пожаловать,', welcomeIn: 'Добро пожаловать',
    raidOne: 'рейдеры {first}', raidTwo: 'рейдеры {first} и {second}', raidMore: { other: 'рейдеры {first} и ещё {n}' },
    viewers: { one: '{n} зритель', few: '{n} зрителя', many: '{n} зрителей', other: '{n} зрителя' },
    titleLead: 'Ранее', titleRest: 'на канале {channel}',
    now: 'Сейчас', commandBefore: 'Напишите', commandAfter: 'в чат',
    messages: { one: '{n} сообщение', few: '{n} сообщения', many: '{n} сообщений', other: '{n} сообщения' },
    window: { one: 'за {n} секунду', few: 'за {n} секунды', many: 'за {n} секунд', other: 'за {n} секунды' },
    summaryLabel: 'Кратко об эфире',
    beat: { attempt: 'Цель', change: 'Что изменилось', origin: 'Источник', now: 'Сейчас', context: 'Контекст эфира' },
  },
  bot: { loreUnconfirmed: 'Происхождение этой шутки пока не подтверждено.', recapPreparing: 'Подтверждённый пересказ ещё готовится.', raidWelcome: 'Добро пожаловать!' },
  story: { contextUnavailable: 'Проверенный контекст эфира пока недоступен.', originUnconfirmed: 'Происхождение не подтверждено.' },
};

const uk: ProductMessages = {
  scene: {
    welcomeRaid: 'Ласкаво просимо,', welcomeIn: 'Ласкаво просимо',
    raidOne: 'рейдери {first}', raidTwo: 'рейдери {first} і {second}', raidMore: { other: 'рейдери {first} і ще {n}' },
    viewers: { one: '{n} глядач', few: '{n} глядачі', many: '{n} глядачів', other: '{n} глядача' },
    titleLead: 'Раніше', titleRest: 'на каналі {channel}',
    now: 'Зараз', commandBefore: 'Напишіть', commandAfter: 'у чат',
    messages: { one: '{n} повідомлення', few: '{n} повідомлення', many: '{n} повідомлень', other: '{n} повідомлення' },
    window: { one: 'за {n} секунду', few: 'за {n} секунди', many: 'за {n} секунд', other: 'за {n} секунди' },
    summaryLabel: 'Коротко про ефір',
    beat: { attempt: 'Мета', change: 'Що змінилося', origin: 'Звідки почалося', now: 'Зараз', context: 'Контекст ефіру' },
  },
  bot: { loreUnconfirmed: 'Походження цього жарту ще не підтверджено.', recapPreparing: 'Підтверджений переказ ще готується.', raidWelcome: 'Ласкаво просимо, рейдери!' },
  story: { contextUnavailable: 'Перевірений контекст ефіру поки недоступний.', originUnconfirmed: 'Походження не підтверджено.' },
};

const es: ProductMessages = {
  scene: {
    welcomeRaid: 'Bienvenidos,', welcomeIn: 'Bienvenidos',
    raidOne: 'raiders de {first}', raidTwo: 'raiders de {first} y {second}', raidMore: { other: 'raiders de {first} y {n} más' },
    viewers: { one: '{n} espectador', other: '{n} espectadores' },
    titleLead: 'Anteriormente', titleRest: 'en {channel}',
    now: 'Ahora mismo', commandBefore: 'Escribe', commandAfter: 'en el chat',
    messages: { one: '{n} mensaje', other: '{n} mensajes' }, window: { one: 'en {n} segundo', other: 'en {n} segundos' },
    summaryLabel: 'Resumen del directo',
    beat: { attempt: 'El objetivo', change: 'Qué cambió', origin: 'Dónde empezó', now: 'Lo que importa ahora', context: 'Contexto del directo' },
  },
  bot: { loreUnconfirmed: 'El origen de esa broma aún no está confirmado.', recapPreparing: 'El resumen confirmado aún se está preparando.', raidWelcome: '¡Bienvenidos, raiders!' },
  story: { contextUnavailable: 'El contexto revisado del directo aún no está disponible.', originUnconfirmed: 'Su origen no está confirmado.' },
};

const pt: ProductMessages = {
  scene: {
    welcomeRaid: 'Bem-vindos,', welcomeIn: 'Bem-vindos',
    raidOne: 'raiders de {first}', raidTwo: 'raiders de {first} e {second}', raidMore: { other: 'raiders de {first} e mais {n}' },
    viewers: { one: '{n} espectador', other: '{n} espectadores' },
    titleLead: 'Anteriormente', titleRest: 'em {channel}',
    now: 'Agora', commandBefore: 'Digite', commandAfter: 'no chat',
    messages: { one: '{n} mensagem', other: '{n} mensagens' }, window: { one: 'em {n} segundo', other: 'em {n} segundos' },
    summaryLabel: 'Resumo da live',
    beat: { attempt: 'O objetivo', change: 'O que mudou', origin: 'Onde começou', now: 'O que importa agora', context: 'Contexto da live' },
  },
  bot: { loreUnconfirmed: 'A origem dessa piada ainda não foi confirmada.', recapPreparing: 'O resumo confirmado ainda está sendo preparado.', raidWelcome: 'Bem-vindos, raiders!' },
  story: { contextUnavailable: 'O contexto revisado da live ainda não está disponível.', originUnconfirmed: 'A origem não foi confirmada.' },
};

const de: ProductMessages = {
  scene: {
    welcomeRaid: 'Willkommen,', welcomeIn: 'Willkommen',
    raidOne: 'Raider von {first}', raidTwo: 'Raider von {first} und {second}', raidMore: { other: 'Raider von {first} und {n} weiteren' },
    viewers: { other: '{n} Zuschauer' },
    titleLead: 'Bisher', titleRest: 'bei {channel}',
    now: 'Gerade jetzt', commandBefore: 'Schreib', commandAfter: 'in den Chat',
    messages: { one: '{n} Nachricht', other: '{n} Nachrichten' }, window: { one: 'in {n} Sekunde', other: 'in {n} Sekunden' },
    summaryLabel: 'Stream-Rückblick',
    beat: { attempt: 'Das Ziel', change: 'Was sich geändert hat', origin: 'Wo es anfing', now: 'Was jetzt zählt', context: 'Stream-Kontext' },
  },
  bot: { loreUnconfirmed: 'Woher dieser Witz kommt, ist noch nicht bestätigt.', recapPreparing: 'Ein bestätigter Rückblick wird noch vorbereitet.', raidWelcome: 'Willkommen, Raider!' },
  story: { contextUnavailable: 'Geprüfter Stream-Kontext ist noch nicht verfügbar.', originUnconfirmed: 'Die Herkunft ist nicht bestätigt.' },
};

const fr: ProductMessages = {
  scene: {
    welcomeRaid: 'Bienvenue,', welcomeIn: 'Bienvenue',
    raidOne: 'les raiders de {first}', raidTwo: 'les raiders de {first} et {second}', raidMore: { other: 'les raiders de {first} et {n} autres' },
    viewers: { one: '{n} spectateur', other: '{n} spectateurs' },
    titleLead: 'Précédemment', titleRest: 'sur {channel}',
    now: 'En ce moment', commandBefore: 'Tapez', commandAfter: 'dans le chat',
    messages: { one: '{n} message', other: '{n} messages' }, window: { one: 'en {n} seconde', other: 'en {n} secondes' },
    summaryLabel: 'Résumé du live',
    beat: { attempt: 'Le but', change: 'Ce qui a changé', origin: 'D’où ça vient', now: 'Ce qui compte maintenant', context: 'Contexte du live' },
  },
  bot: { loreUnconfirmed: 'L’origine de cette blague n’est pas encore confirmée.', recapPreparing: 'Un résumé confirmé est encore en préparation.', raidWelcome: 'Bienvenue, les raiders !' },
  story: { contextUnavailable: 'Le contexte vérifié du live n’est pas encore disponible.', originUnconfirmed: 'Son origine n’est pas confirmée.' },
};

const it: ProductMessages = {
  scene: {
    welcomeRaid: 'Benvenuti,', welcomeIn: 'Benvenuti',
    raidOne: 'i raider di {first}', raidTwo: 'i raider di {first} e {second}', raidMore: { other: 'i raider di {first} e altri {n}' },
    viewers: { one: '{n} spettatore', other: '{n} spettatori' },
    titleLead: 'In precedenza', titleRest: 'su {channel}',
    now: 'Adesso', commandBefore: 'Scrivi', commandAfter: 'in chat',
    messages: { one: '{n} messaggio', other: '{n} messaggi' }, window: { one: 'in {n} secondo', other: 'in {n} secondi' },
    summaryLabel: 'Riepilogo della live',
    beat: { attempt: 'L’obiettivo', change: 'Cosa è cambiato', origin: 'Da dove è nato', now: 'Cosa conta adesso', context: 'Contesto della live' },
  },
  bot: { loreUnconfirmed: 'L’origine di questa battuta non è ancora confermata.', recapPreparing: 'Il riepilogo confermato è ancora in preparazione.', raidWelcome: 'Benvenuti, raider!' },
  story: { contextUnavailable: 'Il contesto verificato della live non è ancora disponibile.', originUnconfirmed: 'L’origine non è confermata.' },
};

const pl: ProductMessages = {
  scene: {
    welcomeRaid: 'Witajcie,', welcomeIn: 'Witajcie',
    raidOne: 'raid od {first}', raidTwo: 'raidy od {first} i {second}', raidMore: { other: 'raidy od {first} i jeszcze {n}' },
    viewers: { one: '{n} widz', few: '{n} widzów', many: '{n} widzów', other: '{n} widza' },
    titleLead: 'Wcześniej', titleRest: 'na kanale {channel}',
    now: 'Teraz', commandBefore: 'Wpisz', commandAfter: 'na czacie',
    messages: { one: '{n} wiadomość', few: '{n} wiadomości', many: '{n} wiadomości', other: '{n} wiadomości' },
    window: { one: 'w {n} sekundę', few: 'w {n} sekundy', many: 'w {n} sekund', other: 'w {n} sekundy' },
    summaryLabel: 'Podsumowanie streamu',
    beat: { attempt: 'Cel', change: 'Co się zmieniło', origin: 'Skąd to się wzięło', now: 'Teraz', context: 'Kontekst streamu' },
  },
  bot: { loreUnconfirmed: 'Pochodzenie tego żartu nie jest jeszcze potwierdzone.', recapPreparing: 'Potwierdzone podsumowanie jest jeszcze przygotowywane.', raidWelcome: 'Witajcie, raiderzy!' },
  story: { contextUnavailable: 'Sprawdzony kontekst streamu nie jest jeszcze dostępny.', originUnconfirmed: 'Pochodzenie nie jest potwierdzone.' },
};

const tr: ProductMessages = {
  scene: {
    welcomeRaid: 'Hoş geldiniz,', welcomeIn: 'Hoş geldiniz',
    raidOne: '{first} raid ekibi', raidTwo: '{first} ve {second} raid ekipleri', raidMore: { other: '{first} ve {n} raid daha' },
    viewers: { other: '{n} izleyici' },
    titleLead: 'Daha önce', titleRest: '{channel} kanalında',
    now: 'Şu anda', commandBefore: 'Sohbete', commandAfter: 'yazın',
    messages: { other: '{n} mesaj' }, window: { other: '{n} saniyede' },
    summaryLabel: 'Yayın özeti',
    beat: { attempt: 'Hedef', change: 'Ne değişti', origin: 'Nereden çıktı', now: 'Şu an önemli olan', context: 'Yayın bağlamı' },
  },
  bot: { loreUnconfirmed: 'Bu şakanın kökeni henüz doğrulanmadı.', recapPreparing: 'Doğrulanmış özet hâlâ hazırlanıyor.', raidWelcome: 'Hoş geldiniz, raiderlar!' },
  story: { contextUnavailable: 'İncelenmiş yayın bağlamı henüz hazır değil.', originUnconfirmed: 'Kökeni doğrulanmadı.' },
};

const ja: ProductMessages = {
  scene: {
    welcomeRaid: 'ようこそ、', welcomeIn: 'ようこそ',
    raidOne: '{first}からのレイド', raidTwo: '{first}と{second}からのレイド', raidMore: { other: '{first}ほか{n}件のレイド' },
    viewers: { other: '視聴者{n}人' },
    titleLead: 'これまでの配信', titleRest: '{channel}',
    now: 'いま', commandBefore: 'チャットに', commandAfter: 'と入力',
    messages: { other: '{n}件のメッセージ' }, window: { other: '{n}秒間で' },
    summaryLabel: '配信のあらすじ',
    beat: { attempt: '目標', change: '変わったこと', origin: 'はじまり', now: 'いま大事なこと', context: '配信の背景' },
  },
  bot: { loreUnconfirmed: 'このネタの由来はまだ確認されていません。', recapPreparing: '確認済みのあらすじを準備中です。', raidWelcome: 'レイドの皆さん、ようこそ！' },
  story: { contextUnavailable: '確認済みの配信の背景はまだありません。', originUnconfirmed: '由来は確認されていません。' },
};

const ko: ProductMessages = {
  scene: {
    welcomeRaid: '환영합니다,', welcomeIn: '환영합니다',
    raidOne: '{first} 레이드', raidTwo: '{first}, {second} 레이드', raidMore: { other: '{first} 외 {n}개 레이드' },
    viewers: { other: '시청자 {n}명' },
    titleLead: '지난 이야기', titleRest: '{channel}',
    now: '지금', commandBefore: '채팅에', commandAfter: '입력',
    messages: { other: '메시지 {n}개' }, window: { other: '{n}초 동안' },
    summaryLabel: '방송 요약',
    beat: { attempt: '목표', change: '달라진 점', origin: '시작된 곳', now: '지금 중요한 것', context: '방송 맥락' },
  },
  bot: { loreUnconfirmed: '이 밈의 유래는 아직 확인되지 않았습니다.', recapPreparing: '확인된 요약을 아직 준비 중입니다.', raidWelcome: '레이드 여러분, 환영합니다!' },
  story: { contextUnavailable: '검토된 방송 맥락이 아직 없습니다.', originUnconfirmed: '유래가 확인되지 않았습니다.' },
};

const zh: ProductMessages = {
  scene: {
    welcomeRaid: '欢迎，', welcomeIn: '欢迎',
    raidOne: '来自 {first} 的突袭', raidTwo: '来自 {first} 和 {second} 的突袭', raidMore: { other: '来自 {first} 及另外 {n} 个频道的突袭' },
    viewers: { other: '{n} 位观众' },
    titleLead: '前情提要', titleRest: '{channel}',
    now: '现在', commandBefore: '在聊天中输入', commandAfter: '即可查看',
    messages: { other: '{n} 条消息' }, window: { other: '{n} 秒内' },
    summaryLabel: '直播回顾',
    beat: { attempt: '目标', change: '有什么变化', origin: '起源', now: '现在的重点', context: '直播背景' },
  },
  bot: { loreUnconfirmed: '这个梗的出处还没有确认。', recapPreparing: '确认过的回顾还在准备中。', raidWelcome: '欢迎各位突袭的朋友！' },
  story: { contextUnavailable: '经过审核的直播背景暂不可用。', originUnconfirmed: '出处尚未确认。' },
};

const zhHant: ProductMessages = {
  scene: {
    welcomeRaid: '歡迎，', welcomeIn: '歡迎',
    raidOne: '來自 {first} 的揪團', raidTwo: '來自 {first} 和 {second} 的揪團', raidMore: { other: '來自 {first} 及另外 {n} 個頻道的揪團' },
    viewers: { other: '{n} 位觀眾' },
    titleLead: '前情提要', titleRest: '{channel}',
    now: '現在', commandBefore: '在聊天室輸入', commandAfter: '即可查看',
    messages: { other: '{n} 則訊息' }, window: { other: '{n} 秒內' },
    summaryLabel: '直播回顧',
    beat: { attempt: '目標', change: '有什麼變化', origin: '起源', now: '現在的重點', context: '直播背景' },
  },
  bot: { loreUnconfirmed: '這個梗的出處還沒有確認。', recapPreparing: '確認過的回顧還在準備中。', raidWelcome: '歡迎揪團的朋友們！' },
  story: { contextUnavailable: '經過審核的直播背景暫時無法提供。', originUnconfirmed: '出處尚未確認。' },
};

const catalogs: Readonly<Record<string, ProductMessages>> = { en, ru, uk, es, pt, de, fr, it, pl, tr, ja, ko, zh, 'zh-Hant': zhHant };

/** Catalog keys that have their own wording; every other recap language uses `en` for fixed labels. */
export const CATALOG_LANGUAGES: readonly string[] = Object.keys(catalogs);

/** The catalog serving `language`: exact tag, then Traditional Chinese by script/region, then the primary subtag, else English. */
export function catalogLanguage(language: RecapLanguage): string {
  if (catalogs[language]) return language;
  const [primary = '', ...rest] = language.split('-');
  if (primary === 'zh') return rest.some(part => ['Hant', 'TW', 'HK', 'MO'].includes(part)) ? 'zh-Hant' : 'zh';
  return catalogs[primary] ? primary : 'en';
}

/** True when fixed labels appear in `language` itself rather than in English. */
export const hasOwnCatalog = (language: RecapLanguage) => catalogLanguage(language) !== 'en' || language.split('-')[0] === 'en';

export const messagesFor = (language: RecapLanguage): ProductMessages => catalogs[catalogLanguage(language)]!;

/** Replaces `{name}` placeholders. */
export const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/gu, (whole, key: string) => key in values ? String(values[key]) : whole);

/** Picks the plural form for `n` with the catalog language's own plural rules. */
export function countText(language: RecapLanguage, n: number, forms: PluralForms, values: Record<string, string | number> = {}): string {
  let category: Intl.LDMLPluralRule = 'other';
  try { category = new Intl.PluralRules(catalogLanguage(language)).select(n); } catch { /* 'other' */ }
  return fill(forms[category] ?? forms.other, { ...values, n });
}

/** Recap page chrome used by the UI foundation showcase. */
export interface RecapMessages { whatMattersNow: string; chapters: string; watchLive: string; watchRecording: string; streamEnded: string; recapPaused: string; sources: string; clipUnavailable: string; originUnconfirmed: string; lastUpdated: string; }
export const recapMessages: Readonly<Record<'en' | 'ru', RecapMessages>> = {
  en: { whatMattersNow: 'What matters now', chapters: 'Chapters', watchLive: 'Watch live', watchRecording: 'Watch the recording', streamEnded: 'This stream has ended', recapPaused: 'Recap paused', sources: 'See the sources', clipUnavailable: 'Clip unavailable', originUnconfirmed: 'No confirmed origin yet', lastUpdated: 'Last updated' },
  ru: { whatMattersNow: 'Что происходит сейчас', chapters: 'Главы', watchLive: 'Смотреть эфир', watchRecording: 'Смотреть запись', streamEnded: 'Этот эфир завершён', recapPaused: 'Обновление приостановлено', sources: 'Посмотреть источники', clipUnavailable: 'Клип недоступен', originUnconfirmed: 'Происхождение пока не подтверждено', lastUpdated: 'Последнее обновление' },
};
export const recapMessagesFor = (language: RecapLanguage): RecapMessages => language === 'ru' ? recapMessages.ru : recapMessages.en;
export type { RecapLanguage };
