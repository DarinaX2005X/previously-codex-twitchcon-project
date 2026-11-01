import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createFFmpegProbe,type MediaRecord} from '../media/cache.js';

const execute=promisify(execFile),limit=3_000_000;
/** Derive a bounded export from an owner-selected, already validated cache item.
 * Video always uses NVIDIA H.264; no software fallback silently changes that policy.
 * The complete original range is retained for privacy lineage even after encoding. */
export async function prepareRecordingMedia(input:{record:MediaRecord;path:string},privateDirectory:string):Promise<{bytes:Uint8Array;mime:'video/mp4'|'audio/wav'|'audio/mpeg';derived:boolean}>{
  const {record,path}=input,info=await stat(path);
  if(info.size!==record.size||info.size<=0||info.size>80_000_000||record.durationMs<=0||record.durationMs>120000)throw new Error('recording_media_changed');
  const accepted=['video/mp4','audio/wav','audio/mpeg'].includes(record.mimeType);
  if(info.size<=limit&&accepted)return {bytes:new Uint8Array(await readFile(path)),mime:record.mimeType as 'video/mp4'|'audio/wav'|'audio/mpeg',derived:false};
  const video=record.kind==='video',output=join(privateDirectory,`prepare-${randomUUID()}.${video?'mp4':'mp3'}`),seconds=record.durationMs/1000;
  const bitrate=Math.max(96_000,Math.min(1_800_000,Math.floor(2_450_000*8/seconds)-48_000));
  const args=['-v','error','-nostdin','-protocol_whitelist','file,pipe','-i',path,'-map_metadata','-1','-t',String(seconds),...(video?['-map','0:v:0','-map','0:a:0?','-vf','scale=w=min(640\\,iw):h=-2,fps=24','-c:v','h264_nvenc','-preset','p4','-rc','cbr','-b:v',String(bitrate),'-maxrate',String(bitrate),'-bufsize',String(bitrate*2),'-pix_fmt','yuv420p','-c:a','aac','-b:a','48k','-ac','1','-movflags','+faststart']:['-map','0:a:0','-vn','-c:a','libmp3lame','-b:a','64k','-ac','1']),'-y',output];
  try{
    await execute('ffmpeg',args,{timeout:120000,maxBuffer:100000,windowsHide:true});
    const size=(await stat(output)).size;if(!size||size>limit)throw new Error('recording_media_export_too_large');
    const probe=await createFFmpegProbe()(output,record.kind);if(Math.abs(probe.durationMs-record.durationMs)>250)throw new Error('recording_media_duration_changed');
    return {bytes:new Uint8Array(await readFile(output)),mime:video?'video/mp4':'audio/mpeg',derived:true};
  }finally{await unlink(output).catch(()=>{});}
}
