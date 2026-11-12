/** #36 R2 test-only worklet: independent post-render PCM observer.
 * This Worklet records actual audio graph samples; it does not use
 * source-pcm-renderer missing counters or synthesize the measured signal.
 * The test's source is nonzero constant PCM; measured zeros are therefore
 * unexpected once the graph is armed and warmed up.
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
    this.frames=0;this.nonzero=0;this.zero=0;this.blocks=0;
    this.maxStep=0;this.maxAbs=0;this.previous=0;this.hasPrevious=false;
    this.squared=0;this.peakChannels=0;
  }
  stats(){
    return {frames:this.frames,nonzeroFrames:this.nonzero,
      zeroFrames:this.zero,blocks:this.blocks,maxStep:this.maxStep,
      maxAbs:this.maxAbs,rms:this.frames?
        Math.sqrt(this.squared/this.frames):0,
      inputChannels:this.peakChannels};
  }
  process(inputs,outputs){
    const incoming=inputs[0]||[],outgoing=outputs[0]||[];
    for(let ch=0;ch<outgoing.length;ch++){
      const source=incoming[ch]||incoming[0];
      if(source)outgoing[ch].set(source);
      else outgoing[ch].fill(0);
    }
    if(!this.active||!incoming.length)return true;
    const first=incoming[0];
    this.peakChannels=Math.max(this.peakChannels,incoming.length);
    for(let i=0;i<first.length;i++){
      const value=first[i];
      if(Math.abs(value)<1e-7)this.zero++;
      else this.nonzero++;
      const abs=Math.abs(value);
      if(abs>this.maxAbs)this.maxAbs=abs;
      if(this.hasPrevious)this.maxStep=Math.max(this.maxStep,Math.abs(value-this.previous));
      this.previous=value;this.hasPrevious=true;
      this.squared+=value*value;this.frames++;
    }
    this.blocks++;
    return true;
  }
}
registerProcessor("audio-lab-pcm-probe",AudioLabPCMProbe);
