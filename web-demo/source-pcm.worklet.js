/** #36 R2 experimental raw-source AudioWorklet (NOT the player default).
 * Sound comes from bounded Float32Array source windows, not a 1.5s Worker.
 * Negative speed changes pitch; speed zero holds a PCM sample (DC).
 * A later DSP stage must provide independent musical pitch/frozen-time tone.
 */
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";

class AudioLabSourcePCMProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const props=options.processorOptions||{};
    this.renderer=createSourcePCMRenderer({...props,outputSampleRate:sampleRate});
    this.running=false;
    this.disposed=false;
    this.blocks=0;
    this.pendingRequest=null;
    this.lastMissing=0;
    this.port.onmessage=event=>{
      const m=event.data||{};
      try{
        if(m.type==="dispose"){
          this.running=false;
          this.disposed=true;
          this.pendingRequest=null;
          this.port.close();
          return;
        }
        if(this.disposed)return;
        if(m.type==="window"){
          this.renderer.installWindow(m.start,m.channels,m.pin??null);
          this.pendingRequest=null;
          this.port.postMessage({type:"window-accepted",requestId:m.requestId,start:m.start});
          return;
        }
        if(m.type==="seek-window"){
          // One atomic handler: install the requested destination PCM before
          // changing source time, without a render quantum between commands.
          this.renderer.installWindow(m.start,m.channels,null,"seek");
          const st=this.renderer.timeline.seek(m.frame);
          this.pendingRequest=null;
          this.port.postMessage({type:"command-accepted",
            requestId:m.requestId,op:"seek",sourceFrame:st.sourceFrame,
            revision:st.revision,rawPCM:true});
          return;
        }
        if(m.type!=="command")return;
        const t=this.renderer.timeline;
        switch(m.op){
          case "play":this.running=true;break;
          case "pause":this.running=false;break;
          case "seek":t.seek(m.frame);break;
          case "speed":t.setSpeed(m.speed);break;
          case "bounds":t.setLoopBounds(m.a,m.b);break;
          case "loop":t.setLoopEnabled(m.enabled);break;
          default:throw RangeError("unknown source PCM worklet command");
        }
        const st=t.state;
        this.port.postMessage({type:"command-accepted",requestId:m.requestId,op:m.op,
          sourceFrame:st.sourceFrame,revision:st.revision,rawPCM:true});
      }catch(error){
        this.port.postMessage({type:"error",requestId:m.requestId,
          message:error?.message||String(error)});
      }
    };
  }
  request(frame){
    if(frame===null||this.pendingRequest===frame)return;
    this.pendingRequest=frame;
    this.port.postMessage({type:"need-window",frame});
  }
  process(_input,outputs){
    const out=outputs[0];
    if(this.disposed)return false;
    if(!out?.length||!out[0]?.length)return true;
    if(!this.running){
      for(const ch of out)ch.fill(0);
      return true;
    }
    const missing=this.renderer.render(out);
    this.blocks++;
    // Host window cache refill is outside the audio callback and never
    // blocks or starts/stops the AudioWorklet on every loop wrap.
    if(missing){
      // Request the actual first missing source frame, not the block's
      // still-cached starting frame (which may never trigger a refill).
      this.request(this.renderer.firstMissingFrame);
      this.lastMissing=missing;
    }
    if(this.blocks%8===0){
      this.request(this.renderer.needsSourceWindow(4096));
      const state=this.renderer.timeline.state;
      const stats=this.renderer.statistics;
      this.port.postMessage({
        type:"progress",sourceFrame:state.sourceFrame,
        revision:state.revision,ended:state.ended,
        renderedFrames:stats.renderedFrames,
        missingFrames:stats.missingFrames,
        rawPCM:true
      });
    }
    return true;
  }
}
registerProcessor("audio-lab-source-pcm",AudioLabSourcePCMProcessor);
