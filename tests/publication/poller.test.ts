import {afterEach,describe,it,expect,vi} from 'vitest';
import {PublicPoller} from '../../src/cloud/public-poller.js';
afterEach(()=>vi.useRealTimers());
describe('public visibility lease',()=>{
  it('clears after six seconds without a successful poll even during backoff',async()=>{
    vi.useFakeTimers();const onValue=vi.fn(),onUnavailable=vi.fn();let calls=0;
    const poller=new PublicPoller({url:'/api/public/channels/test',onValue,onUnavailable,fetch:(async()=>++calls===1?new Response('{"revision":1}'):new Response('',{status:429})) as typeof fetch});
    poller.start();await vi.advanceTimersByTimeAsync(0);expect(onValue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5999);expect(onUnavailable).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(onUnavailable).toHaveBeenCalledTimes(1);poller.stop();
  });
  it('stops hidden-tab polling, clears its data, revalidates immediately on visibility',async()=>{
    vi.useFakeTimers();let listener=()=>{};const document={visibilityState:'visible' as DocumentVisibilityState,addEventListener:(_name:string,cb:EventListenerOrEventListenerObject)=>{listener=cb as ()=>{};},removeEventListener:()=>{}};
    const fetcher=vi.fn(async()=>new Response('{}')),onUnavailable=vi.fn(),poller=new PublicPoller({url:'/api/public/test',onValue:()=>{},onUnavailable,fetch:fetcher,document});
    poller.start();await vi.advanceTimersByTimeAsync(0);document.visibilityState='hidden';listener();expect(onUnavailable).toHaveBeenCalled();await vi.advanceTimersByTimeAsync(20_000);expect(fetcher).toHaveBeenCalledTimes(1);
    document.visibilityState='visible';listener();await vi.advanceTimersByTimeAsync(0);expect(fetcher).toHaveBeenCalledTimes(2);poller.stop();
  });
});
