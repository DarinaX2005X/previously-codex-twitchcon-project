import type {OwnerSnapshot,PublicChapter} from '../../shared/contracts/index.js';

export function correctionTarget(snapshot:OwnerSnapshot|undefined,targetId?:string):PublicChapter|undefined {
  if(!snapshot)return undefined;
  const chapters=new Map<string,PublicChapter>();
  for(const chapter of [...snapshot.held,...snapshot.drafts,...snapshot.published?.chapters??[]]){
    if('summary' in chapter&&!chapters.has(chapter.id))chapters.set(chapter.id,chapter);
  }
  return targetId?chapters.get(targetId):chapters.size===1?[...chapters.values()][0]:undefined;
}
