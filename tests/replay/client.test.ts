import {describe,it,expect,vi} from 'vitest';
import {ReplayClient} from '../../src/replay/client.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';

class FakeWorker {
  onmessage:((event:MessageEvent)=>void)|null=null;onerror:(()=>void)|null=null;onmessageerror:(()=>void)|null=null;messages:{id:number;method:string;args:unknown[]}[]=[];terminate=vi.fn();
  postMessage(message:{id:number;method:string;args:unknown[]}){this.messages.push(message);}
  emit(value:unknown){this.onmessage?.({data:value} as MessageEvent);}
}
describe('replay client updates',()=>{
  it('snapshot replies do not produce another subscription refresh',async()=>{const worker=new FakeWorker(),client=new ReplayClient(worker as unknown as Worker),listener=vi.fn();client.subscribe(listener);const d=new ReplayDriver(createAuthoredBundle(),'client-test'),snapshot=d.snapshot(),view={snapshot,transport:{atMs:0,durationMs:d.durationMs,playing:false,speed:1,error:null,correction:d.correction,milestones:d.milestones}};
    const reply=client.getSnapshot();worker.emit({id:worker.messages[0]!.id,result:snapshot,view});await expect(reply).resolves.toEqual(snapshot);expect(listener).not.toHaveBeenCalled();worker.emit({kind:'change',view});expect(listener).toHaveBeenCalledOnce();client.dispose();});
  it('worker failure terminates execution and tells the surface to clear retained content',()=>{const worker=new FakeWorker(),failed=vi.fn(),client=new ReplayClient(worker as unknown as Worker,failed);worker.onerror?.();expect(worker.terminate).toHaveBeenCalledOnce();expect(failed).toHaveBeenCalledOnce();expect(client.view).toBeNull();});
});
