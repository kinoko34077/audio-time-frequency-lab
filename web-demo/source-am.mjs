/** #36: Native AM-envelope + peak-locked phase-vocoder model.
 * Owns only envelope treatment and sound synthesis. The PCM renderer owns
 * source time, A/B loop, speed, cache, scrub, pause and all receipts.
 * The existing offline amVocoder is the reference for 12ms RMS contours,
 * 35ms gain smoothing and bounded 0.72..1.28 envelope correction.
 */
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {loopSourcePosition} from "./source-timeline.mjs";

const finite=x=>typeof x==="number"&&Number.isFinite(x);
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));

export function createAmTimePitch({sourceSampleRate,outputSampleRate,
  channelCount=1,pitchSemitones=0}={}){
  if(!finite(sourceSampleRate)||sourceSampleRate<=0||
    !finite(outputSampleRate)||outputSampleRate<=0||
    !Number.isInteger(channelCount)||channelCount<1||channelCount>2)
    throw RangeError("invalid AM source-time configuration");
  const pv=createSpectralTimePitch({sourceSampleRate,outputSampleRate,
    channelCount,pitchSemitones,phaseLock:true});
  const stepRatio=sourceSampleRate/outputSampleRate;
  const alphaEnv=1-Math.exp(-1/(outputSampleRate*.012));
  const alphaGain=1-Math.exp(-1/(outputSampleRate*.035));
  // Full-band squared-source samples are integrated at each probe; the
  // slower 64-output-frame update bounds real-time worklet CPU overhead.
  // 64 samples are still far below the 12ms envelope time constant.
  const sourceStride=64;
  const sourceAlpha=1-Math.exp(-sourceStride/(outputSampleRate*.012));
  const radius=Math.round(sourceSampleRate*.012);
  let sourceEnvelope=0,processedPower=0,gain=1,outputFrames=0;
  let sourcePeak=0,correctionFrames=0;

  // A/B constrains the analysis CENTER (as in the common PV), not every
  // surrounding PCM sample. Tiny loops never synthesize a false grain rate.
  function sourceRms(center,state,read,sourceFrames){
    const position=loopSourcePosition(center,state);
    let power=0,count=0;
    // Never decimate a raw periodic waveform before squaring it: a 3kHz
    // tone at 48kHz completes exactly one cycle per old 16-sample stride.
    // Skipped probes therefore followed one fixed phase and fabricated AM
    // gain changes at 0x even though its physical RMS was unchanged.
    for(let q=-radius;q<=radius;q++){
      const frame=Math.round(position+q);
      if(frame<0||frame>=sourceFrames)continue;
      for(let ch=0;ch<channelCount;ch++){
        const value=read(ch,frame);
        if(finite(value)){power+=value*value;count++;}
      }
    }
    return count?Math.sqrt(power/count):null;
  }
  return {
    get state(){return {
      algorithm:"am-envelope-pv-continuous",
      carrierAlgorithm:pv.state.algorithm,
      pitchSemitones:pv.state.pitchSemitones,
      pitchRevision:pv.state.pitchRevision,
      outputFrames,correctionFrames,
      gain,sourcePeak
    };},
    setPitch(semitones){return pv.setPitch(semitones);},
    beginTransition(){pv.beginTransition();},
    shiftSource(delta){
      if(!finite(delta))throw RangeError("invalid AM scratch displacement");
      pv.shiftSource(delta);
    },
    reset(){
      pv.reset();
      sourceEnvelope=0;processedPower=0;gain=1;outputFrames=0;
      sourcePeak=0;correctionFrames=0;
    },
    render(output,state,read,sourceFrames){
      if(!Array.isArray(output)||output.length!==channelCount||
        output.some(ch=>!(ch instanceof Float32Array)||
          ch.length!==output[0].length)||
        !state||typeof read!=="function"||
        !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
        throw RangeError("invalid AM PCM render");
      const result=pv.render(output,state,read,sourceFrames);
      const distance=state.speed*stepRatio;
      for(let i=0;i<output[0].length;i++){
        if(i%sourceStride===0){
          const rms=sourceRms(state.sourceFrame+i*distance,
            state,read,sourceFrames);
          if(rms!==null){
            sourceEnvelope+=sourceAlpha*(rms-sourceEnvelope);
            sourcePeak=Math.max(sourcePeak,sourceEnvelope);
          }
        }
        let square=0;
        for(let ch=0;ch<channelCount;ch++)square+=output[ch][i]**2;
        square/=channelCount;
        processedPower+=alphaEnv*(square-processedPower);
        const actual=Math.sqrt(Math.max(0,processedPower));
        const wanted=sourceEnvelope<.004?1:
          clamp(sourceEnvelope/Math.max(.004,actual),.72,1.28);
        gain+=alphaGain*(wanted-gain);
        if(Math.abs(gain-1)>.005)correctionFrames++;
        for(let ch=0;ch<channelCount;ch++)
          output[ch][i]*=gain;
      }
      outputFrames+=output[0].length;
      return result;
    }
  };
}
