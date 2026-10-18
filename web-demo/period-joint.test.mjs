import test from 'node:test';
import assert from 'node:assert/strict';
import {integerReferenceHz,theoreticalWindow,commonBoundary,sampleInterval,estimateJointTone,renderPeriodJointTone} from './period-joint.mjs';
const sr=16000;
const tone=(f,length=sr,amplitude=.3,phase=.2)=>Float32Array.from({length},(_,i)=>amplitude*Math.cos(2*Math.PI*f*i/sr+phase));
const crossing=(ch,start=1000,end=ch.length-1000)=>{let n=0;for(let i=start+1;i<end;i++)if(ch[i-1]<0&&ch[i]>=0)n++;return n*sr/(end-start);};
test('integer reference +/-0.5 band and theoretical noninteger period',()=>{
 assert.equal(integerReferenceHz(440.4),440);
 assert.equal(integerReferenceHz(440.5),441);
 assert.equal(integerReferenceHz(439.5),440);
 assert.ok(Math.abs(theoreticalWindow(440.4,8)-8/440.4)<1e-14);
});
test('2x, 3x, 5x, coprime time boundaries',()=>{
 assert.ok(Math.abs(commonBoundary(440,880,8)-8/440)<1e-14);
 assert.ok(Math.abs(commonBoundary(440,660,8)-8/220)<1e-14);
 assert.ok(Math.abs(commonBoundary(440,550,8)-8/110)<1e-14);
 assert.equal(commonBoundary(440,441,8),8);
});
test('sample positions are rounded separately from continuous boundaries',()=>{
 const b=sampleInterval(.1,440.4,sr);
 assert.equal(b.firstSample,Math.ceil(b.leftSeconds*sr));
 assert.ok(Math.abs(b.leftSeconds*sr-Math.round(b.leftSeconds*sr))>.0001);
});
test('one shared frequency/phase/amplitude across seven observation windows',()=>{
 const e=estimateJointTone({channels:[tone(440.4)],sampleRate:sr});
 assert.ok(Math.abs(e.frequency-440.4)<.08,JSON.stringify(e));
 assert.ok(e.explained>.97,JSON.stringify(e));
 assert.equal(e.referenceHz,440);assert.equal(e.windows,7);
});
test('speed and pitch independently control duration and tonal frequency',()=>{
 const ch=tone(440.4);
 const p=renderPeriodJointTone({channels:[ch],sampleRate:sr,speed:1,semitones:12});
 assert.equal(p.channels[0].length,sr);
 assert.ok(Math.abs(crossing(p.channels[0])-880.8)<3);
 const s=renderPeriodJointTone({channels:[ch],sampleRate:sr,speed:.5,semitones:0});
 assert.equal(s.channels[0].length,2*sr);
 assert.ok(Math.abs(crossing(s.channels[0])-440.4)<2);
});
test('stereo output retains different relative amplitude/phase with common frequency',()=>{
 const p=renderPeriodJointTone({channels:[tone(437.3),tone(437.3,sr,.15,1.2)],sampleRate:sr,speed:.75});
 assert.equal(p.channels.length,2);
 const rms=ch=>Math.sqrt(ch.reduce((sum,v)=>sum+v*v,0)/ch.length);
 assert.ok(Math.abs(rms(p.channels[1])/rms(p.channels[0])-.5)<.06);
});
test('two independent equal-level tones explicitly unsupported',()=>{
 const a=tone(440),b=tone(660);
 assert.throws(()=>renderPeriodJointTone({channels:[Float32Array.from(a,(v,i)=>v+b[i])],sampleRate:sr,speed:.8}),/未対応/);
});
test('silence finite and length coherent',()=>{
 const x=renderPeriodJointTone({channels:[new Float32Array(sr)],sampleRate:sr,speed:2,semitones:12});
 assert.equal(x.channels[0].length,sr/2);
 assert.ok(x.channels[0].every(v=>v===0));
});
