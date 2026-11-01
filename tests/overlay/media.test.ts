import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {prepareMedia,syncMedia} from '../../src/features/overlay/media.js';
import {planFixture} from './fixture.js';

class FakeMedia extends EventTarget {
  src='';preload='';currentTime=0;duration=10;paused=true;seeking=false;volume=1;
  play=vi.fn(async()=>{this.paused=false;});pause=vi.fn(()=>{this.paused=true;});load=vi.fn();remove=vi.fn();
  removeAttribute=vi.fn((name:string)=>{if(name==='src')this.src='';});
}
class FakeVideo extends FakeMedia {muted=false;playsInline=false;}
class FakeImage extends EventTarget {src='';remove=vi.fn();removeAttribute=vi.fn();}
let created:FakeMedia[]=[];
beforeEach(()=>{
  created=[];vi.stubGlobal('HTMLMediaElement',FakeMedia);vi.stubGlobal('HTMLVideoElement',FakeVideo);vi.stubGlobal('Image',FakeImage);
  vi.stubGlobal('document',{createElement:(kind:string)=>{const el=kind==='video'?new FakeVideo():new FakeMedia();created.push(el);return el;}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function withVideo(){const plan=planFixture();plan.media=[{id:'clip:1',kind:'video',inMs:0,outMs:2000,captureStartMs:10000,captureEndMs:12000,previousSession:false}];return plan;}
describe('media readiness and cleanup',()=>{
  it('requires decoded first frame, not merely metadata, before prepare completes',async()=>{
    const plan=withVideo(),abort=new AbortController();let ready=false;const pending=prepareMedia(plan,id=>`/api/media/${id}`,abort.signal).then(value=>{ready=true;return value;});
    created[0].dispatchEvent(new Event('loadedmetadata'));await Promise.resolve();expect(ready).toBe(false);
    created[0].dispatchEvent(new Event('loadeddata'));const result=await pending;expect(result.visuals.has('clip:1')).toBe(true);expect((created[0] as FakeVideo).muted).toBe(true);expect(created[0].play).not.toHaveBeenCalled();result.release();
  });
  it('uses a truthful no-video result after the 1500ms readiness budget',async()=>{
    vi.useFakeTimers();const pending=prepareMedia(withVideo(),id=>`/api/media/${id}`,new AbortController().signal);await vi.advanceTimersByTimeAsync(1500);const result=await pending;expect(result.visuals.size).toBe(0);expect(created[0].src).toBe('');expect(created[0].pause).toHaveBeenCalled();
  });
  it('revocation during prepare aborts and drops all retained sources',async()=>{
    const abort=new AbortController(),pending=prepareMedia(withVideo(),id=>`/api/media/${id}`,abort.signal);abort.abort();const result=await pending;expect(result.visuals.size).toBe(0);expect(created[0].src).toBe('');expect(created[0].remove).toHaveBeenCalled();
  });
  it('cancel releases prepared narrator and video together',async()=>{
    const plan=withVideo();plan.audio={id:'voice:1',startMs:1000,durationMs:7000};const abort=new AbortController(),pending=prepareMedia(plan,id=>`/api/media/${id}`,abort.signal);for(const media of created)media.dispatchEvent(new Event('loadeddata'));const result=await pending;expect(result.narrator).not.toBeNull();abort.abort();expect(result.narrator).toBeNull();expect(result.visuals.size).toBe(0);for(const media of created){expect(media.pause).toHaveBeenCalled();expect(media.src).toBe('');}
  });
  it('corrects bounded drift and stops without waiting for a video ended event',async()=>{
    const media=new FakeVideo();media.currentTime=1;syncMedia(media as unknown as HTMLMediaElement,3,true);await Promise.resolve();expect(media.currentTime).toBe(3);expect(media.play).toHaveBeenCalledOnce();syncMedia(media as unknown as HTMLMediaElement,3.05,true);expect(media.currentTime).toBe(3);syncMedia(media as unknown as HTMLMediaElement,3.1,false);expect(media.pause).toHaveBeenCalledOnce();
  });
  it('reports autoplay restriction once instead of retrying at frame rate',async()=>{
    const media=new FakeVideo(),blocked=vi.fn();media.play.mockRejectedValue(new Error('NotAllowedError'));syncMedia(media as unknown as HTMLMediaElement,0,true,blocked);await Promise.resolve();await Promise.resolve();syncMedia(media as unknown as HTMLMediaElement,.02,true,blocked);expect(media.play).toHaveBeenCalledOnce();expect(blocked).toHaveBeenCalledOnce();
  });
});
