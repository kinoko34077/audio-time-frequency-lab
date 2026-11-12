/** #36 R2: bounded raw-PCM source-frame renderer, not a pitch-preserving DSP.
 * Owns only source sample reads/interpolation and underrun measurement.
 * Transport decisions live in source-timeline.mjs.
 */
import {createSourceTimeline} from "./source-timeline.mjs";

export const SOURCE_WINDOW_FRAMES=65536;
export const SOURCE_WINDOW_SLOTS=3;

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
  let missingFrames=0,renderedFrames=0;
  const find=(index)=>{
    for(let i=windows.length-1;i>=0;i--){
      const w=windows[i];
      if(index>=w.start&&index<w.end)return w;
    }
    return null;
  };
  const api={
    timeline,
    get statistics(){return Object.freeze({
      missingFrames,renderedFrames,windowCount:windows.length
    });},
    hasFrame(index){return Number.isInteger(index)&&!!find(index);},
    installWindow(start,channels){
      if(!Number.isSafeInteger(start)||start<0||
         !Array.isArray(channels)||channels.length!==channelCount||
         channels.some(ch=>!(ch instanceof Float32Array))||
         channels[0].length<1||channels[0].length>maxWindowFrames||
         channels.some(ch=>ch.length!==channels[0].length)||
         start+channels[0].length>sourceFrames)
        throw RangeError("invalid PCM window");
      const end=start+channels[0].length;
      // Replace an old covering range with the newly transferred snapshot.
      for(let i=windows.length-1;i>=0;i--){
        if(windows[i].start===start)windows.splice(i,1);
      }
      windows.push({start,end,channels});
      while(windows.length>maxWindows)windows.shift();
      return windows.length;
    },
    /**
     * Render exactly one output block, no new worklet/node per loop.
     * Output must contain zeroed-by-render Float32Array channels of equal length.
     * Missing source data is explicitly counted. On underrun the timeline is
     * held for the whole block; missing samples are silence, never fake success.
     * Returns missing-frame count (not a newly allocated status object).
     */
    render(output){
      if(!Array.isArray(output)||output.length!==channelCount||
         output.some(ch=>!(ch instanceof Float32Array)||
           ch.length!==output[0].length))
        throw RangeError("invalid output PCM block");
      const len=output[0].length;
      let missing=0;
      const loopState=timeline.state;
      for(let i=0;i<len;i++){
        const position=timeline.sourceFrameAt(i);
        if(position===null){
          for(let ch=0;ch<channelCount;ch++)output[ch][i]=0;
          continue;
        }
        const at=Math.floor(position);
        const weight=position-at;
        const next=weight>0&&loopState.loopEnabled&&at+1>=loopState.loopEndFrame
          ?loopState.loopStartFrame:Math.min(sourceFrames-1,at+1);
        const left=find(at);
        const right=weight>0?find(next):left;
        if(!left||!right){missing++;
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
      if(missing===0)timeline.advance(len);
      return missing;
    },
    /** Used by host to prefetch ahead; does not report an audio success. */
    needsSourceWindow(outputLookahead=8192){
      const pos=timeline.sourceFrameAt(outputLookahead);
      if(pos===null)return null;
      const at=Math.floor(pos);
      const s=timeline.state;
      const next=s.loopEnabled&&at+1>=s.loopEndFrame?s.loopStartFrame:Math.min(sourceFrames-1,at+1);
      return find(at)&&find(next)?null:at;
    }
  };
  return api;
}
