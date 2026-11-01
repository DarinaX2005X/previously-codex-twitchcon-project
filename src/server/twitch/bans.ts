import type {ControlStore} from '../auth/control.js';
import type {TwitchHelix,BannedUser} from './helix.js';
type BanRecord={actorId:string;blocked:boolean;expiresAtMs:number|null;sequence:number;snapshot:string|null;verifiedAtMs:number};
type Snapshot={id:string;fence:number;ready:boolean};
export interface BanSyncOptions {
  control:ControlStore;helix:Pick<TwitchHelix,'bannedUsers'>;now?:()=>number;
  /** Invalidates old sources, never reverses tombstones. Snapshot cutoff is receipt time. */
  onBlocked:(actorId:string,throughAt:string,reason:'ban'|'snapshot')=>void|Promise<void>;
  onReadiness?:(ready:boolean)=>void;
}
/** Durable actor state. The index is paged; neither the full ban list nor live messages accumulate in RAM. */
export class TwitchBanSync {
  private readonly now:()=>number;private checks=new Map<string,Promise<boolean>>();private timer:ReturnType<typeof setInterval>|null=null;
  constructor(private readonly options:BanSyncOptions){this.now=options.now??Date.now;this.suspend();}
  private key(actor:string){if(!/^\d{1,30}$/.test(actor))throw new Error('Invalid Twitch actor');return `ban:actor:${actor}`;}
  private next(){const value=(this.options.control.get<number>('ban:sequence')??0)+1;this.options.control.put('ban:sequence',value);return value;}
  private remember(actor:string){
    if(!this.options.control.claim(`ban:indexed:${actor}`,true))return;
    const count=this.options.control.get<number>('ban:index-count')??0;const page=Math.floor(count/100);const values=this.options.control.get<string[]>(`ban:index:${page}`)??[];values.push(actor);this.options.control.put(`ban:index:${page}`,values);this.options.control.put('ban:index-count',count+1);
  }
  ready(){return this.options.control.get<Snapshot>('ban:snapshot')?.ready===true;}
  suspend(){const snapshot=this.options.control.get<Snapshot>('ban:snapshot');if(snapshot)this.options.control.put('ban:snapshot',{...snapshot,ready:false});this.options.onReadiness?.(false);}
  begin=(id:string)=>{this.options.control.put('ban:snapshot',{id,fence:this.next(),ready:false} satisfies Snapshot);this.options.onReadiness?.(false);};
  page=async(id:string,users:BannedUser[])=>{
    const snapshot=this.options.control.get<Snapshot>('ban:snapshot');if(!snapshot||snapshot.id!==id)return;
    for(const user of users){
      const key=this.key(user.user_id);const record=this.options.control.get<BanRecord>(key);this.remember(user.user_id);
      // A live moderation event after begin wins even if this API page was already in flight.
      if(record&&record.sequence>snapshot.fence)continue;
      this.options.control.put(key,{actorId:user.user_id,blocked:true,expiresAtMs:user.expires_at?Date.parse(user.expires_at):null,sequence:snapshot.fence,snapshot:id,verifiedAtMs:this.now()} satisfies BanRecord);
      await this.options.onBlocked(user.user_id,new Date(this.now()).toISOString(),'snapshot');
    }
  };
  finish=(id:string)=>{const snapshot=this.options.control.get<Snapshot>('ban:snapshot');if(snapshot?.id!==id)return;this.options.control.put('ban:snapshot',{...snapshot,ready:true});this.options.onReadiness?.(true);};
  /** This synchronous check is safe in a final outbound fence. Expired/uncertain bans remain blocked until verified. */
  allows(actorId:string){
    const snapshot=this.options.control.get<Snapshot>('ban:snapshot');if(!snapshot?.ready)return false;
    const record=this.options.control.get<BanRecord>(this.key(actorId));if(!record)return true;
    if(record.blocked)return false;
    return record.snapshot===snapshot.id||record.sequence>snapshot.fence;
  }
  async ban(event:{user_id:string;banned_at:string;ends_at?:string|null;is_permanent?:boolean}){
    const key=this.key(event.user_id);this.remember(event.user_id);const sequence=this.next();
    this.options.control.put(key,{actorId:event.user_id,blocked:true,expiresAtMs:event.is_permanent?null:event.ends_at?Date.parse(event.ends_at):null,sequence,snapshot:this.options.control.get<Snapshot>('ban:snapshot')?.id??null,verifiedAtMs:this.now()} satisfies BanRecord);
    await this.options.onBlocked(event.user_id,event.banned_at,'ban');
  }
  async unban(event:{user_id:string}){
    const actor=event.user_id;const key=this.key(actor);this.remember(actor);
    // Unban could itself arrive late; a point query confirms current eligibility, never old source restoration.
    const old=this.options.control.get<BanRecord>(key);this.options.control.put(key,{actorId:actor,blocked:true,expiresAtMs:this.now(),sequence:this.next(),snapshot:old?.snapshot??null,verifiedAtMs:0} satisfies BanRecord);
    return this.verifyActor(actor);
  }
  verifyActor(actor:string):Promise<boolean>{
    const existing=this.checks.get(actor);if(existing)return existing;
    if(this.checks.size>=8)return Promise.resolve(false);
    const promise=this.checkActor(actor).finally(()=>this.checks.delete(actor));this.checks.set(actor,promise);return promise;
  }
  private async checkActor(actor:string){
    const key=this.key(actor);const before=this.options.control.get<BanRecord>(key);const sequence=before?.sequence??0;const snapshotId=this.options.control.get<Snapshot>('ban:snapshot')?.id;let found:BannedUser|null=null;
    try{await this.options.helix.bannedUsers(users=>{found=users.find(item=>item.user_id===actor)??found;},actor);}catch{return false;}
    const current=this.options.control.get<BanRecord>(key);if((current?.sequence??0)!==sequence)return this.allows(actor);
    if(this.options.control.get<Snapshot>('ban:snapshot')?.id!==snapshotId)return false;
    const user=found as BannedUser|null;const snapshot=this.options.control.get<Snapshot>('ban:snapshot');
    this.options.control.put(key,{actorId:actor,blocked:Boolean(user),expiresAtMs:user?.expires_at?Date.parse(user.expires_at):null,sequence:this.next(),snapshot:snapshot?.id??null,verifiedAtMs:this.now()} satisfies BanRecord);this.remember(actor);
    if(user)await this.options.onBlocked(actor,new Date(this.now()).toISOString(),'snapshot');
    return !user&&this.ready();
  }
  /** Inspect at most 100 persisted actors/tick; only expired or missing-from-new-snapshot bans cause network I/O. */
  async tick(){
    if(!this.ready())return;const count=this.options.control.get<number>('ban:index-count')??0;if(!count)return;
    const pages=Math.ceil(count/100),cursor=(this.options.control.get<number>('ban:cursor')??0)%pages;const actors=this.options.control.get<string[]>(`ban:index:${cursor}`)??[];
    this.options.control.put('ban:cursor',(cursor+1)%pages);const snapshot=this.options.control.get<Snapshot>('ban:snapshot')!;
    let requests=0;for(const actor of actors){const record=this.options.control.get<BanRecord>(this.key(actor));if(!record)continue;
      const needs=(record.expiresAtMs!==null&&record.expiresAtMs<=this.now())||(record.snapshot!==snapshot.id&&record.sequence<=snapshot.fence);
      if(needs){await this.verifyActor(actor);if(++requests>=5)break;}
    }
  }
  start(){if(!this.timer){this.timer=setInterval(()=>{void this.tick().catch(()=>this.suspend());},5000);this.timer.unref();}}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.suspend();}
}
