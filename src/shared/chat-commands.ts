import type {PublicSnapshot,RecapLanguage} from './contracts/index.js';
export type ChatCommand={kind:'previously'}|{kind:'lore';term:string};
export function parseCommand(text:string):ChatCommand|null {
  const value=text.normalize('NFKC').trim().replace(/\s+/gu,' ');
  if(value==='!previously')return {kind:'previously'};
  const lore=/^!lore ([^\r\n]{1,120})$/u.exec(value);return lore?{kind:'lore',term:lore[1]}:null;
}
/** Replies with the published context itself; the public recap link is appended only when a public origin is configured. */
export function composeReply(command:ChatCommand,snapshot:PublicSnapshot|null,language:RecapLanguage,publicUrl?:string|null,blocked=false,maxLength=500):string {
  const url=publicUrl?new URL(publicUrl):null;if(url&&(url.protocol!=='https:'||url.username||url.password||url.hash))throw new Error('Chat needs canonical HTTPS public URL');
  let text:string;
  if(command.kind==='lore'){
    const match=!blocked&&snapshot?.lore.find(item=>item.term.normalize('NFKC').toLowerCase()===command.term.toLowerCase());
    text=match&&match.originKind!=='unknown'?`${match.term}: ${match.explanation}`:language==='ru'?'Происхождение этой шутки пока не подтверждено.':'The origin of that joke is not confirmed yet.';
  }else{
    const chapters=snapshot?.chapters.slice(-2)??[];
    text=chapters.length?chapters.map(chapter=>chapter.summary).join(' '):(language==='ru'?'Подтверждённый пересказ ещё готовится.':'A confirmed recap is still being prepared.');
    const now=snapshot?.current?.now?.trim();
    if(now&&!text.replace(/\s+/gu,' ').includes(now.replace(/\s+/gu,' ')))text+=` ${now}`;
  }
  text=text.replace(/\s+/gu,' ').trim();const budget=url?maxLength-[...url.href].length-1:maxLength;
  if(budget<20)throw new Error('Canonical URL is too long');
  if([...text].length>budget)text=[...text].slice(0,budget-1).join('').trimEnd()+'…';
  return url?`${text} ${url.href}`:text;
}
