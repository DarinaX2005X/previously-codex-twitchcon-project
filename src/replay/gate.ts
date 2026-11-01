import {ManifestSchema,type ExportManifest} from '../cloud/contracts.js';
import {validateBundle,type CaptureBundle} from './contracts.js';
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
export class ReplayGate {
  private timer:ReturnType<typeof setInterval>|undefined;private expiry:ReturnType<typeof setTimeout>|undefined;private leaseDeadline=0;private stopped=false;private busy=false;private revision:number|null=null;private currentManifest:ExportManifest|null=null;private aborts=new Set<AbortController>();
  constructor(readonly manifestUrl:string,private invalidated:(reason:string)=>void,private fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init)){}
  private async request(url:string){
    const controller=new AbortController();this.aborts.add(controller);const timeout=setTimeout(()=>controller.abort(),4500);
    try{
      let response:Response;try{response=await this.fetcher(url,{cache:'no-store',credentials:'omit',signal:controller.signal});}catch(error){throw new Error(error instanceof DOMException&&error.name==='AbortError'?'recording_request_timeout':'recording_fetch_failed');}
      if(response.status===410){this.clear('This recording has been withdrawn');throw new Error('recording_revoked');}if(!response.ok)throw new Error('recording_unavailable');
      const reader=response.body?.getReader(),parts:Uint8Array[]=[];let length=0;
      if(reader)for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>3_500_000){await reader.cancel();throw new Error('recording_response_too_large');}parts.push(part.value);}
      const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
      return new Response(bytes,{status:response.status,headers:response.headers});
    }finally{clearTimeout(timeout);this.aborts.delete(controller);}
  }
  private lease(){clearTimeout(this.expiry);this.leaseDeadline=Date.now()+6000;this.expiry=setTimeout(()=>this.clear('The recording could not be revalidated. Reload to continue.'),6000);}
  async manifest():Promise<ExportManifest>{const raw=await(await this.request(this.manifestUrl)).json();const {visibilityLeaseMs:_lease,...value}=raw;const manifest=ManifestSchema.parse(value);if(this.stopped)throw new Error('recording_revoked');if(this.leaseDeadline&&Date.now()>=this.leaseDeadline){this.clear('The recording could not be revalidated. Reload to continue.');throw new Error('recording_lease_expired');}if(this.revision!==null&&manifest.revision!==this.revision){this.clear('A newer recording is available. Reload to continue.');throw new Error('recording_changed');}this.revision=manifest.revision;this.currentManifest=manifest;this.lease();return manifest;}
  mediaUrl(assetId:string){if(this.stopped||!this.currentManifest?.assets.some(a=>a.id===assetId&&['video','audio','image'].includes(a.kind)))return undefined;return `${this.manifestUrl}/assets/${encodeURIComponent(assetId)}?revision=${this.revision}`;}
  async load():Promise<CaptureBundle>{const manifest=await this.manifest();const asset=manifest.assets.find(a=>a.kind==='bundle');if(!asset)throw new Error('recording_bundle_missing');const response=await this.request(`${this.manifestUrl}/assets/${encodeURIComponent(asset.id)}?revision=${manifest.revision}`);const bytes=await response.arrayBuffer();if(!globalThis.crypto?.subtle)throw new Error('recording_requires_secure_browser');if(bytes.byteLength!==asset.bytes||hex(await crypto.subtle.digest('SHA-256',bytes))!==asset.hash||asset.hash!==manifest.bundleHash)throw new Error('recording_integrity_failed');const bundle=validateBundle(JSON.parse(new TextDecoder().decode(bytes)));if(bundle.revision!==manifest.revision||bundle.origin!==manifest.origin)throw new Error('recording_identity_mismatch');await this.manifest();if(this.stopped)throw new Error('recording_revoked');this.timer=setInterval(()=>{void this.revalidate();},2000);return bundle;}
  async revalidate(){if(this.stopped)return;if(this.leaseDeadline&&Date.now()>=this.leaseDeadline){this.clear('The recording could not be revalidated. Reload to continue.');return;}if(this.busy)return;this.busy=true;try{await this.manifest();}catch{/* The independent 6 s lease closes a stalled fetch. */}finally{this.busy=false;}}
  private clear(reason:string){if(this.stopped)return;this.dispose();this.invalidated(reason);}
  dispose(){this.stopped=true;this.currentManifest=null;clearInterval(this.timer);clearTimeout(this.expiry);for(const abort of this.aborts)abort.abort();this.aborts.clear();}
}
