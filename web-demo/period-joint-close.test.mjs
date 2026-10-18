import test from 'node:test';
import assert from 'node:assert/strict';
import {detectClosePair,transportSourcePhase,CLOSE_CANDIDATE_STEP_HZ} from './period-joint-close.mjs';
import {estimateSharedPartials} from './period-joint-multi.mjs';
import {renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
const Fs=16000;
const tone=(frequencies,duration=1.8)=>
 Float32Array.from({length:Math.round(Fs*duration)},(_,i)=>
  frequencies.reduce((v,[f,amp,phase=0])=>v+amp*Math.cos(2*Math.PI*f*i/Fs+phase),0));
test('0.25Hz is candidate grid only; final frequencies are not snapped',()=>{
 assert.equal(CLOSE_CANDIDATE_STEP_HZ,.25);
 const f1=440.13,f2=441.07;
 const x=tone([[f1,.24,.1],[f2,.24,.7]]);
 const fit=detectClosePair({channels:[x],sampleRate:Fs,peakFrequency:440.5});
 assert.ok(fit,'near-frequency 2-tone hypothesis must be discovered');
 const values=fit.frequencies;
 assert.ok(Math.abs(values[0]-f1)<.16&&Math.abs(values[1]-f2)<.16,'frequencies '+JSON.stringify(values));
 assert.ok(values.some(v=>Math.abs(v*4-Math.round(v*4))>.02),'estimates should not snap to 0.25Hz');
});
test('440@4.41s versus 441@4.4s: equal cycles but timestamps must NOT be spliced',()=>{
 const a=440*4.41,b=441*4.4;
 assert.ok(Math.abs(a-b)<1e-9);
 const p1=transportSourcePhase(2*Math.PI*a,440,4.41,0);
 const p2=transportSourcePhase(2*Math.PI*b,441,4.4,0);
 assert.ok(Math.abs(p1-p2)<1e-8,'separately transported phases at common t0 agree');
 const q1=transportSourcePhase(0,440,0,4.41);
 const q2=transportSourcePhase(0,441,0,4.41);
 assert.ok(Math.abs(q1-q2)>1,'at SAME time distinct frequencies have distinct relative phase');
});
test('440/441 close pair survives shared-component estimation without merged-bin loss',()=>{
 const x=tone([[440,.19,.2],[441,.19,1]],1.6);
 const model=estimateSharedPartials({channels:[x],sampleRate:Fs});
 const f=model.partials.map(p=>p.frequency);
 assert.ok(f.some(v=>Math.abs(v-440)<.18),'440 source missing '+JSON.stringify(f));
 assert.ok(f.some(v=>Math.abs(v-441)<.18),'441 source missing '+JSON.stringify(f));
 assert.ok(model.explained>.88,'model energy score '+model.explained);
});
test('pure off-grid 440.4Hz does not get hallucinated as two partials',()=>{
 const x=tone([[440.4,.3,.1]],1.8);
 const p=detectClosePair({channels:[x],sampleRate:Fs,peakFrequency:440.4});
 assert.equal(p,null,'one oscillator should not be split in two');
});
test('time stretch and independent pitch preserve close tones at adjacent preview chunks',()=>{
 const duration=Fs*4,speed=.8,semi=3,p=2**(semi/12);
 const source=tone([[440,.18,.1],[441,.18,.7]],4);
 const render=seconds=>{
  const plan=planChunk({totalFrames:duration,sampleRate:Fs,speed,startSeconds:seconds,
    model:'period-joint',fftSize:2048,shortFftSize:512,longFftSize:2048,referenceWindows:8});
  const slice=source.slice(plan.from,plan.to);
  const result=renderPCM({channels:[slice],sampleRate:Fs,speed,semitones:semi,
    model:'period-joint',sourceStartSeconds:plan.from/Fs});
  return {plan,raw:result.channels[0],centre:result.channels[0].subarray(plan.outputStart,plan.outputStart+plan.coreFrames)};
 };
 const a=render(0),b=render(1.5);
 const last=a.centre[a.centre.length-1],first=b.centre[0];
 assert.ok(Number.isFinite(last)&&Number.isFinite(first));
 assert.ok(Math.abs(last-first)<.12,'close-tone seam '+(last-first));
 assert.ok(a.raw.length===Math.round((a.plan.to-a.plan.from)/speed));
 assert.ok(p>1);
});
