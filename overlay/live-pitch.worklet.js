/* Real-time granular pitch compensation.
 * Input is an AudioBufferSourceNode playing at the desired SPEED.
 * This worklet compensates pitch by ratio q = requestedPitch / speed,
 * without pre-rendering the recording. This is not the offline PV/WSOLA
 * analysis engine and does not claim phase-perfect reconstruction.
 * User-provided audio never leaves the browser.
 */
class LabPitchWorklet extends AudioWorkletProcessor {
  constructor(){
    super();
    this.ring=Array.from({length:2},()=>new Float32Array(32768));
    this.index=0;
    this.filled=0;
    this.phase=0;
    this.ratio=1;
    this.pending=null;
    this.port.onmessage=({data})=>{
      if(data?.type==="params" && Number.isFinite(data.ratio) && data.ratio>=0.125 && data.ratio<=8){
        this.pending=data.ratio;
      }
      if(data?.type==="reset"){this.index=0;this.filled=0;this.phase=0;this.ring.forEach(b=>b.fill(0));}
    };
  }
  delayed(channel,delay){
    const ring=this.ring[channel]||this.ring[0],mask=ring.length-1;
    const position=this.index-1-delay;
    const index=Math.floor(position);
    const fract=position-index;
    return ring[index&mask]*(1-fract)+ring[(index+1)&mask]*fract;
  }
  process(inputs,outputs){
    const input=inputs[0]||[],out=outputs[0]||[];
    const frames=out[0]?.length||128;
    if(this.pending!==null){this.ratio=this.pending;this.pending=null;}
    // Fixed delay 15–65ms; overlap two delay heads at opposite phase.
    const low=Math.max(96,Math.floor(sampleRate*.015)),span=Math.max(128,Math.floor(sampleRate*.05));
    const q=this.ratio,diff=1-q,rate=Math.abs(diff)/span;
    for(let n=0;n<frames;n++){
      const index=this.index&32767;
      for(let ch=0;ch<2;ch++)this.ring[ch][index]=input[ch]?.[n]??input[0]?.[n]??0;
      this.index++;this.filled=Math.min(32768,this.filled+1);
      const ph=this.phase,opp=(ph+.5)%1;
      const delayFor=t=>low+(diff<0?span*(1-t):span*t);
      const a=delayFor(ph),b=delayFor(opp);
      const weight=Math.sin(Math.PI*ph)**2;
      for(let ch=0;ch<out.length;ch++){
        const raw=input[ch]?.[n]??input[0]?.[n]??0;
        out[ch][n]=Math.abs(diff)<1e-5?raw:
          this.filled<low+span+3?0:
          this.delayed(ch,a)*weight+this.delayed(ch,b)*(1-weight);
      }
      this.phase=(this.phase+rate)%1;
    }
    return true;
  }
}
registerProcessor("audio-lab-live-pitch",LabPitchWorklet);
