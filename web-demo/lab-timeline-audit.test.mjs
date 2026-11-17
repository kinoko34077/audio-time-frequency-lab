import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createModelStream,planChunk} from './lab-stream.mjs';
import {renderPCM} from './lab-dsp.mjs';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('legacy Worker PCM is rendered by one shared Worklet source clock',async()=>{
 const OriginalWorker=globalThis.Worker,OriginalWorklet=globalThis.AudioWorkletNode;
 const workers=[],worklets=[];
 class StubWorker{
  constructor(){workers.push(this);this.requests=[];}
  postMessage(payload){this.requests.push(payload);}
  terminate(){}
  flush(){
   const req=this.requests.shift();assert.ok(req,'pending bounded Worker request');
   const channels=req.channels.map(()=>new Float32Array(req.plan.outputFrames).fill(.1));
   this.onmessage({data:{job:req.job,generation:req.generation,ok:true,channels,plan:req.plan}});
  }
 }
 class StubPort{
  constructor(node){this.node=node;this.onmessage=null;this.messages=[];}
  postMessage(message){
   this.messages.push(message);
   const respond=data=>queueMicrotask(()=>this.onmessage?.({data}));
   if(message.type==="rendered-chunk"){
    this.node.segments.push(message);
    respond({type:"rendered-chunk-accepted",requestId:message.requestId,
      generation:message.generation,bufferedSegments:this.node.segments.length});
   }else if(message.type==="worker-state"){
    this.node.frame=message.frame;this.node.speed=message.speed;
    this.node.generation=message.generation;this.node.segments.length=0;
    this.node.revision++;
    respond({type:"worker-state-accepted",requestId:message.requestId,
      generation:message.generation,sourceFrame:this.node.frame,
      speed:this.node.speed,pitchSemitones:message.pitchSemitones,
      revision:this.node.revision,bufferedSegments:0});
   }else if(message.type==="command"){
    if(message.op==="play")this.node.running=true;
    if(message.op==="pause")this.node.running=false;
    respond({type:"command-accepted",requestId:message.requestId,
      op:message.op,sourceFrame:this.node.frame,revision:this.node.revision});
   }
  }
 }
 class StubWorklet{
  constructor(ctx,name,options){
   this.options=options;this.port=new StubPort(this);this.listeners={};
   this.frame=options.processorOptions.startFrame;
   this.speed=options.processorOptions.speed;this.generation=0;
   this.revision=0;this.running=false;this.segments=[];worklets.push(this);
  }
  connect(){return this;}disconnect(){}
  addEventListener(name,fn){this.listeners[name]=fn;}
  removeEventListener(name){delete this.listeners[name];}
  advance(outputFrames){
   if(!this.running)return;
   this.frame+=outputFrames*this.speed*this.options.processorOptions.sourceSampleRate/
     this.options.processorOptions.sourceSampleRate;
   const length=this.options.processorOptions.sourceFrames;
   if(this.frame>=length)this.frame%=length;
   this.port.onmessage?.({data:{type:"progress",sourceFrame:this.frame,
     speed:this.speed,running:true,revision:this.revision,
     workerGeneration:this.generation,bufferedSegments:this.segments.length,
     missingFrames:0}});
  }
 }
 globalThis.Worker=StubWorker;globalThis.AudioWorkletNode=StubWorklet;
 const ctx={sampleRate:16000,currentTime:5,destination:{},
  audioWorklet:{addModule:async()=>{}},resume:async()=>{},
  createGain(){return {gain:{value:1},connect(){},disconnect(){}};}};
 let stream;
 try{
  stream=await createModelStream({ctx,sourceChannels:[new Float32Array(16000*12)],
   sampleRate:16000,speed:.75,semitones:0,model:'period-joint',
   jointBackend:'pv',fftSize:2048,shortFftSize:512,longFftSize:2048,
   referenceWindows:8,periodCycles:8,startSeconds:4});
  stream.start();
  assert.equal(workers.length,1);
  assert.equal(workers[0].requests.length,1);
  assert.equal(stream.sourcePositionAt(),4);
  workers[0].flush();await settle();await settle();
  assert.equal(stream.firstScheduled,false,
    "playback waits until a second segment is buffered");
  assert.equal(worklets.length,1);
  assert.equal(worklets[0].options.processorOptions.processingMode,"worker");
  assert.equal(worklets[0].options.processorOptions.loopEnabled,true,
    "legacy full-track wrap remains enabled in the common timeline");
  assert.equal(workers[0].requests.length,1,
    "the second bounded Worker segment fills initial lookahead");
  assert.equal(worklets[0].port.messages.filter(m=>m.type==="window").length,0,
    "the Worker PCM path does not use the raw-window playback clock");
  workers[0].flush();await settle();await settle();
  assert.equal(stream.firstScheduled,true);
  assert.equal(stream.bufferedSegments,2);
  worklets[0].advance(16000);await settle();
  assert.ok(Math.abs(stream.sourcePositionAt()-4.75)<1e-6,
    "playhead follows Worklet source frames rather than wall time");
  await stream.seek(88000);
  assert.ok(Math.abs(stream.sourcePositionAt()-5.5)<1e-6);
  assert.equal(worklets.length,1,"seek reuses the same Worklet");
  assert.ok(worklets[0].port.messages.some(m=>m.type==="worker-state"&&
    m.frame===88000&&m.generation===1));
  const newestRequest=workers[0].requests.at(-1);
  assert.equal(newestRequest.generation,1);
  assert.equal(newestRequest.plan.start,88000);
 }finally{stream?.stop();globalThis.Worker=OriginalWorker;
  globalThis.AudioWorkletNode=OriginalWorklet;}
});
test('app model playback follows Worklet source frames and reports failures without dry substitution',()=>{
  const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
  assert.match(app,/if\(state\.player\.labStream\)return state\.player\.stream\.sourcePositionAt\(\)/);
  assert.match(app,/scheduleModelSeek\(p,/);
  assert.match(app,/const resume=playPosition\(\);\s*void \(async\(\)=>\{\s*await stop\(\);\s*if\(state\.player\)return;\s*state\.seek=resume;/);
  assert.match(app,/message\("選択モデルで音声処理できませんでした: "\+error,"error"\)/);
  assert.doesNotMatch(app,/if\(!state\.player\)await play\("dry",resume\)/);
  const stream=readFileSync(new URL('lab-stream.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(stream,/createBufferSource|scheduledSourcePosition/,
    "the legacy stream has no second playback node or wall-clock ledger");
});

test('disabled joint-mode long/short/reference controls do not change preview context',()=>{
 const req={totalFrames:48000*8,sampleRate:48000,speed:.8,startSeconds:3,model:'period-joint',fftSize:2048};
 const a=planChunk({...req,shortFftSize:256,longFftSize:1024,referenceWindows:2});
 const b=planChunk({...req,shortFftSize:2048,longFftSize:8192,referenceWindows:16});
 assert.deepEqual({left:a.left,right:a.right,from:a.from,to:a.to},
   {left:b.left,right:b.right,from:b.from,to:b.to},'disabled controls must have zero influence');
 assert.equal(a.left,Math.ceil(48000*.12),'bounded model-owned context');
});
test('joint residual PV output does not change when disabled longFFT value changes',()=>{
 const sr=16000;
 const pcm=Float32Array.from({length:sr},(_,i)=>.2*Math.sin(2*Math.PI*413*i/sr)+.05*Math.sin(i*2.11));
 const args={channels:[pcm],sampleRate:sr,speed:.8,semitones:3,model:'period-joint'};
 const a=renderPCM({...args,fftSize:1024,longFftSize:1024});
 const b=renderPCM({...args,fftSize:4096,longFftSize:8192});
 assert.deepEqual(a.channels[0],b.channels[0]);
});
