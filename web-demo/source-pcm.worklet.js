/** #36 R2/R3 experimental AudioWorklet (NOT the default player).
 * Raw mode: bounded source frames; negative speed shifts pitch and 0x is DC.
 * Granular mode: provisional independent grain pitch and audible 0x;
 * formal music/transient/CPU/mobile quality acceptance is still OPEN.
 */
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {createGranularTimePitch} from "./source-granular.mjs";

class AudioLabSourcePCMProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const props=options.processorOptions||{};
    this.renderer=createSourcePCMRenderer({...props,outputSampleRate:sampleRate});
    const mode=props.processingMode??"raw";
    if(mode!=="raw"&&mode!=="granular")
      throw RangeError("unknown PCM processing mode");
    this.processingMode=mode;
    this.granular=mode==="granular"?createGranularTimePitch({
      sourceSampleRate:props.sourceSampleRate,
      outputSampleRate:sampleRate,
      channelCount:props.channelCount,
      pitchSemitones:props.pitchSemitones??0
    }):null;
    this.running=false;
    this.disposed=false;
    this.blocks=0;
    this.pendingRequest=null;
    this.refillSequence=0;
    this.lastMissing=0;
    this.renderPending=null;
    this.port.onmessage=event=>{
      const m=event.data||{};
      try{
        if(m.type==="dispose"){
          this.running=false;
          this.disposed=true;
          this.pendingRequest=null;
          this.renderPending=null;
          this.port.close();
          return;
        }
        if(this.disposed)return;
        if(m.type==="window"){
          // Ignore late source refills from an obsolete seek, loop or speed.
          if(m.refillId!=null&&m.refillId!==this.pendingRequest)return;
          this.renderer.installWindow(m.start,m.channels,m.pin??null);
          if(m.refillId!=null)this.pendingRequest=null;
          this.port.postMessage({type:"window-accepted",requestId:m.requestId,start:m.start});
          return;
        }
        if(m.type==="seek-window"){
          // One atomic handler: install the requested destination PCM before
          // changing source time, without a render quantum between commands.
          this.renderer.installWindow(m.start,m.channels,null,"seek");
          const st=this.renderer.timeline.seek(m.frame);
          this.granular?.reset();
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"command-accepted",
            requestId:m.requestId,op:"seek",sourceFrame:st.sourceFrame,
            revision:st.revision,
            processingMode:this.processingMode,
            pitchRevision:this.granular?.state.pitchRevision??null,
            rawPCM:this.processingMode==="raw"});
          return;
        }
        if(m.type==="loop-config"){
          // No process() callback can run between endpoint-cache installation
          // and transport bounds/enable update in this synchronous handler.
          const st=this.renderer.applyLoopConfiguration(
            m.a,m.b,m.enabled,m.endpoints
          );
          this.granular?.reset();
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"command-accepted",requestId:m.requestId,
            op:m.op,sourceFrame:st.sourceFrame,revision:st.revision,
            loopStartFrame:st.loopStartFrame,loopEndFrame:st.loopEndFrame,
            loopEnabled:st.loopEnabled,
            processingMode:this.processingMode,
            pitchRevision:this.granular?.state.pitchRevision??null,
            rawPCM:this.processingMode==="raw"});
          return;
        }
        if(m.type!=="command")return;
        const t=this.renderer.timeline;
        switch(m.op){
          case "play":this.running=true;break;
          case "pause":this.running=false;break;
          case "seek":t.seek(m.frame);this.granular?.reset();break;
          case "speed":
            t.setSpeed(m.speed);
            this.granular?.reset();
            break;
          case "pitch":
            if(!this.granular)
              throw RangeError("independent pitch requires granular mode");
            this.granular.setPitch(m.semitones);
            break;
          case "bounds":t.setLoopBounds(m.a,m.b);
            this.granular?.reset();break;
          case "loop":t.setLoopEnabled(m.enabled);
            this.granular?.reset();break;
          default:throw RangeError("unknown source PCM worklet command");
        }
        if(m.op==="seek"||m.op==="speed"||m.op==="bounds"||
           m.op==="loop"||m.op==="pitch")
          this.pendingRequest=null;
        const st=t.state;
        this.queueRenderReceipt(m.requestId,st);
        this.port.postMessage({type:"command-accepted",requestId:m.requestId,op:m.op,
          sourceFrame:st.sourceFrame,revision:st.revision,
          processingMode:this.processingMode,
          pitchRevision:this.granular?.state.pitchRevision??null,
          pitchSemitones:this.granular?.state.pitchSemitones??null,
          rawPCM:this.processingMode==="raw"});
      }catch(error){
        this.port.postMessage({type:"error",requestId:m.requestId,
          message:error?.message||String(error)});
      }
    };
  }
  queueRenderReceipt(requestId,state){
    // A command accepted by the message handler may never reach an output
    // quantum if another command arrives first. Do not falsely report that
    // the earlier command was heard.
    if(this.renderPending){
      this.port.postMessage({type:"render-superseded",
        requestId:this.renderPending.requestId,
        revision:this.renderPending.revision,
        pitchRevision:this.renderPending.pitchRevision,
        supersededBy:requestId});
    }
    this.renderPending={requestId,revision:state.revision,
      pitchRevision:this.granular?.state.pitchRevision??null};
  }
  emitRenderReceipt(sourceFrame,missingInBlock){
    const pending=this.renderPending;
    if(!pending)return;
    this.renderPending=null;
    // currentFrame belongs to AudioWorkletGlobalScope. The first frame of
    // this output quantum is the exact render-thread observation boundary,
    // NOT the speaker/DAC presentation time.
    this.port.postMessage({type:"render-applied",
      requestId:pending.requestId,revision:pending.revision,
      pitchRevision:pending.pitchRevision,
      processingMode:this.processingMode,
      outputFrame:typeof currentFrame==="number"?currentFrame:null,
      outputTime:typeof currentTime==="number"?currentTime:null,
      sourceFrame,missingFramesInBlock:missingInBlock,
      running:this.running,rawPCM:this.processingMode==="raw"});
  }
  request(frame){
    if(frame===null||this.pendingRequest!==null)return;
    // Bound outstanding source copies to one request per processor. A stalled
    // main thread must not accumulate thousands of overlapping PCM windows.
    const refillId=++this.refillSequence;
    this.pendingRequest=refillId;
    this.port.postMessage({type:"need-window",frame,refillId});
  }
  process(_input,outputs){
    const out=outputs[0];
    if(this.disposed)return false;
    if(!out?.length||!out[0]?.length)return true;
    const sourceFrame=this.renderer.timeline.state.sourceFrame;
    if(!this.running){
      for(const ch of out)ch.fill(0);
      this.emitRenderReceipt(sourceFrame,0);
      return true;
    }
    const missing=this.granular?
      this.renderer.renderGranular(out,this.granular):
      this.renderer.render(out);
    this.emitRenderReceipt(sourceFrame,missing);
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
        processingMode:this.processingMode,
        pitchSemitones:this.granular?.state.pitchSemitones??null,
        pitchRevision:this.granular?.state.pitchRevision??null,
        rawPCM:this.processingMode==="raw"
      });
    }
    return true;
  }
}
registerProcessor("audio-lab-source-pcm",AudioLabSourcePCMProcessor);
