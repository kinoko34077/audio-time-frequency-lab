// #20 P2 research: several joint frequency-specific partials + preserved residual.
// This is a bounded *shared-sinusoid* model, not physical source separation.
// All observation windows fit the SAME oscillator unknowns for each candidate;
// no waveforms synthesized by different windows are mixed.
import {PERIOD_K,WINDOW_COUNT,theoreticalWindow,sampleInterval} from './period-joint.mjs';
import {detectClosePair,transportSourcePhase} from './period-joint-close.mjs';
const TAU=2*Math.PI;
const MAX_PARTIALS=6;
function fft(re,im){
 const n=re.length;
 for(let i=1,j=0;i<n;i++){
  let bit=n>>1;while(j&bit){j^=bit;bit>>=1;}j^=bit;
  if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}
 }
 for(let size=2;size<=n;size*=2){
  const step=TAU/size;
  for(let start=0;start<n;start+=size){
   for(let j=0;j<size/2;j++){
    const angle=-step*j,wr=Math.cos(angle),wi=Math.sin(angle),k=start+j,p=k+size/2;
    const tr=re[p]*wr-im[p]*wi,ti=re[p]*wi+im[p]*wr;
    re[p]=re[k]-tr;im[p]=im[k]-ti;
    re[k]+=tr;im[k]+=ti;
   }
  }
 }
}
export function detectSharedCandidates(channels,sr,{maxCandidates=14}={}){
 // Take the strongest channel as guide, to avoid cancellation in antiphase stereo.
 const L=channels[0].length;
 let guide=channels[0],largest=-1;
 for(const ch of channels){
  let energy=0;for(let i=0;i<L;i+=8)energy+=ch[i]*ch[i];
  if(energy>largest){largest=energy;guide=ch;}
 }
 if(largest<1e-9)return [];
 let N=1024;
 while(N*2<=Math.min(L,16384))N*=2;
 const minHz=45,maxHz=Math.min(7500,sr*.44);
 const density=sr/N;
 const peaks=[];
 for(const center of [.23,.5,.77]){
  const start=Math.max(0,Math.min(L-N,Math.round(L*center-N/2)));
  const re=new Float64Array(N),im=new Float64Array(N);
  for(let i=0;i<N;i++)re[i]=guide[start+i]*(.5-.5*Math.cos(TAU*i/(N-1)));
  fft(re,im);
  const spectrum=new Float64Array(N/2);
  for(let k=0;k<N/2;k++)spectrum[k]=re[k]*re[k]+im[k]*im[k];
  const lo=Math.max(1,Math.ceil(minHz/density)),hi=Math.min(N/2-2,Math.floor(maxHz/density));
  for(let k=lo;k<=hi;k++){
   if(spectrum[k]<spectrum[k-1]||spectrum[k]<=spectrum[k+1])continue;
   const a=Math.log(spectrum[k-1]+1e-24),b=Math.log(spectrum[k]+1e-24),c=Math.log(spectrum[k+1]+1e-24);
   const offset=Math.max(-.5,Math.min(.5,.5*(a-c)/(a-2*b+c||1)));
   peaks.push({f:(k+offset)*density,power:spectrum[k]});
  }
 }
 peaks.sort((a,b)=>b.power-a.power);
 const chosen=[];
 for(const peak of peaks){
  if(chosen.every(v=>Math.abs(v.f-peak.f)>Math.max(density*1.15,3))){
   chosen.push(peak);
   if(chosen.length>=maxCandidates)break;
  }
 }
 return chosen.map(p=>({frequency:p.f,binHz:density,power:p.power}));
}
function observationFit(signal,sr,f,centers,K){
 let cc=0,cs=0,ss=0,yc=0,ys=0,energy=0;
 const half=theoreticalWindow(f,K)/2;
 for(const center of centers){
  const {firstSample,endSample}=sampleInterval(center,f,sr,K);
  for(let i=Math.max(0,firstSample);i<Math.min(signal.length,endSample);i++){
   const t=i/sr,position=(t-center)/half;
   if(Math.abs(position)>=1)continue;
   const w=.5+.5*Math.cos(Math.PI*position),p=TAU*f*t;
   const a=Math.cos(p),b=Math.sin(p),y=signal[i];
   cc+=w*a*a;cs+=w*a*b;ss+=w*b*b;yc+=w*y*a;ys+=w*y*b;energy+=w*y*y;
  }
 }
 const det=cc*ss-cs*cs;
 if(!(det>1e-8))return null;
 const a=(yc*ss-ys*cs)/det,b=(ys*cc-yc*cs)/det;
 return {a,b,score:Math.max(0,a*yc+b*ys),energy};
}
function scoreSource(signal,sr,f,params){
 // Independent full-segment consistency for a candidate inferred from
 // frequency-specific windows. Does not count overlapping windows as
 // independent physical measurements.
 let projection=0,energy=0,error=0;
 const stride=Math.max(1,Math.floor(sr/12000));
 for(let i=0;i<signal.length;i+=stride){
  const y=signal[i],p=TAU*f*i/sr;
  const predicted=params.a*Math.cos(p)+params.b*Math.sin(p);
  projection+=predicted*predicted;energy+=y*y;error+=(y-predicted)**2;
 }
 return {explained:energy>1e-12?Math.max(-1,1-error/energy):1,projection,energy};
}
function refine(signal,sr,centers,freq,binHz,K){
 let best=null;
 const test=f=>{
  if(f<45||f>Math.min(7500,sr*.44))return;
  const params=observationFit(signal,sr,f,centers,K);
  if(!params)return;
  const full=scoreSource(signal,sr,f,params);
  // Full waveform is a validation penalty, while source parameter
  // unknowns still come from ALL seven observation windows.
  const rating=full.explained;
  if(!best||rating>best.rating)best={frequency:f,params,rating,full};
 };
 const span=Math.min(14,Math.max(2,binHz*1.4)),coarseStep=Math.max(.25,span/12);
 for(let f=freq-span;f<=freq+span+.000001;f+=coarseStep)test(f);
 if(best){
  const at=best.frequency;
  for(let f=at-.45;f<=at+.451;f+=.05)test(f);
 }
 return best;
}
function addComponent(dest,component,sr,sign=1){
 const f=component.frequency;
 for(let c=0;c<dest.length;c++){
  const arr=dest[c],{a,b}=component.coefficients[c];
  if(!a&&!b)continue;
  const step=TAU*f/sr,cs=Math.cos(step),sn=Math.sin(step);
  let x=1,y=0;
  for(let i=0;i<arr.length;i++){
   arr[i]+=sign*(a*x+b*y);
   const nextX=x*cs-y*sn;
   y=y*cs+x*sn;x=nextX;
   // Periodic exact re-anchor guards against drift over long chunks.
   if((i&4095)===4095){x=Math.cos(step*(i+1));y=Math.sin(step*(i+1));}
  }
 }
}
export function estimateSharedPartials({channels,sampleRate,K=PERIOD_K,maxPartials=MAX_PARTIALS}){
 if(!Array.isArray(channels)||channels.length<1||channels.length>2||!channels[0]?.length||
    channels.some(ch=>ch.length!==channels[0].length)||!Number.isFinite(sampleRate)||
    sampleRate<8000||sampleRate>192000)throw RangeError('invalid PCM for shared partial estimation');
 const L=channels[0].length;
 if(L>sampleRate*3)throw RangeError('joint processing chunks must be <=3s');
 if(!channels.every(ch=>ch.every(Number.isFinite)))throw RangeError('nonfinite PCM');
 const residual=channels.map(ch=>Float64Array.from(ch));
 const centers=Array.from({length:WINDOW_COUNT},(_,i)=>L/sampleRate*(i+.5)/WINDOW_COUNT);
 const candidates=detectSharedCandidates(channels,sampleRate,{maxCandidates:14});
 const partials=[];
 let baseEnergy=0;for(const ch of channels)for(let i=0;i<L;i+=4)baseEnergy+=ch[i]*ch[i];
 if(baseEnergy<1e-10)return {partials:[],residual,explained:1,windows:WINDOW_COUNT,candidates:0};
 // Resolve a bounded close-frequency hypothesis BEFORE greedy residual
 // peeling. FFT-bin peak de-dup can hide 440Hz + 441Hz as one source.
 // Do not force frequency fractions or align samples at disparate times.
 if(candidates.length){
  const close=detectClosePair({channels,sampleRate,peakFrequency:candidates[0].frequency});
  if(close){
   for(const p of close.partials){partials.push(p);addComponent(residual,p,sampleRate,-1);}
  }
 }
 for(const c of candidates){
  if(partials.length>=maxPartials)break;
  const guide=residual.reduce((best,ch)=>{
   let power=0;for(let i=0;i<L;i+=8)power+=ch[i]*ch[i];
   return !best||power>best.power?{ch,power}:best;
  },null).ch;
  const fit=refine(guide,sampleRate,centers,c.frequency,c.binHz,K);
  if(!fit||fit.rating<.008)continue;
  if(partials.some(p=>Math.abs(p.frequency-fit.frequency)<Math.max(.8,c.binHz*.2)))continue;
  const coefficients=residual.map(ch=>observationFit(ch,sampleRate,fit.frequency,centers,K)||{a:0,b:0});
  const partial={frequency:fit.frequency,coefficients,explainedInResidual:fit.rating};
  addComponent(residual,partial,sampleRate,-1);
  partials.push(partial);
 }
 // Block-coordinate joint refinement: refit each oscillator conditional on
 // all others. The final model uses ONE shared set of frequency/amplitudes.
 // Do not mix the synthetic outputs of any independent windows.
 for(const partial of partials){
  addComponent(residual,partial,sampleRate,1);
  const guide=residual[0];
  const updated=refine(guide,sampleRate,centers,partial.frequency,.4,K);
  if(updated&&updated.rating>=.005){
   partial.frequency=updated.frequency;
   partial.coefficients=residual.map(ch=>observationFit(ch,sampleRate,partial.frequency,centers,K)||{a:0,b:0});
  }
  addComponent(residual,partial,sampleRate,-1);
 }
 let residualEnergy=0;for(const ch of residual)for(let i=0;i<L;i+=4)residualEnergy+=ch[i]*ch[i];
 return {partials,residual,explained:Math.max(-1,1-residualEnergy/(baseEnergy+1e-12)),
   windows:WINDOW_COUNT,candidates:candidates.length,unresolvedPhysicalGrouping:true};
}
export function renderJointAudio({channels,sampleRate,speed=1,semitones=0,sourceStartSeconds=0,renderResidual}){
 if(!(Number.isFinite(speed)&&speed>=.5&&speed<=2&&Number.isFinite(semitones)&&semitones>=-12&&semitones<=12))throw RangeError('invalid transform');
 if(!(Number.isFinite(sourceStartSeconds)&&sourceStartSeconds>=0))throw RangeError('source offset');
 if(typeof renderResidual!=='function')throw TypeError('residual renderer is required');
 const frames=Math.max(1,Math.round(channels[0].length/speed));
 if(frames*channels.length>14_000_000)throw RangeError('memory cap');
 const model=estimateSharedPartials({channels,sampleRate});
 // For the neutral transform, retain the PCM exactly while still running
 // shared estimation. No transient or high-frequency signal is discarded.
 if(speed===1&&semitones===0)return {channels:channels.map(ch=>Float32Array.from(ch)),
  sampleRate,diagnostics:{partials:model.partials.length,residualEnergy:1-model.explained,neutral:true}};
 const transformedResidual=renderResidual(model.residual.map(ch=>Float32Array.from(ch)),frames);
 if(transformedResidual.length!==channels.length||transformedResidual.some(ch=>ch.length!==frames))throw RangeError('residual length mismatch');
 const out=transformedResidual.map(ch=>Float32Array.from(ch));
 const p=2**(semitones/12),absoluteOutputStart=sourceStartSeconds/speed;
 for(const partial of model.partials){
  const outF=partial.frequency*p;
  for(let c=0;c<out.length;c++){
   const {a,b}=partial.coefficients[c],amp=Math.hypot(a,b);
   if(amp<1e-8)continue;
   const localPhase=Math.atan2(-b,a);
   const globalPhase=transportSourcePhase(localPhase,partial.frequency,sourceStartSeconds,0);
   for(let i=0;i<frames;i++){
    out[c][i]+=amp*Math.cos(globalPhase+TAU*outF*(absoluteOutputStart+i/sampleRate));
   }
  }
 }
 // Output never silently drops the unmodeled content; artifacts remain possible.
 for(const ch of out)for(let i=0;i<ch.length;i++)if(!Number.isFinite(ch[i]))throw RangeError('nonfinite rendered PCM');
 return {channels:out,sampleRate,diagnostics:{partials:model.partials.length,
   residualEnergy:Math.max(0,1-model.explained),candidates:model.candidates,grouping:'ambiguous'}};
}
