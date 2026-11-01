import type { IncomingMessage, ServerResponse } from 'node:http';
import {randomUUID} from 'node:crypto';
import { VercelBlobStore } from '../src/cloud/blob-store.js';
import { createPublicationService } from '../src/cloud/service.js';
import { createCloudHandler, RESPONSE_HEADERS } from '../src/cloud/http.js';
import { LIMITS } from '../src/cloud/contracts.js';

export const config={api:{bodyParser:false}};
export default async function handler(req:IncomingMessage,res:ServerResponse){
  const requestId=randomUUID();
  const secret=process.env.PUBLISH_SHARED_SECRET,channelLogin=process.env.TWITCH_CHANNEL_LOGIN,token=process.env.BLOB_READ_WRITE_TOKEN;
  if(!secret||!channelLogin||!token){res.writeHead(503,{...RESPONSE_HEADERS,'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'cloud_unconfigured',message:'Public recap is not configured.',retryable:false,requestId}}));return;}
  try{
    const chunks:Buffer[]=[];let total=0;
    for await(const chunk of req){const value=Buffer.from(chunk);total+=value.length;if(total>LIMITS.request){res.writeHead(413,{...RESPONSE_HEADERS,'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'payload_too_large',message:'Publication request exceeds its limit.',retryable:false,requestId}}));return;}chunks.push(value);}
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers)){if(typeof value==='string')headers.set(key,value);else if(value)headers.set(key,value.join(','));}
    const method=req.method??'GET',request=new Request(`https://publication.invalid${req.url??'/'}`,{method,headers,body:method==='GET'||method==='HEAD'?undefined:Buffer.concat(chunks)});
    const service=createPublicationService({store:new VercelBlobStore(token),channelLogin});
    const response=await createCloudHandler({service,secret,channelLogin})(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503,{...RESPONSE_HEADERS,'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'storage_unavailable',message:'Publication storage is temporarily unavailable.',retryable:true,requestId}}));}
}
