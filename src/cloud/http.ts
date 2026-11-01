import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { LIMITS, Key, PublicationError, UploadSchema } from './contracts.js';
import { PublicationService } from './service.js';
import { sha256, verifySignature } from './signing.js';
export const RESPONSE_HEADERS={'Cache-Control':'private, no-store','CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...RESPONSE_HEADERS,'Content-Type':'application/json'}});
async function bytes(request:Request){
  if(Number(request.headers.get('content-length'))>LIMITS.request)throw new PublicationError(413,'payload_too_large');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();const parts:Uint8Array[]=[];let size=0;
  for(;;){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>LIMITS.request){await reader.cancel();throw new PublicationError(413,'payload_too_large');}parts.push(result.value);}
  const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
/** Signed binary upload framing: UTF-8 JSON metadata, one LF, then exact asset bytes. */
export function encodeAssetUpload(metadata:z.infer<typeof UploadSchema>,asset:Uint8Array){return Buffer.concat([Buffer.from(JSON.stringify(UploadSchema.parse(metadata))+'\n'),Buffer.from(asset)]);}
export function createCloudHandler(options:{service:PublicationService;secret:string;channelLogin:string;now?:()=>number}){
  return async(request:Request):Promise<Response>=>{
    const requestId=randomUUID();
    try{
      const url=new URL(request.url),path=url.pathname;
      if(request.method==='POST'&&path.startsWith('/api/publish')){
        const raw=await bytes(request),signed=verifySignature(options.secret,'POST',path,request.headers,raw,options.now?.()??Date.now());
        if(path==='/api/publish/export-assets'){
          const newline=raw.indexOf(10);if(newline<0||newline>8192)throw new PublicationError(400,'invalid_asset_frame');
          const metadata=UploadSchema.parse(JSON.parse(new TextDecoder().decode(raw.subarray(0,newline))));
          if(metadata.channelId!==signed.channelId||metadata.publishSeq!==signed.publishSeq)throw new PublicationError(401,'signed_scope_mismatch');
          return json(await options.service.uploadAsset(metadata,raw.subarray(newline+1)));
        }
        const body=JSON.parse(new TextDecoder().decode(raw)) as Record<string,unknown>;
        if(body.channelId!==signed.channelId||body.publishSeq!==signed.publishSeq)throw new PublicationError(401,'signed_scope_mismatch');
        if(path==='/api/publish')return json(await options.service.publish(body,sha256(raw)));
        if(path==='/api/publish/maintenance'){
          const input=z.object({channelId:Key,publishSeq:z.number().int().positive(),paths:z.array(z.string().max(500)).max(100)}).strict().parse(body);
          if(input.channelId!==await options.service.resolveChannel())throw new PublicationError(403,'wrong_channel');
          return json(await options.service.maintenance(input.channelId,input.paths));
        }
        throw new PublicationError(404,'not_found');
      }
      if(request.method!=='GET')throw new PublicationError(405,'method_not_allowed');
      const channelId=await options.service.resolveChannel(),parts=path.split('/').filter(Boolean);
      if(parts[0]!=='api'||parts[1]!=='public')throw new PublicationError(404,'not_found');
      const cutoff=url.searchParams.has('untilMs')?Number(url.searchParams.get('untilMs')):undefined;
      if(parts[2]==='channels'&&parts.length===4){if(parts[3]!==options.channelLogin)throw new PublicationError(404,'not_found');return json(await options.service.readSnapshot(channelId,undefined,cutoff));}
      if(parts[2]==='sessions'&&parts.length===4)return json(await options.service.readSnapshot(channelId,Key.parse(parts[3]),cutoff));
      if(parts[2]==='replays'&&parts.length===3){
        const head=await options.service.getHead(channelId),available=[];
        for(const pointer of (head?.head.exports??[]).filter(p=>p.status==='active').sort((a,b)=>b.publishSeq-a.publishSeq)){
          const {manifest}=await options.service.readManifest(channelId,pointer.id,pointer.revision);
          available.push(manifest);
        }
        const selected=available.find(manifest=>manifest.origin==='own-stream')??available[0];
        if(!selected)throw new PublicationError(410,'recording_unavailable');
        return json({id:selected.id});
      }
      if(parts[2]==='replays'&&(parts.length===4||parts.length===6)){
        const id=Key.parse(parts[3]),head=await options.service.getHead(channelId),pointer=head?.head.exports.find(p=>p.id===id);
        const revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):pointer?.revision;
        if(revision===undefined||!Number.isSafeInteger(revision)||revision<0)throw new PublicationError(410,'export_revoked');
        if(parts.length===4){const {manifest}=await options.service.readManifest(channelId,id,revision);return json({...manifest,visibilityLeaseMs:6000});}
        if(parts[4]!=='assets')throw new PublicationError(404,'not_found');
        if(!url.searchParams.has('revision'))throw new PublicationError(400,'revision_required');
        const asset=await options.service.readAsset(channelId,id,revision,Key.parse(parts[5])),headers:Record<string,string>={...RESPONSE_HEADERS,'Content-Type':asset.mime,'Accept-Ranges':'bytes','Content-Disposition':'inline'};
        let body=asset.bytes,status=200;const range=request.headers.get('range');
        if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)throw new PublicationError(416,'invalid_range');const start=Number(match[1]),end=match[2]?Number(match[2]):body.length-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=body.length)throw new PublicationError(416,'invalid_range');headers['Content-Range']=`bytes ${start}-${end}/${body.length}`;body=body.subarray(start,end+1);status=206;}
        headers['Content-Length']=String(body.length);return new Response(Buffer.from(body),{status,headers});
      }
      throw new PublicationError(404,'not_found');
    }catch(error){
      if(error instanceof PublicationError)return json({error:{code:error.code,message:error.message,retryable:error.status>=500,requestId}},error.status);
      if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:{code:'invalid_request',message:'Request does not match the public contract.',retryable:false,requestId}},400);
      return json({error:{code:'storage_unavailable',message:'Publication storage is temporarily unavailable.',retryable:true,requestId}},503);
    }
  };
}
