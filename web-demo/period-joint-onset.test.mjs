import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';

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
