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
  flush(generation=null){
   const index=generation===null?0:this.requests.findIndex(req=>
    req.generation===generation);
   assert.ok(index>=0,'pending bounded Worker request');
   const [req]=this.requests.splice(index,1);
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
    if(this.node.rejectStagedChunk&&
       this.node.stagedState?.generation===message.generation&&
       this.node.stagedState.sequence===message.sequence){
     this.node.rejectStagedChunk=false;
     respond({type:"rendered-chunk-accepted",requestId:message.requestId,
       generation:message.generation,stale:true,
       bufferedSegments:this.node.segments.length+
         this.node.stagedChunks.length});
     return;
    }
    if(this.node.stagedState?.generation===message.generation)
      this.node.stagedChunks.push(message);
    else this.node.segments.push(message);
    respond({type:"rendered-chunk-accepted",requestId:message.requestId,
      generation:message.generation,bufferedSegments:this.node.segments.length+
        this.node.stagedChunks.length});
   }else if(message.type==="worker-stage"){
    const active=this.node.segments.filter(segment=>
      segment.generation===this.node.generation);
    const current=active.find(segment=>
      this.node.frame>=segment.startFrame&&
      this.node.frame<segment.endFrame)||
      active.find(segment=>this.node.frame===segment.endFrame)||
      active.find(segment=>this.node.frame<segment.startFrame)||null;
    let frame,sequence;
    if(current){
     const index=active.indexOf(current);
     this.node.segments=active.slice(index,index+2);
     frame=current.endFrame;sequence=current.sequence+1;
    }else{
     this.node.segments=[];frame=Math.floor(this.node.frame);
     sequence=(active.at(-1)?.sequence??-1)+1;
    }
    this.node.stagedState={frame,speed:message.speed,
      pitchSemitones:message.pitchSemitones,generation:message.generation,
      sequence};
    this.node.stagedChunks=[];
    respond({type:"worker-state-staged",requestId:message.requestId,
      generation:message.generation,sourceFrame:frame,sequence,
      speed:message.speed,pitchSemitones:message.pitchSemitones,
      bufferedSegments:this.node.segments.length});
   }else if(message.type==="worker-seek-stage"){
    this.node.stagedState={frame:message.frame,speed:message.speed,
      pitchSemitones:message.pitchSemitones,generation:message.generation,
      requiredChunks:message.requiredChunks};
    this.node.stagedChunks=[];
    respond({type:"worker-state-staged",requestId:message.requestId,
      generation:message.generation,sourceFrame:message.frame,sequence:0,
      speed:message.speed,pitchSemitones:message.pitchSemitones,
      bufferedSegments:this.node.segments.length});
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
   this.revision=0;this.running=false;this.segments=[];this.stagedChunks=[];
   this.rejectStagedChunk=false;
   this.deferNextActivation=false;this.deferredActivation=null;
   worklets.push(this);
  }
  connect(){return this;}disconnect(){}
  addEventListener(name,fn){this.listeners[name]=fn;}
  removeEventListener(name){delete this.listeners[name];}
  advance(outputFrames){
   if(!this.running)return;
   if(this.stagedState&&this.stagedChunks.length>=
      (this.stagedState.requiredChunks??1)){
    const staged=this.stagedState;
    this.frame=staged.frame;this.speed=staged.speed;
    this.generation=staged.generation;this.segments=[...this.stagedChunks];
    this.stagedState=null;this.stagedChunks=[];this.revision++;
    const activated={type:"worker-state-activated",
      generation:this.generation,sourceFrame:this.frame,speed:this.speed,
      pitchSemitones:staged.pitchSemitones,revision:this.revision,
      bufferedSegments:this.segments.length};
    this.port.messages.push(activated);
    if(this.deferNextActivation){
     this.deferNextActivation=false;this.deferredActivation=activated;
    }else this.port.onmessage?.({data:activated});
   }
   this.frame+=outputFrames*this.speed*this.options.processorOptions.sourceSampleRate/
     this.options.processorOptions.sourceSampleRate;
   const length=this.options.processorOptions.sourceFrames;
   if(this.frame>=length)this.frame%=length;
   const progress={type:"progress",sourceFrame:this.frame,
     speed:this.speed,running:true,revision:this.revision,
     workerGeneration:this.generation,bufferedSegments:this.segments.length,
     missingFrames:0};
   this.port.messages.push(progress);
   this.port.onmessage?.({data:progress});
  }
  deliverActivation(){
   assert.ok(this.deferredActivation,'deferred activation is available');
   const data=this.deferredActivation;this.deferredActivation=null;
   this.port.onmessage?.({data});
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
  await settle();
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
  assert.deepEqual(worklets[0].segments.map(segment=>segment.sequence),[0,1],
    "Worker PCM chunks receive ordered identities on the shared source clock");
  worklets[0].advance(16000);await settle();
  assert.ok(Math.abs(stream.sourcePositionAt()-4.75)<1e-6,
    "playhead follows Worklet source frames rather than wall time");
  const seek=stream.seek(88000);
  await settle();await settle();
  assert.equal(stream.sourcePositionAt(),4.75,
    "the old shared-clock PCM remains audible while the seek chunk renders");
  assert.ok(worklets[0].port.messages.some(m=>m.type==="worker-seek-stage"&&
    m.frame===88000&&m.generation===1));
  assert.equal(workers.length,2,"seek rendering uses a bounded handoff Worker");
  assert.equal(workers[1].requests[0].plan.start,88000,
    "the handoff PCM starts at the exact requested source frame");
  workers[1].flush();await settle();await settle();await settle();
  assert.equal(stream.sourcePositionAt(),4.75,
    "the source clock changes only after the target PCM is prepared");
  assert.equal(worklets[0].stagedChunks.length,1,
    "seek PCM is installed without waiting for an obsolete main Worker job");
  worklets[0].advance(0);
  await seek;
  assert.ok(Math.abs(stream.sourcePositionAt()-5.5)<1e-6);
  assert.equal(worklets.length,1,"seek reuses the same Worklet");
  assert.equal(worklets[0].port.messages.some(m=>m.type==="worker-state"&&
    m.frame===88000&&m.generation===1),false,
    "a started seek does not reset the active queue before target PCM is ready");
  assert.ok(worklets[0].port.messages.some(m=>m.type==="worker-state-activated"&&
    m.sourceFrame===88000&&m.generation===1));
  assert.deepEqual(worklets[0].segments.map(segment=>segment.sequence),[0],
    "the activated seek starts a fresh ordered PCM queue");
  workers[0].flush();await settle();await settle();
  const newestRequest=workers[0].requests.at(-1);
  assert.equal(newestRequest.generation,1);
  assert.equal(newestRequest.plan.start,112000);
  workers[0].flush();await settle();await settle();
  assert.deepEqual(worklets[0].segments.map(segment=>segment.sequence),[0,1],
    "the next main Worker chunk continues the seek generation in queue order");
  while(worklets[0].segments.length<4){
   assert.ok(workers[0].requests.length,"fill the active queue before staging");
   workers[0].flush();await settle();await settle();
  }
  worklets[0].frame=88000;
  const transition=stream.updateSettings({speed:1.25});
  await settle();await settle();await settle();
  assert.equal(worklets[0].port.messages.filter(m=>m.type==="worker-stage").length,1);
  assert.equal(workers[0].requests[0].plan.start,112000,
    "the first staged generation starts at the next retained PCM boundary");
  worklets[0].frame=120000;
  const delayedProgress={type:"progress",sourceFrame:120000,speed:1,
    running:true,revision:worklets[0].revision,workerGeneration:1,
    bufferedSegments:2,missingFrames:0};
  worklets[0].port.onmessage?.({data:delayedProgress});
  worklets[0].rejectStagedChunk=true;
  workers[0].flush();await settle();await settle();await settle();
  assert.equal(worklets[0].port.messages.filter(m=>m.type==="worker-stage").length,2,
    "a late staged result is re-planned at the live old-generation cursor");
  assert.equal(worklets[0].stagedState.frame,136000);
  assert.equal(workers[0].requests[0].plan.start,136000,
    "the replacement Worker job starts at the updated safe boundary");

  // The Worklet can activate a generation before its main-thread activation
  // event is dispatched. A subsequent settings reversal currently deletes
  // that generation's config metadata; a seek must then fail closed on reuse.
  const returnedToDifferentPitch=stream.updateSettings({speed:.75,semitones:2});
  let preparedGenerationThree=false;
  for(let attempt=0;attempt<20&&!preparedGenerationThree;attempt++){
   await settle();
   const owner=workers.find(candidate=>candidate.requests.some(request=>
    request.generation===3));
   if(owner){
    owner.flush(3);
    for(let i=0;i<8;i++)await settle();
    preparedGenerationThree=worklets[0].stagedChunks.some(chunk=>
     chunk.generation===3);
   }else{
    const pendingOwner=workers.find(candidate=>candidate.requests.length);
    const request=pendingOwner?.requests[0];
    if(request){
     pendingOwner.flush(request.generation);
     await settle();
    }else{
     await settle();
    }
   }
  }
  assert.ok(preparedGenerationThree,
    "the intermediate pitch generation has prepared shared-clock PCM");
  worklets[0].deferNextActivation=true;worklets[0].advance(0);
  assert.equal(worklets[0].deferredActivation.generation,3);
  assert.equal(worklets[0].deferredActivation.pitchSemitones,2,
    "the activated intermediate generation has different PCM settings");
  const returnedToOriginal=stream.updateSettings({speed:.75,semitones:0});
  for(let i=0;i<4;i++)await settle();
  worklets[0].deliverActivation();
  await settle();
  const activeChunk=worklets[0].segments[0];
  assert.ok(activeChunk&&activeChunk.generation===3);
  const racedSeek=stream.seek(activeChunk.startFrame+1);
  for(let i=0;i<4;i++)await settle();
  const racedSeekStage=worklets[0].port.messages.filter(message=>
   message.type==="worker-seek-stage").at(-1);
  assert.equal(racedSeekStage?.reuseCompatible,false,
    "unknown active-generation config must disable PCM reuse after a delayed activation event");

  const pendingAtStop=stream.updateSettings({speed:.9,semitones:0});
  for(let i=0;i<2;i++)await settle();
  stream.stop();
  const stopped=await pendingAtStop;
  assert.equal(stopped.cancelled,true,
    "normal stream stop cancels a pending model transition without rejecting");
  await Promise.allSettled([transition,returnedToDifferentPitch,
    returnedToOriginal,racedSeek]);
 }finally{stream?.stop();globalThis.Worker=OriginalWorker;
  globalThis.AudioWorkletNode=OriginalWorklet;}
});
test('app model playback follows Worklet source frames and reports failures without dry substitution',()=>{
  const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
  assert.match(app,/if\(state\.player\.labStream\)return state\.player\.stream\.sourcePositionAt\(\)/);
  assert.match(app,/scheduleModelSeek\(p,/);
  const recovery=app.match(/async function recoverPlaybackAfterFailure\(\{[\s\S]*?(?=\nasync function play\()/)?.[0];
  assert.ok(recovery,"shared playback failure recovery is present");
  assert.match(recovery,/player\?\.playRequested&&!player\.paused/,
    "only a failure during active playback resumes automatically");
  assert.match(recovery,/await stop\(\)/,"the failed renderer is stopped before restart");
  assert.match(recovery,/state\.seek=clamp\(frame,/,
    "recovery restores the failed source position");
  assert.match(recovery,/await restart\(\)/,
    "recovery restarts the selected renderer");
  assert.match(app,/const recoveryConfig=player\.appliedConfig\|\|applied;[\s\S]*?recoverPlaybackAfterFailure\(\{player,mode:"worker",frame:resume,[\s\S]*?restart:\(\)=>startModelPlayback\(resume,recoveryConfig\)\}/,
    "Worker failure recovery uses the latest successfully applied configuration");
  assert.match(app,/recoverPlaybackAfterFailure\(\{player:failedPlayer,[\s\S]*?restart:\(\)=>play\(failedPlayer\.mode,resumeAt\)\}/,
    "source-PCM failures use the shared recovery path");
  assert.match(recovery,/message\("処理に失敗しました。音源は保持されています: "\+reason,"error"\)/,
    "a non-playing failure is reported while keeping the source retryable");
  assert.match(recovery,/message\("音声処理が再度失敗したため停止しました。音源と位置は保持されています。","error"\)/,
    "a repeated runtime failure stops instead of retrying forever");
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
