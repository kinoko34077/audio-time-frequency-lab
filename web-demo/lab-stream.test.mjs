import test from 'node:test';
import assert from 'node:assert/strict';
import {planChunk,CHUNK_SECONDS,repeatLoopContext} from './lab-stream.mjs';
import {renderPCM} from './lab-dsp.mjs';

test('long 4-minute 48k stereo 0.5x track is split into strictly bounded preview chunks',()=>{
 const sr=48000,total=sr*240;
 for(const start of [0,1.5,60,121.4,239.7]){
  for(const fftSize of [1024,2048,4096])for(const referenceWindows of [2,8,16]){
   const plan=planChunk({totalFrames:total,sampleRate:sr,speed:.5,startSeconds:start,fftSize,referenceWindows});
   const inputFrames=plan.to-plan.from+plan.wrapLeft+plan.wrapRight;
   assert.ok(inputFrames<sr*3, 'must NOT allocate entire recording');
   assert.ok(plan.core<=sr*(CHUNK_SECONDS+1/sr));
   assert.ok(plan.outputFrames*2<14_000_000);
   assert.ok(plan.start>=0&&plan.to<=total);
   assert.equal(plan.sourceStartFrame+plan.left,plan.start);
   assert.ok(plan.outputStart+plan.outputFrames<=Math.ceil(inputFrames/.5)+2);
  }
 }
});
test('the final full-track Worker chunk includes bounded wrapped PCM for its interpolation neighbor',()=>{
 const sr=48000,total=sr*6,speed=1.33;
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed,
  startSeconds:4.5,model:'pv',fftSize:2048,referenceWindows:8});
 assert.equal(plan.start+plan.core,total);
 assert.ok(plan.wrapRight>0);
 assert.equal(plan.coreFrames,Math.ceil(plan.core/speed));
 assert.equal(plan.outputFrames,plan.coreFrames+1);
 assert.ok(plan.wrapRight<sr*.7);
});
test('a legacy Worker A/B loop bounds chunks and wraps analysis context at both endpoints',()=>{
 const sr=48000,total=sr*12,loopStart=sr*2,loopEnd=sr*7,start=sr*6;
 const atEnd=planChunk({totalFrames:total,sampleRate:sr,speed:1.33,
  startFrame:start,startSeconds:start/sr,loopStartFrame:loopStart,
  loopEndFrame:loopEnd,loopEnabled:true,model:'pv',fftSize:2048,
  referenceWindows:8});
 assert.equal(atEnd.start, start);
 assert.equal(atEnd.start+atEnd.core, loopEnd);
 assert.equal(atEnd.nextFrame, loopStart);
 assert.equal(atEnd.right, 0);
 assert.ok(atEnd.wrapRight>0);

 const atStart=planChunk({totalFrames:total,sampleRate:sr,speed:1.33,
  startFrame:loopStart,startSeconds:loopStart/sr,
  loopStartFrame:loopStart,loopEndFrame:loopEnd,loopEnabled:true,
  model:'pv',fftSize:2048,referenceWindows:8});
 assert.equal(atStart.start, loopStart);
 assert.equal(atStart.from, loopStart);
 assert.ok(atStart.wrapLeft>0);
});
test('A/B analysis origin may precede zero while the requested loop starts near the file beginning',()=>{
 const sr=48000,total=sr*12,loopStart=96,loopEnd=sr*7;
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed:1,
  startFrame:loopStart,startSeconds:loopStart/sr,loopStartFrame:loopStart,
  loopEndFrame:loopEnd,loopEnabled:true,model:'pv',fftSize:2048,
  referenceWindows:8});
 assert.equal(plan.start,loopStart);
 assert.ok(plan.wrapLeft>0);
 assert.ok(plan.sourceStartFrame<0,plan);
});
test('disabling an A/B loop leaves the remaining full-track chunk unwrapped',()=>{
 const sr=48000,total=sr*12,start=sr*10.5;
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed:1.25,
  startFrame:start,startSeconds:start/sr,loopStartFrame:sr*2,
  loopEndFrame:sr*7,loopEnabled:false,model:'pv',fftSize:2048,
  referenceWindows:8});
 assert.equal(plan.start,start);
 assert.equal(plan.start+plan.core,total);
 assert.equal(plan.nextFrame,total);
 assert.equal(plan.wrapRight,0);
});
test('a Worker chunk starts at its exact integer source cursor after seconds round-trip',()=>{
 const sr=48000,total=sr*10,startFrame=202064;
 const plan=planChunk({totalFrames:total,sampleRate:sr,speed:1,
  startSeconds:startFrame/sr,startFrame,model:'pv',fftSize:2048,
  referenceWindows:8});
 assert.equal(plan.start,startFrame);
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
test('ultrashort individual-period PV loops repeat enough analysis context to stay audible',()=>{
 const sr=48000,total=sr*2,speed=.5;
 for(const a of [0,100]){
  const b=a+4;
  const plan=planChunk({totalFrames:total,sampleRate:sr,speed,
   startFrame:a,startSeconds:a/sr,model:'period-joint',jointBackend:'pv',
   longFftSize:2048,loopStartFrame:a,loopEndFrame:b,loopEnabled:true});
  const source=new Float32Array(total).fill(.5);
  const parts=[plan.wrapLeft?repeatLoopContext(source,a,b,plan.wrapLeft,'left'):
    new Float32Array(),source.slice(plan.from,plan.to),
    repeatLoopContext(source,a,b,plan.wrapRight,'right')];
  const input=new Float32Array(parts.reduce((sum,part)=>sum+part.length,0));
  let offset=0;for(const part of parts){input.set(part,offset);offset+=part.length;}
  const rendered=renderPCM({channels:[input],sampleRate:sr,speed,semitones:0,
   model:'period-joint',jointBackend:'pv',fftSize:2048,longFftSize:2048,
   periodCycles:8}).channels[0];
  const core=rendered.slice(plan.outputStart,plan.outputStart+plan.coreFrames);
  assert.ok(core.some(sample=>Math.abs(sample)>1e-6),
   `the ${b-a}-sample loop at A=${a} must not repeat silent PV output (input ${input.length} frames)`);
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
