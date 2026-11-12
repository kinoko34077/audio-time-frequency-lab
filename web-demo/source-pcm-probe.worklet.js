/** #36 R2 test-only worklet: independent stereo post-render PCM observer.
 * Captures EACH input channel from the real audio graph, independent of
 * source-pcm-renderer telemetry. Nonzero constant source is the known oracle.
 */
class AudioLabPCMProbe extends AudioWorkletProcessor {
  constructor(){
    super();
    this.active=false;
    this.reset();
    this.port.onmessage=e=>{
      const {op,id}=e.data||{};
      if(op==="arm"){this.reset();this.active=true;}
      else if(op==="snapshot"){}
      else if(op==="disarm")this.active=false;
      else return;
      this.port.postMessage({id,op,stats:this.stats()});
    };
  }
  reset(){
    this.channels=[];
    this.blocks=0;
    this.peakChannels=0;
  }
  stats(){
    const channels=this.channels.map(c=>({
      frames:c.frames,zeroFrames:c.zero,nonzeroFrames:c.nonzero,
      maxStep:c.maxStep,maxAbs:c.maxAbs,
      rms:c.frames?Math.sqrt(c.squared/c.frames):0
    }));
    const first=channels[0]||{frames:0,zeroFrames:0,nonzeroFrames:0,
      maxStep:0,maxAbs:0,rms:0};
    return {...first,blocks:this.blocks,inputChannels:this.peakChannels,
      channels};
  }
  process(inputs,outputs){
    const incoming=inputs[0]||[],outgoing=outputs[0]||[];
    for(let ch=0;ch<outgoing.length;ch++){
      const source=incoming[ch]||incoming[0];
      if(source)outgoing[ch].set(source);
      else outgoing[ch].fill(0);
    }
    if(!this.active||!incoming.length)return true;
    this.peakChannels=Math.max(this.peakChannels,incoming.length);
    for(let channel=0;channel<incoming.length;channel++){
      const samples=incoming[channel];
      let c=this.channels[channel];
      if(!c){
        c={frames:0,nonzero:0,zero:0,maxStep:0,maxAbs:0,
          previous:0,hasPrevious:false,squared:0};
        this.channels[channel]=c;
      }
      for(let i=0;i<samples.length;i++){
        const value=samples[i],abs=Math.abs(value);
        if(abs<1e-7)c.zero++;
        else c.nonzero++;
        if(abs>c.maxAbs)c.maxAbs=abs;
        if(c.hasPrevious)c.maxStep=Math.max(c.maxStep,
          Math.abs(value-c.previous));
        c.previous=value;c.hasPrevious=true;
        c.squared+=value*value;c.frames++;
      }
    }
    this.blocks++;
    return true;
  }
}
registerProcessor("audio-lab-pcm-probe",AudioLabPCMProbe);
