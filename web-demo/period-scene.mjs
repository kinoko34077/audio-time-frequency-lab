// Issue #20: joint multi-tone latent model plus explicitly retained residual.
// Candidate detection initializes frequencies; ALL amplitudes/relative phases
// are refitted in one weighted least-squares problem across ALL K/f windows.
import {estimateJointTone,theoreticalWindow,WINDOW_COUNT,PERIOD_K} from './period-joint.mjs';
const TAU=2*Math.PI;
function energy(channels){let e=0;for(const ch of channels)for(const y of ch)e+=y*y;return e;}
function linearSolve(matrix,rhs,n){
 const a=Float64Array.from(matrix),b=Float64Array.from(rhs);
 let trace=0;for(let i=0;i<n;i++)trace+=a[i*n+i];
 for(let i=0;i<n;i++)a[i*n+i]+=Math.max(1e-10,trace/n*1e-9);
 for(let p=0;p<n;p++){
  let pivot=p,largest=Math.abs(a[p*n+p]);
  for(let j=p+1;j<n;j++)if(Math.abs(a[j*n+p])>largest){pivot=j;largest=Math.abs(a[j*n+p]);}
  if(largest<1e-12)return null;
  if(p!==pivot){for(let j=0;j<n;j++)[a[p*n+j],a[pivot*n+j]]=[a[pivot*n+j],a[p*n+j]];[b[p],b[pivot]]=[b[pivot],b[p]];}
  for(let j=p+1;j<n;j++){
   const k=a[j*n+p]/a[p*n+p];
   for(let h=p;h<n;h++)a[j*n+h]-=k*a[p*n+h];
   b[j]-=k*b[p];
  }
 }
 for(let p=n-1;p>=0;p--){for(let j=p+1;j<n;j++)b[p]-=a[p*n+j]*b[j];b[p]/=a[p*n+p];}
 return b.every(Number.isFinite)?b:null;
}
export function jointlyRefit(channels,sr,components){
 if(!components.length)return components;
 const size=2*components.length,L=channels[0].length,centers=Array.from({length:WINDOW_COUNT},(_,i)=>L/sr*(i+.5)/WINDOW_COUNT);
 const half=components.map(v=>theoreticalWindow(v.frequency,PERIOD_K)/2);
 const matrix=new Float64Array(size*size),rhs=channels.map(()=>new Float64Array(size)),basis=new Float64Array(size);
 for(let i=0;i<L;i++){
  const t=i/sr;
  // One source-domain residual term plus correlated frequency-specific windows.
  let weight=.35;
  for(let m=0;m<components.length;m++){
   const h=half[m];
   for(const center of centers){const z=(t-center)/h;if(Math.abs(z)<1)weight+=(.65/components.length)*(.5+.5*Math.cos(Math.PI*z));}
   const phi=TAU*components[m].frequency*t;
   basis[2*m]=Math.cos(phi);basis[2*m+1]=Math.sin(phi);
  }
  for(let a=0;a<size;a++){
   const wa=weight*basis[a];
   for(let b=0;b<=a;b++)matrix[a*size+b]+=wa*basis[b];
   for(let c=0;c<channels.length;c++)rhs[c][a]+=wa*channels[c][i];
  }
 }
 for(let a=0;a<size;a++)for(let b=0;b<a;b++)matrix[b*size+a]=matrix[a*size+b];
 const answers=rhs.map(r=>linearSolve(matrix,r,size));
 if(answers.some(v=>v===null))return components;
 return components.map((component,m)=>({...component,coefficients:answers.map(v=>({a:v[2*m],b:v[2*m+1]}))}));
}
export function estimateJointScene({channels,sampleRate,maxComponents=5}){
 if(!Array.isArray(channels)||channels.length<1||channels.length>2||!channels[0]?.length||channels.some(ch=>ch.length!==channels[0].length))throw RangeError('mono/stereo PCM');
 if(!(Number.isFinite(sampleRate)&&sampleRate>=8000&&sampleRate<=192000))throw RangeError('sample rate');
 if(!channels.every(ch=>ch.every(Number.isFinite)))throw RangeError('nonfinite PCM');
 const sr=sampleRate,L=channels[0].length,power=energy(channels),components=[],residual=channels.map(ch=>Float64Array.from(ch));
 if(power>1e-10&&L>=sr*.2&&L<=sr*3){
  for(let n=0;n<maxComponents;n++){
   let candidate;
   try{candidate=estimateJointTone({channels:residual,sampleRate});}catch{break;}
   if(candidate.silent)break;
   const f=candidate.frequency;
   if(components.some(x=>Math.abs(x.frequency-f)<Math.max(.8,f*.0015)))break;
   const next=residual.map((ch,c)=>Float64Array.from(ch,(y,i)=>{
    const phi=TAU*f*i/sr,{a,b}=candidate.coefficients[c];
    return y-a*Math.cos(phi)-b*Math.sin(phi);
   }));
   const before=energy(residual),improvement=before-energy(next);
   if(improvement<power*.015||improvement<before*.025)break;
   components.push({frequency:f,coefficients:candidate.coefficients.map(({a,b})=>({a,b}))});
   for(let c=0;c<residual.length;c++)residual[c]=next[c];
   if(energy(residual)<power*.01)break;
  }
 }
 // True joint solve: amplitudes of every component, in every channel,
 // come from a common normal equation on original PCM + every observation.
 const joint=jointlyRefit(channels,sr,components);
 const complement=channels.map((ch,c)=>Float32Array.from(ch,(y,i)=>{
  let modeled=0;
  for(const comp of joint){const phi=TAU*comp.frequency*i/sr,{a,b}=comp.coefficients[c];modeled+=a*Math.cos(phi)+b*Math.sin(phi);}
  return y-modeled;
 }));
 const residualPower=energy(complement);
 return {components:joint,residual:complement,residualPower,sourcePower:power,
  explained:power>0?Math.max(0,1-residualPower/power):1,windows:WINDOW_COUNT};
}
export function renderJointScene({channels,sampleRate,speed=1,semitones=0,sourceStartSeconds=0,renderResidual}){
 if(!(Number.isFinite(speed)&&speed>=.5&&speed<=2&&Number.isFinite(semitones)&&semitones>=-12&&semitones<=12))throw RangeError('speed/pitch');
 if(!(Number.isFinite(sourceStartSeconds)&&sourceStartSeconds>=0)||typeof renderResidual!=='function')throw RangeError('origin/residual processor');
 const outFrames=Math.max(1,Math.round(channels[0].length/speed));
 if(outFrames*channels.length>14000000)throw RangeError('memory cap');
 const scene=estimateJointScene({channels,sampleRate});
 const result=renderResidual(scene.residual,outFrames);
 if(!Array.isArray(result)||result.length!==channels.length||result.some(x=>x.length!==outFrames))throw RangeError('residual renderer');
 const out=result.map(ch=>Float32Array.from(ch)),pitch=2**(semitones/12);
 for(const comp of scene.components){
  const frequency=comp.frequency;
  for(let c=0;c<channels.length;c++){
   const {a,b}=comp.coefficients[c],amplitude=Math.hypot(a,b);
   const phase=Math.atan2(-b,a)-TAU*frequency*sourceStartSeconds;
   for(let i=0;i<outFrames;i++)out[c][i]+=amplitude*Math.cos(phase+TAU*frequency*pitch*(sourceStartSeconds/speed+i/sampleRate));
  }
 }
 if(out.some(ch=>!ch.every(Number.isFinite)))throw RangeError('nonfinite output');
 return {channels:out,sampleRate,diagnostics:{components:scene.components.map(x=>x.frequency),explained:scene.explained,
  residualPower:scene.residualPower,method:'joint partial fit + declared phase-vocoder residual'}};
}
