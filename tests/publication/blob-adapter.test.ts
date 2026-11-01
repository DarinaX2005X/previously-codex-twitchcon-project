import {describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),del:vi.fn(),list:vi.fn()}));
vi.mock('@vercel/blob',()=>({...mocks,BlobPreconditionFailedError:class extends Error{}}));
import {VercelBlobStore} from '../../src/cloud/blob-store.js';
describe('real SDK adapter options',()=>{
  it('requests origin freshness and uncompressed representation ETags for conditional writes',async()=>{
    mocks.get.mockResolvedValue({stream:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{}'));c.close();}}),blob:{etag:'"origin-etag"',uploadedAt:new Date(0),size:2}});
    const store=new VercelBlobStore('test-token'),object=await store.get('channels/test/head.json');
    expect(mocks.get).toHaveBeenCalledWith('channels/test/head.json',{access:'private',useCache:false,headers:{'accept-encoding':'identity'},token:'test-token'});
    mocks.put.mockResolvedValue({etag:'next'});await store.put('channels/test/head.json',new Uint8Array([1]),{ifMatch:object!.etag,contentType:'application/json'});
    expect(mocks.put.mock.calls[0][2]).toMatchObject({access:'private',allowOverwrite:true,ifMatch:'"origin-etag"',addRandomSuffix:false});
  });
});
