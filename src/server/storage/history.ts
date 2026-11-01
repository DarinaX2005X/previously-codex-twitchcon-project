import type {Scope,Source,VersionRef} from '../../shared/contracts/index.js';
import {IdSchema,safetyAllowsPublication} from '../../shared/contracts/index.js';
import {normalizeTerm} from '../../core/evidence.js';
import type {StoryCandidate} from '../../core/types.js';
import type {SqliteRepository} from './repository.js';
import {StorageDatabase,StorageError,integer} from './database.js';
import type {DomainEntity,EntityGraph,EntityHistoryCursor,EntityHistoryPage} from './domain-types.js';

const NODE_CAP=512,EDGE_CAP=4096,BYTE_CAP=1_000_000;
type Closure={entities:DomainEntity[];sources:Source[]};
type Row=ReturnType<StorageDatabase['all']>[number];
/** Targeted historical reads never hydrate a whole session or raw transcript text. */
export class HistoryPersistence {
  constructor(private readonly db:StorageDatabase,private readonly repository:SqliteRepository){
    db.raw.function('history_normalize',{deterministic:true},value=>typeof value==='string'?normalizeTerm(value):'');
  }
  private scope(scope:Scope){return [scope.channelId,scope.runId] as const;}
  private entity(row:Row,edges:Row[]):DomainEntity {
    const refs=(kind:string):VersionRef[]=>edges.filter(edge=>edge.kind===kind).map(edge=>({id:String(edge.parent_id),revision:Number(edge.parent_revision)}));
    return {id:String(row.id),revision:Number(row.revision),kind:String(row.kind) as DomainEntity['kind'],supports:refs('supports'),exposedTo:refs('exposed_to'),startMs:Number(row.start_ms??0),endMs:Number(row.end_ms??0),active:row.status==='active',body:row.body===null?null:JSON.parse(String(row.body)),ownerRevision:Number(row.owner_revision),ownerLocked:Boolean(row.owner_locked),pinned:Boolean(row.pinned)};
  }
  private closure(scope:Scope,roots:string[]):Closure|null {
    const ids=this.db.all(`WITH RECURSIVE ancestry(id) AS (
      SELECT value FROM json_each(?) UNION
      SELECT d.parent_id FROM dependencies d JOIN ancestry a ON a.id=d.child_id WHERE d.channel_id=? AND d.run_id=? LIMIT ?
    ) SELECT id FROM ancestry`,JSON.stringify(roots),...this.scope(scope),NODE_CAP+1).map(row=>String(row.id));
    if(ids.length>NODE_CAP)throw new StorageError('capacity','Historical dependency graph exceeds its limit.');
    const list=JSON.stringify(ids);
    const rows=this.db.all('SELECT * FROM entities WHERE channel_id=? AND run_id=? AND id IN (SELECT value FROM json_each(?))',...this.scope(scope),list);
    // Deliberately omit sources.text from SQL, including for rejected roots.
    const sourceRows=this.db.all('SELECT id,revision,status,metadata FROM sources WHERE channel_id=? AND run_id=? AND id IN (SELECT value FROM json_each(?))',...this.scope(scope),list);
    const edges=this.db.all('SELECT child_id,parent_id,parent_revision,kind FROM dependencies WHERE channel_id=? AND run_id=? AND child_id IN (SELECT value FROM json_each(?)) LIMIT ?',...this.scope(scope),list,EDGE_CAP+1);
    if(edges.length>EDGE_CAP)throw new StorageError('capacity','Historical dependency graph exceeds its limit.');
    const sources=sourceRows.map(row=>({...JSON.parse(String(row.metadata)),id:String(row.id),revision:Number(row.revision),status:String(row.status),text:null}) as Source);
    for(const source of sources)if(source.status!=='active'||this.repository.sourcePolicy(scope,source)!=='active')return null;
    const entities=rows.map(row=>this.entity(row,edges.filter(edge=>edge.child_id===row.id)));
    for(let i=0;i<entities.length;i++){
      const node=entities[i]!,row=rows[i]!;
      if(!node.active||node.body===null)return null;
      if(this.db.get("SELECT 1 FROM source_tombstones WHERE channel_id=? AND run_id=? AND session_id=? AND (kind='session' OR (kind='entity' AND target_id=?)) LIMIT 1",...this.scope(scope),String(row.session_id),node.id))return null;
      if(node.kind==='lore'||node.kind==='presentation'&&(node.body as {kind?:string}).kind==='lore'){
        const lore=node.body as {term?:unknown;aliases?:unknown};
        const terms=[lore.term,...Array.isArray(lore.aliases)?lore.aliases:[]].filter((term):term is string=>typeof term==='string');
        if(terms.some(term=>this.repository.isTermBlocked(scope,String(row.session_id),term)))return null;
      }
    }
    const revisions=new Map([...entities,...sources].map(value=>[value.id,value.revision]));
    if(ids.some(id=>!revisions.has(id))||edges.some(edge=>revisions.get(String(edge.parent_id))!==Number(edge.parent_revision)))return null;
    const parents=new Map(entities.map(node=>[node.id,[...node.supports,...node.exposedTo].map(ref=>ref.id)]));
    const complete=new Set<string>(),visiting=new Set<string>();
    const acyclic=(id:string,depth:number):boolean=>{if(depth>128)throw new StorageError('capacity','Historical dependency depth exceeds its limit.');if(visiting.has(id))return false;if(complete.has(id))return true;visiting.add(id);for(const parent of parents.get(id)??[])if(!acyclic(parent,depth+1))return false;visiting.delete(id);complete.add(id);return true;};
    if(roots.some(id=>!acyclic(id,0)))return null;
    const result={entities,sources};this.bound(result);return result;
  }
  private bound(value:Closure){if(value.entities.length+value.sources.length>NODE_CAP||value.entities.reduce((count,node)=>count+node.supports.length+node.exposedTo.length,0)>EDGE_CAP||Buffer.byteLength(JSON.stringify(value))>BYTE_CAP)throw new StorageError('capacity','Historical dependency graph exceeds its limit.');}
  graph(scope:Scope,sessionId:string,id:string):EntityGraph|null {
    IdSchema.parse(id);const session=this.repository.getSession(scope,sessionId);
    const row=this.db.get('SELECT * FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND id=?',...this.scope(scope),sessionId,id);
    if(!row||!['chapter','lore'].includes(String(row.kind)))return null;
    const closure=this.closure(scope,[id]);if(!closure)return null;
    const root=closure.entities.find(node=>node.id===id)!;
    const entityMap=new Map(closure.entities.map(node=>[node.id,node])),sourceMap=new Map(closure.sources.map(source=>[source.id,source]));
    const candidates:StoryCandidate[]=[];
    const merge=(next:Closure)=>{for(const node of next.entities)entityMap.set(node.id,node);for(const source of next.sources)sourceMap.set(source.id,source);this.bound({entities:[...entityMap.values()],sources:[...sourceMap.values()]});};
    const candidateRows:Row[]=[];
    if(root.kind==='chapter'){
      for(const language of ['en','ru'])candidateRows.push(...this.db.all("SELECT body,status FROM publication_candidates WHERE channel_id=? AND run_id=? AND session_id=? AND entity_id=? AND owner_revision=? AND status='published' AND body IS NOT NULL AND json_extract(body,'$.language')=? ORDER BY revision DESC,eligible_at_ms DESC,id DESC LIMIT 1",...this.scope(scope),sessionId,id,root.ownerRevision,language));
      const pending=this.db.all("SELECT body,status FROM publication_candidates WHERE channel_id=? AND run_id=? AND session_id=? AND entity_id=? AND owner_revision=? AND privacy_epoch=? AND status='pending' AND body IS NOT NULL ORDER BY revision DESC,id LIMIT 5",...this.scope(scope),sessionId,id,root.ownerRevision,session.privacyEpoch);
      if(pending.length>4)throw new StorageError('capacity','Historical candidate queue exceeds its limit.');candidateRows.push(...pending);
    }
    for(const candidateRow of candidateRows){
      const candidate=JSON.parse(String(candidateRow.body)) as StoryCandidate;
      if(!candidate.id||candidate.entityId!==id||candidate.chapter?.id!==id||candidate.chapter.sessionId!==sessionId||candidate.chapter.revision!==candidate.revision||candidate.revision>root.revision||candidate.ownerRevision!==root.ownerRevision||!Array.isArray(candidate.inputRefs)||!['en','ru'].includes(candidate.language))continue;
      if(candidateRow.status==='pending'&&candidate.privacyEpoch!==session.privacyEpoch)continue;
      const roots=[candidate.id,...candidate.currentNodeId?[candidate.currentNodeId]:[],...candidate.inputRefs.map(ref=>ref.id)];
      const next=this.closure(scope,roots);if(!next)continue;
      const versions=new Map([...next.entities,...next.sources].map(node=>[node.id,node.revision]));
      if(candidate.inputRefs.some(ref=>versions.get(ref.id)!==ref.revision))continue;
      merge(next);candidates.push({...candidate,status:String(candidateRow.status) as StoryCandidate['status']});
    }
    if(root.kind==='lore'){
      const presentations=this.db.all("SELECT DISTINCT e.id FROM dependencies d JOIN entities e ON e.channel_id=d.channel_id AND e.run_id=d.run_id AND e.id=d.child_id WHERE d.channel_id=? AND d.run_id=? AND d.parent_id=? AND d.parent_revision=? AND e.session_id=? AND e.kind='presentation' AND e.status='active' AND json_extract(e.body,'$.kind')='lore' AND json_extract(e.body,'$.entityId')=? AND json_extract(e.body,'$.entityRevision')=? LIMIT 9",...this.scope(scope),id,root.revision,sessionId,id,root.revision);
      if(presentations.length>8)throw new StorageError('capacity','Historical presentations exceed their limit.');
      for(const presentation of presentations){const next=this.closure(scope,[String(presentation.id)]);if(next)merge(next);}
    }
    const result={root,entities:[...entityMap.values()],sources:[...sourceMap.values()],candidates};
    if(Buffer.byteLength(JSON.stringify(result))>BYTE_CAP)throw new StorageError('capacity','Historical dependency graph exceeds its limit.');
    return result;
  }
  page(scope:Scope,sessionId:string,options:{kind:'chapter'|'lore';limit?:number;cursor?:EntityHistoryCursor}):EntityHistoryPage {
    this.repository.getSession(scope,sessionId);if(!['chapter','lore'].includes(options.kind))throw new StorageError('invalid_input','Invalid history kind.');
    const limit=Math.min(integer(options.limit??20,1),50),cursor=options.cursor;
    if(cursor){integer(cursor.startMs);IdSchema.parse(cursor.id);}
    const rows=this.db.all(`SELECT id,COALESCE(start_ms,0) AS start_ms FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND kind=? AND status='active' ${cursor?'AND (COALESCE(start_ms,0)<? OR (COALESCE(start_ms,0)=? AND id<?))':''} ORDER BY COALESCE(start_ms,0) DESC,id DESC LIMIT ?`,...this.scope(scope),sessionId,options.kind,...cursor?[cursor.startMs,cursor.startMs,cursor.id]:[],limit);
    const items:DomainEntity[]=[];
    for(const row of rows){const graph=this.graph(scope,sessionId,String(row.id));if(graph)items.push(graph.root);}
    const last=rows.at(-1);return {items,nextCursor:rows.length===limit&&last?{startMs:Number(last.start_ms),id:String(last.id)}:null};
  }
  generation(scope:Scope,sessionId:string,options:{text:string;limit?:number}):string[] {
    this.repository.getSession(scope,sessionId);
    if(typeof options.text!=='string'||options.text.length>12000)throw new StorageError('invalid_input','History retrieval text exceeds its limit.');
    const limit=Math.min(integer(options.limit??8,1),8),text=normalizeTerm(options.text),ids:string[]=[];
    const exact=(term:unknown)=>{
      if(typeof term!=='string'||!term.trim()||term.length>120)return false;
      const escaped=normalizeTerm(term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'u').test(text);
    };
    // SQL returns a bounded candidate window; exact Unicode boundaries and graph validity are checked below.
    const loreRows=text?this.db.all(`SELECT id FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND kind='lore' AND status='active' AND (
      (length(history_normalize(json_extract(body,'$.term')))>0 AND instr(?,history_normalize(json_extract(body,'$.term')))>0)
      OR EXISTS(SELECT 1 FROM json_each(json_extract(entities.body,'$.aliases')) alias WHERE length(history_normalize(alias.value))>0 AND instr(?,history_normalize(alias.value))>0)
    ) ORDER BY COALESCE(start_ms,0) DESC,id DESC LIMIT 32`,...this.scope(scope),sessionId,text,text):[];
    let loreCount=0;
    for(const row of loreRows){
      if(loreCount>=4||ids.length>=limit)break;
      const graph=this.graph(scope,sessionId,String(row.id));if(!graph)continue;
      const lore=graph.root.body as {term?:unknown;aliases?:unknown;status?:string;originKind?:string;safety?:Parameters<typeof safetyAllowsPublication>[0]};
      if(!['confirmed','published'].includes(lore.status??'')||!['spoken','owner_confirmed'].includes(lore.originKind??'')||!lore.safety||!safetyAllowsPublication(lore.safety))continue;
      if(![lore.term,...Array.isArray(lore.aliases)?lore.aliases:[]].some(exact))continue;
      ids.push(graph.root.id);loreCount++;
    }
    if(ids.length<limit){
      const pinned=this.db.all("SELECT id FROM entities WHERE channel_id=? AND run_id=? AND session_id=? AND kind='chapter' AND status='active' AND pinned=1 ORDER BY COALESCE(start_ms,0) DESC,id DESC LIMIT 32",...this.scope(scope),sessionId);
      let pinnedCount=0;
      for(const row of pinned){if(pinnedCount>=4||ids.length>=limit)break;const graph=this.graph(scope,sessionId,String(row.id));if(!graph||!graph.candidates.some(candidate=>candidate.status==='published'&&candidate.safety&&safetyAllowsPublication(candidate.safety)))continue;ids.push(graph.root.id);pinnedCount++;}
    }
    return ids;
  }
}
