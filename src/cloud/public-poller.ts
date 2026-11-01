/** Browser-only polling primitive: hidden tabs do not poll and never retain a live visibility lease. */
export class PublicPoller<T> {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private expiry:ReturnType<typeof setTimeout>|undefined;
  private generation=0;private stopped=true;private failures=0;private controller:AbortController|undefined;
  constructor(private readonly options:{url:string;onValue:(value:T)=>void;onUnavailable:()=>void;fetch?:typeof fetch;isFinalized?:(value:T)=>boolean;document?:Pick<Document,'visibilityState'|'addEventListener'|'removeEventListener'>}){}
  private document(){return this.options.document??globalThis.document;}
  private visibility=()=>{if(this.document()?.visibilityState==='hidden'){this.clear();this.options.onUnavailable();}else if(!this.stopped){this.clear();void this.poll();}};
  start(){if(!this.stopped)return;this.stopped=false;this.document()?.addEventListener('visibilitychange',this.visibility);void this.poll();}
  stop(){this.stopped=true;this.document()?.removeEventListener('visibilitychange',this.visibility);this.clear();this.options.onUnavailable();}
  private clear(){this.generation++;clearTimeout(this.timer);clearTimeout(this.expiry);this.controller?.abort();}
  private async poll(){
    if(this.stopped||this.document()?.visibilityState==='hidden')return;
    const generation=this.generation,controller=new AbortController();this.controller=controller;const timeout=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await(this.options.fetch??fetch)(this.options.url,{cache:'no-store',signal:controller.signal});
      if(!response.ok){if([404,409,410,503].includes(response.status))this.options.onUnavailable();throw new Error('Public revalidation failed');}
      const value=await response.json() as T;if(this.stopped||generation!==this.generation)return;
      this.failures=0;this.options.onValue(value);clearTimeout(this.expiry);
      // Replay exports always pass isFinalized=false: they must keep revalidating their revocation gate.
      if(!this.options.isFinalized?.(value))this.expiry=setTimeout(()=>this.options.onUnavailable(),6000);
    }catch{if(generation===this.generation)this.failures++;}finally{clearTimeout(timeout);if(!this.stopped&&generation===this.generation)this.timer=setTimeout(()=>void this.poll(),Math.min(30_000,2000*2**Math.min(4,this.failures)));}
  }
}
