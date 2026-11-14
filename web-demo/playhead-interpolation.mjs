/** #63 U2: display-only projection from an audio-thread PCM progress receipt.
 * Never feeds the projected frame back to DSP seek/loop/transport ownership.
 * Source frame and signed speed come from the same AudioWorklet revision.
 * Extrapolation is bounded: a stalled UI must not pretend to have an
 * unbounded amount of freshly rendered audio.
 */
export function displaySourceFrame(progress,audioTime,sourceFrames,sourceSampleRate){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1||
    !Number.isFinite(sourceSampleRate)||sourceSampleRate<=0||
    !progress||!Number.isFinite(progress.sourceFrame))return null;
  const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
  let frame=clamp(progress.sourceFrame,0,sourceFrames-1);
  const time=progress.renderTime,rate=progress.speed;
  if(!progress.ended&&Number.isFinite(time)&&Number.isFinite(audioTime)&&
     Number.isFinite(rate)&&rate>=-8&&rate<=8){
    // At 48kHz the Worklet sends a progress receipt ~21ms apart.
    // Permit up to 50ms of projection, never extrapolate across seconds of
    // main-thread work or after AudioContext suspension.
    frame+=clamp(audioTime-time,0,.05)*rate*sourceSampleRate;
  }
  if(progress.loopEnabled&&
    Number.isSafeInteger(progress.loopStartFrame)&&
    Number.isSafeInteger(progress.loopEndFrame)&&
    progress.loopStartFrame>=0&&
    progress.loopEndFrame<=sourceFrames&&
    progress.loopEndFrame>progress.loopStartFrame){
    const a=progress.loopStartFrame,len=progress.loopEndFrame-a;
    frame=a+((frame-a)%len+len)%len;
  }else frame=clamp(frame,0,sourceFrames-1);
  return frame;
}
