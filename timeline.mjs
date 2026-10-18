/** Original-source time and processed audio buffer time are different when speed != 1. */
export function toSourceSeconds(seconds, processed=false, speed=1){
  if(!Number.isFinite(speed)||speed<=0)throw new RangeError('speed must be positive');
  return seconds*(processed?speed:1);
}
export function fromSourceSeconds(seconds, processed=false, speed=1){
  if(!Number.isFinite(speed)||speed<=0)throw new RangeError('speed must be positive');
  return seconds/(processed?speed:1);
}
