/** #63 U9/U10: source-frame gesture velocity and bounded DJ-style return.
 * This is only a temporary transport override, never the user's saved speed.
 */
const clamp=(v,low,high)=>Math.max(low,Math.min(high,v));
export function scrubSpeed(previousFrame,nextFrame,elapsedMs,sourceRate){
  if(![previousFrame,nextFrame,elapsedMs,sourceRate].every(Number.isFinite)||
     elapsedMs<=0||sourceRate<=0)return 0;
  return clamp((nextFrame-previousFrame)*1000/(elapsedMs*sourceRate),-8,8);
}
export function releaseScrubSpeed(speed,timeSinceMoveMs){
  if(!Number.isFinite(speed)||!Number.isFinite(timeSinceMoveMs)||
     timeSinceMoveMs>100||Math.abs(speed)<.3)return 0;
  return clamp(speed,-8,8);
}
export function returnToPlaySpeed(scrub,requested,elapsedMs,durationMs=480){
  if(![scrub,requested,elapsedMs,durationMs].every(Number.isFinite)||
     durationMs<=0)throw RangeError("invalid scrub return parameters");
  const t=clamp(elapsedMs/durationMs,0,1),remain=(1-t)**3;
  return requested+(scrub-requested)*remain;
}
