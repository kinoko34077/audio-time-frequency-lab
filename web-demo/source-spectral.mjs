import {loopSourcePosition} from "./source-timeline.mjs";
/** #36 spectral-first experimental continuous source-time renderer.
 * STFT phase-coherent overlap-add, NOT granular repetition. The original
 * source sample-frame clock remains in source-timeline.mjs; this module only
 * synthesizes sound in the already persistent/bounded PCM AudioWorklet.
 * Freeze at 0x evolves spectral phases without repeatedly playing a fixed
 * physical grain. Exact microscopic A/B loops can never recover harmonic
 * content not present in their original samples.
 */
const TAU=2*Math.PI;
const wrapPhase=x=>x-TAU*Math.round(x/TAU);
const finite=x=>typeof x==="number"&&Number.isFinite(x);
export function createSpectralTimePitch({
  sourceSampleRate,outputSampleRate,channelCount=1,
  fftFrames=2048,hopFrames=256,pitchSemitones=0,phaseLock=false
}={}){
  if(!finite(sourceSampleRate)||sourceSampleRate<=0||
    !finite(outputSampleRate)||outputSampleRate<=0||
    !Number.isInteger(channelCount)||channelCount<1||channelCount>2||
    ![1024,2048,4096,8192].includes(fftFrames)||
    !Number.isInteger(hopFrames)||hopFrames<1||
    fftFrames%hopFrames!==0||hopFrames>fftFrames/4||
    typeof phaseLock!=="boolean")
    throw RangeError("invalid spectral source/time configuration");
  const N=fftFrames,H=hopFrames,half=N/2,srcRatio=sourceSampleRate/outputSampleRate;
  const win=new Float64Array(N);
  for(let i=0;i<N;i++)win[i]=.5-.5*Math.cos(TAU*(i+.5)/N);
  const analysis=Array.from({length:channelCount},()=>({
    re:new Float64Array(N),im:new Float64Array(N)
  }));
  const probe={re:new Float64Array(N),im:new Float64Array(N)};
  const synth=Array.from({length:channelCount},()=>({
    re:new Float64Array(N),im:new Float64Array(N)
  }));
  const prev=new Float64Array(half+1),phases=new Float64Array(half+1);
  const binPhase=new Float64Array(half+1);
  const freq=new Float64Array(half+1),mags=new Float64Array(half+1);
  // Distinct real-time peak-locked PV backend. Coherent neighboring bins
  // preserve source-relative phases; the base spectral model stays unmodified.
  const lockedPhases=new Float64Array(half+1);
  const peaks=new Int32Array(half+1);
  const ringSize=N*4;
  const ola=Array.from({length:channelCount},()=>new Float64Array(ringSize));
  const norm=new Float64Array(ringSize);
  const last=new Float32Array(channelCount);
  const fadeFrom=new Float32Array(channelCount);
  const FADE=128;
  let fadeLeft=0,outputFrames=0,nextStart=-N+H,initialized=false;
  let pitch=0,ratio=1,revision=0;
  // In-place FFT. No per-frame objects/arrays and no allocations on the
  // realtime callback, even when source time is held at 0x.
  function fft(re,im,inverse=false){
    for(let i=1,j=0;i<N;i++){
      let bit=N>>1;
      for(;j&bit;bit>>=1)j^=bit;
      j^=bit;
      if(i<j){let t=re[i];re[i]=re[j];re[j]=t;
        t=im[i];im[i]=im[j];im[j]=t;}
    }
    for(let size=2;size<=N;size*=2){
      const ar=Math.cos(TAU/size),ai=(inverse?1:-1)*Math.sin(TAU/size);
      for(let start=0;start<N;start+=size){
        let wr=1,wi=0;
        for(let j=0;j<size/2;j++){
          const a=start+j,b=a+size/2;
          const br=re[b]*wr-im[b]*wi,bi=re[b]*wi+im[b]*wr;
          const ur=re[a],ui=im[a];
          re[a]=ur+br;im[a]=ui+bi;
          re[b]=ur-br;im[b]=ui-bi;
          const nr=wr*ar-wi*ai;
          wi=wr*ai+wi*ar;wr=nr;
        }
      }
    }
    if(inverse)for(let i=0;i<N;i++){re[i]/=N;im[i]/=N;}
  }
  function beginTransition(){fadeFrom.set(last);fadeLeft=FADE;}
  function reset(){
    beginTransition();
    for(const buffer of ola)buffer.fill(0);
    norm.fill(0);outputFrames=0;nextStart=-N+H;initialized=false;
  }
  function setPitch(semitones){
    if(!finite(semitones)||semitones<-12||semitones>12)
      throw RangeError("pitch must be finite in ±12 semitones");
    if(semitones!==pitch){
      pitch=semitones;ratio=2**(pitch/12);revision++;
      beginTransition();
    }
    return {pitchSemitones:pitch,pitchRatio:ratio,pitchRevision:revision};
  }
  setPitch(pitchSemitones);
  // Sampling is in ORIGINAL source-time frames. The source cache and sample
  // interpolation are the same bounded PCM reader as the existing renderer.
  function sampleAt(ch,pos,_state,read,sourceFrames,missing){
    // A/B constrains the STFT ANALYSIS CENTER, not every sample of its
    // context window. Repeating 1..128 PCM values inside a 2048-sample FFT
    // would synthesize precisely the fixed-period comb the user rejected.
    // A one-sample loop is an exact stationary center surrounded by the
    // original musical context; it does not copy non-existent source notes.
    if(pos<0||pos>=sourceFrames)return 0;
    const index=Math.floor(pos),frac=pos-index;
    const next=frac===0?index:Math.min(sourceFrames-1,index+1);
    const x=read(ch,index),y=frac===0?x:read(ch,next);
    if(!finite(x)||!finite(y)){
      if(missing.first===null)missing.first=!finite(x)?index:next;
      missing.total++;return 0;
    }
    return x+(y-x)*frac;
  }
  function makeFrame(start,sourceCenter,state,read,sourceFrames,missing){
    const center=N/2,probeShift=H/2;
    for(let ch=0;ch<channelCount;ch++){
      const {re,im}=analysis[ch];
      for(let i=0;i<N;i++){
        re[i]=sampleAt(ch,sourceCenter+i-center,state,read,sourceFrames,missing)*win[i];
        im[i]=0;
      }
      fft(re,im);
    }
    // A source-relative fixed probe gives frequency even when the user holds
    // 0×. It also avoids dividing by a near-zero (or reversed) source hop.
    for(let i=0;i<N;i++){
      probe.re[i]=sampleAt(0,sourceCenter+probeShift+i-center,
        state,read,sourceFrames,missing)*win[i];
      probe.im[i]=0;
    }
    fft(probe.re,probe.im);
    for(let k=0;k<=half;k++){
      const re=analysis[0].re[k],im=analysis[0].im[k];
      mags[k]=Math.hypot(re,im);
      const phase=Math.atan2(im,re);
      const phiProbe=Math.atan2(probe.im[k],probe.re[k]);
      const nominal=TAU*k/N;
      // Each spectral bin keeps its real instantaneous angular frequency.
      // phase evolution is in output time, independent of signed source speed.
      const delta=wrapPhase(phiProbe-phase-nominal*probeShift);
      const angular=nominal+delta/probeShift;
      freq[k]=k===0?0:Math.max(0,Math.min(Math.PI,angular));
      if(!initialized)phases[k]=phase;
      else phases[k]+=freq[k]*H*ratio*srcRatio;
      binPhase[k]=phase;
    }
    initialized=true;
    if(phaseLock){
      // Laroche-Dolson-style identity phase locking: track the real phase of
      // each dominant analysis peak, then preserve nearby bin/peak phase
      // relationships. Unlike regular binwise STFT this suppresses vertical
      // phase dispersion during slowing/freeze without repeating PCM grains.
      let maxMag=0,count=0;
      for(let k=0;k<=half;k++)if(mags[k]>maxMag)maxMag=mags[k];
      for(let k=1;k<half;k++){
        if(mags[k]>=mags[k-1]&&mags[k]>=mags[k+1]&&
           mags[k]>maxMag*.004)peaks[count++]=k;
      }
      if(count===0){
        let best=0;
        for(let k=1;k<=half;k++)if(mags[k]>mags[best])best=k;
        peaks[count++]=best;
      }
      for(let k=0,j=0;k<=half;k++){
        while(j+1<count&&
          Math.abs(peaks[j+1]-k)<Math.abs(peaks[j]-k))j++;
        const peak=peaks[j];
        lockedPhases[k]=Math.abs(peak-k)<=4?
          phases[peak]+wrapPhase(binPhase[k]-binPhase[peak]):phases[k];
      }
    }
    for(let ch=0;ch<channelCount;ch++){
      const dest=synth[ch];
      dest.re.fill(0);dest.im.fill(0);
      const input=analysis[ch];
      for(let k=0;k<=half;k++){
        const mag=Math.hypot(input.re[k],input.im[k]);
        if(mag<1e-12)continue;
        const actualPhase=Math.atan2(input.im[k],input.re[k]);
        const phase=(phaseLock?lockedPhases[k]:phases[k])+
          wrapPhase(actualPhase-binPhase[k]);
        // Pitch independent of source traversal speed: interpolate between
        // destination FFT bins instead of repeating small waveform grains.
        // FFT bins here were measured at sourceSampleRate, whereas
        // synthesis FFT bins are outputSampleRate. Keep 440 Hz as 440 Hz
        // even when a 44.1 kHz source plays through a 48 kHz device.
        const target=k*ratio*srcRatio,j=Math.floor(target),frac=target-j;
        // The Hann analysis window is CENTERED at N/2. At that center,
        // adjacent FFT carriers differ by pi. Reusing an identical complex
        // phase for destination bins j and j+1 therefore CANCELS the source
        // partial when fractional shift approaches half a bin (comb-like
        // frequency-dependent loss even at a tiny nonzero pitch).
        // Compensate the source->destination integer-bin parity. The center
        // of each synthesized partial then retains the original relative
        // phase; the outer timeline still owns time and looping.
        const polarity=((j-k)&1)?-1:1;
        const re=mag*Math.cos(phase),im=mag*Math.sin(phase);
        if(j<=half){
          const gain=polarity*(1-frac);
          dest.re[j]+=gain*re;
          dest.im[j]+=gain*im;
        }
        if(frac>0&&j+1<=half){
          const gain=-polarity*frac;
          dest.re[j+1]+=gain*re;
          dest.im[j+1]+=gain*im;
        }
      }
      for(let k=1;k<half;k++){dest.re[N-k]=dest.re[k];dest.im[N-k]=-dest.im[k];}
      dest.im[0]=0;dest.im[half]=0;
      fft(dest.re,dest.im,true);
    }
    for(let i=0;i<N;i++){
      const t=start+i;
      if(t<0)continue;
      const slot=t%ringSize,w=win[i];
      norm[slot]+=w*w;
      for(let ch=0;ch<channelCount;ch++)
        ola[ch][slot]+=synth[ch].re[i]*w;
    }
  }
  return {
    get state(){return {pitchSemitones:pitch,pitchRatio:ratio,
      pitchRevision:revision,outputFrames,algorithm:phaseLock?
        "phase-vocoder-peak-locked":"stft-phase-coherent"};},
    setPitch,beginTransition,reset,
    shiftSource(delta){
      if(!finite(delta))throw RangeError("invalid spectral scratch displacement");
      // Audio Time's atomic scrub moves the canonical source cursor. Spectral
      // analysis follows that source frame on the NEXT hop; keep overlap-add
      // and accumulated output phase across every finger movement.
      // Resetting on each scrub event makes audible 256-sample repeats/cuts.
      if(Math.abs(delta)>N/2)beginTransition();
    },
    render(output,state,read,sourceFrames){
      if(!Array.isArray(output)||output.length!==channelCount||
        output.some(ch=>!(ch instanceof Float32Array)||
          ch.length!==output[0].length)||
        !state||typeof read!=="function"||
        !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
        throw RangeError("invalid spectral PCM render");
      const missing={first:null,total:0};
      const base=state.sourceFrame,sourceStep=state.speed*srcRatio;
      const centerAt=position=>loopSourcePosition(position,state);
      for(let i=0;i<output[0].length;i++){
        const t=outputFrames+i;
        while(nextStart<=t){
          makeFrame(nextStart,centerAt(
            base+(nextStart+half-outputFrames)*sourceStep),
            state,read,sourceFrames,missing);
          nextStart+=H;
        }
        const slot=t%ringSize,denom=norm[slot];
        for(let ch=0;ch<channelCount;ch++){
          const sample=denom>1e-10?ola[ch][slot]/denom:0;
          const mix=fadeLeft>0?fadeLeft/FADE:0;
          const value=sample*(1-mix)+fadeFrom[ch]*mix;
          output[ch][i]=finite(value)?value:0;
          last[ch]=output[ch][i];ola[ch][slot]=0;
        }
        norm[slot]=0;
        if(fadeLeft>0)fadeLeft--;
      }
      outputFrames+=output[0].length;
      return {missingFrames:missing.total>0?Math.min(output[0].length,missing.total):0,
        firstMissingFrame:missing.first};
    }
  };
}
