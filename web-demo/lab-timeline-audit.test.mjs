import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scheduledSourcePosition,createModelStream} from './lab-stream.mjs';

test('audible source clock stays frozen during Worker overrun, resumes from exact scheduled second',()=>{
 const segments=[
  {at:10,until:12,sourceFrom:3,sourceEnd:4.5,sourceTo:4.5,speed:.75},
  {at:13.25,until:15.25,sourceFrom:4.5,sourceEnd:6,sourceTo:6,speed:.75}
 ];
 const at=t=>scheduledSourcePosition(segments,t,3,20);
 assert.equal(at(9.99),3);
 assert.ok(Math.abs(at(10.8)-3.6)<1e-10);
 assert.equal(at(12),4.5);
 assert.equal(at(12.6),4.5,'source position must not advance during 1.25s gap');
 assert.equal(at(13.24),4.5);
 assert.ok(Math.abs(at(14.25)-5.25)<1e-10);
 assert.equal(at(16),6);
});
test('source clock correctly wraps on EOF rather than assuming elapsed wall time',()=>{
 const segments=[
  {at:1,until:2,sourceFrom:9,sourceEnd:10,sourceTo:0,speed:1},
  {at:2.6,until:3.6,sourceFrom:0,sourceEnd:1,sourceTo:1,speed:1}
 ];
 assert.equal(scheduledSourcePosition(segments,1.25,9,10),9.25);
 assert.equal(scheduledSourcePosition(segments,2.4,9,10),0);
 assert.ok(Math.abs(scheduledSourcePosition(segments,3.1,9,10)-.5)<1e-10);
});
test('real schedule registers late Worker completion without skipping playback positions',()=>{
 const original=globalThis.Worker;
 let fake;
 class StubWorker{
  constructor(){fake=this;this.requests=[];}
  postMessage(payload){this.requests.push(payload);}
  terminate(){}
  flush(){
   const req=this.requests.shift();
   assert.ok(req,'pending worker request');
   this.onmessage({data:{job:req.job,ok:true,channels:req.channels.map(()=>new Float32Array(req.plan.outputFrames)),plan:req.plan}});
  }
 }
 const ctx={
  currentTime:10,destination:{},
  createGain(){return {gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){}};},
  createBuffer(channels,frames,sampleRate){return {length:frames,duration:frames/sampleRate,copyToChannel(){}};},
  createBufferSource(){return {connect(){},start(){},stop(){},disconnect(){}};}
 };
 globalThis.Worker=StubWorker;
 let stream;
 try{
  stream=createModelStream({ctx,sourceChannels:[new Float32Array(16000*12)],sampleRate:16000,
   speed:.75,semitones:0,model:'pv',fftSize:2048,referenceWindows:8,startSeconds:4});
  stream.start();
  assert.equal(fake.requests.length,1);
  assert.equal(stream.sourcePositionAt(10.04),4);
  fake.flush();
  assert.equal(fake.requests.length,1);
  assert.ok(Math.abs(stream.sourcePositionAt(11.12)-4.75)<.0001);
  ctx.currentTime=14.5;
  assert.ok(Math.abs(stream.sourcePositionAt(ctx.currentTime)-5.5)<.0001,'clock frozen between buffers');
  fake.flush();
  assert.ok(Math.abs(stream.sourcePositionAt(14.53)-5.5)<.0001);
  // Worker finished at ctx=14.5, so audio is scheduled at 14.54, NOT 15.04.
  assert.ok(Math.abs(stream.sourcePositionAt(14.54)-5.5)<.0001);
  assert.ok(Math.abs(stream.sourcePositionAt(15.54)-6.25)<.0001);
 }finally{stream?.stop();globalThis.Worker=original;}
});
test('app playback and error fallback use audible scheduled source rather than original start offset',()=>{
 const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
 assert.match(app,/if\(state\.player\.labStream\)return state\.player\.stream\.sourcePositionAt\(state\.ctx\.currentTime\)/);
 assert.match(app,/const resume=playPosition\(\);\s*void \(async\(\)=>\{await stop\(\);if\(!state\.player\)await play\("dry",resume\);\}\)\(\)/);
 assert.doesNotMatch(app,/stop\(\)\.then\(\(\)=>play\("dry",where\)\)/);
});
