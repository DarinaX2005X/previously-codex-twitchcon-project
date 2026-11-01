class PreviouslyPCM extends AudioWorkletProcessor {
  constructor(){super();this.pending=new Float32Array(2048);this.used=0;}
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;const length=channels[0].length;for(let i=0;i<length;i++){let sum=0;for(const channel of channels)sum+=channel[i]||0;this.pending[this.used++]=sum/channels.length;if(this.used===this.pending.length){this.port.postMessage(this.pending,[this.pending.buffer]);this.pending=new Float32Array(2048);this.used=0;}}return true;}
}
registerProcessor('previously-pcm',PreviouslyPCM);
