/** #63 U2: display-only interpolation of render-thread source position.
 * The AudioWorklet is authoritative: never feed this value back to transport,
 * DSP, A/B state, seek or gesture commands.
 */
export const MAX_DISPLAY_LEAD_SECONDS=0.035;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const wrap=(p,a,b)=>a+((p-a)%(b-a)+(b-a))%(b-a);

/**
 * progress.sourceFrame is the first source frame AFTER an audio quantum.
 * progress.outputTime is the AudioContext time at that quantum's end.
 * The main thread may paint between 8-quantum progress reports. Extrapolate
 * only to the next nearby paint, and never across a transport revision.
 */
export function displaySourceFrameFromProgress(progress,{audioTime,sourceRate,sourceFrames}){
  if(!Number.isFinite(sourceRate)||sourceRate<=0||
     !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
    throw RangeError("invalid display source length or rate");
  if(!progress||!Number.isFinite(progress.sourceFrame))return null;
  const base=clamp(progress.sourceFrame,0,sourceFrames);
  if(!progress.running||progress.ended||!Number.isFinite(progress.speed)||
     !Number.isFinite(progress.outputTime)||!Number.isFinite(audioTime))
    return base;
  const elapsed=clamp(audioTime-progress.outputTime,0,MAX_DISPLAY_LEAD_SECONDS);
  const predicted=base+elapsed*progress.speed*sourceRate;
  if(progress.loopEnabled&&
     Number.isSafeInteger(progress.loopStartFrame)&&
     Number.isSafeInteger(progress.loopEndFrame)&&
     progress.loopStartFrame>=0&&
     progress.loopStartFrame<progress.loopEndFrame&&
     progress.loopEndFrame<=sourceFrames)
    return wrap(predicted,progress.loopStartFrame,progress.loopEndFrame);
  return clamp(predicted,0,sourceFrames);
}
