import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {StorageDatabase} from '../../src/server/storage/database.js';
import {SqliteRepository} from '../../src/server/storage/repository.js';
import {StoryEngine} from '../../src/server/runtime/engine.js';

const samples=new Map<string,{calls:number;ms:number}>();
function record(name:string,elapsed:number){const value=samples.get(name)??{calls:0,ms:0};value.calls++;value.ms+=elapsed;samples.set(name,value);}
for(const name of ['run','get','all'] as const){
  const original=StorageDatabase.prototype[name];
  StorageDatabase.prototype[name]=function(sql:string,...params:any[]){const start=performance.now();try{return original.call(this,sql,...params);}finally{record(`sql:${sql}`,performance.now()-start);}} as typeof original;
}
const originalExec=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql:string){const start=performance.now();try{return originalExec.call(this,sql);}finally{record(`exec:${sql.replace(/storage_\d+/g,'storage_N')}`,performance.now()-start);}};
const originalState=StoryEngine.prototype.state;
StoryEngine.prototype.state=function(...args:Parameters<typeof originalState>){const start=performance.now();try{return originalState.apply(this,args);}finally{record('engine.state',performance.now()-start);}};
const originalApply=SqliteRepository.prototype.applyDomainTransition;
SqliteRepository.prototype.applyDomainTransition=function(...args:Parameters<typeof originalApply>){const start=performance.now();try{return originalApply.apply(this,args);}finally{record('repository.apply',performance.now()-start);}};
process.argv[2]='docs/testing/reliability/engine-throughput-traced.json';
await import('./engine-throughput.mjs');
console.log('TRACE',JSON.stringify([...samples].map(([name,value])=>({name,...value})).sort((a,b)=>b.ms-a.ms).slice(0,30)));
