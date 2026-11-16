/** Audio Lab #36: real-time Dual long PV + short WSOLA onset carrier.
 *
 * Both DSP engines consume the SAME immutable source-time state per AudioWorklet
 * render quantum. Neither advances the source clock; only the existing bounded
 * PCM renderer does that once, after composition. This implements the original
 * dualWindowVocoder responsibility split without a 1.5-second preview Worker.
 *
 * A detected source transient is emitted from ONE short waveform-coherent
 * carrier. Between onsets the peak-locked long-window PV retains tonal pitch.
 * The blend is bounded/smoothed and uses stereo-shared cross-correlation lag.
 * Audible quality, particularly on one-sample loops/iPhone, is NOT certified.
 */
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {createWsolaTimePitch} from "./source-granular.mjs";

const finite=x=>typeof x==="number"&&Number.isFinite(x);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function createDualTimePitch({
  sourceSampleRate,outputSampleRate,channelCount=1,
  shortFrames=512,longFrames=2048,pitchSemitones=0
}={}){
  if(!finite(sourceSampleRate)||sourceSampleRate<=0||
    !finite(outputSampleRate)||outputSampleRate<=0||
    !Number.isInteger(channelCount)||channelCount<1||channelCount>2||
    ![256,512,1024,2048,4096].includes(shortFrames)||
    ![1024,2048,4096,8192].includes(longFrames)||
    shortFrames>=longFrames)
    throw RangeError("Dual requires valid short WSOLA and longer PV windows");
  const pv=createSpectralTimePitch({sourceSampleRate,outputSampleRate,
    channelCount,fftFrames:longFrames,hopFrames:longFrames/8,
    pitchSemitones,phaseLock:true});
  const wsola=createWsolaTimePitch({sourceSampleRate,outputSampleRate,
    channelCount,grainFrames:shortFrames,hopFrames:shortFrames/4,
    pitchSemitones});
  let longPCM=Array.from({length:channelCount},()=>new Float32Array(128));
  let shortPCM=Array.from({length:channelCount},()=>new Float32Array(128));
  let pitch=pitchSemitones,revision=0,renderedFrames=0,lastTrigger=-Infinity;
  let hold=0,prevGain=0,bestLag=0,attacks=0,lastAttackSource=-Infinity;
  const outputLast=new Float32Array(channelCount);
  const sourceRatio=sourceSampleRate/outputSampleRate;
  const attackLength=Math.round(outputSampleRate*.030);
  const fadeLength=Math.max(64,Math.round(outputSampleRate*.007));
  const alignSpan=Math.min(24,Math.max(3,Math.round(outputSampleRate*.0005)));
  function ensureLength(n){
    if(longPCM[0].length===n)return;
    longPCM=Array.from({length:channelCount},()=>new Float32Array(n));
    shortPCM=Array.from({length:channelCount},()=>new Float32Array(n));
  }
  function energyAt(center,read,sourceFrames){
    const half=Math.min(160,shortFrames/4),stride=8;
    let energy=0,count=0;
    for(let offset=-half;offset<=half;offset+=stride){
      const index=Math.round(center+offset);
      if(index<0||index>=sourceFrames)continue;
      for(let ch=0;ch<channelCount;ch++){
        const v=read(ch,index);
        if(finite(v)){energy+=v*v;count++;}
      }
    }
    return count?Math.sqrt(energy/count):0;
  }
  // The previous source interval is measured along the gesture's direction,
  // not output-time direction; moving backward encounters attacks in reverse.
  function detectAttack(state,read,frames,n){
    const step=state.speed*sourceRatio;
    if(Math.abs(step)<1e-8)return -1;
    const direction=step<0?-1:1;
    const lookBehind=Math.max(128,shortFrames/2);
    // Scan short source intervals at most every 16 output samples: detection
    // remains meaningful under both +8 and -8 source-frame traversal.
    for(let i=0;i<n;i+=16){
      const at=state.sourceFrame+i*step;
      const current=energyAt(at,read,frames);
      const before=energyAt(at-direction*lookBehind,read,frames);
      if(current>before*2.15+.009&&current>.017&&
        Math.abs(at-lastAttackSource)>shortFrames/2&&
        renderedFrames+i-lastTrigger>shortFrames/4){
        lastAttackSource=at;
        lastTrigger=renderedFrames+i;
        return i;
      }
    }
    return -1;
  }
  // Original offline Dual aligns the two independently reconstructed
  // carriers around each source onset; preserve this step instead of
  // blindly mixing potentially opposite phases.
  function stereoSharedLag(n){
    if(n<48)return 0;
    let best=0,bestScore=-Infinity;
    const width=Math.min(alignSpan,Math.floor(n/4));
    for(let lag=-width;lag<=width;lag++){
      let dot=0,aa=0,bb=0;
      for(let i=width;i<n-width;i+=3){
        const shifted=i+lag;
        for(let ch=0;ch<channelCount;ch++){
          const a=longPCM[ch][i],b=shortPCM[ch][shifted];
          dot+=a*b;aa+=a*a;bb+=b*b;
        }
      }
      const score=dot/Math.sqrt(aa*bb+1e-12);
      if(score>bestScore){bestScore=score;best=lag;}
    }
    return bestScore>.12?best:0;
  }
  return {
    get state(){return {algorithm:"dual-onset-wsola-pv",
      shortAlgorithm:wsola.state.algorithm,longAlgorithm:pv.state.algorithm,
      pitchSemitones:pitch,pitchRevision:revision,
      outputFrames:renderedFrames,transientCount:attacks,
      currentBlend:prevGain};},
    setPitch(semitones){
      // Validate in both existing engines before exposing a new dual value.
      if(!finite(semitones)||semitones<-12||semitones>12)
        throw RangeError("pitch must be finite in ±12 semitones");
      pv.setPitch(semitones);wsola.setPitch(semitones);
      if(pitch!==semitones){pitch=semitones;revision++;}
      return {pitchSemitones:pitch,pitchRevision:revision};
    },
    shiftSource(delta){
      if(!finite(delta))throw RangeError("invalid dual scrub displacement");
      pv.shiftSource(delta);wsola.shiftSource(delta);
      if(Math.abs(delta)>shortFrames/2){
        lastAttackSource=-Infinity;lastTrigger=-Infinity;
      }
    },
    beginTransition(){pv.beginTransition();wsola.beginTransition();},
    reset(){
      pv.reset();wsola.reset();
      renderedFrames=0;hold=0;prevGain=0;
      bestLag=0;lastTrigger=-Infinity;lastAttackSource=-Infinity;
    },
    render(output,state,read,sourceFrames){
      if(!Array.isArray(output)||output.length!==channelCount||
        output.some(ch=>!(ch instanceof Float32Array)||
          ch.length!==output[0].length)||
        !state||typeof read!=="function"||
        !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
        throw RangeError("invalid dual PCM render");
      const n=output[0].length;
      ensureLength(n);
      // Two distinct, real signal processors; no source-clock duplication.
      const longResult=pv.render(longPCM,state,read,sourceFrames);
      const shortResult=wsola.render(shortPCM,state,read,sourceFrames);
      const attackAt=detectAttack(state,read,sourceFrames,n);
      if(attackAt>=0){attacks++;bestLag=stereoSharedLag(n);}
      for(let i=0;i<n;i++){
        if(i===attackAt)hold=attackLength;
        const target=hold>fadeLength?1:hold>0?hold/fadeLength:0;
        // Attack must quickly select the single short carrier, while release
        // is slow enough not to modulate the phase-locked sustained tone.
        const alpha=target>prevGain?.22:.018;
        prevGain+=alpha*(target-prevGain);
        const gain=clamp(prevGain,0,1);
        const lag=bestLag;
        for(let ch=0;ch<channelCount;ch++){
          const index=clamp(i+lag,0,n-1);
          const v=longPCM[ch][i]*(1-gain)+shortPCM[ch][index]*gain;
          output[ch][i]=finite(v)?v:0;
          outputLast[ch]=output[ch][i];
        }
        if(hold>0)hold--;
      }
      renderedFrames+=n;
      const a=longResult.firstMissingFrame,b=shortResult.firstMissingFrame;
      return {missingFrames:Math.max(longResult.missingFrames,
        shortResult.missingFrames),firstMissingFrame:a===null?b:b===null?a:
        Math.min(a,b)};
    }
  };
}
