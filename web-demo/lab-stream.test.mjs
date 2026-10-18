import test from 'node:test';
import assert from 'node:assert/strict';
import {planChunk,CHUNK_SECONDS} from './lab-stream.mjs';
import {renderPCM} from './lab-dsp.mjs';

test('long 4-minute 48k stereo 0.5x track is split into strictly bounded preview chunks',()=>{
 const sr=48000,total=sr*240;
 for(const start of [0,1.5,60,121.4,239.7]){
  for(const fftSize of [1024,2048,4096])for(const referenceWindows of [2,8,16]){
   const plan=planChunk({totalFrames:total,sampleRate:sr,speed:.5,startSeconds:start,fftSize,referenceWindows});
   assert.ok(plan.to-plan.from<sr*3, 'must NOT allocate entire recording');
   assert.ok(plan.core<=sr*(CHUNK_SECONDS+1/sr));
   assert.ok(plan.outputFrames*2<14_000_000);
   assert.ok(plan.start>=0&&plan.to<=total);
   assert.equal(plan.from+plan.left,plan.start);
   assert.ok(plan.outputStart+plan.outputFrames<=Math.ceil((plan.to-plan.from)/.5)+2);
  }
 }
});
test('all four DSP engines render bounded 48k stereo segments without memory errors',()=>{
 const sr=48000,total=sr*240,startSeconds=120;
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed:.5,startSeconds,fftSize:1024,referenceWindows:2});
 const n=plan.to-plan.from;
 const a=Float32Array.from({length:n},(_,i)=>.24*Math.sin(2*Math.PI*440*i/sr));
 const b=Float32Array.from({length:n},(_,i)=>.20*Math.sin(2*Math.PI*554.37*i/sr));
 for(const model of ['pv','wsola','dual','am']){
  const r=renderPCM({channels:[a,b],sampleRate:sr,speed:.5,semitones:5,model,fftSize:1024});
  assert.equal(r.channels.length,2,model);
  assert.ok(r.channels.every(ch=>ch.length>=plan.outputStart+plan.outputFrames),model);
  assert.ok(r.channels.every(ch=>ch.every(Number.isFinite)),model);
 }
});
test('window settings affect actual output and context, not presentation alone',()=>{
 const p=planChunk({totalFrames:48000*90,sampleRate:48000,speed:1,startSeconds:30,fftSize:1024,referenceWindows:2});
 const q=planChunk({totalFrames:48000*90,sampleRate:48000,speed:1,startSeconds:30,fftSize:4096,referenceWindows:16});
 assert.ok(q.left>p.left&&q.right>p.right);
 const wave=Float32Array.from({length:6000},(_,i)=>Math.sin(i*i*.000014)*.25);
 const a=renderPCM({channels:[wave],sampleRate:16000,speed:.75,semitones:2,model:'pv',fftSize:1024}).channels[0];
 const b=renderPCM({channels:[wave],sampleRate:16000,speed:.75,semitones:2,model:'pv',fftSize:4096}).channels[0];
 assert.ok(a.some((x,i)=>Math.abs(x-b[i])>1e-5));
});
