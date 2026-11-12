/** #36 R1 pure source-time transport. Does not render sound or claim gaplessness.
 * A/B coordinates are original-source sample frames, independent of zoom/UI.
 */
export const SPEED_LIMIT=8;
export const SPEED_RAIL_RANGES=Object.freeze([1,2,4,8]);
const finite=v=>typeof v==="number"&&Number.isFinite(v);
const frame=v=>Number.isSafeInteger(v)&&v>=0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const wrap=(p,a,b)=>a+((p-a)%(b-a)+(b-a))%(b-a);

export function validatePlaybackSpeed(s){
  if(!finite(s)||s<-SPEED_LIMIT||s>SPEED_LIMIT)
    throw RangeError("speed must be finite and within -8..8");
  return Object.is(s,-0)?0:s;
}
export function validateSpeedRailRange(range){
  if(!SPEED_RAIL_RANGES.includes(range))
    throw RangeError("speed rail range must be ±1, ±2, ±4 or ±8");
  return range;
}
export function speedOnRail(speed,range){
  validatePlaybackSpeed(speed);validateSpeedRailRange(range);
  return clamp(speed,-range,range);
}
export function formatPlaybackSpeed(speed,{editing=false}={}){
  const s=validatePlaybackSpeed(speed);
  return editing?String(s):s.toFixed(2);
}
/** Source time in frames; speed=0 freezes time but DOES NOT synthesize audio. */
export function createSourceTimeline({
  sourceFrames,sourceSampleRate,outputSampleRate=sourceSampleRate,
  speed=1,startFrame=0,loopStartFrame=0,loopEndFrame=sourceFrames,
  loopEnabled=false
}={}){
  if(!frame(sourceFrames)||sourceFrames<1)throw RangeError("sourceFrames must be a positive safe integer");
  if(!finite(sourceSampleRate)||sourceSampleRate<=0||
     !finite(outputSampleRate)||outputSampleRate<=0)throw RangeError("invalid sample rate");
  if(!frame(startFrame)||startFrame>sourceFrames)throw RangeError("invalid startFrame");
  const valid=(a,b)=>frame(a)&&frame(b)&&a<b&&b<=sourceFrames;
  if(!valid(loopStartFrame,loopEndFrame))throw RangeError("invalid A/B source-frame interval");
  if(typeof loopEnabled!=="boolean")throw TypeError("loopEnabled must be boolean");
  let position=startFrame,rate=validatePlaybackSpeed(speed),
      A=loopStartFrame,B=loopEndFrame,loop=loopEnabled,revision=0;
  const reconcile=()=>{
    if(loop){
      if(position<A||position>=B)position=rate<0?B-1:A;
    }else if(rate<0&&position===sourceFrames)position=sourceFrames-1;
  };
  const state=()=>Object.freeze({
    sourceFrame:position,speed:rate,loopStartFrame:A,loopEndFrame:B,
    loopEnabled:loop,revision
  });
  const delta=frames=>frames*rate*sourceSampleRate/outputSampleRate;
  reconcile();
  const api={
    get state(){return state();},
    sourceFrameAt(outputOffset=0){
      if(!frame(outputOffset))throw RangeError("invalid output-frame offset");
      const p=position+delta(outputOffset);
      if(loop)return wrap(p,A,B);
      return p>=0&&p<sourceFrames?p:null;
    },
    sampleIndexAt(outputOffset=0){
      const p=api.sourceFrameAt(outputOffset);
      return p===null?null:Math.floor(p);
    },
    advance(outputFrames){
      if(!frame(outputFrames))throw RangeError("invalid output frame count");
      const p=position+delta(outputFrames);
      position=loop?wrap(p,A,B):clamp(p,0,sourceFrames);
      return state();
    },
    seek(p){
      if(!frame(p)||p>sourceFrames)throw RangeError("invalid seek frame");
      const old=position;position=p;reconcile();
      if(!Object.is(old,position))revision++;
      return state();
    },
    setSpeed(s){
      const next=validatePlaybackSpeed(s);
      if(Object.is(rate,next))return state();
      rate=next;reconcile();revision++;
      return state();
    },
    setLoopBounds(a,b){
      if(!valid(a,b))throw RangeError("invalid A/B source-frame interval");
      if(A===a&&B===b)return state();
      A=a;B=b;reconcile();revision++;
      return state();
    },
    setLoopEnabled(enabled){
      if(typeof enabled!=="boolean")throw TypeError("loopEnabled must be boolean");
      if(loop===enabled)return state();
      loop=enabled;reconcile();revision++;
      return state();
    }
  };
  return api;
}
