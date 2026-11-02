/**
 * Local text signals used before any model sees the text: chat laughter and clip requests (moment detection),
 * quoted instructions, bare leading pronouns and sarcasm markers (story validation). They cover the languages
 * with built-in catalogs plus language-neutral forms; anything they miss still goes through moderation and the
 * model's grounding review, so a miss only means a weaker local signal.
 */

/** Not preceded or followed by a letter or digit: a word boundary that also works outside ASCII. */
const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
const word = (alternatives: string) => new RegExp(`${B}(?:${alternatives})${E}`, 'iu');

const LAUGH_WORDS = word([
  'lol+', 'lo+l', 'lmf?ao+', 'rofl', 'kek(?:w)?', 'xd+', 'ptdr', 'mdr+',                    // en, gaming, fr
  '(?:h[ae]){2,}h?', 'a?(?:ha){2,}h?', 'he(?:he)+', 'bu?a(?:ha){2,}',                        // haha, ahaha, hehe
  '(?:ja){2,}j?', '(?:je){2,}j?', 'js(?:js)+',                                                // es
  'k{3,}', 'rs(?:rs)+', 'hue(?:hue)+',                                          // pt-BR
  'a?(?:ха){2,}х?', 'хе(?:хе)+', 'лол', 'кек',                                               // ru, uk
  '5{3,}',                                                                                     // th
].join('|'));
/** Scripts without spaces: repeated laughter characters count on their own. */
const LAUGH_MARKS = /(?:哈){2,}|(?:呵){2,}|(?:嘻){2,}|[ㅋㅎ]{2,}|(?<![A-Za-z])(?:ｗ|w){3,}(?![.A-Za-z])|[笑草]$|[😂🤣😆😹]|[хxаa]{4,}/iu;
export const isLaughter = (text: string): boolean => LAUGH_WORDS.test(text) || LAUGH_MARKS.test(text);

const CLIP_REQUEST = new RegExp([
  `${B}clip+(?:\\s+(?:it|that|this))${E}`, `${B}clip\\s+(?:das|ça|ca|eso|esto|isso|isto|quello|questo|to)${E}`, // en, de, fr, es, pt, it, pl
  `${B}(?:clipea(?:lo)?|clipéalo|haz\\s+(?:un\\s+)?clip|clipa(?:r)?(?:\\s+(?:isso|aí|ai))?|faz\\s+(?:um\\s+)?clip|clippa(?:lo)?|fai\\s+(?:una?\\s+)?clip|fais\\s+(?:un\\s+)?clip|clippe(?:z)?(?:\\s+(?:ça|ca))?|klipuj|zrób\\s+klipa?|klip(?:le|leyin)|klip\\s+at)${E}`,
  `сделай\\s+клип|клипани|зроби\\s+кліп|кліпни`,                                                // ru, uk
  `クリップ(?:して|しろ|頼む|お願い)|클립\\s*(?:해|따|각)|(?:快|赶紧)?(?:剪下来|切片|录下来|剪輯|剪辑)`,         // ja, ko, zh
].join('|'), 'iu');
export const asksForClip = (text: string): boolean => CLIP_REQUEST.test(text);

const INSTRUCTION = new RegExp([
  // Language-neutral: role markers and prompt plumbing.
  'system\\s*prompt', 'developer\\s+message', '<\\|?(?:system|im_start|im_end)\\|?>', '\\[/?INST\\]', '^\\s*#{0,3}\\s*(?:system|assistant|developer)\\s*:',
  'publish\\s+this', 'reveal\\s+.*secret',
  // "ignore (all/previous) instructions" in the catalog languages.
  'ignore\\s+(?:all\\s+|previous\\s+|prior\\s+|the\\s+|your\\s+)*instructions',
  'игнорируй\\s+.*инструкц', 'ігноруй\\s+.*інструкц',
  'ignora\\s+(?:todas\\s+)?las\\s+instrucciones', 'ignor[ae]\\s+(?:todas\\s+)?as\\s+instruções', 'ignoriere\\s+(?:alle\\s+)?(?:vorherigen\\s+)?anweisungen',
  'ignore[zr]?\\s+(?:toutes\\s+)?(?:les\\s+)?instructions', 'ignora\\s+(?:tutte\\s+)?le\\s+istruzioni', 'zignoruj\\s+(?:wszystkie\\s+)?(?:poprzednie\\s+)?instrukcje',
  'talimatları\\s+(?:yok\\s+say|görmezden\\s+gel)', '指示を無視', '지시(?:를|사항을)?\\s*무시', '(?:忽略|无视|無視)(?:之前|以上|所有)?(?:的)?(?:指令|指示)',
].join('|'), 'imu');
export const looksLikeInstruction = (text: string): boolean => INSTRUCTION.test(text);

/**
 * A claim that opens with a bare personal or demonstrative pronoun has no antecedent of its own. Checked in the
 * claim's own language (claims are written in the recap language), always with English and Russian as before.
 * Words that also open ordinary sentences (Spanish "es", Italian "il", German "es", Turkish "o") are left out,
 * and pro-drop scripts (Japanese, Korean, Chinese) are not checked locally.
 */
const PRONOUNS: Readonly<Record<string, string>> = {
  en: 'it|he|she|they|this|that', ru: 'он|она|оно|они|это', uk: 'він|вона|воно|вони|це', es: 'él|ella|ellos|ellas|eso|esto',
  pt: 'ele|ela|eles|elas|isso|isto', de: 'er|sie', fr: 'il|elle|ils|elles|cela|ça', it: 'lui|lei|loro|esso|essa|ciò',
  pl: 'on|ona|ono|oni|one', tr: 'onlar',
};
export function startsWithBarePronoun(text: string, language = 'en'): boolean {
  const primary = language.split('-')[0]!.toLowerCase();
  const list = [...new Set([PRONOUNS.en, PRONOUNS.ru, PRONOUNS[primary] ?? ''])].filter(Boolean).join('|');
  return new RegExp(`^(?:${list})\\s`, 'iu').test(text);
}

const SARCASM = new RegExp(`${B}(?:sarcasm|sarcasmo|sarkasmus|sarcasme|sarkazm|сарказм|ирония)${E}|(?:^|\\s)/s${E}|ага[,.]?\\s+конечно|ага[,.]?\\s+звісно|皮肉|비꼬|讽刺|諷刺|反讽`, 'iu');
export const marksSarcasm = (text: string): boolean => SARCASM.test(text);
