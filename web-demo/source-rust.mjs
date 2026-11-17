/**
 * Engine-3 Rust partial + residual synthesis on the shared PCM source clock.
 * The host supplies source-positioned analysis/probe windows; Rust retains
 * the canonical peak tracking, spectral residual and overlap-add DSP.
 */
const finite=value=>typeof value==="number"&&Number.isFinite(value);

export function createRustTimePitch({
  wasmBytes,rustSettings,sourceSampleRate,outputSampleRate,
  channelCount=1,pitchSemitones=0
}={}){
  if(!(wasmBytes instanceof ArrayBuffer)||!rustSettings||
     rustSettings.engine!==3||!finite(sourceSampleRate)||sourceSampleRate<=0||
     !finite(outputSampleRate)||outputSampleRate<=0||
     !Number.isInteger(channelCount)||channelCount<1||channelCount>2||
     !finite(pitchSemitones)||pitchSemitones<-12||pitchSemitones>12)
    throw RangeError("invalid Rust source-time configuration");
  const ratio=2**(pitchSemitones/12);
  const instance=new WebAssembly.Instance(new WebAssembly.Module(wasmBytes),{});
  const e=instance.exports;
  if(!e.memory||!(e.memory instanceof WebAssembly.Memory))
    throw Error("Rust source-time WASM memory is missing");
  for(const name of ["memory","warp_alloc_f32","warp_free_f32",
    "warp_stream_create_ext","warp_stream_free","warp_stream_reset",
    "warp_stream_window_frames","warp_stream_hop_frames",
    "warp_stream_process_source_window","warp_stream_set_source_rate",
    "warp_stream_set_source_pitch","warp_stream_set_transform",
    "warp_stream_set_geometry","warp_stream_set_a_options",
    "warp_stream_set_a_band","warp_stream_set_a_quality",
    "warp_stream_set_zero_reflect_gain","warp_stream_set_zero_reflect_decay",
    "warp_stream_set_crusher"]){
    if(typeof e[name]!=="function"&&name!=="memory")
      throw Error("Rust source-time ABI is missing "+name);
  }
  const mode=rustSettings.mode==="blend"?1:
    rustSettings.mode==="fold-l"?2:rustSettings.mode==="reciprocal"?3:0;
  const stream=e.warp_stream_create_ext(outputSampleRate,channelCount,
    rustSettings.low,rustSettings.high,rustSettings.curvature,rustSettings.invert,
    mode,rustSettings.qualityIndex,rustSettings.outside==="pass"?1:0,
    3,ratio,rustSettings.shiftHz,rustSettings.carrierHz,
    rustSettings.zeroMode,rustSettings.hopDiv);
  if(!stream)throw Error("Rust source-time engine initialization failed");
  let inputPtr=0,probePtr=0,outputPtr=0,disposed=false;
  try{
    const setters=[
      e.warp_stream_set_source_rate(stream,sourceSampleRate),
      e.warp_stream_set_transform(stream,rustSettings.axisShift,
        rustSettings.axisReference,rustSettings.ringEnabled?1:0,
        rustSettings.rationalEnabled?1:0),
      e.warp_stream_set_geometry(stream,rustSettings.axisPivot,rustSettings.axisSlope),
      e.warp_stream_set_a_options(stream,rustSettings.aMinHz,rustSettings.aReverb),
      e.warp_stream_set_a_band(stream,rustSettings.aBandBins),
      e.warp_stream_set_a_quality(stream,rustSettings.aQuality),
      e.warp_stream_set_zero_reflect_gain(stream,rustSettings.zeroReflectGain),
      e.warp_stream_set_zero_reflect_decay(stream,rustSettings.zeroReflectDecay),
      e.warp_stream_set_crusher(stream,rustSettings.crusherBits,rustSettings.crusherHold)
    ];
    if(setters.some(code=>code!==0))
      throw Error("Rust source-time engine settings were rejected");
    const windowFrames=e.warp_stream_window_frames(stream);
    const hopFrames=e.warp_stream_hop_frames(stream);
    if(!windowFrames||!hopFrames||windowFrames%4!==0)
      throw Error("Rust source-time window geometry is invalid");
    const inputLength=windowFrames*channelCount;
    const outputLength=hopFrames*channelCount;
    inputPtr=e.warp_alloc_f32(inputLength);
    probePtr=e.warp_alloc_f32(inputLength);
    outputPtr=e.warp_alloc_f32(outputLength);
    if(!inputPtr||!probePtr||!outputPtr)
      throw Error("Rust source-time PCM buffers could not be allocated");
    const input=new Float32Array(e.memory.buffer,inputPtr,inputLength);
    const probe=new Float32Array(e.memory.buffer,probePtr,inputLength);
    const output=new Float32Array(e.memory.buffer,outputPtr,outputLength);
    const hop=Array.from({length:channelCount},(_,channel)=>
      new Float32Array(output.buffer,output.byteOffset+channel*hopFrames*4,hopFrames));
    const last=new Float32Array(channelCount),fadeFrom=new Float32Array(channelCount);
    let pitch=pitchSemitones,pitchRatio=ratio,pitchRevision=0;
    let outputFrames=0,nextStart=0,pendingIndex=hopFrames;
    let fadeLeft=0,missingFirst=null,missingTotal=0;
    const fadeLength=128;

    function beginTransition(){fadeFrom.set(last);fadeLeft=fadeLength;}
    function reset(){
      beginTransition();
      if(e.warp_stream_reset(stream)!==0)
        throw Error("Rust source-time stream reset failed");
      outputFrames=0;nextStart=0;pendingIndex=hopFrames;
      for(const channel of hop)channel.fill(0);
    }
    function setPitch(semitones){
      if(!finite(semitones)||semitones<-12||semitones>12)
        throw RangeError("pitch must be finite within -12..12 semitones");
      if(semitones!==pitch){
        const next=2**(semitones/12);
        if(e.warp_stream_set_source_pitch(stream,next)!==0)
          throw Error("Rust source-time pitch update failed");
        pitch=semitones;pitchRatio=next;pitchRevision++;beginTransition();
      }
      return {pitchSemitones:pitch,pitchRatio,pitchRevision};
    }
    function sampleWindow(target,offset,read,sourceFrames,state,channel,missing){
      let position=target+offset;
      if(state.loopEnabled){
        const length=state.loopEndFrame-state.loopStartFrame;
        position=state.loopStartFrame+
          ((position-state.loopStartFrame)%length+length)%length;
      }
      if(position<0||position>=sourceFrames)return 0;
      const index=Math.floor(position),fraction=position-index;
      const next=fraction===0?index:
        state.loopEnabled&&index+1>=state.loopEndFrame?
          state.loopStartFrame:Math.min(sourceFrames-1,index+1);
      const x=read(channel,index),y=fraction===0?x:read(channel,next);
      if(!finite(x)||!finite(y)){
        if(missing.first===null)missing.first=!finite(x)?index:next;
        missing.total++;return 0;
      }
      return x+(y-x)*fraction;
    }
    function render(outputChannels,state,read,sourceFrames,sourceFrameAt){
      if(disposed||!Array.isArray(outputChannels)||
         outputChannels.length!==channelCount||
         outputChannels.some(ch=>!(ch instanceof Float32Array)||
           ch.length!==outputChannels[0].length)||
         !state||typeof read!=="function"||typeof sourceFrameAt!=="function"||
         !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
        throw RangeError("invalid Rust source-time PCM render");
      const frames=outputChannels[0].length;
      const missing={first:null,total:0};
      for(let i=0;i<frames;i++){
        if(pendingIndex>=hopFrames){
          let sourceCenter=sourceFrameAt(nextStart+windowFrames/2-outputFrames);
          if(sourceCenter===null&&!state.loopEnabled){
            // The render window can extend past a clip boundary while its
            // output hop is still in range. Anchor at the nearest endpoint;
            // sampleWindow zero-pads only the out-of-range part of each window.
            sourceCenter=state.speed<0?0:state.speed>0?sourceFrames-1:
              Math.max(0,Math.min(sourceFrames-1,state.sourceFrame));
          }
          input.fill(0);probe.fill(0);
          if(sourceCenter!==null){
            for(let channel=0;channel<channelCount;channel++){
              const base=channel*windowFrames;
              for(let sample=0;sample<windowFrames;sample++){
                const offset=sample-windowFrames/2;
                input[base+sample]=sampleWindow(sourceCenter,offset,
                  read,sourceFrames,state,channel,missing);
                probe[base+sample]=sampleWindow(sourceCenter+windowFrames/4,
                  offset,read,sourceFrames,state,channel,missing);
              }
            }
          }
          const code=e.warp_stream_process_source_window(stream,inputPtr,
            probePtr,outputPtr,nextStart,hopFrames);
          if(code!==0)throw Error("Rust source-time render returned "+code);
          pendingIndex=0;nextStart+=hopFrames;
        }
        const mix=fadeLeft>0?fadeLeft/fadeLength:0;
        for(let channel=0;channel<channelCount;channel++){
          const sample=hop[channel][pendingIndex];
          const value=sample*(1-mix)+fadeFrom[channel]*mix;
          outputChannels[channel][i]=finite(value)?value:0;
          last[channel]=outputChannels[channel][i];
        }
        if(fadeLeft>0)fadeLeft--;
        pendingIndex++;
      }
      outputFrames+=frames;
      missingFirst=missing.first;missingTotal=missing.total;
      return {missingFrames:missingTotal>0?frames:0,
        firstMissingFrame:missingFirst};
    }
    return {
      get state(){return {pitchSemitones:pitch,pitchRatio,pitchRevision,
        outputFrames,algorithm:"rust-engine-3-partial-residual"};},
      beginTransition,reset,setPitch,
      shiftSource(delta){
        if(!finite(delta))throw RangeError("invalid Rust source displacement");
        if(Math.abs(delta)>windowFrames/2)beginTransition();
      },render,
      dispose(){
        if(disposed)return;disposed=true;
        e.warp_free_f32(inputPtr,inputLength);
        e.warp_free_f32(probePtr,inputLength);
        e.warp_free_f32(outputPtr,outputLength);
        e.warp_stream_free(stream);
      }
    };
  }catch(error){
    if(inputPtr)e.warp_free_f32(inputPtr,e.warp_stream_window_frames(stream)*channelCount);
    if(probePtr)e.warp_free_f32(probePtr,e.warp_stream_window_frames(stream)*channelCount);
    if(outputPtr)e.warp_free_f32(outputPtr,e.warp_stream_hop_frames(stream)*channelCount);
    e.warp_stream_free(stream);
    throw error;
  }
}
