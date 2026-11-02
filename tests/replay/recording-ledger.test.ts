import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordingStore} from '../../src/server/replay/recording-store.js';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function store(now:()=>number){const directory=mkdtempSync(join(tmpdir(),'previously-ledger-'));directories.push(directory);return new RecordingStore(directory,now);}

describe('recording command ledger (review B7)',()=>{
  it('keeps accepting commands past 500 entries and still replays recent ones',()=>{
    let now=Date.parse('2026-11-02T00:00:00Z');const recordings=store(()=>now);let runs=0;
    for(let i=0;i<520;i++){now+=1000;expect(recordings.command(`key-${i}`,'hash',()=>++runs)).toBe(i+1);}
    expect(recordings.command('key-519','hash',()=>++runs)).toBe(520);expect(runs).toBe(520);
    expect(()=>recordings.command('key-519','other',()=>++runs)).toThrow('recording_idempotency_conflict');
    expect(Object.keys(JSON.parse(readFileSync(join(recordings.directory,'commands.json'),'utf8'))).length).toBe(500);
  });
  it('keeps accepting commands once large results would pass 1 MB, including a withdraw after many exports',async()=>{
    let now=Date.parse('2026-11-02T00:00:00Z');const recordings=store(()=>now),manifest='m'.repeat(60_000);
    for(let i=0;i<40;i++){now+=1000;recordings.command(`export-${i}`,'hash',()=>({manifest}));}
    expect(statSync(join(recordings.directory,'commands.json')).size).toBeLessThanOrEqual(1_000_000);
    expect(recordings.command('revoke','hash',()=>({revoked:true}))).toEqual({revoked:true});
    expect(await recordings.commandAsync('attach','hash',async()=>({attached:true}))).toEqual({attached:true});
    expect(recordings.command('export-39','hash',()=>({manifest:'re-run'}))).toEqual({manifest});
  });
  it('expires entries after a day',()=>{
    let now=Date.parse('2026-11-02T00:00:00Z');const recordings=store(()=>now);let runs=0;
    recordings.command('old','hash',()=>++runs);now+=25*3600_000;recordings.command('new','hash',()=>++runs);
    expect(Object.keys(JSON.parse(readFileSync(join(recordings.directory,'commands.json'),'utf8')))).toEqual(['new']);
  });
});
