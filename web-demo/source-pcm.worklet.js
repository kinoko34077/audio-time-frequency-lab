/** #36 R2/R3 experimental AudioWorklet (NOT the default player).
 * Raw mode: bounded source frames; negative speed shifts pitch and 0x is DC.
 * Spectral mode: phase-coherent STFT at the signed source timeline,
 * including a non-DC phase-evolving 0× freeze. Granular remains a comparison
 * mode. Neither guarantees perfect short-loop musical timbre or iPhone CPU.
 */
import {createSourcePCMRenderer,RENDERED_CHUNK_SLOTS} from "./source-pcm-renderer.mjs";
import {createGranularTimePitch,createWsolaTimePitch} from "./source-granular.mjs";
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {createDualTimePitch} from "./source-dual.mjs";
import {createAmTimePitch} from "./source-am.mjs";
import {createRustTimePitch} from "./source-rust.mjs";

class AudioLabSourcePCMProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const props=options.processorOptions||{};
    this.renderer=createSourcePCMRenderer({...props,outputSampleRate:sampleRate});
    this.sourceFrames=props.sourceFrames;
    this.sourceSampleRate=props.sourceSampleRate;
    this.channelCount=props.channelCount;
    this.initialPitchSemitones=props.pitchSemitones??0;
    const mode=props.processingMode??"raw";
    if(!["raw","granular","spectral","pv","wsola","dual","am","live","worker"].includes(mode))
      throw RangeError("unknown PCM processing mode");
    this.processingMode=mode;
    this.workerGeneration=0;
    this.workerPitchSemitones=props.pitchSemitones??0;
    const synthConfig={
      sourceSampleRate:props.sourceSampleRate,outputSampleRate:sampleRate,
      channelCount:props.channelCount,pitchSemitones:props.pitchSemitones??0
    };
    this.synth=mode==="live"?null:
      mode==="dual"?createDualTimePitch({
        ...synthConfig,shortFrames:props.dualShortFrames??512,
        longFrames:props.dualLongFrames??2048
      }):
      mode==="am"?createAmTimePitch(synthConfig):
      mode==="pv"?createSpectralTimePitch({...synthConfig,phaseLock:true}):
      mode==="spectral"?createSpectralTimePitch(synthConfig):
      mode==="wsola"?createWsolaTimePitch({
        ...synthConfig,grainFrames:props.wsolaWindowFrames??1024,
        hopFrames:(props.wsolaWindowFrames??1024)/4
      }):
      mode==="granular"?createGranularTimePitch(synthConfig):null;
    // Retain the old Granular diagnostic view for existing protocol tests
    // and third-party scripts; STFT remains a distinct selected renderer.
    this.granular=mode==="granular"?this.synth:null;
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
          this.synth?.dispose?.();
          this.pendingRequest=null;
          this.renderPending=null;
          this.port.close();
          return;
        }
        if(this.disposed)return;
        if(m.type==="rendered-chunk"){
          if(this.processingMode!=="worker")
            throw Error("rendered Worker chunk sent to another processing mode");
          const bufferedSegments=this.renderer.installRenderedChunk(m);
          this.port.postMessage({type:"rendered-chunk-accepted",
            requestId:m.requestId,generation:m.generation,
            sequence:m.sequence,
            startFrame:m.startFrame,endFrame:m.endFrame,speed:m.speed,
            coreFrames:m.coreFrames,outputFrames:m.channels?.[0]?.length,
            stale:bufferedSegments===false,
            bufferedSegments:this.renderer.statistics.renderedChunkCount});
          return;
        }
        if(m.type==="worker-stage"){
          if(this.processingMode!=="worker"||
             !Number.isSafeInteger(m.generation)||
             m.generation<=this.workerGeneration)
            throw RangeError("invalid staged legacy Worker playback state");
          this.workerSeekRequestId=null;
          const staged=this.renderer.stageRenderedState({
            generation:m.generation,speed:m.speed,
            pitchSemitones:m.pitchSemitones
          });
          this.port.postMessage({type:"worker-state-staged",
            requestId:m.requestId,generation:m.generation,
            sourceFrame:staged.sourceFrame,sequence:staged.sequence,
            speed:m.speed,
            pitchSemitones:m.pitchSemitones,
            bufferedSegments:staged.bufferedSegments,
            stageRequestAudioTime:m.requestAudioTime,
            stageAudioTime:currentTime});
          return;
        }
        if(m.type==="worker-seek-stage"){
          if(this.processingMode!=="worker"||
             !Number.isSafeInteger(m.frame)||m.frame<0||
             m.frame>=this.sourceFrames||!Number.isFinite(m.speed)||
             m.speed<.5||m.speed>2||
             !Number.isFinite(m.pitchSemitones)||
             m.pitchSemitones<-12||m.pitchSemitones>12||
             !Number.isSafeInteger(m.generation)||
             m.generation<=this.workerGeneration||
             !Number.isSafeInteger(m.requiredChunks)||
             m.requiredChunks<1||m.requiredChunks>RENDERED_CHUNK_SLOTS||
             m.reuseCompatible!==undefined&&
               typeof m.reuseCompatible!=="boolean")
            throw RangeError("invalid staged legacy Worker seek");
          const staged=this.renderer.stageRenderedSeekState({
            generation:m.generation,frame:m.frame,speed:m.speed,
            pitchSemitones:m.pitchSemitones,
            requiredChunks:m.requiredChunks,
            reuseCompatible:m.reuseCompatible===true
          });
          this.workerSeekRequestId=m.requestId;
          this.port.postMessage({type:"worker-state-staged",
            requestId:m.requestId,generation:m.generation,
            sourceFrame:staged.sourceFrame,sequence:staged.sequence,
            nextFrame:staged.nextFrame,nextSequence:staged.nextSequence,
            speed:m.speed,pitchSemitones:m.pitchSemitones,
            bufferedSegments:staged.bufferedSegments,
            reusedChunks:staged.reusedChunks,
            stageRequestAudioTime:m.requestAudioTime,
            stageAudioTime:currentTime});
          return;
        }
        if(m.type==="worker-state"){
          if(this.processingMode!=="worker"||
             !Number.isSafeInteger(m.frame)||m.frame<0||m.frame>=this.sourceFrames||
             !Number.isFinite(m.speed)||m.speed<.5||m.speed>2||
             !Number.isFinite(m.pitchSemitones)||
             m.pitchSemitones<-12||m.pitchSemitones>12||
             !Number.isSafeInteger(m.generation)||
             m.generation<=this.workerGeneration)
            throw RangeError("invalid legacy Worker playback state");
          this.workerSeekRequestId=null;
          this.renderer.resetRenderedChunks(m.generation,{
            speed:m.speed,pitchSemitones:m.pitchSemitones
          });
          const st=this.renderer.timeline.scrub(m.frame,m.speed);
          this.workerGeneration=m.generation;
          this.workerPitchSemitones=m.pitchSemitones;
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"worker-state-accepted",
            requestId:m.requestId,generation:m.generation,
            sourceFrame:st.sourceFrame,speed:st.speed,
            pitchSemitones:this.workerPitchSemitones,
            revision:st.revision,
            bufferedSegments:this.renderer.statistics.renderedChunkCount});
          return;
        }
        if(m.type==="rust-init"){
          try{
            if(this.processingMode!=="live"||this.synth)
              throw Error("unexpected Rust source-time initialization");
            this.synth=createRustTimePitch({
              wasmBytes:m.wasmBytes,rustSettings:m.rustSettings,
              sourceSampleRate:this.sourceSampleRate,
              outputSampleRate:sampleRate,
              channelCount:this.channelCount,
              pitchSemitones:this.initialPitchSemitones
            });
            this.port.postMessage({type:"rust-ready"});
          }catch(error){
            this.port.postMessage({type:"rust-error",
              message:error?.message||String(error)});
          }
          return;
        }
        if(m.type==="window"){
          // Ignore late source refills from an obsolete seek, loop or speed.
          if(m.refillId!=null&&m.refillId!==this.pendingRequest)return;
          this.renderer.installWindow(m.start,m.channels,m.pin??null);
          if(m.refillId!=null)this.pendingRequest=null;
          this.port.postMessage({type:"window-accepted",requestId:m.requestId,start:m.start});
          return;
        }
        if(m.type==="seek-window"){
          if(this.processingMode==="worker")
            throw Error("legacy Worker seeks must reset the Worker generation");
          // One atomic handler: install the requested destination PCM before
          // changing source time, without a render quantum between commands.
          this.renderer.installWindow(m.start,m.channels,null,"seek");
          this.renderer.beginOutputTransition();
          const st=this.renderer.timeline.seek(m.frame);
          this.synth?.reset();
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"command-accepted",
            requestId:m.requestId,op:"seek",sourceFrame:st.sourceFrame,
            revision:st.revision,
            processingMode:this.processingMode,
            pitchRevision:this.synth?.state.pitchRevision??null,
            rawPCM:this.processingMode==="raw"});
          return;
        }
        if(m.type==="scrub"){
          if(this.processingMode==="worker")
            throw Error("legacy Worker scrubbing is unavailable");
          const t=this.renderer.timeline;
          // A gesture's exact sample position and instantaneous signed speed
          // must become one audio-thread transaction. The old pair of
          // seek-window+speed commands cleared the granular history at every
          // pointer move and could render an interim, wrong-speed quantum.
          if(!Number.isSafeInteger(m.frame)||m.frame<0||
             m.frame>=this.sourceFrames||
             typeof m.speed!=="number"||!Number.isFinite(m.speed)||
             m.speed<-8||m.speed>8)
            throw RangeError("invalid atomic scratch frame/speed");
          if(m.channels){
            this.renderer.installWindow(m.start,m.channels,null,"seek");
          }
          if(!this.renderer.hasFrame(m.frame))
            throw RangeError("scratch source window missing");
          const previous=t.state.sourceFrame;
          const st=t.scrub(m.frame,m.speed);
          // Ordinary near-sample scrubs must stay responsive. A large jump
          // has no continuous source PCM phase to splice directly.
          if(Math.abs(st.sourceFrame-previous)>128)
            this.renderer.beginOutputTransition();
          this.synth?.shiftSource(st.sourceFrame-previous);
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"command-accepted",
            requestId:m.requestId,op:"scrub",
            sourceFrame:st.sourceFrame,speed:st.speed,
            revision:st.revision,
            processingMode:this.processingMode,
            pitchRevision:this.synth?.state.pitchRevision??null,
            rawPCM:this.processingMode==="raw"});
          return;
        }
        if(m.type==="loop-config"){
          if(this.processingMode==="worker")
            throw Error("A/B playback is unavailable for the legacy Worker");
          // No process() callback can run between endpoint-cache installation
          // and transport bounds/enable update in this synchronous handler.
          this.renderer.beginOutputTransition();
          const st=this.renderer.applyLoopConfiguration(
            m.a,m.b,m.enabled,m.endpoints
          );
          this.synth?.reset();
          this.pendingRequest=null;
          this.queueRenderReceipt(m.requestId,st);
          this.port.postMessage({type:"command-accepted",requestId:m.requestId,
            op:m.op,sourceFrame:st.sourceFrame,revision:st.revision,
            loopStartFrame:st.loopStartFrame,loopEndFrame:st.loopEndFrame,
            loopEnabled:st.loopEnabled,
            processingMode:this.processingMode,
            pitchRevision:this.synth?.state.pitchRevision??null,
            rawPCM:this.processingMode==="raw"});
          return;
        }
        if(m.type!=="command")return;
        const t=this.renderer.timeline;
        switch(m.op){
          case "play":this.running=true;break;
          case "pause":this.running=false;break;
          case "seek":
            if(this.processingMode==="worker")
              throw Error("legacy Worker seeks must reset the Worker generation");
            this.renderer.beginOutputTransition();
            t.seek(m.frame);this.synth?.reset();break;
          case "speed":
            if(this.processingMode==="worker")
              throw Error("legacy Worker speed changes must reset the Worker generation");
            t.setSpeed(m.speed);
            // Keep the existing overlap grains and output-time epoch: a
            // scrub wheel changes signed speed many times per second.
            // Clearing every grain on every speed command produces audible
            // joins even when the source PCM window is already cached.
            this.synth?.beginTransition();
            break;
          case "pitch":
            if(this.processingMode==="worker")
              throw Error("legacy Worker pitch changes must reset the Worker generation");
            if(!this.synth)
              throw RangeError("independent pitch requires spectral or granular mode");
            this.synth.setPitch(m.semitones);
            break;
          case "bounds":
            if(this.processingMode==="worker")
              throw Error("A/B playback is unavailable for the legacy Worker");
            this.renderer.beginOutputTransition();
            t.setLoopBounds(m.a,m.b);
            this.synth?.reset();break;
          case "loop":
            if(this.processingMode==="worker")
              throw Error("A/B playback is unavailable for the legacy Worker");
            this.renderer.beginOutputTransition();
            t.setLoopEnabled(m.enabled);
            this.synth?.reset();break;
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
          pitchRevision:this.synth?.state.pitchRevision??null,
          pitchSemitones:this.synth?.state.pitchSemitones??null,
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
      pitchRevision:this.synth?.state.pitchRevision??null};
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
      pitchSemitones:this.processingMode==="worker"?
        this.workerPitchSemitones:this.synth?.state.pitchSemitones??null,
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
    const missing=this.processingMode==="worker"?
      this.renderer.renderBuffered(out):
      this.processingMode==="spectral"||this.processingMode==="pv"?
      this.renderer.renderSpectral(out,this.synth):
      this.processingMode==="live"?
      this.renderer.renderRust(out,this.synth):
      this.synth?this.renderer.renderGranular(out,this.synth):
      this.renderer.render(out);
    const workerActivation=this.processingMode==="worker"?
      this.renderer.takeWorkerActivation():null;
    if(workerActivation){
      this.workerGeneration=workerActivation.generation;
      this.workerPitchSemitones=workerActivation.pitchSemitones;
      const requestId=this.workerSeekRequestId??null;
      if(requestId!==null){
        this.workerSeekRequestId=null;
        this.queueRenderReceipt(requestId,workerActivation);
      }
      this.port.postMessage({type:"worker-state-activated",
        ...workerActivation,requestId,
        activationAudioTime:currentTime+
          (workerActivation.sampleOffset??0)/sampleRate,
        bufferedSegments:this.renderer.statistics.renderedChunkCount,
        missingFrames:this.renderer.statistics.missingFrames});
    }
    this.emitRenderReceipt(workerActivation?.sourceFrame??sourceFrame,missing);
    this.blocks++;
    // Host window cache refill is outside the audio callback and never
    // blocks or starts/stops the AudioWorklet on every loop wrap.
    if(missing&&this.processingMode!=="worker"){
      // Request the actual first missing source frame, not the block's
      // still-cached starting frame (which may never trigger a refill).
      this.request(this.renderer.firstMissingFrame);
      this.lastMissing=missing;
    }
    if(this.blocks%8===0){
      if(this.processingMode!=="worker")
        this.request(this.renderer.needsSourceWindow(4096));
      const state=this.renderer.timeline.state;
      const stats=this.renderer.statistics;
      this.port.postMessage({
        type:"progress",sourceFrame:state.sourceFrame,
        revision:state.revision,ended:state.ended,
        // Render-completed clock sample: main-thread waveform interpolation
        // uses this metadata only for paint; never for audio scheduling.
        outputTime:typeof currentTime==="number"?
          currentTime+out[0].length/sampleRate:null,
        speed:state.speed,running:this.running,
        loopEnabled:state.loopEnabled,
        loopStartFrame:state.loopStartFrame,
        loopEndFrame:state.loopEndFrame,
        renderedFrames:stats.renderedFrames,
        missingFrames:stats.missingFrames,
        firstMissingFrame:this.renderer.firstMissingFrame,
        processingMode:this.processingMode,
        pitchSemitones:this.processingMode==="worker"?
          this.workerPitchSemitones:this.synth?.state.pitchSemitones??null,
        pitchRevision:this.synth?.state.pitchRevision??null,
        rawPCM:this.processingMode==="raw",
        bufferedSegments:stats.renderedChunkCount,
        workerGeneration:this.processingMode==="worker"?
          this.workerGeneration:null,
        workerPitchSemitones:this.processingMode==="worker"?
          this.workerPitchSemitones:null
      });
    }
    return true;
  }
}
registerProcessor("audio-lab-source-pcm",AudioLabSourcePCMProcessor);
