import {createHash} from 'node:crypto';
import {ManifestSchema,type ExportAsset,type ExportManifest} from '../../cloud/contracts.js';
import {MAX_BUNDLE_BYTES,validateBundle,type CaptureBundle} from '../../replay/contracts.js';
import {assertBundleIdentity,assertPackageBounds} from '../../replay/package.js';
import {ReplayDriver} from '../../replay/driver.js';
import {packageRecordingBundle} from './recording-package.js';

export const MAX_OFFLINE_ARCHIVE_BYTES=MAX_BUNDLE_BYTES;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
const fail=():never=>{throw new Error('recording_archive_invalid');};
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^crcTable[(crc^byte)&255]!;return (crc^0xffffffff)>>>0;}
const safePath=(name:string)=>/^(?:bundle\.json|manifest\.json|media\/[a-zA-Z0-9_-]{1,120})$/.test(name);
const mediaKind=(asset:ExportAsset)=>['video','audio','image'].includes(asset.kind);

/** Repacking verifies the reviewed manifest's commitment even when its root is a chunk index. */
function verifyManifest(bundle:CaptureBundle,manifest:ExportManifest){
  assertPackageBounds(manifest);assertBundleIdentity(bundle,manifest);
  const packaged=packageRecordingBundle(bundle),data=manifest.assets.filter(a=>!mediaKind(a));
  if(packaged.bundleHash!==manifest.bundleHash||data.length!==packaged.assets.length)throw new Error('recording_integrity_failed');
  for(const {asset}of packaged.assets){const reviewed=data.find(a=>a.id===asset.id);if(!reviewed||reviewed.hash!==asset.hash||reviewed.bytes!==asset.bytes||reviewed.kind!==asset.kind||reviewed.mime!==asset.mime)throw new Error('recording_integrity_failed');}
  const referenced=new Set(bundle.media.map(m=>m.assetId));
  if(new Set(bundle.media.map(m=>m.id)).size!==bundle.media.length||manifest.assets.filter(mediaKind).some(a=>!referenced.has(a.id))||[...referenced].some(id=>!manifest.assets.some(a=>a.id===id&&mediaKind(a))))throw new Error('recording_media_missing');
}

/** Deterministic uncompressed ZIP. No filesystem extraction or network access is involved. */
function zip(entries:{name:string;bytes:Uint8Array}[]):Uint8Array{
  const size=entries.reduce((sum,e)=>sum+76+2*Buffer.byteLength(e.name)+e.bytes.length,22);
  if(size>MAX_OFFLINE_ARCHIVE_BYTES)throw new Error('recording_archive_too_large');
  const output=Buffer.alloc(size),central:{name:Buffer;crc:number;length:number;offset:number}[]=[];let cursor=0;
  for(const entry of entries){
    if(!safePath(entry.name))fail();const name=Buffer.from(entry.name),crc=crc32(entry.bytes),start=cursor;
    output.writeUInt32LE(0x04034b50,cursor);output.writeUInt16LE(20,cursor+4);output.writeUInt16LE(33,cursor+12);output.writeUInt32LE(crc,cursor+14);output.writeUInt32LE(entry.bytes.length,cursor+18);output.writeUInt32LE(entry.bytes.length,cursor+22);output.writeUInt16LE(name.length,cursor+26);
    cursor+=30;name.copy(output,cursor);cursor+=name.length;output.set(entry.bytes,cursor);cursor+=entry.bytes.length;
    central.push({name,crc,length:entry.bytes.length,offset:start});
  }
  const centralStart=cursor;
  for(const entry of central){
    output.writeUInt32LE(0x02014b50,cursor);output.writeUInt16LE(20,cursor+4);output.writeUInt16LE(20,cursor+6);output.writeUInt16LE(33,cursor+14);output.writeUInt32LE(entry.crc,cursor+16);output.writeUInt32LE(entry.length,cursor+20);output.writeUInt32LE(entry.length,cursor+24);output.writeUInt16LE(entry.name.length,cursor+28);output.writeUInt32LE(entry.offset,cursor+42);cursor+=46;entry.name.copy(output,cursor);cursor+=entry.name.length;
  }
  output.writeUInt32LE(0x06054b50,cursor);output.writeUInt16LE(entries.length,cursor+8);output.writeUInt16LE(entries.length,cursor+10);output.writeUInt32LE(cursor-centralStart,cursor+12);output.writeUInt32LE(centralStart,cursor+16);return output;
}

