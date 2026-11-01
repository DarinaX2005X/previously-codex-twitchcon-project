import { get, put, del, list, BlobPreconditionFailedError } from '@vercel/blob';

export type BlobObject={bytes:Uint8Array;etag:string;uploadedAt:number};
export interface BlobStore { get(path:string):Promise<BlobObject|null>; put(path:string,bytes:Uint8Array,options:{ifMatch?:string;contentType:string}):Promise<{etag:string}>; delete(path:string):Promise<void>;list?(prefix:string,cursor?:string):Promise<{paths:string[];cursor?:string}> }
export class CasConflict extends Error {}
/** All reads deliberately bypass the private Blob origin cache. No Blob URL leaves this adapter. */
export class VercelBlobStore implements BlobStore {
  constructor(private readonly token?:string){}
  async get(path:string):Promise<BlobObject|null>{
    // Compression can turn origin ETags into weak representation ETags on larger JSON heads.
    // CAS requires the origin entity tag, so request the identity representation explicitly.
    const result=await get(path,{access:'private',useCache:false,headers:{'accept-encoding':'identity'},token:this.token});
    if(!result)return null;
    if(!result.stream)throw new Error('Unexpected conditional Blob response');
    if((result.blob.size??0)>3_500_000){await result.stream.cancel();throw new Error('Blob exceeds bounded storage contract');}
    const reader=result.stream.getReader(),parts:Uint8Array[]=[];let total=0;
    for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>3_500_000){await reader.cancel();throw new Error('Blob exceeds bounded storage contract');}parts.push(part.value);}
    const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return {bytes,etag:result.blob.etag,uploadedAt:result.blob.uploadedAt.getTime()};
  }
  async put(path:string,bytes:Uint8Array,options:{ifMatch?:string;contentType:string}){
    try { const result=await put(path,Buffer.from(bytes),{access:'private',token:this.token,addRandomSuffix:false,allowOverwrite:options.ifMatch!==undefined,ifMatch:options.ifMatch,contentType:options.contentType});return {etag:result.etag}; }
    catch(error){
      if(error instanceof BlobPreconditionFailedError)throw new CasConflict();
      // Initial create conflicts use the SDK's already-exists error rather than a 412.
      if(error instanceof Error && /already exists/i.test(error.message))throw new CasConflict();
      throw error;
    }
  }
  async delete(path:string){await del(path,{token:this.token});}
  async list(prefix:string,cursor?:string){const page=await list({prefix,cursor,limit:100,token:this.token});return {paths:page.blobs.map(blob=>blob.pathname),cursor:page.hasMore?page.cursor:undefined};}
}
