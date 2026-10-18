import test from 'node:test';
import assert from 'node:assert/strict';
import {detectSharedCandidates,estimateSharedPartials} from './period-joint-multi.mjs';
import {renderPCM} from './lab-dsp.mjs';
const sr=16000;
const signal=(partials,duration=1)=>Float32Array.from({length:Math.round(sr*duration)},(_,i)=>
 partials.reduce((s,[f,a,p=0])=>s+a*Math.cos(2*Math.PI*f*i/sr+p),0));
const allFinite=channels=>channels.every(c=>c.every(Number.isFinite));
test('a single common estimator retains several harmonic partials without window-output mixing',()=>{
 const x=signal([[110,.28],[220,.22],[330,.14],[550,.1]]);
 const est=estimateSharedPartials({channels:[x],sampleRate:sr});
 assert.ok(est.partials.length>=3,'found '+JSON.stringify(est.partials.map(p=>p.frequency)));
 assert.ok(est.explained>.6,'total explained '+est.explained);
});
test('independent simultaneous tones processed with pitch and speed, and no unsupported error',()=>{
 const x=signal([[440,.2],[660,.2]]),speed=.8;
 const r=renderPCM({channels:[x],sampleRate:sr,speed,semitones:4,model:'period-joint'});
 assert.equal(r.channels[0].length,Math.round(x.length/speed));
 assert.ok(allFinite(r.channels));
 const energy=r.channels[0].reduce((sum,v)=>sum+v*v,0)/r.channels[0].length;
 assert.ok(energy>.006,'both tones not erased');
 assert.ok(r.diagnostics.partials>=1);
});
test('AM audio and its mathematically equivalent sidebands are processed, without source-attribution claim',()=>{
 const am=Float32Array.from({length:sr},(_,i)=>{
   const t=i/sr;return (.23+.12*Math.cos(2*Math.PI*4*t))*Math.cos(2*Math.PI*440*t);
 });
 const r=renderPCM({channels:[am],sampleRate:sr,speed:1.2,semitones:2,model:'period-joint'});
 assert.ok(allFinite(r.channels));
 assert.ok(r.channels[0].some(v=>Math.abs(v)>.03));
 assert.equal(r.diagnostics.grouping,'ambiguous');
});
test('impulse and noise residual survive rather than disappear when pitched/stretched',()=>{
 const x=Float32Array.from({length:sr},(_,i)=>{
  const transient=(i>3300&&i<3370)?Math.sin((i-3300)*.35)*.8:0;
  const noise=.07*Math.sin(i*2.17);
  return transient+noise+.1*Math.cos(2*Math.PI*330*i/sr);
 });
 const original=renderPCM({channels:[x],sampleRate:sr,model:'period-joint'});
 assert.deepEqual(original.channels[0],x,'neutral must preserve exact original signal');
 const out=renderPCM({channels:[x],sampleRate:sr,speed:.75,semitones:3,model:'period-joint'});
 assert.ok(allFinite(out.channels));
 assert.ok(Math.max(...out.channels[0])>.1);
});
test('stereo anti-phase and finite frames survive multicomponent processing',()=>{
 const x=signal([[330,.18],[550,.11]]);
 const y=Float32Array.from(x,v=>-v);
 const r=renderPCM({channels:[x,y],sampleRate:sr,speed:1.25,semitones:-3,model:'period-joint'});
 let max=0;for(let i=0;i<r.channels[0].length;i++)max=Math.max(max,Math.abs(r.channels[0][i]+r.channels[1][i]));
 assert.ok(max<.01,'stereo relative phase diff '+max);
});
test('noise-only can be rendered without inventing a unique physical source',()=>{
 let state=123456;
 const noise=Float32Array.from({length:sr},()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state/2147483648)*.15});
 const r=renderPCM({channels:[noise],sampleRate:sr,speed:1.1,semitones:-2,model:'period-joint'});
 assert.ok(allFinite(r.channels));
 assert.equal(r.channels[0].length,Math.round(sr/1.1));
});
