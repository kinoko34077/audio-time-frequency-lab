import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
import {estimateSharedPartials,renderJointAudio} from './period-joint-multi.mjs';

const sr=16000;
function toneAfter({duration=1.6,onset=.9,frequency=392,amplitude=.33}){
 return Float32Array.from({length:Math.round(duration*sr)},(_,i)=>{
  const t=i/sr;
  if(t<onset)return 0;
  const attack=Math.min(1,(t-onset)/.016);
  return amplitude*attack*Math.cos(2*Math.PI*frequency*(t-onset));
 });
}
function rms(data,from,to){let sum=0,n=0;for(let i=Math.round(from*sr);i<Math.min(data.length,Math.round(to*sr));i++){sum+=data[i]*data[i];n++;}return Math.sqrt(sum/(n||1));}
test('late pitched instrument does not sound almost a second early in full render',()=>{
 const input=toneAfter({onset:.9});
 const speed=.8;
 const out=renderPCM({channels:[input],sampleRate:sr,speed,semitones:4,model:'period-joint'}).channels[0];
 const expected=.9/speed;
 const early=rms(out,.26,expected-.19);
 const active=rms(out,expected+.08,expected+.32);
 console.log('LATE_INSTRUMENT_EARLY_ENERGY',JSON.stringify({early,active,ratio:early/(active+1e-12),expected}));
 assert.ok(active>.045,'late note was deleted');
 assert.ok(early<Math.max(.008,active*.10),'late note advanced into previous second, ratio '+early/active);
});
test('one tone already active, independent second tone enters late without precursor',()=>{
 const input=Float32Array.from({length:Math.round(1.6*sr)},(_,i)=>{
  const t=i/sr;
  const background=.18*Math.cos(2*Math.PI*220*t+.2);
  const late=t<.88?0:.27*Math.min(1,(t-.88)/.02)*Math.cos(2*Math.PI*610*(t-.88));
  return background+late;
 });
 const s=.8,semi=4;
 const output=renderPCM({channels:[input],sampleRate:sr,speed:s,semitones:semi,model:'period-joint'}).channels[0];
 // The reference before the second onset contains only the first partial.
 // Compare temporal accuracy against the result for this early background by
 // using the same *whole-segment* render contract.
 const bg=Float32Array.from(input,(_,i)=>.18*Math.cos(2*Math.PI*220*i/sr+.2));
 const baseline=renderPCM({channels:[bg],sampleRate:sr,speed:s,semitones:semi,model:'period-joint'}).channels[0];
 let before=0,after=0,n1=0,n2=0;
 for(let i=Math.round(.25*sr);i<output.length;i++){
  const d=output[i]-baseline[i],t=i/sr;
  if(t<.88/s-.13){before+=d*d;n1++}
  if(t>.88/s+.08&&t<1.5){after+=d*d;n2++}
 }
 const early=Math.sqrt(before/(n1||1)),late=Math.sqrt(after/(n2||1));
 console.log('ADDED_PART_EARLY_ENERGY',JSON.stringify({early,late,ratio:early/(late+1e-12)}));
 assert.ok(late>.035,'added note vanished');
 assert.ok(early<Math.max(.018,late*.22),'new note appears before its own onset');
});
test('actual 1.5s worker-equivalent core preserves late onset source-time / speed time',()=>{
 const total=sr*3,onset=.92,speed=.75,semi=3;
 const source=toneAfter({duration:3,onset,frequency:370});
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed,startSeconds:0,
  model:'period-joint',fftSize:2048,shortFftSize:512,longFftSize:2048,referenceWindows:8});
 const rendered=renderPCM({channels:[source.subarray(plan.from,plan.to)],sampleRate:sr,speed,semitones:semi,
  model:'period-joint',sourceStartSeconds:plan.from/sr}).channels[0];
 const centre=rendered.subarray(plan.outputStart,plan.outputStart+plan.coreFrames);
 const expected=onset/speed,early=rms(centre,.2,expected-.17),active=rms(centre,expected+.08,Math.min(centre.length/sr,expected+.32));
 console.log('WORKER_PLAN_ONSET_ALIGNMENT',JSON.stringify({sourceOnset:onset,speed,expected,early,active,ratio:early/(active+1e-12)}));
 assert.ok(active>.045);
 assert.ok(early<Math.max(.008,active*.12),'worker preview early onset');
});

