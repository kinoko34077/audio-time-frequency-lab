/** #36 R2: host-side bounded raw PCM source-window delivery.
 * Uses decoded local PCM; no whole-song transfer or per-loop Worker startup.
 * Experimental transport ONLY; not pitch-preserving DSP or user-facing player.
 */
import {chooseSourceWindowStart,SOURCE_WINDOW_FRAMES,
  RENDERED_CHUNK_SLOTS} from "./source-pcm-renderer.mjs";
import {validatePlaybackSpeed} from "./source-timeline.mjs";

const installations=new WeakMap();
const LOOP_ENDPOINT_WINDOW_FRAMES=8192;
function ensureProcessor(ctx){
  let ready=installations.get(ctx);
  if(!ready){
    ready=ctx.audioWorklet.addModule(new URL("./source-pcm.worklet.js",import.meta.url));
    installations.set(ctx,ready);
    // A rejected registration is not a permanent backend failure. Keep the
    // successful promise, but permit a new attempt after the cause is fixed.
    ready.catch(()=>{
      if(installations.get(ctx)===ready)installations.delete(ctx);
    });
  }
  return ready;
}

export async function createSourcePCMBridge({
  ctx,source,sourceChannels,sourceSampleRate,
  sourceFrames=source?.sourceFrames??sourceChannels?.[0]?.length,
  speed=1,startFrame=0,loopStartFrame=0,
  loopEndFrame=sourceFrames,loopEnabled=false,
  onEvent=()=>{},commandTimeoutMs=5000,
  processingMode="raw",pitchSemitones=0,wsolaWindowFrames=1024,
  dualShortFrames=512,dualLongFrames=2048,wasmBytes=null,rustSettings=null
}={}){
  const channelCount=source?.channelCount??sourceChannels?.length;
  const readerValid=source&&typeof source.read==="function"&&
    Number.isSafeInteger(sourceFrames)&&sourceFrames>0&&
    Number.isInteger(channelCount)&&channelCount>=1&&channelCount<=2;
  const channelsValid=Array.isArray(sourceChannels)&&sourceChannels.length>=1&&
    sourceChannels.length<=2&&
    sourceChannels.every(ch=>ch instanceof Float32Array&&ch.length>0&&
      ch.length===sourceChannels[0].length);
  if(!ctx?.audioWorklet||!Number.isFinite(ctx.sampleRate)||
     !(readerValid||channelsValid))
    throw RangeError("decoded mono/stereo PCM source and AudioWorklet required");
  const frames=source?.sourceFrames??sourceChannels[0].length;
  const outputChannels=source?.channelCount??sourceChannels.length;
  if(!Number.isFinite(sourceSampleRate)||sourceSampleRate<=0)
    throw RangeError("invalid source PCM sample rate");
  if(!Number.isFinite(commandTimeoutMs)||commandTimeoutMs<1||commandTimeoutMs>60000)
    throw RangeError("invalid PCM command timeout");
  let currentSpeed=validatePlaybackSpeed(speed);
  if(!["raw","granular","spectral","pv","wsola","dual","am","live","worker"].includes(processingMode))
    throw RangeError("invalid PCM processing mode");
  if(processingMode==="worker"&&!(currentSpeed>=.5&&currentSpeed<=2))
    throw RangeError("legacy Worker playback supports only positive 0.5..2x");
  if(processingMode==="live"&&(!(wasmBytes instanceof ArrayBuffer)||
     !rustSettings||rustSettings.engine!==3))
    throw RangeError("Rust engine 3 requires the shared WASM module and settings");
  if(![256,512,1024,2048,4096].includes(wsolaWindowFrames))
    throw RangeError("invalid WSOLA synthesis window");
  if(![256,512,1024,2048,4096].includes(dualShortFrames)||
     ![1024,2048,4096,8192].includes(dualLongFrames)||
     dualShortFrames>=dualLongFrames)
    throw RangeError("Dual short window must be smaller than long window");
  const validatePitch=value=>{
    if(typeof value!=="number"||!Number.isFinite(value)||
      value<-12||value>12)
      throw RangeError("pitch must be finite within -12..12 semitones");
    return value;
  };
  pitchSemitones=validatePitch(pitchSemitones);
  if(processingMode==="raw"&&pitchSemitones!==0)
    throw RangeError("raw PCM cannot apply independent pitch");
  let A=loopStartFrame,B=loopEndFrame,loop=loopEnabled;
  if(!Number.isSafeInteger(A)||!Number.isSafeInteger(B)||
     A<0||A>=B||B>frames||typeof loop!=="boolean"||
     !Number.isSafeInteger(startFrame)||startFrame<0||startFrame>frames)
    throw RangeError("invalid initial sample-frame transport");
  await ensureProcessor(ctx);
  const node=new AudioWorkletNode(ctx,"audio-lab-source-pcm",{
    numberOfInputs:0,numberOfOutputs:1,
    outputChannelCount:[outputChannels],
    processorOptions:{
      sourceFrames:frames,sourceSampleRate,
      channelCount:outputChannels,speed,
      startFrame,loopStartFrame:A,loopEndFrame:B,loopEnabled:loop,
      processingMode,pitchSemitones,wsolaWindowFrames,
      dualShortFrames,dualLongFrames
    }
  });
  // Do not copy entire track to the worklet; these small snapshots are moved.
  let requestId=0,closed=false,closureError=null,latest=null,scratchCached=null;
  let refillRevision=0;
  let loopPreparing=false,queuedLoop=null;
  // Source is immutable for this bridge lifetime. Retain only the two most
  // recent endpoint windows; transfer copies rather than detach these buffers.
  const endpointCache=[null,null];
  const pending=new Map();
  const closedFailure=()=>closureError??Error("PCM bridge disposed");
  let rustReadyResolve=null,rustReadyReject=null;
  const rejectPending=error=>{
    for(const ticket of pending.values()){
      clearTimeout(ticket.timer);
      ticket.reject(error);
    }
    pending.clear();
    endpointCache.fill(null);
    if(queuedLoop){queuedLoop.reject(error);queuedLoop=null;}
  };
  const failProcessor=error=>{
    if(closed)return;
    // A lost command ACK does not mean the audio render thread has stopped.
    // Ask the processor to terminate before suppressing normal dispose().
    try{node.port.postMessage({type:"dispose"});}catch{}
    closed=true;
    closureError=error;
    rustReadyReject?.(error);rustReadyResolve=null;rustReadyReject=null;
    node.port.onmessage=null;
    node.removeEventListener("processorerror",onProcessorError);
    try{node.disconnect();}catch{}
    rejectPending(error);
    onEvent({type:"fatal-error",message:error.message});
  };
  const onProcessorError=()=>failProcessor(
    Error("AudioWorklet processor unexpectedly terminated")
  );
  // Some Chrome runtimes do not invoke assignment-style onprocessorerror
  // handlers for synthetic or host-level processorerror events. Use the
  // EventTarget listener contract for the actual processor lifecycle.
  node.addEventListener("processorerror",onProcessorError);
  const submit=(data,transfers=[])=>{
    if(closed)return Promise.reject(Error("PCM bridge disposed"));
    const id=++requestId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>failProcessor(
        Error("AudioWorklet command response timed out: "+(data.op||data.type))
      ),commandTimeoutMs);
      // Only a successful Worklet command clears its pending source refill.
      // Keep the old request live during asynchronous PCM preparation and
      // on rejection. ACKs and need-window messages share one ordered port.
      const invalidatesRefill=["seek-window","scrub","loop-config"].includes(data.type)||
        data.type==="command"&&["seek","speed","bounds","loop","pitch"].includes(data.op);
      pending.set(id,{resolve,reject,timer,invalidatesRefill});
      try{node.port.postMessage({...data,requestId:id},transfers);}
      catch(error){
        clearTimeout(timer);pending.delete(id);
        reject(error);
      }
    });
  };
  const sourceWindowRange=(requested,direction,windowFrames)=>{
    const frame=Math.max(0,Math.min(frames-1,Math.floor(requested)));
    const requestedStart=chooseSourceWindowStart(frame,frames,windowFrames,direction);
    // Progressive readers align decode windows. Align the small endpoint range
    // here too, so a single A/B edit never spills into a second decode window.
    let start=requestedStart;
    if(windowFrames!==SOURCE_WINDOW_FRAMES){
      start=Math.floor(requestedStart/windowFrames)*windowFrames;
      if(frame>=start+windowFrames)start+=windowFrames;
      start=Math.min(start,
        Math.floor((frames-1)/windowFrames)*windowFrames);
    }
    return {start,end:Math.min(frames,start+Math.min(windowFrames,frames))};
  };
  const windowSlice=async(requested,direction=currentSpeed,priority="playback",
    windowFrames=SOURCE_WINDOW_FRAMES)=>{
    const {start,end}=sourceWindowRange(requested,direction,windowFrames);
    if(source){
      const range=await source.read(start,end-start,{priority,windowFrames});
      if(range?.startFrame!==start||!Array.isArray(range.channels)||
         range.channels.length!==outputChannels||
         !range.channels.every(ch=>ch instanceof Float32Array&&ch.length===end-start))
        throw Error("progressive PCM source returned an invalid frame range");
      return {start,channels:range.channels};
    }
    return {start,channels:sourceChannels.map(x=>x.slice(start,end))};
  };
  const endpointWindow=async(frame,direction,slot)=>{
    const size=Math.min(LOOP_ENDPOINT_WINDOW_FRAMES,frames);
    const {start,end}=sourceWindowRange(frame,direction,size);
    let window=endpointCache[slot];
    if(!window||window.start!==start||window.channels[0].length!==end-start){
      window=await windowSlice(frame,direction,"playback",size);
      if(closed)throw closedFailure();
      endpointCache[slot]=window;
    }
    return {start:window.start,channels:window.channels.map(ch=>ch.slice())};
  };
  const postWindow=({start,channels},pin=null,refillId=null)=>{
    if(closed)return;
    node.port.postMessage({
      type:"window",start,channels,pin,refillId,
      requestId:++requestId
    },channels.map(x=>x.buffer));
  };
  const sendWindow=async(requested,pin=null,direction=currentSpeed,refillId=null)=>{
    if(closed)return;
    const window=await windowSlice(requested,direction,"playback");
    if(closed)return;
    postWindow(window,pin,refillId);
  };
  const requestRefill=(frame,refillId,revision,attempt=0)=>{
    void sendWindow(frame,null,currentSpeed,refillId).catch(error=>{
      if(closed)return;
      const preempted=error?.name==="AbortError"||
        error?.message==="PCM window decode aborted";
      if(preempted){
        if(revision!==refillRevision)return;
        if(attempt>=1){failProcessor(error);return;}
        queueMicrotask(()=>{
          if(!closed&&revision===refillRevision)
            requestRefill(frame,refillId,revision,attempt+1);
        });
        return;
      }
      failProcessor(error);
    });
  };
  const primeLoop=async()=>{
    if(!loop)return;
    const endpoints=await Promise.all([
      endpointWindow(A,1,0),
      endpointWindow(B-1,-1,1)
    ]);
    if(closed)return;
    postWindow(endpoints[0],"A");postWindow(endpoints[1],"B");
  };
  node.port.onmessage=event=>{
    if(closed)return;
    const data=event.data||{};
    if(data.type==="need-window"){
      requestRefill(data.frame,data.refillId,refillRevision);
    }else if(data.type==="rust-ready"){
      rustReadyResolve?.();rustReadyResolve=null;rustReadyReject=null;
    }else if(data.type==="rust-error"){
      rustReadyReject?.(Error(data.message));rustReadyResolve=null;rustReadyReject=null;
    }else if(data.type==="command-accepted"||
             data.type==="rendered-chunk-accepted"||
             data.type==="worker-state-accepted"||
             data.type==="worker-state-staged"||data.type==="error"){
      const ticket=pending.get(data.requestId);
      if(ticket){
        pending.delete(data.requestId);
        clearTimeout(ticket.timer);
        if(data.type==="error")ticket.reject(Error(data.message));
        else{
          if(data.type==="command-accepted"&&ticket.invalidatesRefill)
            refillRevision++;
          ticket.resolve(data);
        }
      }
    }else if(data.type==="progress")latest=data;
    onEvent(data);
  };
  if(processingMode==="live"){
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(
          Error("Rust source-time engine initialization timed out")
        ),commandTimeoutMs);
        rustReadyResolve=()=>{clearTimeout(timer);resolve();};
        rustReadyReject=error=>{clearTimeout(timer);reject(error);};
        try{node.port.postMessage({type:"rust-init",wasmBytes,rustSettings});}
        catch(error){clearTimeout(timer);reject(error);}
      });
    }catch(error){
      closed=true;
      try{node.port.postMessage({type:"dispose"});}catch{}
      node.port.onmessage=null;
      node.removeEventListener("processorerror",onProcessorError);
      try{node.disconnect();}catch{}
      throw error;
    }
  }
  // At initial start only, populate both loop endpoints before play.
  // Later user A/B changes use one atomic loop-config message.
  // The renderer bounds its cache to four windows by default.
  if(processingMode!=="worker"){
    try{
      await primeLoop();
      const initial=await windowSlice(startFrame===frames?frames-1:startFrame,
        currentSpeed,"playback");
      if(!closed)postWindow(initial);
    }catch(error){
      closed=true;
      try{node.port.postMessage({type:"dispose"});}catch{}
      node.port.onmessage=null;
      node.removeEventListener("processorerror",onProcessorError);
      try{node.disconnect();}catch{}
      rejectPending(error);throw error;
    }
  }
  const command=(op,params={})=>submit({type:"command",op,...params});
  let cursorRevision=0,loopRevision=0;
  const prepareLoop=async({a,b,enabled,op,revision})=>{
    let endpoints=[];
    while(enabled&&!closed&&revision===loopRevision){
      try{
        endpoints=await Promise.all([
          endpointWindow(a,1,0),
          endpointWindow(b-1,-1,1)
        ]);
        break;
      }catch(error){
        if(closed)throw closedFailure();
        if(revision!==loopRevision)return {stale:true};
        const preempted=error?.name==="AbortError"||
          error?.message==="PCM window decode aborted";
        if(!preempted)throw error;
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    if(closed)throw closedFailure();
    if(revision!==loopRevision)return {stale:true};
    const receipt=await submit({type:"loop-config",op,a,b,enabled,endpoints},
      endpoints.flatMap(w=>w.channels.map(ch=>ch.buffer)));
    return revision===loopRevision?receipt:{stale:true};
  };
  const launchLoop=async job=>{
    loopPreparing=true;
    try{job.resolve(await prepareLoop(job));}
    catch(error){job.reject(error);}
    finally{
      loopPreparing=false;
      const next=queuedLoop;
      queuedLoop=null;
      if(next){
        if(closed)next.reject(closedFailure());
        else void launchLoop(next);
      }
    }
  };
  const updateLoop=(a,b,enabled,op)=>{
    if(closed)return Promise.reject(Error("PCM bridge disposed"));
    const revision=++loopRevision;
    // One active endpoint preparation and one replaceable latest request.
    // An OFF request requires no endpoint PCM, so never queue it behind a
    // cold decode. Revision fencing prevents obsolete preparation applying.
    if(queuedLoop){queuedLoop.resolve({stale:true});queuedLoop=null;}
    const job={a,b,enabled,op,revision};
    if(!enabled)return prepareLoop(job);
    return new Promise((resolve,reject)=>{
      const request={...job,resolve,reject};
      if(loopPreparing)queuedLoop=request;
      else void launchLoop(request);
    });
  };
  const api={
    node,
    connect(destination){node.connect(destination);return api;},
    async play(){await ctx.resume();return command("play");},
    pause(){return command("pause");},
    async seek(frame){
      if(processingMode==="worker")
        return Promise.reject(Error("legacy Worker seeks must reset the Worker generation"));
      if(!Number.isSafeInteger(frame)||frame<0||frame>frames)
        return Promise.reject(RangeError("invalid source-frame seek"));
      if(closed)return Promise.reject(Error("PCM bridge disposed"));
      const revision=++cursorRevision;
      const {start,channels}=await windowSlice(frame===frames?frames-1:frame,
        currentSpeed,"playback");
      if(closed)throw closedFailure();
      if(revision!==cursorRevision)return {stale:true};
      // The source window and seek become one Worklet message, so prefetch
      // eviction cannot discard the target while protecting the old cursor.
      return submit({type:"seek-window",start,channels,frame,op:"seek"},
        channels.map(x=>x.buffer));
    },
    setSpeed(next){
      if(processingMode==="worker")
        return Promise.reject(Error("legacy Worker speed changes must reset the Worker generation"));
      try{currentSpeed=validatePlaybackSpeed(next);}
      catch(error){return Promise.reject(error);}
      return command("speed",{speed:currentSpeed});
    },
    async scrub(frame,speed){
      if(!Number.isSafeInteger(frame)||frame<0||frame>=frames)
        throw RangeError("invalid scratch sample frame");
      const wantedSpeed=validatePlaybackSpeed(speed);
      if(closed)throw Error("PCM bridge disposed");
      currentSpeed=wantedSpeed;
      const revision=++cursorRevision;
      // No 64k-frame PCM copy for each pointermove. The first scratch
      // positions the source cache, subsequent moves within that interval
      // transmit just a frame+speed pair (tens of bytes).
      const margin=4096;
      const needsCache=!scratchCached||
        frame<scratchCached.start+(scratchCached.start>0?margin:0)||
        frame>=scratchCached.end-(scratchCached.end<frames?margin:0);
      const send=()=>{
        return (async()=>{
          const {start,channels}=await windowSlice(frame,wantedSpeed,"scrub");
          if(closed)throw closedFailure();
          if(revision!==cursorRevision)return {stale:true};
          scratchCached={start,end:start+channels[0].length};
          return submit({type:"scrub",op:"scrub",start,channels,
            frame,speed:wantedSpeed},channels.map(c=>c.buffer));
        })();
      };
      if(needsCache)return send();
      try{
        if(revision!==cursorRevision)return {stale:true};
        return await submit({type:"scrub",op:"scrub",frame,speed:wantedSpeed});
      }catch(error){
        // The AudioWorklet cache can evict a former pointer window while
        // honoring A/B pins or forward prefetch. Retry with an atomic window
        // instead of treating a valid finger position as a fatal DSP error.
        if(!/scratch source window missing/.test(error.message))throw error;
        scratchCached=null;
        return send();
      }
    },
    setPitch(next){
      if(processingMode==="raw")
        return Promise.reject(Error("independent pitch requires a synthesis model"));
      if(processingMode==="worker")
        return Promise.reject(Error("legacy Worker pitch changes must reset the Worker generation"));
      try{next=validatePitch(next);}
      catch(error){return Promise.reject(error);}
      // Preserve caller's full finite input precision, independent of any
      // display rounding or rail snap. Render receipt has pitchRevision.
      return command("pitch",{semitones:next});
    },
    setLoopBounds(a,b){
      if(processingMode==="worker")
        return Promise.reject(Error("A/B playback is unavailable for the legacy Worker"));
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||
         a<0||a>=b||b>frames)return Promise.reject(RangeError("invalid A/B bounds"));
      A=a;B=b;
      return updateLoop(a,b,loop,"bounds");
    },
    setLoopEnabled(enabled){
      if(processingMode==="worker")
        return Promise.reject(Error("A/B playback is unavailable for the legacy Worker"));
      if(typeof enabled!=="boolean")
        return Promise.reject(TypeError("invalid loop enabled"));
      loop=enabled;
      return updateLoop(A,B,enabled,"loop");
    },
    setLoopConfiguration(a,b,enabled){
      if(processingMode==="worker")
        return Promise.reject(Error("A/B playback is unavailable for the legacy Worker"));
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||
         a<0||a>=b||b>frames||typeof enabled!=="boolean")
        return Promise.reject(RangeError("invalid A/B configuration"));
      A=a;B=b;loop=enabled;
      return updateLoop(a,b,enabled,"configuration");
    },
    pushRenderedChunk(chunk){
      if(processingMode!=="worker")
        return Promise.reject(Error("rendered Worker chunks require Worker processing mode"));
      if(!chunk||!Array.isArray(chunk.channels))
        return Promise.reject(RangeError("invalid rendered Worker chunk"));
      return submit({type:"rendered-chunk",...chunk},
        chunk.channels.map(channel=>channel.buffer));
    },
    resetWorkerPlayback({frame,speed:nextSpeed,pitchSemitones:nextPitch,
      generation}={}){
      if(processingMode!=="worker")
        return Promise.reject(Error("Worker playback state requires Worker processing mode"));
      if(!Number.isSafeInteger(frame)||frame<0||frame>=frames||
         !Number.isFinite(nextSpeed)||nextSpeed<.5||nextSpeed>2||
         !Number.isFinite(nextPitch)||nextPitch<-12||nextPitch>12||
         !Number.isSafeInteger(generation)||generation<1)
        return Promise.reject(RangeError("invalid legacy Worker playback state"));
      currentSpeed=nextSpeed;
      return submit({type:"worker-state",frame,speed:nextSpeed,
        pitchSemitones:nextPitch,generation});
    },
    stageWorkerSeekPlayback({frame,speed:nextSpeed,
      pitchSemitones:nextPitch,generation,requiredChunks=1,
      reuseCompatible=false,reuseGeneration=null,
      loopStartFrame=A,loopEndFrame=B,loopEnabled=loop}={}){
      if(processingMode!=="worker")
        return Promise.reject(Error("Worker seek requires Worker processing mode"));
      if(!Number.isSafeInteger(frame)||frame<0||frame>=frames||
         !Number.isFinite(nextSpeed)||nextSpeed<.5||nextSpeed>2||
         !Number.isFinite(nextPitch)||nextPitch<-12||nextPitch>12||
         !Number.isSafeInteger(generation)||generation<1||
         !Number.isSafeInteger(loopStartFrame)||loopStartFrame<0||
         !Number.isSafeInteger(loopEndFrame)||loopStartFrame>=loopEndFrame||
         loopEndFrame>frames||typeof loopEnabled!=="boolean"||
         !Number.isSafeInteger(requiredChunks)||requiredChunks<1||
         requiredChunks>RENDERED_CHUNK_SLOTS||
         typeof reuseCompatible!=="boolean"||
         reuseGeneration!==null&&
           (!Number.isSafeInteger(reuseGeneration)||reuseGeneration<0)||
         reuseCompatible&&reuseGeneration===null)
        return Promise.reject(RangeError("invalid staged legacy Worker seek"));
      return submit({type:"worker-seek-stage",frame,speed:nextSpeed,
        pitchSemitones:nextPitch,generation,requiredChunks,reuseCompatible,
        reuseGeneration,loopStartFrame,loopEndFrame,loopEnabled,
        requestAudioTime:ctx.currentTime});
    },
    stageWorkerPlayback({speed:nextSpeed,pitchSemitones:nextPitch,
      loopStartFrame=A,loopEndFrame=B,loopEnabled=loop,generation}={}){
      if(processingMode!=="worker")
        return Promise.reject(Error("staged playback requires Worker processing mode"));
      if(!Number.isFinite(nextSpeed)||nextSpeed<.5||nextSpeed>2||
         !Number.isFinite(nextPitch)||nextPitch<-12||nextPitch>12||
         !Number.isSafeInteger(loopStartFrame)||loopStartFrame<0||
         !Number.isSafeInteger(loopEndFrame)||loopStartFrame>=loopEndFrame||
         loopEndFrame>frames||typeof loopEnabled!=="boolean"||
         !Number.isSafeInteger(generation)||generation<1)
        return Promise.reject(RangeError("invalid staged legacy Worker playback state"));
      return submit({type:"worker-stage",speed:nextSpeed,
        pitchSemitones:nextPitch,loopStartFrame,loopEndFrame,loopEnabled,
        generation,
        requestAudioTime:ctx.currentTime});
    },
    get latest(){return latest;},
    get processingMode(){return processingMode;},
    dispose(){
      if(closed)return;
      scratchCached=null;closed=true;
      // Disconnecting a node is NOT a processor lifetime command. Explicitly
      // stop its render loop and release its WorkletGlobalScope PCM windows.
      node.port.postMessage({type:"dispose"});
      node.port.onmessage=null;
      node.removeEventListener("processorerror",onProcessorError);
      node.disconnect();
      rejectPending(Error("PCM bridge disposed"));
    }
  };
  return api;
}
