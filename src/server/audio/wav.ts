/** Canonical independently playable PCM16 mono RIFF/WAV. Safe in both browser and server. */
export function encodeWav(samples:Float32Array,sampleRate:number):Uint8Array {
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000)throw new Error('Invalid sample rate.');
  const bytes=new Uint8Array(44+samples.length*2),view=new DataView(bytes.buffer);
  const ascii=(at:number,text:string)=>{for(let i=0;i<text.length;i++)bytes[at+i]=text.charCodeAt(i);};
  ascii(0,'RIFF');view.setUint32(4,bytes.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const sample=Math.max(-1,Math.min(1,Number.isFinite(samples[i])?samples[i]:0));view.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);}
  return bytes;
}
export function parseWav(bytes:Uint8Array):{sampleRate:number;durationMs:number;samples:number;rms:number;peak:number} {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const ascii=(at:number,len:number)=>String.fromCharCode(...bytes.subarray(at,at+len));
  if(bytes.length<44||bytes.length>6_000_000||ascii(0,4)!=='RIFF'||ascii(8,4)!=='WAVE'||view.getUint32(4,true)!==bytes.length-8||ascii(12,4)!=='fmt '||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint16(32,true)!==2||view.getUint16(34,true)!==16||ascii(36,4)!=='data'||view.getUint32(40,true)!==bytes.length-44||(bytes.length-44)%2)throw new Error('Invalid standalone PCM WAV.');
  const sampleRate=view.getUint32(24,true);if(sampleRate<8000||sampleRate>96000||view.getUint32(28,true)!==sampleRate*2)throw new Error('Invalid sample rate.');
  const samples=(bytes.length-44)/2;let sum=0,peak=0;for(let i=0;i<samples;i++){const value=view.getInt16(44+i*2,true)/32768;sum+=value*value;peak=Math.max(peak,Math.abs(value));}
  return {sampleRate,durationMs:samples/sampleRate*1000,samples,rms:Math.sqrt(sum/Math.max(1,samples)),peak};
}
