import {ReplayDriver} from './driver.js';
import type {CaptureBundle} from './contracts.js';
import type {ReplayControl} from '../shared/contracts/index.js';

let driver:ReplayDriver|null=null,bundle:CaptureBundle|null=null,run=0,manual=0,virtualPosition=0,last=performance.now();
const scope=crypto.randomUUID();
function view(){return driver?{snapshot:driver.snapshot(),transport:{atMs:Math.min(driver.atMs,driver.durationMs),durationMs:driver.durationMs,playing:driver.playing,speed:driver.speed,error:driver.error,correction:driver.correction,correctionApplied:driver.correctionApplied,availableLanguages:driver.availableLanguages,milestones:driver.milestones,latestSource:driver.latestSource}}:null;}
function notify(){postMessage({kind:'change',view:view()});}
function fresh(){driver?.revoke();driver=new ReplayDriver(bundle!,`${scope}-${++run}`);manual=0;virtualPosition=0;last=performance.now();}
setInterval(()=>{const now=performance.now(),delta=now-last;last=now;if(driver?.playing){virtualPosition+=delta*driver.speed;driver.advanceTo(virtualPosition);notify();}},100);
self.onmessage=(message:MessageEvent<{id:number;method:string;args:unknown[]}>)=>{
  const {id,method,args}=message.data;
  try{
    let result:unknown;
    if(method==='init'){bundle=args[0] as CaptureBundle;fresh();}
    else if(method==='revoke'){driver?.revoke();driver=null;bundle=null;}
    else {
      if(!driver)throw new Error('recording_unavailable');
      switch(method){
        case 'getSnapshot':result=driver.snapshot();break;
        case 'controlReplay':{const control=args[0] as ReplayControl;if(control.action==='reset')fresh();else if(control.action==='seek'){const target=driver.seekTarget(control);if(target!==null&&target<driver.atMs){const {playing,speed}=driver;fresh();driver!.playing=playing;driver!.speed=speed;}driver!.control(control);}else driver.control(control);virtualPosition=driver!.atMs;last=performance.now();break;}
        case 'editChapter':result=driver.editChapter(args[0] as string,args[1] as Parameters<ReplayDriver['editChapter']>[1]);break;
        case 'deleteChapter':driver.chapter(args[0] as string,args[1] as number);result=driver.privacy({kind:'entity',sessionId:driver.state.session.id,id:args[0] as string});break;
        case 'privacy':result=driver.privacy(args[0] as Parameters<ReplayDriver['privacy']>[0]);break;
        case 'pinChapter':driver.chapter(args[0] as string,args[2] as number);driver.send({type:'owner.pin',entityId:args[0] as string,pinned:args[1] as boolean,baseRevision:args[2] as number});result=driver.state.chapters.find(c=>c.id===args[0]);break;
        case 'setSettings':result=driver.setSettings(args[0] as Parameters<ReplayDriver['setSettings']>[0]);break;
        case 'saveMoment':{const input=args[0] as {sessionId:string;label?:string};if(input.sessionId!==driver.state.session.id)throw new Error('wrong_session');driver.send({type:'moment.save',atMs:driver.atMs,label:input.label});result=driver.state.moments.at(-1);break;}
        case 'previewRecap':result=driver.preview();break;
        case 'triggerRecap':{if(args[0]!==driver.state.session.id)throw new Error('wrong_session');const trigger={id:`manual-${++manual}`,sessionId:driver.state.session.id,reason:'manual' as const,occurredAt:driver.clock.iso()};driver.send({type:'recap.trigger',trigger});driver.flush();if(driver.atMs>=driver.durationMs){driver.playing=true;virtualPosition=driver.atMs;last=performance.now();}result=driver.state.playbacks.at(-1);break;}
        case 'cancelRecap':driver.send({type:'playback',id:args[0] as string,action:'cancel'});break;
        case 'getEvidence':result=driver.evidence(args[0] as string);break;
        case 'listSources':{const query=args[0] as {sessionId:string;fromMs?:number;toMs?:number;cursor?:string;limit:number};if(query.sessionId!==driver.state.session.id)throw new Error('wrong_session');const cursor=Math.max(0,Number(query.cursor)||0),items=driver.state.sources.filter(s=>s.status==='active'&&s.text&&s.endMs>=(query.fromMs??0)&&s.startMs<=(query.toMs??Infinity)),limit=Math.min(50,Math.max(1,query.limit));result={items:items.slice(cursor,cursor+limit),nextCursor:cursor+limit<items.length?String(cursor+limit):null};break;}
        default:throw new Error('unsupported_replay_action');
      }
    }
    postMessage({id,result,view:view()});if(!['getSnapshot','getEvidence','listSources','previewRecap'].includes(method))notify();
  }catch(error){postMessage({id,error:{message:error instanceof Error?error.message:'Replay action failed',code:(error as {code?:string}).code??'replay_error',status:(error as {status?:number}).status}});}
};
