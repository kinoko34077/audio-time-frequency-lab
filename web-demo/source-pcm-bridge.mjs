/** #36 R2: host-side bounded raw PCM source-window delivery.
 * Uses decoded local PCM; no whole-song transfer or per-loop Worker startup.
 * Experimental transport ONLY; not pitch-preserving DSP or user-facing player.
 */
import {chooseSourceWindowStart,SOURCE_WINDOW_FRAMES} from "./source-pcm-renderer.mjs";
import {validatePlaybackSpeed} from "./source-timeline.mjs";

const installations=new WeakMap();
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
  ctx,sourceChannels,sourceSampleRate,
  speed=1,startFrame=0,loopStartFrame=0,
  loopEndFrame=sourceChannels?.[0]?.length,loopEnabled=false,
  onEvent=()=>{},commandTimeoutMs=5000,
  processingMode="raw",pitchSemitones=0
}={}){
  if(!ctx?.audioWorklet||!Number.isFinite(ctx.sampleRate)||
     !Array.isArray(sourceChannels)||sourceChannels.length<1||
     sourceChannels.length>2||
     !sourceChannels.every(ch=>ch instanceof Float32Array&&ch.length>0&&
                                  ch.length===sourceChannels[0].length))
    throw RangeError("decoded local mono/stereo PCM and AudioWorklet required");
  const frames=sourceChannels[0].length;
  if(!Number.isFinite(sourceSampleRate)||sourceSampleRate<=0)
    throw RangeError("invalid source PCM sample rate");
  if(!Number.isFinite(commandTimeoutMs)||commandTimeoutMs<1||commandTimeoutMs>60000)
    throw RangeError("invalid PCM command timeout");
  let currentSpeed=validatePlaybackSpeed(speed);
  if(processingMode!=="raw"&&processingMode!=="granular")
    throw RangeError("invalid PCM processing mode");
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
    outputChannelCount:[sourceChannels.length],
    processorOptions:{
      sourceFrames:frames,sourceSampleRate,
      channelCount:sourceChannels.length,speed,
      startFrame,loopStartFrame:A,loopEndFrame:B,loopEnabled:loop,
      processingMode,pitchSemitones
    }
  });
  // Do not copy entire track to the worklet; these small snapshots are moved.
  let requestId=0,closed=false,latest=null;
  const pending=new Map();
  const rejectPending=error=>{
    for(const ticket of pending.values()){
      clearTimeout(ticket.timer);
      ticket.reject(error);
    }
    pending.clear();
  };
  const failProcessor=error=>{
    if(closed)return;
    // A lost command ACK does not mean the audio render thread has stopped.
    // Ask the processor to terminate before suppressing normal dispose().
    try{node.port.postMessage({type:"dispose"});}catch{}
    closed=true;
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
      pending.set(id,{resolve,reject,timer});
      try{node.port.postMessage({...data,requestId:id},transfers);}
      catch(error){
        clearTimeout(timer);pending.delete(id);
        reject(error);
      }
    });
  };
  const windowSlice=(requested,direction=currentSpeed)=>{
    const frame=Math.max(0,Math.min(frames-1,Math.floor(requested)));
    const start=chooseSourceWindowStart(frame,frames,SOURCE_WINDOW_FRAMES,direction);
    const end=Math.min(frames,start+SOURCE_WINDOW_FRAMES);
    return {start,channels:sourceChannels.map(x=>x.slice(start,end))};
  };
  const sendWindow=(requested,pin=null,direction=currentSpeed,refillId=null)=>{
    if(closed)return;
    const {start,channels}=windowSlice(requested,direction);
    node.port.postMessage({
      type:"window",start,channels,pin,refillId,
      requestId:++requestId
    },channels.map(x=>x.buffer));
  };
  const primeLoop=()=>{
    if(!loop)return;
    sendWindow(A,"A",1);
    sendWindow(B-1,"B",-1);
  };
  node.port.onmessage=event=>{
    if(closed)return;
    const data=event.data||{};
    if(data.type==="need-window"){
      sendWindow(data.frame,null,currentSpeed,data.refillId);
    }else if(data.type==="command-accepted"||data.type==="error"){
      const ticket=pending.get(data.requestId);
      if(ticket){
        pending.delete(data.requestId);
        clearTimeout(ticket.timer);
        if(data.type==="error")ticket.reject(Error(data.message));
        else ticket.resolve(data);
      }
    }else if(data.type==="progress")latest=data;
    onEvent(data);
  };
  // At initial start only, populate both loop endpoints before play.
  // Later user A/B changes use one atomic loop-config message.
  // The renderer bounds its cache to four windows by default.
  primeLoop();
  sendWindow(startFrame===frames?frames-1:startFrame);
  const command=(op,params={})=>submit({type:"command",op,...params});
  const updateLoop=(a,b,enabled,op)=>{
    if(closed)return Promise.reject(Error("PCM bridge disposed"));
    // Transfer both endpoint PCM windows and target loop configuration as
    // one message. No render quantum can see new pins with old A/B bounds.
    const endpoints=enabled?[
      windowSlice(a,1),windowSlice(b-1,-1)
    ]:[];
    return submit({type:"loop-config",op,a,b,enabled,endpoints},
      endpoints.flatMap(w=>w.channels.map(ch=>ch.buffer)));
  };
  const api={
    node,
    connect(destination){node.connect(destination);return api;},
    async play(){await ctx.resume();return command("play");},
    pause(){return command("pause");},
    seek(frame){
      if(!Number.isSafeInteger(frame)||frame<0||frame>frames)
        return Promise.reject(RangeError("invalid source-frame seek"));
      if(closed)return Promise.reject(Error("PCM bridge disposed"));
      const {start,channels}=windowSlice(frame===frames?frames-1:frame);
      // The source window and seek become one Worklet message, so prefetch
      // eviction cannot discard the target while protecting the old cursor.
      return submit({type:"seek-window",start,channels,frame,op:"seek"},
        channels.map(x=>x.buffer));
    },
    setSpeed(next){
      try{currentSpeed=validatePlaybackSpeed(next);}
      catch(error){return Promise.reject(error);}
      return command("speed",{speed:currentSpeed});
    },
    setPitch(next){
      if(processingMode!=="granular")
        return Promise.reject(Error("independent pitch requires granular mode"));
      try{next=validatePitch(next);}
      catch(error){return Promise.reject(error);}
      // Preserve caller's full finite input precision, independent of any
      // display rounding or rail snap. Render receipt has pitchRevision.
      return command("pitch",{semitones:next});
    },
    setLoopBounds(a,b){
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||
         a<0||a>=b||b>frames)return Promise.reject(RangeError("invalid A/B bounds"));
      A=a;B=b;
      return updateLoop(a,b,loop,"bounds");
    },
    setLoopEnabled(enabled){
      if(typeof enabled!=="boolean")
        return Promise.reject(TypeError("invalid loop enabled"));
      loop=enabled;
      return updateLoop(A,B,enabled,"loop");
    },
    get latest(){return latest;},
    get processingMode(){return processingMode;},
    dispose(){
      if(closed)return;
      closed=true;
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
