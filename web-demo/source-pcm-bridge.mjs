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
  onEvent=()=>{}
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
  let currentSpeed=validatePlaybackSpeed(speed);
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
      startFrame,loopStartFrame:A,loopEndFrame:B,loopEnabled:loop
    }
  });
  // Do not copy entire track to the worklet; these small snapshots are moved.
  let requestId=0,closed=false,latest=null;
  const pending=new Map();
  const windowSlice=(requested,direction=currentSpeed)=>{
    const frame=Math.max(0,Math.min(frames-1,Math.floor(requested)));
    const start=chooseSourceWindowStart(frame,frames,SOURCE_WINDOW_FRAMES,direction);
    const end=Math.min(frames,start+SOURCE_WINDOW_FRAMES);
    return {start,channels:sourceChannels.map(x=>x.slice(start,end))};
  };
  const sendWindow=(requested,pin=null,direction=currentSpeed)=>{
    if(closed)return;
    const {start,channels}=windowSlice(requested,direction);
    node.port.postMessage({
      type:"window",start,channels,pin,
      requestId:++requestId
    },channels.map(x=>x.buffer));
  };
  const primeLoop=()=>{
    if(!loop)return;
    sendWindow(A,"A",1);
    sendWindow(B-1,"B",-1);
  };
  node.port.onmessage=event=>{
    const data=event.data||{};
    if(data.type==="need-window"){
      sendWindow(data.frame,null,currentSpeed);
    }else if(data.type==="command-accepted"||data.type==="error"){
      const ticket=pending.get(data.requestId);
      if(ticket){
        pending.delete(data.requestId);
        if(data.type==="error")ticket.reject(Error(data.message));
        else ticket.resolve(data);
      }
    }else if(data.type==="progress")latest=data;
    onEvent(data);
  };
  // One PCM window per loop endpoint and one dynamic window. For a 1-sample
  // loop the transfer can be tiny; three slots cap duplicated PCM memory.
  primeLoop();
  sendWindow(startFrame===frames?frames-1:startFrame);
  const command=(op,params={})=>{
    if(closed)return Promise.reject(Error("PCM bridge disposed"));
    const id=++requestId;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      node.port.postMessage({type:"command",op,...params,requestId:id});
    });
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
      const id=++requestId;
      // The source window and seek become one Worklet message, so prefetch
      // eviction cannot discard the target while protecting the old cursor.
      return new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});
        node.port.postMessage({type:"seek-window",
          start,channels,frame,requestId:id},channels.map(x=>x.buffer));
      });
    },
    setSpeed(next){
      try{currentSpeed=validatePlaybackSpeed(next);}
      catch(error){return Promise.reject(error);}
      return command("speed",{speed:currentSpeed});
    },
    setLoopBounds(a,b){
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||
         a<0||a>=b||b>frames)return Promise.reject(RangeError("invalid A/B bounds"));
      A=a;B=b;primeLoop();
      return command("bounds",{a,b});
    },
    setLoopEnabled(enabled){
      if(typeof enabled!=="boolean")
        return Promise.reject(TypeError("invalid loop enabled"));
      loop=enabled;primeLoop();
      return command("loop",{enabled});
    },
    get latest(){return latest;},
    dispose(){
      if(closed)return;
      closed=true;
      // Disconnecting a node is NOT a processor lifetime command. Explicitly
      // stop its render loop and release its WorkletGlobalScope PCM windows.
      node.port.postMessage({type:"dispose"});
      node.port.onmessage=null;
      node.disconnect();
      for(const ticket of pending.values())ticket.reject(Error("PCM bridge disposed"));
      pending.clear();
    }
  };
  return api;
}
