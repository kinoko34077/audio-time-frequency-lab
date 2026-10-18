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

/** Frequency Warp's engine 3 already implements a tracked-partial plus
 * in-band spectral-residual reconstruction. The original Lab accidentally
 * left its quality at an unrelated, hidden slider's default (0): the
 * spectral complement was excluded. Use the full existing residual path.
 *
 * Full residual processing is NOT lossless reconstruction: aliasing,
 * missing transients, phase quantisation and mapping above Nyquist remain.
 */
export function fullBandPartialOptions(sampleRate){
 if(!(Number.isFinite(sampleRate)&&sampleRate>=8000&&sampleRate<=192000))throw RangeError('invalid sample rate');
 return {
   aQuality:100,aBandBins:1,aMinHz:1,aReverb:0,
   low:1,high:Math.min(20000,sampleRate*.49),
   outside:'pass',crusherBits:0,crusherHold:1,
   ringEnabled:false,wet:1
 };
}
