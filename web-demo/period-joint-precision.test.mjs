import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateSharedPartials} from './period-joint-multi.mjs';
import {renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
const sr=16000,TAU=2*Math.PI;
const rms=(x)=>Math.sqrt(x.reduce((sum,v)=>sum+v*v,0)/x.length);
const signal=(components,n=sr*1.6,at=0)=>Float32Array.from({length:n},(_,i)=>components.reduce((v,[f,a,phase])=>v+a*Math.cos(TAU*f*(at+i/sr)+phase),0));
function nearest(est,f){const sorted=[...est.partials].sort((a,b)=>Math.abs(a.frequency-f)-Math.abs(b.frequency-f));assert.ok(sorted.length,'missing fitted tone');return sorted[0];}
test('fractional non-grid single-tone frequency is continuously estimated (not snapped to 0.05Hz)',()=>{
 for(const f of [317.137,523.283,973.419]){
  const est=estimateSharedPartials({channels:[signal([[f,.3,.37]])],sampleRate:sr});
  const closest=nearest(est,f);
  const error=Math.abs(closest.frequency-f);
  console.log('PHASE_PRECISION_SINGLE',JSON.stringify({target:f,actual:closest.frequency,error,explained:est.explained,partials:est.partials.length}));
  assert.ok(error<.004,'source frequency insufficiently resolved, error '+error+'Hz');
  assert.ok(est.explained>.995,'source should be fully explained without residual delayed duplicate, explained='+est.explained);
 }
});
test('independent arbitrary stationary partials have jointly aligned amplitude/phase, minimal residual',()=>{
 const tones=[[271.137,.22,.13],[693.283,.18,1.3]];
 const original=signal(tones);
 const model=estimateSharedPartials({channels:[original],sampleRate:sr});
 const measure=rms(model.residual[0])/rms(original);
 console.log('PHASE_PRECISION_MULTI',JSON.stringify({partials:model.partials.map(x=>x.frequency),residualRmsRatio:measure}));
 for(const [f] of tones)assert.ok(Math.abs(nearest(model,f).frequency-f)<.008,'unresolved '+f);
 assert.ok(measure<.055,'residual keeps a separate near-duplicate tonal copy '+measure);
});
test('adjacent worker model chunks align source-global phase against exact target without millisecond echo',()=>{
 const frequency=317.137,pitch=3,speed=.8,startAt=0;
 const source=signal([[frequency,.30,.21]],sr*4);
 const frames=sr*4,render=[];
 for(const startSeconds of [0,1.5]){
  const plan=planChunk({totalFrames:frames,sampleRate:sr,speed,startSeconds,
   model:'period-joint',jointBackend:'pv',fftSize:2048,shortFftSize:512,longFftSize:2048,referenceWindows:8});
  const partial=source.slice(plan.from,plan.to);
  const result=renderPCM({channels:[partial],sampleRate:sr,speed,semitones:pitch,model:'period-joint',
   jointBackend:'pv',sourceStartSeconds:plan.from/sr});
  const core=result.channels[0].subarray(plan.outputStart,plan.outputStart+plan.coreFrames);
  const target=Float32Array.from(core,(_,i)=>.30*Math.cos(TAU*frequency*2**(pitch/12)*((startSeconds/speed)+i/sr)+.21));
  const error=rms(Float32Array.from(core,(v,i)=>v-target[i]));
  console.log('PHASE_PRECISION_CORE',JSON.stringify({startSeconds,error,sourceRms:rms(core),fraction:error/(rms(target)+1e-12)}));
  assert.ok(error/rms(target)<.16,'adjacent source-phase output differs from ideal carrier');
  render.push({core,plan});
 }
 const before=render[0].core.at(-1),after=render[1].core[0];
 const maxSlope=.3*TAU*frequency*2**(pitch/12)/sr*1.3;
 assert.ok(Math.abs(after-before)<maxSlope,'stitched phase jump exceeds one continuous sample step');
});

test('all seven cycle spans retain continuous source clock and transformed arbitrary stereo phase',()=>{
 const freq=553.283,phase=.77,speed=.8,semitones=5;
 const stereo=[
  signal([[freq,.27,phase]],sr*1.4,.75),
  signal([[freq,.135,phase+1.12]],sr*1.4,.75)
 ];
 for(const periodCycles of [.5,1,2,4,8,16,32]){
  const r=renderPCM({channels:stereo,sampleRate:sr,speed,semitones,model:'period-joint',
   periodCycles,sourceStartSeconds:.75,jointBackend:'pv'});
  assert.equal(r.channels.length,2);
  assert.equal(r.channels[0].length,Math.round(stereo[0].length/speed));
  const freqOut=freq*2**(semitones/12);
  const expected=Float32Array.from(r.channels[0],(_,i)=>.27*Math.cos(TAU*freqOut*(.75/speed+i/sr)+phase));
  const ratio=rms(Float32Array.from(r.channels[0],(v,i)=>v-expected[i]))/rms(expected);
  console.log('PHASE_STEREO_K',JSON.stringify({periodCycles,ratio}));
  assert.ok(ratio<.07,'phase/stereo changes at K='+periodCycles+': '+ratio);
  assert.ok(r.channels.every(ch=>ch.every(Number.isFinite)));
 }
});