test('diagnostic only: separate source latent gate, tonal output and PV residual leakage',()=>{
 const source=toneAfter({onset:.9});
 const m=estimateSharedPartials({channels:[source],sampleRate:sr});
 const resOnly=m.residual[0],amp=rms(resOnly,.2,.7);
 const tonal=renderJointAudio({channels:[source],sampleRate:sr,speed:.8,semitones:4,
  renderResidual:(ch,n)=>ch.map(()=>new Float32Array(n))}).channels[0];
 const combined=renderPCM({channels:[source],sampleRate:sr,speed:.8,semitones:4,model:'period-joint'}).channels[0];
 const diagnostics={parts:m.partials.map(x=>({f:x.frequency,gainFirst:x.envelope?.[0],
   gainEarly:x.envelope?.[Math.floor(.4*sr/x.envelopeHop)],gainLate:x.envelope?.[Math.floor(1.2*sr/x.envelopeHop)]})),
   rawResidualEarly:amp,tonalEarly:rms(tonal,.26,.93),fullEarly:rms(combined,.26,.93)};
 console.log('TEMPORAL_PARTIAL_DIAG',JSON.stringify(diagnostics));
 assert.ok(Number.isFinite(amp));
});

test('arbitrary frequencies and speed factors cannot create notes far ahead of true event',()=>{
 for(const scenario of [
  {frequency:137.37,onset:.78,speed:.5,semitones:-3},
  {frequency:981.75,onset:1.03,speed:1.5,semitones:5}
 ]){
  const input=toneAfter({frequency:scenario.frequency,onset:scenario.onset,duration:1.6});
  const result=renderPCM({channels:[input],sampleRate:sr,speed:scenario.speed,semitones:scenario.semitones,model:'period-joint'}).channels[0];
  const expected=scenario.onset/scenario.speed;
  const prior=rms(result,Math.max(.02,expected-.60),Math.max(.04,expected-.17));
  const post=rms(result,expected+.06,Math.min(result.length/sr,expected+.32));
  console.log('ARBITRARY_FREQUENCY_ONSET',JSON.stringify({...scenario,expected,prior,post,ratio:prior/(post+1e-12)}));
  assert.ok(post>.04,'actual note lost '+JSON.stringify(scenario));
  assert.ok(prior<Math.max(.008,post*.1),'arbitrary frequency advanced by substantial fraction of a second');
 }
});
test('note enters just after 1.5s chunk boundary: earlier core remains silent and later core starts at mapped time',()=>{
 const source=toneAfter({frequency:735.4,onset:1.65,duration:3.5});
 const speed=.75;
 const core=startSeconds=>{
  const plan=planChunk({totalFrames:source.length,sampleRate:sr,speed,startSeconds,
   model:'period-joint',fftSize:2048,shortFftSize:512,longFftSize:2048,referenceWindows:8});
  const out=renderPCM({channels:[source.subarray(plan.from,plan.to)],sampleRate:sr,speed,semitones:2,
   model:'period-joint',sourceStartSeconds:plan.from/sr}).channels[0];
  return out.subarray(plan.outputStart,plan.outputStart+plan.coreFrames);
 };
 const earlier=core(0),later=core(1.5);
 const before=rms(earlier,.4,1.7);
 const expected=(1.65-1.5)/speed,precursor=rms(later,.005,Math.max(.03,expected-.075));
 const active=rms(later,expected+.05,expected+.35);
 console.log('CROSS_CHUNK_LATE_ENTRY',JSON.stringify({expected,before,precursor,active}));
 assert.ok(before<.01,'previous core predicts future note early');
 assert.ok(precursor<Math.max(.008,active*.1),'new core has early note');
 assert.ok(active>.04,'note after boundary was lost');
});
