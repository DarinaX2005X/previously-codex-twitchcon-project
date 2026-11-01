import type {RecapClient,OwnerSnapshot,UpdateEvent,Chapter,Moment,InvalidationReceipt,Settings,PrivacyTarget,PlaybackRef,RecapPlan,ReplayControl,Source} from '../shared/contracts/index.js';
import type {CaptureBundle} from './contracts.js';
export type ReplayView={snapshot:OwnerSnapshot;transport:{atMs:number;durationMs:number;playing:boolean;speed:1|2|4;error:string|null;correction:{title:string;summary:string};milestones:CaptureBundle['milestones']}};
export class ReplayClient implements RecapClient {
  private serial=0;private eventSerial=0;private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();private listeners=new Set<(event:UpdateEvent)=>void>();private views=new Set<(view:ReplayView)=>void>();view:ReplayView|null=null;
  constructor(private worker:Worker){worker.onmessage=e=>{const data=e.data;if(data.view){this.view=data.view;for(const listener of this.views)listener(data.view);for(const listener of this.listeners)listener({id:++this.eventSerial,event:'snapshot.changed',data:{sessionId:data.view.snapshot.session?.id??null,revision:data.view.snapshot.revision}});}if(data.id){const pending=this.pending.get(data.id);this.pending.delete(data.id);if(data.error)pending?.reject(Object.assign(new Error(data.error.message),data.error));else pending?.resolve(data.result);}};worker.onerror=()=>this.dispose();}
  private call<T>(method:string,...args:unknown[]):Promise<T>{const id=++this.serial;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve:resolve as (v:unknown)=>void,reject});this.worker.postMessage({id,method,args});});}
  async initialize(bundle:CaptureBundle){await this.call('init',bundle);return this;}
  observe(listener:(view:ReplayView)=>void){this.views.add(listener);if(this.view)listener(this.view);return()=>{this.views.delete(listener);};}
  subscribe(listener:(event:UpdateEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  getSnapshot(){return this.call<OwnerSnapshot>('getSnapshot');}
  editChapter(id:string,patch:{title:string;summary:string;baseRevision:number}){return this.call<Chapter>('editChapter',id,patch);}
  deleteChapter(id:string,revision:number){return this.call<InvalidationReceipt>('deleteChapter',id,revision);}
  pinChapter(id:string,pinned:boolean,revision:number){return this.call<Chapter>('pinChapter',id,pinned,revision);}
  saveMoment(input:{sessionId:string;label?:string}){return this.call<Moment>('saveMoment',input);}
  privacy(target:PrivacyTarget,reason:string){return this.call<InvalidationReceipt>('privacy',target,reason);}
  setSettings(patch:Partial<Settings>&{baseRevision:number}){return this.call<Settings>('setSettings',patch);}
  triggerRecap(sessionId:string){return this.call<PlaybackRef>('triggerRecap',sessionId);}
  previewRecap(sessionId:string){return this.call<RecapPlan|null>('previewRecap',sessionId);}
  cancelRecap(id:string){return this.call<void>('cancelRecap',id);}
  controlReplay(control:ReplayControl){return this.call<void>('controlReplay',control);}
  getEvidence(id:string){return this.call<Source[]>('getEvidence',id);}
  listSources(query:{sessionId:string;fromMs?:number;toMs?:number;cursor?:string;limit:number}){return this.call<{items:Source[];nextCursor:string|null}>('listSources',query);}
  dispose(){this.worker.terminate();this.view=null;for(const p of this.pending.values())p.reject(new Error('Recording closed'));this.pending.clear();this.views.clear();this.listeners.clear();}
}
