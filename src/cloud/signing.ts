import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PublicationError } from './contracts.js';
export const sha256=(body:Uint8Array|string)=>createHash('sha256').update(body).digest('hex');
export function signingInput(method:string,path:string,timestamp:string,channelId:string,seq:string,body:Uint8Array|string){return [method.toUpperCase(),path,timestamp,channelId,seq,sha256(body)].join('\n');}
export function signedHeaders(secret:string,method:string,path:string,channelId:string,publishSeq:number,body:Uint8Array|string,now=Date.now()){
  const timestamp=String(now),seq=String(publishSeq);
  return {'x-publish-timestamp':timestamp,'x-publish-channel':channelId,'x-publish-seq':seq,'x-publish-signature':createHmac('sha256',secret).update(signingInput(method,path,timestamp,channelId,seq,body)).digest('hex')};
}
export function verifySignature(secret:string,method:string,path:string,headers:Headers,body:Uint8Array,now=Date.now()){
  const timestamp=headers.get('x-publish-timestamp')??'',channelId=headers.get('x-publish-channel')??'',seq=headers.get('x-publish-seq')??'',signature=headers.get('x-publish-signature')??'';
  if(secret.length<32||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60_000||!/^\d+$/.test(seq)||!Number.isSafeInteger(Number(seq))||Number(seq)<1||!/^[a-zA-Z0-9_-]{1,120}$/.test(channelId)||!/^[a-f0-9]{64}$/.test(signature))throw new PublicationError(401,'invalid_signature');
  const expected=createHmac('sha256',secret).update(signingInput(method,path,timestamp,channelId,seq,body)).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new PublicationError(401,'invalid_signature');
  return {channelId,publishSeq:Number(seq)};
}
