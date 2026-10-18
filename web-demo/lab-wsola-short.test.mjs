import test from 'node:test';
import assert from 'node:assert/strict';
import {wsola,renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';

const sr=48000;
const tone=(f,n,amp=.28)=>Float32Array.from({length:n},(_,i)=>amp*Math.sin(2*Math.PI*f*i/sr));
const averagePower=(x,a=0,b=x.length)=>{
 let sum=0;for(let i=a;i<b;i++)sum+=x[i]*x[i];
 return Math.sqrt(sum/Math.max(1,b-a));
};
const pitch=(x,a,b)=>{
 let count=0;
 for(let i=a+1;i<b;i++)if(x[i-1]<=0&&x[i]>0)count++;
 return count*sr/(b-a);
};

test('WSOLA true N256: 110Hz bass stays near intended pitch at 0.5x playback',()=>{
 const x=tone(110,sr*2);
 const y=wsola([x],2,sr*4,256,sr)[0];
 assert.equal(y.length,sr*4);
 assert.ok(y.every(Number.isFinite));
 const rates=[];
 for(let at=sr*.5;at<sr*3.25;at+=sr*.25){
  const hz=pitch(y,at,at+sr*.25);
  rates.push(hz);
  assert.ok(hz>82&&hz<140,'local 110Hz pitch flutter at '+at/sr+'s: '+hz+' Hz');
 }
 const mean=rates.reduce((a,b)=>a+b,0)/rates.length;
 assert.ok(Math.abs(mean-110)<14,'average WSOLA pitch must remain near 110Hz: '+mean);
});
test('WSOLA N256 time compression 1.5x preserves stereo-relative phase and low bass',()=>{
 const a=tone(220,sr*2);
 const b=Float32Array.from(a,v=>v*-.6);
 const stretch=1/1.5,outputLen=Math.round(a.length*stretch);
 const [l,r]=wsola([a,b],stretch,outputLen,256,sr);
 assert.ok(l.every(Number.isFinite)&&r.every(Number.isFinite));
 const hz=pitch(l,Math.round(sr*.18),outputLen-Math.round(sr*.18));
 assert.ok(hz>185&&hz<255,'compressed 220Hz pitch drift: '+hz);
 const step=43;
 for(let i=1000;i<outputLen-1000;i+=step){
  assert.ok(Math.abs(r[i]+.6*l[i])<.00015,'stereo phase/level coherence index '+i);
 }
});
test('WSOLA N256 on a tone+noise+impulse retains actual short-grain character and finite peaks',()=>{
 const src=Float32Array.from({length:sr*2},(_,i)=>{
  const j=i/sr;
  const noise=.015*Math.sin(i*2.31)*Math.sin(i*.173);
  return .25*Math.sin(2*Math.PI*(110*j+25*j*j))+.11*Math.sin(2*Math.PI*375*j)+noise+
    (i===sr||i===Math.floor(sr*1.7)?.8:0);
 });
 const a=wsola([src],1.6,Math.round(src.length*1.6),256,sr)[0];
 const b=wsola([src],1.6,Math.round(src.length*1.6),1024,sr)[0];
 assert.ok(a.every(Number.isFinite));
 assert.ok(a.some((v,i)=>Math.abs(v-b[i])>1e-5),'256 must remain a real grain size, not silently clamped to 1024');
 assert.ok(averagePower(a,sr*.3,sr*2)>.045,'do not accidentally erase sustained spectrum');
 assert.ok(Math.max(...a.subarray(8000,9000).map(Math.abs))<2);
});
test('neutral bypass remains bit-identical with N256 and test cases include .5x/1.5x and pitch offset',()=>{
 const a=tone(110,sr),b=Float32Array.from(a,v=>v*.7);
 const neutral=renderPCM({channels:[a,b],sampleRate:sr,speed:1,semitones:0,model:'wsola',shortFftSize:256,longFftSize:1024,fftSize:1024});
 assert.deepEqual(neutral.channels[0],a);
 for(const [speed,semitones] of [[.5,0],[1.5,0],[.75,5]]){
  const out=renderPCM({channels:[a,b],sampleRate:sr,speed,semitones,model:'wsola',shortFftSize:256,longFftSize:1024,fftSize:1024});
  assert.equal(out.channels.length,2);
  assert.equal(out.channels[0].length,Math.round(sr/speed));
  assert.ok(out.channels.every(x=>x.every(Number.isFinite)));
 }
 const plan=planChunk({totalFrames:sr*180,sampleRate:sr,speed:.5,startSeconds:93,model:'wsola',shortFftSize:256,longFftSize:1024,referenceWindows:8});
 assert.equal(plan.shortFftSize,256);
 assert.ok(plan.to-plan.from<sr*3);
});
