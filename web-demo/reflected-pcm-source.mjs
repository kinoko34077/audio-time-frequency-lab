import {loopSourcePosition} from "./source-timeline.mjs";

/**
 * Virtual endpoint-exclusive ping-pong PCM source for the existing repeat
 * transport. Original interval [A,B); virtual period [0,P).
 * No full reflected copy: read() returns only the requested transferable window.
 * The input channels are immutable for this reader's lifetime.
 */
export function createReflectedPCMSource({channels,startFrame=0,endFrame=channels?.[0]?.length}={}){
  if(!Array.isArray(channels)||channels.length<1||channels.length>2||
     !channels.every(c=>c instanceof Float32Array&&c.length===channels[0].length))
    throw RangeError("mono/stereo PCM required");
  const A=startFrame,B=endFrame;
  if(!Number.isSafeInteger(A)||!Number.isSafeInteger(B)||A<0||A>=B||B>channels[0].length)
    throw RangeError("invalid reflected PCM interval");
  const span=B-A-1,period=span===0?1:2*span;
  if(!Number.isSafeInteger(period))throw RangeError("reflected PCM period is too large");
  const loop={loopEnabled:true,loopStartFrame:0,loopEndFrame:period};
  function toSourceFrame(frame){
    if(!Number.isFinite(frame))throw RangeError("invalid virtual frame");
    const p=loopSourcePosition(frame,loop);
    return A+(span===0?0:Math.min(p,period-p));
  }
  function toVirtualFrame(frame,{returning=false}={}){
    if(!Number.isFinite(frame)||frame<A||frame>B-1||typeof returning!=="boolean")
      throw RangeError("invalid original frame");
    const p=frame-A;
    return returning&&p>0?period-p:p;
  }
  function isReturning(frame){
    if(!Number.isFinite(frame))throw RangeError("invalid virtual frame");
    return span>0&&loopSourcePosition(frame,loop)>span;
  }
  async function read(start,count){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||start<0||count<1||
       count>period-start)throw RangeError("invalid virtual read range");
    const result=channels.map(()=>new Float32Array(count));
    for(let i=0;i<count;i++){
      const p=start+i,index=A+(span===0?0:Math.min(p,period-p));
      for(let c=0;c<channels.length;c++)result[c][i]=channels[c][index];
    }
    return {startFrame:start,channels:result};
  }
  return Object.freeze({sourceFrames:period,channelCount:channels.length,
    startFrame:A,endFrame:B,toSourceFrame,toVirtualFrame,isReturning,read});
}