function unzip(input:Uint8Array):Map<string,Uint8Array>{
  if(input.length>MAX_OFFLINE_ARCHIVE_BYTES)throw new Error('recording_archive_too_large');
  if(input.length<22)fail();const bytes=Buffer.from(input),end=bytes.length-22;
  if(bytes.readUInt32LE(end)!==0x06054b50||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+20))fail();
  const count=bytes.readUInt16LE(end+10),centralStart=bytes.readUInt32LE(end+16),centralSize=bytes.readUInt32LE(end+12);
  if(count<2||count>102||bytes.readUInt16LE(end+8)!==count||centralStart+centralSize!==end)fail();
  const entries=new Map<string,Uint8Array>();let cursor=centralStart,localCursor=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)fail();
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),size=bytes.readUInt32LE(cursor+20),expanded=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    if(flags||method||size!==expanded||!size||extra||comment||bytes.readUInt16LE(cursor+34)||bytes.readUInt32LE(cursor+38)||offset!==localCursor||cursor+46+nameLength>end)fail();
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength),name=nameBytes.toString('utf8');
    if(!safePath(name)||entries.has(name)||offset+30+nameLength+size>centralStart)fail();
    if(bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt32LE(offset+14)!==crc||bytes.readUInt32LE(offset+18)!==size||bytes.readUInt32LE(offset+22)!==expanded||bytes.readUInt16LE(offset+26)!==nameLength||bytes.readUInt16LE(offset+28)||!bytes.subarray(offset+30,offset+30+nameLength).equals(nameBytes))fail();
    const body=bytes.subarray(offset+30+nameLength,offset+30+nameLength+size);if(crc32(body)!==crc)throw new Error('recording_integrity_failed');
    entries.set(name,body);localCursor=offset+30+nameLength+size;cursor+=46+nameLength;
  }
  if(cursor!==end||localCursor!==centralStart)fail();return entries;
}

export function createOfflineArchive(inputManifest:ExportManifest,inputBundle:CaptureBundle,read:(asset:ExportAsset)=>Uint8Array):Uint8Array{
  const manifest=ManifestSchema.parse(inputManifest),bundle=validateBundle(inputBundle);verifyManifest(bundle,manifest);
  const entries=[{name:'manifest.json',bytes:encode(manifest)},{name:'bundle.json',bytes:encode(bundle)}];
  for(const asset of manifest.assets.filter(mediaKind).sort((a,b)=>a.id.localeCompare(b.id))){const bytes=read(asset);if(bytes.length!==asset.bytes||hash(bytes)!==asset.hash)throw new Error('recording_integrity_failed');entries.push({name:`media/${asset.id}`,bytes:Buffer.from(bytes)});}
  return zip(entries);
}

export function loadOfflineArchive(bytes:Uint8Array,runId='offline-run'){
  const entries=unzip(bytes),manifest=ManifestSchema.parse(JSON.parse(Buffer.from(entries.get('manifest.json')??fail()).toString('utf8'))),bundle=validateBundle(JSON.parse(Buffer.from(entries.get('bundle.json')??fail()).toString('utf8')));
  verifyManifest(bundle,manifest);const assets=manifest.assets.filter(mediaKind);
  if(entries.size!==assets.length+2)fail();
  for(const asset of assets){const body=entries.get(`media/${asset.id}`);if(!body||body.length!==asset.bytes||hash(body)!==asset.hash)throw new Error('recording_integrity_failed');}
  const driver=new ReplayDriver(bundle,runId);
  const resolveMedia=(id:string):{bytes:Uint8Array;mime:string}|null=>{
    const logical=driver.ids.map(id,'logical'),media=bundle.media.find(m=>m.id===logical||m.assetId===logical);if(!media)return null;
    const asset=assets.find(a=>a.id===media.assetId)!;return {bytes:new Uint8Array(entries.get(`media/${asset.id}`)!),mime:asset.mime};
  };
  return {bundle,manifest,driver,resolveMedia};
}
