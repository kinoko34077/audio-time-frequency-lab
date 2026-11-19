/** #36 R2: bounded raw-PCM source-frame renderer, not a pitch-preserving DSP.
 * Owns only source sample reads/interpolation and underrun measurement.
 * Transport decisions live in source-timeline.mjs.
 */
import {createSourceTimeline,loopSourcePosition,nextSourceSampleIndex} from "./source-timeline.mjs";

export const SOURCE_WINDOW_FRAMES=65536;
export const SOURCE_WINDOW_SLOTS=4;
export const RENDERED_CHUNK_SLOTS=4;

export function chooseSourceWindowStart(frame,sourceFrames,windowFrames=SOURCE_WINDOW_FRAMES,speed=1){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1 ||
     !Number.isSafeInteger(windowFrames)||windowFrames<1||
     !Number.isFinite(frame)||frame<0||frame>sourceFrames||
     !Number.isFinite(speed))
    throw RangeError("invalid PCM source-window request");
  const length=Math.min(windowFrames,sourceFrames);
  const bias=speed<0?.8:.2;
  return Math.max(0,Math.min(sourceFrames-length,Math.floor(frame-length*bias)));
}

export function createSourcePCMRenderer({
  sourceFrames,sourceSampleRate,outputSampleRate,
  channelCount=1,speed=1,startFrame=0,
  loopStartFrame=0,loopEndFrame=sourceFrames,loopEnabled=false,
  maxWindowFrames=SOURCE_WINDOW_FRAMES,maxWindows=SOURCE_WINDOW_SLOTS
}={}){
  if(!Number.isInteger(channelCount)||channelCount<1||channelCount>2)
    throw RangeError("mono or stereo channel count required");
  if(!Number.isSafeInteger(maxWindowFrames)||maxWindowFrames<1||
     maxWindowFrames>SOURCE_WINDOW_FRAMES||
     !Number.isSafeInteger(maxWindows)||maxWindows<1||maxWindows>SOURCE_WINDOW_SLOTS)
    throw RangeError("invalid bounded PCM cache");
  const timeline=createSourceTimeline({
    sourceFrames,sourceSampleRate,outputSampleRate,speed,startFrame,
    loopStartFrame,loopEndFrame,loopEnabled
  });
  const windows=[];
  const renderedChunks=[];
  let missingFrames=0,renderedFrames=0,firstMissingFrame=null;
  let renderedGeneration=0,previousRendered=null,workerMode=false;
  let nextRenderedSequence=0;
  let stagedWorkerState=null,workerActivation=null;
  let workerState={generation:0,speed,pitchSemitones:0};
  let workerTransitionLeft=0;
  const nextRenderedFrame=(endFrame,loopState=timeline.state)=>
    loopState.loopEnabled&&endFrame>=loopState.loopEndFrame?
      loopState.loopStartFrame:
      !loopState.loopEnabled&&endFrame>=sourceFrames?sourceFrames:endFrame;
  const find=(index)=>{
    for(let i=windows.length-1;i>=0;i--){
      const w=windows[i];
      if(index>=w.start&&index<w.end)return w;
    }
    return null;
  };
  const readFrame=(channel,index)=>{
    const w=find(index);
    return w?w.channels[channel][index-w.start]:NaN;
  };
  // Neutral sound belongs to the shared source reader, not to an individual
  // DSP. Keep each selected synth running underneath so a subsequent pitch
  // change has warm overlap/phase state instead of a new, silent startup.
  // Crossfade only at real parameter transitions; do not double the signal.
  let neutralBlend=null,identityOnlyRaw=false;
  const lastAudible=new Float32Array(channelCount);
  const transitionOrigin=new Float32Array(channelCount);
  let transitionLeft=0;
  const TRANSITION_FRAMES=128;
  function rememberLastAudible(output){
    const last=output[0].length-1;
    if(last<0)return;
    for(let ch=0;ch<channelCount;ch++)lastAudible[ch]=output[ch][last];
  }
  function beginOutputTransition(output=null,frameIndex=0){
    // The synth has its own smoothing, but the neutral PCM identity path
    // bypasses that synth. Keep transport discontinuities click-free without
    // adding a parallel audio node or resetting the source clock.
    if(renderedFrames===0)return;
    const priorOutput=output&&frameIndex>0?output:null;
    if(neutralBlend>0){
      for(let ch=0;ch<channelCount;ch++)
        transitionOrigin[ch]=priorOutput?priorOutput[ch][frameIndex-1]:lastAudible[ch];
      transitionLeft=TRANSITION_FRAMES;
    }
    if(workerMode){
      for(let ch=0;ch<channelCount;ch++)
        transitionOrigin[ch]=priorOutput?priorOutput[ch][frameIndex-1]:lastAudible[ch];
      workerTransitionLeft=TRANSITION_FRAMES;
    }
  }
  function blendNeutralPCM(output,state,pitch){
    // Tiny A/B intervals deliberately retain a synthesis context: directly
    // repeating only 1..N samples would create DC/fixed-period comb artifacts.
    const neutral=state.speed===1&&pitch===0&&
      (!state.loopEnabled||state.loopEndFrame-state.loopStartFrame>=4096);
    if(neutralBlend===null)neutralBlend=neutral?1:0;
    identityOnlyRaw=true;
    let missing=0;
    for(let i=0;i<output[0].length;i++){
      neutralBlend=Math.max(0,Math.min(1,
        neutralBlend+(neutral?1:-1)/128));
      const mix=neutralBlend;
      if(mix!==1)identityOnlyRaw=false;
      if(mix===0)continue;
      // The transport, including A/B wrapping, owns this position for every
      // model. The DSP receives a read-only position and cannot change it.
      const pos=timeline.sourceFrameAt(i);
      if(pos===null)continue;
      const at=Math.floor(pos),fraction=pos-at;
      const next=fraction===0?at:
        nextSourceSampleIndex(at,state,sourceFrames);
      let miss=false;
      for(let ch=0;ch<channelCount;ch++){
        const x=readFrame(ch,at),y=fraction===0?x:readFrame(ch,next);
        if(!Number.isFinite(x)||!Number.isFinite(y)){
          if(firstMissingFrame===null)
            firstMissingFrame=Number.isFinite(x)?next:at;
          output[ch][i]*=1-mix;
          miss=true;
        }else{
          const original=x+(y-x)*fraction;
          output[ch][i]=output[ch][i]*(1-mix)+original*mix;
        }
      }
      if(transitionLeft>0&&mix>0){
        const weight=transitionLeft/TRANSITION_FRAMES;
        for(let ch=0;ch<channelCount;ch++)
          output[ch][i]=transitionOrigin[ch]*weight+output[ch][i]*(1-weight);
        transitionLeft--;
      }
      if(miss)missing++;
    }
    return missing;
  }
  const api={
    timeline,beginOutputTransition,
    get firstMissingFrame(){return firstMissingFrame;},
    get workerState(){return {...workerState};},
    takeWorkerActivation(){
      const activated=workerActivation;workerActivation=null;return activated;
    },
    get statistics(){return Object.freeze({
      missingFrames,renderedFrames,windowCount:windows.length,
      renderedChunkCount:renderedChunks.length+
        (stagedWorkerState?.kind==="seek"?
          stagedWorkerState.preparedChunks.length:0)
    });},
    hasFrame(index){return Number.isInteger(index)&&!!find(index);},
    installWindow(start,channels,pin=null,intent="prefetch"){
      if((intent!=="prefetch"&&intent!=="seek")||
         (pin!==null&&pin!=="A"&&pin!=="B")||
         !Number.isSafeInteger(start)||start<0||
         !Array.isArray(channels)||channels.length!==channelCount||
         channels.some(ch=>!(ch instanceof Float32Array))||
         channels[0].length<1||channels[0].length>maxWindowFrames||
         channels.some(ch=>ch.length!==channels[0].length)||
         start+channels[0].length>sourceFrames)
        throw RangeError("invalid PCM window");
      const end=start+channels[0].length;
      // Keep one endpoint cache for A and one for B, plus a moving window.
      // Evict unpinned windows first. Pin labels are replaced atomically.
      // Updating a cached window must not silently erase an existing A/B
      // pin when the moving reader requests that same source range.
      let resolvedPin=pin;
      if(resolvedPin===null){
        const previous=windows.find(w=>w.start===start);
        if(previous)resolvedPin=previous.pin;
      }
      for(let i=windows.length-1;i>=0;i--){
        if(windows[i].start===start||
           resolvedPin!==null&&windows[i].pin===resolvedPin)
          windows.splice(i,1);
      }
      windows.push({start,end,channels,pin:resolvedPin});
      while(windows.length>maxWindows){
        // A/B can occupy two pinned slots. A pair of moving windows must
        // overlap in time during prefetch; never evict the live source
        // window just because a farther lookahead request arrived first.
        const cursor=timeline.sampleIndexAt(0);
        const direction=timeline.state.speed<0?-1:1;
        const moving=[];
        for(let i=0;i<windows.length;i++)
          if(windows[i].pin===null)moving.push(i);
        if(!moving.length){windows.shift();continue;}
        const behind=moving.filter(i=>cursor!==null&&
          (direction>0?windows[i].end<=cursor:windows[i].start>cursor));
        let victim;
        if(intent==="seek"){
          // The host sends an atomic seek-window message: after installing
          // this target, the worklet moves its source cursor within the same
          // message handler. Preserve the new target, not the old cursor.
          const newWindow=windows.length-1;
          victim=moving.find(i=>i!==newWindow)??newWindow;
        }else if(behind.length){
          // Prefer discarding PCM already consumed in this direction.
          victim=behind.reduce((a,b)=>direction>0
            ?(windows[a].end<=windows[b].end?a:b)
            :(windows[a].start>=windows[b].start?a:b));
        }else{
          const notCurrent=moving.filter(i=>cursor===null||
            cursor<windows[i].start||cursor>=windows[i].end);
          if(notCurrent.length){
            // If all remaining windows are still ahead, reject the farthest
            // speculative prefetch rather than dropping the near window.
            victim=notCurrent.reduce((a,b)=>direction>0
              ?(windows[a].start>=windows[b].start?a:b)
              :(windows[a].end<=windows[b].end?a:b));
          }else{
            // Multiple overlapping moving windows all cover current frame.
            victim=moving[0];
          }
        }
        windows.splice(victim,1);
      }
      return windows.length;
    },
    /** One atomic render-thread operation for loop state and endpoint PCM.
     * The host must transfer both endpoint windows in the same worklet message.
     * Validate every piece before mutating the transport or the cache.
     */
    applyLoopConfiguration(a,b,enabled,endpoints=[]){
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||
         a<0||a>=b||b>sourceFrames||typeof enabled!=="boolean"||
         !Array.isArray(endpoints)||endpoints.length!==(enabled?2:0))
        throw RangeError("invalid atomic loop configuration");
      if(enabled){
        for(let i=0;i<2;i++){
          const w=endpoints[i],target=i===0?a:b-1;
          if(!w||!Number.isSafeInteger(w.start)||w.start<0||
             !Array.isArray(w.channels)||w.channels.length!==channelCount||
             w.channels.some(ch=>!(ch instanceof Float32Array))||
             w.channels[0].length<1||w.channels[0].length>maxWindowFrames||
             w.channels.some(ch=>ch.length!==w.channels[0].length)||
             w.start+w.channels[0].length>sourceFrames||
             target<w.start||target>=w.start+w.channels[0].length)
            throw RangeError("invalid loop endpoint PCM window");
        }
      }
      timeline.setLoopBounds(a,b);
      timeline.setLoopEnabled(enabled);
      if(enabled){
        api.installWindow(endpoints[0].start,endpoints[0].channels,"A","seek");
        api.installWindow(endpoints[1].start,endpoints[1].channels,"B","seek");
      }else{
        // Once looping is off, endpoint windows must not monopolize cache.
        for(const w of windows)w.pin=null;
      }
      return timeline.state;
    },
    /**
     * Install one bounded Worker-rendered model segment. The Worker owns the
     * selected legacy DSP; this renderer owns the only audible source clock.
     * A stale generation is ignored, never replayed after emitted output.
     */
    installRenderedChunk({generation,sequence,startFrame,endFrame,speed,coreFrames,channels}={}){
      if(!Number.isSafeInteger(generation)||generation<0||
         !Number.isSafeInteger(startFrame)||!Number.isSafeInteger(endFrame)||
         startFrame<0||startFrame>=endFrame||endFrame>sourceFrames||
         !Number.isFinite(speed)||speed<.5||speed>2||
         !Number.isSafeInteger(coreFrames)||coreFrames<1||
         !Array.isArray(channels)||channels.length!==channelCount||
         channels.some(ch=>!(ch instanceof Float32Array)||
           ch.length<coreFrames||ch.length>14_000_000/channelCount))
        throw RangeError("invalid rendered PCM chunk");
      const active=generation===renderedGeneration;
      const staged=stagedWorkerState?.generation===generation?
        stagedWorkerState:null;
      if(!active&&!staged)return false;
      const queueSequence=sequence??(staged&&!staged.firstChunkAccepted?
        staged.sequence:nextRenderedSequence);
      if(!Number.isSafeInteger(queueSequence)||queueSequence<0)
        throw RangeError("invalid rendered PCM queue sequence");
      const seeking=stagedWorkerState?.kind==="seek"?stagedWorkerState:null;
      if(active&&seeking&&renderedChunks.length>=seeking.retainedLimit)return false;
      if(active&&!seeking&&stagedWorkerState?.firstChunkAccepted&&
         queueSequence>stagedWorkerState.sequence)return false;
      const expectedSpeed=active?timeline.state.speed:staged.speed;
      if(speed!==expectedSpeed)
        throw RangeError("rendered PCM speed does not match source clock");
      if(staged&&!staged.firstChunkAccepted&&startFrame!==staged.frame)
        throw RangeError("staged PCM must begin at the staged source boundary");
      if(staged?.kind==="seek"){
        const previous=staged.preparedChunks.at(-1)||null;
        const expectedSequence=previous?previous.sequence+1:staged.sequence;
        const expectedStart=previous?
          nextRenderedFrame(previous.endFrame,{
            loopEnabled:staged.loopEnabled??timeline.state.loopEnabled,
            loopStartFrame:staged.loopStartFrame??timeline.state.loopStartFrame,
            loopEndFrame:staged.loopEndFrame??timeline.state.loopEndFrame
          }):staged.frame;
        if(renderedChunks.length+staged.preparedChunks.length>=
           RENDERED_CHUNK_SLOTS)return false;
        if(queueSequence!==expectedSequence||startFrame!==expectedStart)
          throw RangeError("prepared seek PCM queue is not source-contiguous");
        staged.preparedChunks.push({generation,sequence:queueSequence,startFrame,
          endFrame,speed,coreFrames,channels});
        staged.firstChunkAccepted=true;
        workerMode=true;
        return renderedChunks.length+staged.preparedChunks.length;
      }
      const replacementIndex=staged&&!staged.firstChunkAccepted?
        renderedChunks.findIndex(segment=>
          segment.generation===renderedGeneration&&
          segment.sequence===staged.sequence):-1;
      if(replacementIndex>=0){
        if(timeline.state.sourceFrame>=renderedChunks[replacementIndex].endFrame)
          return false;
        renderedChunks[replacementIndex]={generation,sequence:queueSequence,
          startFrame,endFrame,speed,coreFrames,channels};
        renderedChunks.splice(replacementIndex+1);
        nextRenderedSequence=queueSequence+1;
        staged.firstChunkAccepted=true;
        workerMode=true;
        return renderedChunks.length;
      }
      if(staged&&!staged.firstChunkAccepted&&
         queueSequence!==staged.sequence)
        throw RangeError("staged PCM queue sequence does not match its boundary");
      if(renderedChunks.some(segment=>segment.sequence===queueSequence))
        return false;
      if(renderedChunks.length>=RENDERED_CHUNK_SLOTS)
        throw RangeError("rendered PCM chunk queue full");
      const previous=renderedChunks.at(-1)||previousRendered;
      const retiringLoopHandoff=staged&&!staged.firstChunkAccepted&&
        previous?.retireAfterLoop&&queueSequence===previous.sequence+1&&
        startFrame===staged.frame;
      const lateHandoffResult=
        (active&&stagedWorkerState&&stagedWorkerState.kind!=="seek"&&
          queueSequence>stagedWorkerState.sequence)||
        (staged&&!staged.firstChunkAccepted&&
          queueSequence===staged.sequence);
      if(previous){
        const expected=nextRenderedFrame(previous.endFrame,
          staged&&staged.kind!=="seek"&&queueSequence>=staged.sequence?
            staged:timeline.state);
        if((startFrame!==expected&&!retiringLoopHandoff)||
           queueSequence!==previous.sequence+1){
          if(lateHandoffResult)return false;
          throw RangeError("rendered PCM chunks are not source-contiguous");
        }
      }else if(queueSequence!==nextRenderedSequence){
        if(lateHandoffResult)return false;
        throw RangeError("rendered PCM queue sequence is not contiguous");
      }
      workerMode=true;
      if(renderedFrames>0&&renderedChunks.length===0)
        workerTransitionLeft=TRANSITION_FRAMES;
      renderedChunks.push({generation,sequence:queueSequence,startFrame,endFrame,
        speed,coreFrames,channels});
      nextRenderedSequence=queueSequence+1;
      if(staged)stagedWorkerState.firstChunkAccepted=true;
      return renderedChunks.length;
    },
    /** Stage a new Worker configuration after the currently audible chunk. */
    stageRenderedState({generation,speed,pitchSemitones,
      loopStartFrame=timeline.state.loopStartFrame,
      loopEndFrame=timeline.state.loopEndFrame,
      loopEnabled=timeline.state.loopEnabled}={}){
      if(!Number.isSafeInteger(generation)||generation<=renderedGeneration||
         !Number.isFinite(speed)||speed<.5||speed>2||
         !Number.isFinite(pitchSemitones)||pitchSemitones<-12||pitchSemitones>12||
         !Number.isSafeInteger(loopStartFrame)||loopStartFrame<0||
         !Number.isSafeInteger(loopEndFrame)||loopStartFrame>=loopEndFrame||
         loopEndFrame>sourceFrames||typeof loopEnabled!=="boolean")
        throw RangeError("invalid staged Worker playback state");
      const state=timeline.state;
      const position=state.sourceFrame;
      if(state.ended){
        if(loopEnabled)
          return api.stageRenderedSeekState({generation,
            frame:loopStartFrame,speed,pitchSemitones,requiredChunks:1,
            loopStartFrame,loopEndFrame,loopEnabled});
        timeline.setLoopConfiguration(loopStartFrame,loopEndFrame,false);
        renderedChunks.length=0;
        previousRendered=null;
        stagedWorkerState={kind:"terminal",generation,frame:sourceFrames,
          sequence:nextRenderedSequence,speed,pitchSemitones,
          loopStartFrame,loopEndFrame,loopEnabled:false,
          firstChunkAccepted:true};
        workerMode=true;
        return {sourceFrame:sourceFrames,sequence:nextRenderedSequence,
          bufferedSegments:0,terminal:true,activated:false};
      }
      const activeChunks=renderedChunks.filter(segment=>
        segment.generation===renderedGeneration);
      const current=activeChunks.find(segment=>
        (position>=segment.startFrame&&position<segment.endFrame)||
        (state.loopEnabled&&segment.endFrame>=state.loopEndFrame&&
          position<segment.startFrame))||
        activeChunks.find(segment=>position===segment.endFrame)||
        activeChunks.find(segment=>position<segment.startFrame)||null;
      if(!loopEnabled&&current&&current.endFrame>=sourceFrames){
        // The final source segment has no successor. Apply any unlooped
        // settings after its retained PCM drains, even if saved B is earlier.
        timeline.setLoopConfiguration(loopStartFrame,loopEndFrame,false);
        renderedChunks.splice(0,renderedChunks.length,current);
        const sequence=current.sequence+1;
        nextRenderedSequence=sequence;
        stagedWorkerState={kind:"terminal",generation,
          frame:sourceFrames,sequence:current.sequence,speed,pitchSemitones,
          loopStartFrame,loopEndFrame,loopEnabled:false,
          firstChunkAccepted:true};
        workerMode=true;
        return {sourceFrame:sourceFrames,sequence,
          bufferedSegments:renderedChunks.length,terminal:true,
          activated:false};
      }
      let frame,sequence;
      if(current){
        const currentIndex=activeChunks.indexOf(current);
        let retained=activeChunks.slice(currentIndex,currentIndex+2);
        const boundary=nextRenderedFrame(current.endFrame,state);
        if(!loopEnabled&&state.loopEnabled&&
           current.endFrame>=state.loopEndFrame){
          frame=loopEndFrame<sourceFrames?loopEndFrame:loopStartFrame;
          if(current.startFrame<=state.loopStartFrame)
            current.retireAfterLoop=true;
        }else if(loopEnabled){
          const positionOutsideLoop=position<loopStartFrame||
            position>=loopEndFrame;
          const continuesInsideNewLoop=current.endFrame>=loopStartFrame&&
            current.endFrame<loopEndFrame;
          frame=positionOutsideLoop?loopStartFrame:
            continuesInsideNewLoop?current.endFrame:
            boundary>=loopStartFrame&&boundary<loopEndFrame?
              boundary:loopStartFrame;
        }else frame=boundary;
        const loopChanged=state.loopEnabled!==loopEnabled||
          state.loopStartFrame!==loopStartFrame||
          state.loopEndFrame!==loopEndFrame;
        if(loopChanged&&state.loopEnabled&&loopEnabled&&
           current.startFrame<=state.loopStartFrame&&
           current.endFrame>=state.loopEndFrame)
          current.retireAfterLoop=true;
        if(loopChanged&&state.loopEnabled&&loopEnabled&&
           current.endFrame>=state.loopEndFrame&&
           (frame<current.startFrame||frame>current.endFrame)){
          current.retireAfterLoop=true;
          // A new A beyond the current loop cannot consume already queued
          // repetitions of the old loop. Keep only the audible old segment;
          // the next sequence is reserved for the staged new A boundary.
          retained=[current];
        }
        if(loopEnabled&&frame===loopStartFrame&&
           current.startFrame===loopStartFrame&&
           current.endFrame>=loopEndFrame)
          current.retireAfterLoop=true;
        // Keep old PCM intact while the replacement Worker chunk renders.
        // New loop bounds apply atomically at generation handoff.
        sequence=current.sequence+1;
        renderedChunks.splice(0,renderedChunks.length,...retained);
      }else if(activeChunks.length&&
          position>=activeChunks.at(-1).endFrame){
        const consumed=activeChunks.at(-1);
        const cursor=Math.floor(position);
        frame=loopEnabled&&(cursor<loopStartFrame||cursor>=loopEndFrame)?
          loopStartFrame:cursor;
        sequence=consumed.sequence+1;
        renderedChunks.length=0;
        previousRendered=null;
      }else{
        const cursor=Math.floor(position);
        frame=loopEnabled&&(cursor<loopStartFrame||cursor>=loopEndFrame)?
          loopStartFrame:cursor;
        sequence=nextRenderedSequence;
        renderedChunks.length=0;
        previousRendered=null;
      }
      nextRenderedSequence=sequence;
      stagedWorkerState={generation,frame,sequence,speed,pitchSemitones,
        loopStartFrame,loopEndFrame,loopEnabled,
        firstChunkAccepted:false};
      workerMode=true;
      return {sourceFrame:frame,sequence,
        bufferedSegments:renderedChunks.length};
    },
    /** Prepare a seek while the active source clock keeps consuming old PCM. */
    stageRenderedSeekState({generation,frame,speed,pitchSemitones,
      requiredChunks=1,reuseCompatible=false,reuseGeneration=null,
      loopStartFrame=timeline.state.loopStartFrame,
      loopEndFrame=timeline.state.loopEndFrame,
      loopEnabled=timeline.state.loopEnabled}={}){
      if(!Number.isSafeInteger(generation)||generation<=renderedGeneration||
         !Number.isSafeInteger(frame)||frame<0||frame>=sourceFrames||
         !Number.isFinite(speed)||speed<.5||speed>2||
         !Number.isFinite(pitchSemitones)||pitchSemitones<-12||pitchSemitones>12||
         !Number.isSafeInteger(loopStartFrame)||loopStartFrame<0||
         !Number.isSafeInteger(loopEndFrame)||loopStartFrame>=loopEndFrame||
         loopEndFrame>sourceFrames||typeof loopEnabled!=="boolean"||
         !Number.isSafeInteger(requiredChunks)||requiredChunks<1||
         requiredChunks>RENDERED_CHUNK_SLOTS||
         typeof reuseCompatible!=="boolean"||
         reuseGeneration!==null&&
           (!Number.isSafeInteger(reuseGeneration)||reuseGeneration<0)||
         reuseCompatible&&reuseGeneration===null)
        throw RangeError("invalid staged Worker seek state");
      const state=timeline.state,position=state.sourceFrame;
      const activeChunks=renderedChunks.filter(segment=>
        segment.generation===renderedGeneration);
      let reusableChunks=[];
      if(reuseCompatible&&reuseGeneration===renderedGeneration){
        const first=activeChunks.findIndex(segment=>segment.speed===speed&&
          frame>=segment.startFrame&&frame<segment.endFrame);
        if(first>=0){
          for(let offset=0;offset<requiredChunks;offset++){
            const segment=activeChunks[first+offset];
            if(!segment||segment.speed!==speed)break;
            if(offset){
              const previous=reusableChunks.at(-1);
              const expected=nextRenderedFrame(previous.endFrame,state);
              if(segment.startFrame!==expected)break;
            }
            reusableChunks.push({...segment,generation,sequence:offset});
          }
          if(reusableChunks.length!==requiredChunks)reusableChunks=[];
        }
      }
      const current=activeChunks.find(segment=>
        (position>=segment.startFrame&&position<segment.endFrame)||
        (state.loopEnabled&&segment.endFrame>=state.loopEndFrame&&
          position<segment.startFrame))||activeChunks[0]||null;
      const currentIndex=current?activeChunks.indexOf(current):0;
      const retainedLimit=RENDERED_CHUNK_SLOTS-requiredChunks;
      const retained=current?
        activeChunks.slice(currentIndex,currentIndex+retainedLimit):
        activeChunks.slice(0,retainedLimit);
      renderedChunks.splice(0,renderedChunks.length,...retained);
      stagedWorkerState={generation,frame,sequence:0,speed,pitchSemitones,
        loopStartFrame,loopEndFrame,loopEnabled,
        kind:"seek",requiredChunks,retainedLimit,
        preparedChunks:reusableChunks,reusedChunks:reusableChunks.length,
        firstChunkAccepted:reusableChunks.length>0};
      workerMode=true;
      const lastReusable=reusableChunks.at(-1);
      return {sourceFrame:frame,sequence:0,
        nextFrame:lastReusable?nextRenderedFrame(lastReusable.endFrame,{
            loopEnabled:stagedWorkerState.loopEnabled??timeline.state.loopEnabled,
            loopStartFrame:stagedWorkerState.loopStartFrame??timeline.state.loopStartFrame,
            loopEndFrame:stagedWorkerState.loopEndFrame??timeline.state.loopEndFrame
          }):frame,
        nextSequence:reusableChunks.length,
        bufferedSegments:renderedChunks.length+reusableChunks.length,
        reusedChunks:reusableChunks.length};
    },
    /** Invalidate queued output after a seek or model-setting change. */
    resetRenderedChunks(generation,state={}){
      if(!Number.isSafeInteger(generation)||generation<=renderedGeneration)
        throw RangeError("rendered PCM generation must advance");
      renderedGeneration=generation;
      renderedChunks.length=0;
      previousRendered=null;
      nextRenderedSequence=0;
      stagedWorkerState=null;workerActivation=null;
      workerState={generation,speed:state.speed??timeline.state.speed,
        pitchSemitones:state.pitchSemitones??workerState.pitchSemitones};
      workerMode=true;
      workerTransitionLeft=0;
      return renderedGeneration;
    },
    /** Render Worker output through the existing source timeline exactly once. */
    renderBuffered(output){
      if(!Array.isArray(output)||output.length!==channelCount||
         output.some(ch=>!(ch instanceof Float32Array)||
           ch.length!==output[0].length))
        throw RangeError("invalid output PCM block");
      const len=output[0].length;
      let state=timeline.state;
      let missing=0;firstMissingFrame=null;
      const read=(channel,segment,index,wrapDepth=0)=>{
        const samples=segment.channels[channel];
        if(!Number.isFinite(index)||index<0||index>=samples.length)return NaN;
        const at=Math.floor(index),fraction=index-at,a=samples[at];
        if(!Number.isFinite(a))return NaN;
        if(fraction===0)return a;
        let b=!state.loopEnabled&&segment.endFrame===sourceFrames&&
          at+1>=segment.coreFrames?0:samples[at+1];
        if(!Number.isFinite(b)&&wrapDepth===0&&state.loopEnabled&&
           segment.endFrame===state.loopEndFrame){
          // A fractional source position just before a loop end
          // needs the next rendered output sample, which belongs to the chunk
          // queued at the loop start. Without this bridge the shared clock
          // freezes on the final fractional frame forever.
          const nextOutputSourceFrame=segment.startFrame+
            (at+1)*segment.speed;
          const wrappedFrame=loopSourcePosition(nextOutputSourceFrame,state);
          const nextSegment=renderedChunks.find(candidate=>
            candidate.generation===renderedGeneration&&
            candidate.speed===state.speed&&
            wrappedFrame>=candidate.startFrame&&
            wrappedFrame<candidate.endFrame);
          if(nextSegment)
            b=read(channel,nextSegment,
              (wrappedFrame-nextSegment.startFrame)/nextSegment.speed,1);
        }
        return Number.isFinite(b)?a+(b-a)*fraction:NaN;
      };
      const fadeFrames=Math.max(1,Math.round(.018*outputSampleRate));
      for(let i=0;i<len;i++){
        state=timeline.state;
        if(stagedWorkerState?.kind==="terminal"&&state.ended&&
           !state.loopEnabled){
          const staged=stagedWorkerState;
          const activated=timeline.setSpeed(staged.speed);
          renderedChunks.length=0;
          previousRendered=null;
          renderedGeneration=staged.generation;
          workerState={generation:staged.generation,speed:staged.speed,
            pitchSemitones:staged.pitchSemitones};
          stagedWorkerState=null;
          workerActivation={...workerState,sourceFrame:sourceFrames,
            revision:activated.revision,sampleOffset:i,terminal:true};
          state=timeline.state;
        }
        const seek=stagedWorkerState?.kind==="seek"&&
          stagedWorkerState.preparedChunks.length>=
            stagedWorkerState.requiredChunks?stagedWorkerState:null;
        let position=timeline.sourceFrameAt(0);
        if(seek){
          beginOutputTransition(output,i);
          timeline.setLoopConfiguration(seek.loopStartFrame,
            seek.loopEndFrame,seek.loopEnabled);
          const activated=timeline.scrub(seek.frame,seek.speed);
          const prepared=seek.preparedChunks;
          renderedChunks.splice(0,renderedChunks.length,...prepared);
          previousRendered=null;
          renderedGeneration=seek.generation;
          workerState={generation:seek.generation,speed:seek.speed,
            pitchSemitones:seek.pitchSemitones};
          nextRenderedSequence=seek.sequence+prepared.length;
          stagedWorkerState=null;
          workerActivation={...workerState,sourceFrame:activated.sourceFrame,
            revision:activated.revision,sampleOffset:i,
            reusedChunks:seek.reusedChunks||0};
          state=timeline.state;
          position=timeline.sourceFrameAt(0);
        }
        if(position===null&&state.ended&&stagedWorkerState&&
           stagedWorkerState.kind!=="seek"&&stagedWorkerState.loopEnabled&&
           renderedChunks.some(segment=>
             segment.generation===stagedWorkerState.generation&&
             segment.sequence===stagedWorkerState.sequence)){
          // A loop re-enabled in the final unlooped chunk has no old-timeline
          // boundary after EOF. Retire exhausted old PCM before re-arming so
          // an overlapping new loop cannot keep the old chunk at the queue head.
          const generation=stagedWorkerState.generation;
          renderedChunks.splice(0,renderedChunks.length,
            ...renderedChunks.filter(segment=>segment.generation===generation));
          previousRendered=null;
          timeline.setLoopConfiguration(stagedWorkerState.loopStartFrame,
            stagedWorkerState.loopEndFrame,true);
          state=timeline.state;
          position=timeline.sourceFrameAt(0);
        }
        if(position===null){for(const ch of output)ch[i]=0;continue;}
        while(renderedChunks.length){
          const head=renderedChunks[0];
          const wrapped=state.loopEnabled&&head.endFrame>=state.loopEndFrame&&
            (position<head.startFrame||
             head.retireAfterLoop&&head.completedLoop);
          if(position>=head.endFrame||wrapped){
            if(head.generation!==renderedGeneration)break;
            previousRendered=renderedChunks.shift();
            continue;
          }
          break;
        }
        let segment=renderedChunks[0];
        if(segment&&segment.generation!==renderedGeneration&&
           stagedWorkerState?.generation===segment.generation&&
           segment.sequence===stagedWorkerState.sequence){
          const staged=stagedWorkerState;
          const activationFrame=position>=segment.startFrame&&
            position<segment.endFrame?position:segment.startFrame;
          beginOutputTransition(output,i);
          // A staged edit often arrives after the source clock has crossed
          // its boundary. Preserve its fractional sample position when it is
          // already inside the replacement chunk; scrub() is intentionally
          // integer-frame-only for user seeks and would throw here.
          timeline.setLoopConfiguration(staged.loopStartFrame,
            staged.loopEndFrame,staged.loopEnabled);
          const target=activationFrame===position&&
            timeline.state.sourceFrame===position?position:
            activationFrame===position?timeline.state.sourceFrame:
            activationFrame;
          const activated=target===timeline.state.sourceFrame?
            timeline.setSpeed(staged.speed):
            timeline.scrub(target,staged.speed);
          state=timeline.state;
          position=activated.sourceFrame;
          renderedGeneration=staged.generation;
          workerState={generation:staged.generation,speed:staged.speed,
            pitchSemitones:staged.pitchSemitones};
          stagedWorkerState=null;
          workerActivation={...workerState,sourceFrame:position,
            revision:activated.revision,sampleOffset:i};
        }
        segment=renderedChunks[0];
        let invalid=!segment||position<segment.startFrame||
          position>=segment.endFrame||segment.generation!==renderedGeneration||
          segment.speed!==state.speed;
        const segmentIndex=segment?
          (position-segment.startFrame)/segment.speed:NaN;
        let value0=NaN,value1=NaN;
        if(!invalid){
          value0=read(0,segment,segmentIndex);
          if(!Number.isFinite(value0))invalid=true;
          if(channelCount===2){
            value1=read(1,segment,segmentIndex);
            if(!Number.isFinite(value1))invalid=true;
          }
        }
        if(invalid){
          if(firstMissingFrame===null)firstMissingFrame=Math.floor(position);
          missing++;
          for(const ch of output)ch[i]=0;
          continue;
        }
        const prior=previousRendered;
        const adjacent=prior&&prior.endFrame===segment.startFrame&&
          segment.startFrame>0;
        const elapsedOutput=adjacent?
          (position-segment.startFrame)*outputSampleRate/
            (segment.speed*sourceSampleRate):Infinity;
        const mix=adjacent?Math.max(0,Math.min(1,elapsedOutput/fadeFrames)):1;
        const priorIndex=adjacent?
          prior.coreFrames+(position-segment.startFrame)/segment.speed:NaN;
        const transition=workerTransitionLeft>0?
          1-workerTransitionLeft/TRANSITION_FRAMES:1;
        if(adjacent&&mix<1){
          const tail0=read(0,prior,priorIndex);
          if(Number.isFinite(tail0))value0=tail0*(1-mix)+value0*mix;
          if(channelCount===2){
            const tail1=read(1,prior,priorIndex);
            if(Number.isFinite(tail1))value1=tail1*(1-mix)+value1*mix;
          }
        }
        output[0][i]=transitionOrigin[0]*(1-transition)+value0*transition;
        if(channelCount===2)
          output[1][i]=transitionOrigin[1]*(1-transition)+value1*transition;
        if(workerTransitionLeft>0)workerTransitionLeft--;
        if(adjacent&&mix>=1)previousRendered=null;
        timeline.advance(1);
        if(state.loopEnabled&&segment?.retireAfterLoop&&
           position+state.speed*sourceSampleRate/outputSampleRate>=
             state.loopEndFrame)
          segment.completedLoop=true;
      }
      missingFrames+=missing;
      renderedFrames+=len;
      // Worker PCM can arrive later than one output quantum. The clock advances
      // once for each emitted sample and holds at the first missing frame.
      rememberLastAudible(output);
      return missing;
    },
    /**
     * Render exactly one output block, no new worklet/node per loop.
     * Output must contain zeroed-by-render Float32Array channels of equal length.
     * Missing source data is explicitly counted. On underrun the timeline is
     * advanced by the output quantum even when a cache miss inserts silence.
     * Frames already emitted must NEVER be replayed after refill. Missing
     * samples are silence and counted, never fake success.
     * Returns missing output-frame count (not a newly allocated status object).
     */
    renderGranular(output,granular){
      // Experimental independent pitch. Reuse EXACTLY the existing R2
      // bounded window cache, source timeline and missing-frame telemetry.
      // No whole-song clone into the AudioWorklet.
      if(!granular||typeof granular.render!=="function")
        throw RangeError("invalid experimental granular engine");
      const state=timeline.state;
      // Unlooped EOF is an exhausted transport, not a time-freeze request.
      // Do not keep resynthesizing the last grain forever at the clamped
      // frame; a later explicit seek or genuine reversal can re-arm it.
      if(state.ended&&!state.loopEnabled){
        for(const channel of output)channel.fill(0);
        firstMissingFrame=null;
        renderedFrames+=output[0].length;
        return 0;
      }
      const outcome=granular.render(
        output,state,readFrame,sourceFrames);
      firstMissingFrame=outcome.firstMissingFrame;
      const identityMisses=blendNeutralPCM(output,state,
        granular.state.pitchSemitones);
      const misses=identityOnlyRaw?identityMisses:
        Math.max(outcome.missingFrames,identityMisses);
      missingFrames+=misses;
      renderedFrames+=output[0].length;
      timeline.advance(output[0].length);
      rememberLastAudible(output);
      return misses;
    },
    renderSpectral(output,spectral){
      // A phase-coherent STFT synthesizer owns only sound, never the source
      // clock. Reuse the same cache/loop/telemetry contract as Granular.
      if(!spectral||typeof spectral.render!=="function")
        throw RangeError("invalid realtime spectral engine");
      const state=timeline.state;
      if(state.ended&&!state.loopEnabled){
        for(const channel of output)channel.fill(0);
        firstMissingFrame=null;
        renderedFrames+=output[0].length;
        return 0;
      }
      const result=spectral.render(output,state,readFrame,sourceFrames);
      firstMissingFrame=result.firstMissingFrame;
      const identityMisses=blendNeutralPCM(output,state,
        spectral.state.pitchSemitones);
      const misses=identityOnlyRaw?identityMisses:
        Math.max(result.missingFrames,identityMisses);
      missingFrames+=misses;
      renderedFrames+=output[0].length;
      timeline.advance(output[0].length);
      rememberLastAudible(output);
      return misses;
    },
    renderRust(output,rust){
      // The Rust engine owns only its partial/residual sound model. It reads
      // source windows and receives the shared timeline cursor read-only;
      // the renderer advances the sole transport exactly once.
      if(!rust||typeof rust.render!=="function")
        throw RangeError("invalid Rust source-time engine");
      const state=timeline.state;
      if(state.ended&&!state.loopEnabled){
        for(const channel of output)channel.fill(0);
        firstMissingFrame=null;
        renderedFrames+=output[0].length;
        return 0;
      }
      const result=rust.render(output,state,readFrame,sourceFrames,
        timeline.sourceFrameAt);
      firstMissingFrame=result.firstMissingFrame;
      const identityMisses=blendNeutralPCM(output,state,
        rust.state.pitchSemitones);
      const misses=identityOnlyRaw?identityMisses:
        Math.max(result.missingFrames,identityMisses);
      missingFrames+=misses;
      renderedFrames+=output[0].length;
      timeline.advance(output[0].length);
      rememberLastAudible(output);
      return misses;
    },
    render(output){
      if(!Array.isArray(output)||output.length!==channelCount||
         output.some(ch=>!(ch instanceof Float32Array)||
           ch.length!==output[0].length))
        throw RangeError("invalid output PCM block");
      const len=output[0].length;
      let missing=0;
      firstMissingFrame=null;
      const loopState=timeline.state;
      for(let i=0;i<len;i++){
        const position=timeline.sourceFrameAt(i);
        if(position===null){
          for(let ch=0;ch<channelCount;ch++)output[ch][i]=0;
          continue;
        }
        const at=Math.floor(position);
        const weight=position-at;
        const next=weight>0?nextSourceSampleIndex(at,loopState,sourceFrames):at;
        const left=find(at);
        const right=weight>0?find(next):left;
        if(!left||!right){
          if(firstMissingFrame===null)firstMissingFrame=left?next:at;
          missing++;
          for(let ch=0;ch<channelCount;ch++)output[ch][i]=0;
          continue;
        }
        for(let ch=0;ch<channelCount;ch++){
          const a=left.channels[ch][at-left.start];
          if(weight===0){output[ch][i]=a;continue;}
          const b=right.channels[ch][next-right.start];
          output[ch][i]=a+(b-a)*weight;
        }
      }
      renderedFrames+=len;
      missingFrames+=missing;
      // An audible quantum has elapsed regardless of cache availability.
      // Holding the entire source clock on a partial miss duplicates the PCM
      // already output before the missing source frame on the next callback.
      timeline.advance(len);
      return missing;
    },
    /** Used by host to prefetch ahead; does not report an audio success. */
    needsSourceWindow(outputLookahead=8192){
      const pos=timeline.sourceFrameAt(outputLookahead);
      if(pos===null)return null;
      const at=Math.floor(pos);
      const s=timeline.state;
      const next=nextSourceSampleIndex(at,s,sourceFrames);
      return find(at)&&find(next)?null:at;
    }
  };
  return api;
}
