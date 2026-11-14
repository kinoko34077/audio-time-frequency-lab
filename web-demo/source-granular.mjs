/** #36 R3: EXPERIMENTAL coherent overlap-add granular pitch/signed-time synth.
 * Source-time speed and grain-local pitch have independent magnitudes.
 * This is not yet accepted as high-fidelity music, transient-preserving DSP,
 * nor a way to make a one-source-sample loop sound naturally pitched.
 * One bounded source reader is supplied by the existing R2 PCM cache.
 */
export function createGranularTimePitch({
  sourceSampleRate,outputSampleRate,channelCount=1,
  grainFrames=2048,hopFrames=1024,pitchSemitones=0
}={}){
  if(![sourceSampleRate,outputSampleRate].every(x=>Number.isFinite(x)&&x>0)||
    !Number.isInteger(channelCount)||channelCount<1||channelCount>2||
    !Number.isInteger(grainFrames)||grainFrames<256||grainFrames>8192||
    !Number.isInteger(hopFrames)||hopFrames<1||hopFrames*2>grainFrames||
    grainFrames%hopFrames!==0)
    throw RangeError("invalid granular time/pitch configuration");
  const half=grainFrames/2,window=new Float64Array(grainFrames+1);
  for(let j=-half;j<=half;j++)
    window[j+half]=.5*(1+Math.cos(Math.PI*j/half));
  const srcPerOutput=sourceSampleRate/outputSampleRate;
  let outputFrames=0,direction=1,pitch=0,factor=1,revision=0;
  const grains=new Map();
  // Old overlap grains retain their pitch ratios while new ones adopt edits.
  const grainRatios=new Map();
  // Bounded output transition prevents a new pitch/speed epoch from jumping
  // immediately from the previous audio sample to a different grain phase.
  const lastSamples=new Float32Array(channelCount);
  const transitionFrom=new Float32Array(channelCount);
  const TRANSITION_FRAMES=128;
  let transitionLeft=0;
  function beginTransition(){
    transitionFrom.set(lastSamples);
    transitionLeft=TRANSITION_FRAMES;
  }
  function setPitch(semitones){
    if(typeof semitones!=="number"||!Number.isFinite(semitones)||
      semitones<-12||semitones>12)
      throw RangeError("pitch must be finite and within -12..12 semitones");
    if(pitch!==semitones){
      pitch=semitones;factor=2**(pitch/12);revision++;
      // Do not clear audible grains or restart the output clock. Overlap
      // already provides an old/new-grain transition at Hann endpoints.
    }
    return {pitchSemitones:pitch,pitchRatio:factor,pitchRevision:revision};
  }
  setPitch(pitchSemitones);
  return {
    get state(){return {
      pitchSemitones:pitch,pitchRatio:factor,
      pitchRevision:revision,outputFrames
    };},
    setPitch,beginTransition,
    // An intentional scratch displacement moves each still-active grain's
    // source anchor by the same amount. Do not erase the overlap epoch: the
    // next render must join the preceding audible sample, not restart.
    shiftSource(delta){
      if(!Number.isFinite(delta))throw RangeError("invalid scratch displacement");
      if(delta===0)return;
      if(Math.abs(delta)>16)beginTransition();
      for(const [k,anchor] of grains)grains.set(k,anchor+delta);
    },
    reset(){
      beginTransition();grains.clear();grainRatios.clear();outputFrames=0;
    },
    render(output,state,read,sourceFrames){
      if(!Array.isArray(output)||output.length!==channelCount||
        output.some(ch=>!(ch instanceof Float32Array)||
          ch.length!==output[0].length)||
        !state||typeof read!=="function"||
        !Number.isSafeInteger(sourceFrames)||sourceFrames<1)
        throw RangeError("invalid granular PCM render");
      if(state.speed>0)direction=1;
      else if(state.speed<0)direction=-1;
      const step=state.speed*srcPerOutput;
      const grainStep=direction*factor*srcPerOutput;
      const looping=state.loopEnabled,a=state.loopStartFrame,b=state.loopEndFrame;
      const wraps=n=>a+((n-a)%(b-a)+(b-a))%(b-a);
      let missing=0,firstMissingFrame=null;
      const baseOutput=outputFrames,baseSource=state.sourceFrame;
      const sampleAt=(ch,p)=>{
        if(looping)p=wraps(p);
        if(p<0||p>=sourceFrames)return 0;
        const index=Math.floor(p),frac=p-index;
        const next=frac===0?index:
          looping&&index+1>=b?a:Math.min(sourceFrames-1,index+1);
        const x=read(ch,index),y=frac===0?x:read(ch,next);
        return Number.isFinite(x)&&Number.isFinite(y)?x+(y-x)*frac:NaN;
      };
      const anchorAt=k=>{
        if(grains.has(k))return grains.get(k);
        const desired=baseSource+(k*hopFrames-baseOutput)*step;
        const previous=grains.get(k-1);
        const previousStep=direction*(grainRatios.get(k-1)??factor)*srcPerOutput;
        let anchor=desired;
        if(previous!==undefined&&
          (Math.abs(Math.abs(step)-Math.abs(grainStep))>1e-6||
            Math.abs(previousStep-grainStep)>1e-6)){
          let min=Infinity,best=0;
          // Waveform-similarity phase alignment. The bounded search is
          // intentionally conservative: this is a prototype, not an
          // arbitrary-time high-quality WSOLA replacement.
          for(let d=-180;d<=180;d+=2){
            let error=0,valid=0;
            for(let ch=0;ch<channelCount;ch++){
              for(let q=-48;q<=48;q+=4){
                const old=sampleAt(ch,
                  previous+(hopFrames+q)*previousStep);
                const candidate=sampleAt(ch,desired+d+q*grainStep);
                if(Number.isFinite(old)&&Number.isFinite(candidate)){
                  const diff=old-candidate;error+=diff*diff;valid++;
                }
              }
            }
            if(valid>=15*channelCount){
              error=error/valid+1e-7*(d/180)**2;
              if(error<min){min=error;best=d;}
            }
          }
          anchor=desired+best;
        }
        grains.set(k,anchor);
        grainRatios.set(k,factor);
        if(grains.size>12){
          const oldest=grains.keys().next().value;
          grains.delete(oldest);grainRatios.delete(oldest);
        }
        return anchor;
      };
      for(let i=0;i<output[0].length;i++){
        const t=baseOutput+i;
        const firstCenter=Math.floor((t-half)/hopFrames)+1;
        const lastCenter=Math.ceil((t+half)/hopFrames)-1;
        for(let k=firstCenter;k<=lastCenter;k++)anchorAt(k);
        let totalWeight=0;
        for(let k=firstCenter;k<=lastCenter;k++)
          totalWeight+=window[t-k*hopFrames+half];
        let sampleMiss=false;
        for(let ch=0;ch<channelCount;ch++){
          let value=0;
          for(let k=firstCenter;k<=lastCenter;k++){
            const center=k*hopFrames,weight=window[t-center+half];
            if(weight<=0)continue;
            // Hold the local pitch of grains that were audible before edit.
            const localStep=direction*(grainRatios.get(k)??factor)*srcPerOutput;
            let p=grains.get(k)+(t-center)*localStep;
            if(looping)p=wraps(p);
            if(p<0||p>=sourceFrames)continue;
            const index=Math.floor(p),frac=p-index;
            const next=frac===0?index:
              looping&&index+1>=b?a:Math.min(sourceFrames-1,index+1);
            const left=read(ch,index),right=frac===0?left:read(ch,next);
            if(!Number.isFinite(left)||!Number.isFinite(right)){
              sampleMiss=true;
              if(firstMissingFrame===null)
                firstMissingFrame=!Number.isFinite(left)?index:next;
              continue;
            }
            value+=weight*(left+(right-left)*frac);
          }
          const rendered=totalWeight?value/totalWeight:0;
          const weight=transitionLeft>0?transitionLeft/TRANSITION_FRAMES:0;
          const smooth=rendered*(1-weight)+transitionFrom[ch]*weight;
          output[ch][i]=smooth;
          lastSamples[ch]=smooth;
        }
        if(transitionLeft>0)transitionLeft--;
        if(sampleMiss)missing++;
      }
      outputFrames+=output[0].length;
      return {missingFrames:missing,firstMissingFrame};
    }
  };
}
