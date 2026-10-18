/** Independent playback speed and spectral pitch mapping using upstream realtime Rust engine 3.
 * BufferSource at rate s => audio duration T/s and raw pitch scaled by s.
 * Rust spectral output ratio r=p/s => approximately input pitch times p.
 * Onset / residual quality remains limited by existing Rust oscillator tracking.
 */
export function liveFactors(speed,semitones){
 if(!Number.isFinite(speed)||speed<.5||speed>2)throw RangeError("speed must be 0.5..2");
 if(!Number.isFinite(semitones)||semitones<-12||semitones>12)throw RangeError("pitch must be -12..+12 semitones");
 const targetPitchRatio=2**(semitones/12);
 return {sourceRate:speed, spectralRatio:targetPitchRatio/speed, targetPitchRatio};
}
export function sourcePosition(start,elapsed,speed){
 return start+Math.max(0,elapsed)*speed;
}
