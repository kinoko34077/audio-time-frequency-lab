import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {createGranularTimePitch} from "./source-granular.mjs";

// A deterministic real Worklet-class harness: no wall-clock sleeps, mock only
// AudioWorkletProcessor's port. The imported renderer is the production module.
const source=readFileSync(new URL("./source-pcm.worklet.js",import.meta.url),"utf8")
  .replace(/^import [^\n]+\n/gm,"");
function processor(options){
  const messages=[];
  let Worklet;
  class FakeAudioWorkletProcessor{
    constructor(){
      this.port={
        postMessage(data){messages.push(data);},
        close(){},
        onmessage:null
      };
    }
  }
  new Function("AudioWorkletProcessor","registerProcessor",
    "createSourcePCMRenderer","createGranularTimePitch","sampleRate",source)(
    FakeAudioWorkletProcessor,
    (name,constructor)=>{assert.equal(name,"audio-lab-source-pcm");Worklet=constructor;},
    createSourcePCMRenderer,createGranularTimePitch,48000
  );
  return {p:new Worklet({processorOptions:options}),messages};
}
test("an unserviced PCM refill stays one in-flight request for 240 quanta",()=>{
  const {p,messages}=processor({
    sourceFrames:1_000_000,sourceSampleRate:48000,
    channelCount:1,startFrame:10_000,speed:8
  });
  p.port.onmessage({data:{type:"command",op:"play",requestId:1}});
  for(let i=0;i<240;i++)p.process([],[[new Float32Array(128)]]);
  const requests=messages.filter(x=>x.type==="need-window");
  assert.equal(requests.length,1,"unserviced PCM must not flood the host");
  const id=requests[0].refillId;
  assert.equal(typeof id,"number");
  assert.ok(p.renderer.timeline.state.sourceFrame>250_000,
    "the committed output clock must continue through underrun");
  p.port.onmessage({data:{type:"window",requestId:2,
    refillId:id+99,start:0,channels:[new Float32Array(65536)]}});
  for(let i=0;i<80;i++)p.process([],[[new Float32Array(128)]]);
  assert.equal(messages.filter(x=>x.type==="need-window").length,1,
    "stale host response must not release the pending request");
  p.port.onmessage({data:{type:"window",requestId:3,
    refillId:id,start:0,channels:[new Float32Array(65536)]}});
  p.process([],[[new Float32Array(128)]]);
  const next=messages.filter(x=>x.type==="need-window");
  assert.equal(next.length,2,"a processed refill permits exactly one new request");
  assert.notEqual(next[1].refillId,id);
});

test("atomic loop-config switches source bounds with endpoint PCM in same handler",()=>{
  const {p,messages}=processor({
    sourceFrames:1000,sourceSampleRate:48000,
    channelCount:1,startFrame:3,speed:1,
    loopEnabled:true,loopStartFrame:0,loopEndFrame:990
  });
  p.port.onmessage({data:{type:"window",start:0,
    channels:[new Float32Array(20).fill(.25)],pin:"A",requestId:1}});
  p.port.onmessage({data:{type:"window",start:970,
    channels:[new Float32Array(20).fill(.25)],pin:"B",requestId:2}});
  p.port.onmessage({data:{type:"command",op:"play",requestId:3}});
  p.process([],[[new Float32Array(4)]]);
  const loop={type:"loop-config",op:"bounds",a:400,b:420,enabled:true,requestId:4,
    endpoints:[
      {start:400,channels:[new Float32Array(20).fill(.5)]},
      {start:400,channels:[new Float32Array(20).fill(.5)]}
    ]};
  p.port.onmessage({data:loop});
  const receipt=messages.find(x=>x.type==="command-accepted"&&x.requestId===4);
  assert.equal(receipt.loopStartFrame,400);
  assert.equal(receipt.loopEndFrame,420);
  const output=[new Float32Array(4)];
  p.process([],[output]);
  assert.deepEqual(Array.from(output[0]),[.5,.5,.5,.5]);
  assert.equal(p.renderer.statistics.missingFrames,0);
});

test("command ACK alone does not claim a rendered output quantum",()=>{
  const {p,messages}=processor({sourceFrames:2048,sourceSampleRate:48000,
    channelCount:1,startFrame:60,speed:1});
  p.port.onmessage({data:{type:"window",start:0,
    channels:[new Float32Array(2048).fill(.4)],requestId:1}});
  p.port.onmessage({data:{type:"command",op:"play",requestId:2}});
  assert.equal(messages.filter(m=>m.type==="render-applied").length,0,
    "accepted play must not be reported as rendered before process()");
  const out=[new Float32Array(128)];
  p.process([],[out]);
  const seen=messages.filter(m=>m.type==="render-applied");
  assert.equal(seen.length,1);
  assert.equal(seen[0].requestId,2);
  assert.equal(seen[0].sourceFrame,60);
  assert.equal(seen[0].missingFramesInBlock,0);
  assert.equal(seen[0].running,true);
  assert.ok(out[0].every(x=>Math.abs(x-.4)<1e-6));
  p.process([],[out]);
  assert.equal(messages.filter(m=>m.type==="render-applied").length,1,
    "one control request must have one render disposition");
});

test("multiple accepted edits before next quantum supersede prior render claims",()=>{
  const {p,messages}=processor({sourceFrames:4096,sourceSampleRate:48000,
    channelCount:1,startFrame:40,speed:1});
  p.port.onmessage({data:{type:"window",start:0,
    channels:[new Float32Array(4096).fill(.3)],requestId:1}});
  p.port.onmessage({data:{type:"command",op:"play",requestId:2}});
  p.port.onmessage({data:{type:"command",op:"speed",speed:2,requestId:3}});
  p.port.onmessage({data:{type:"seek-window",frame:101,start:0,
    channels:[new Float32Array(4096).fill(.3)],requestId:4}});
  assert.deepEqual(messages.filter(m=>m.type==="render-superseded")
    .map(m=>[m.requestId,m.supersededBy]),[[2,3],[3,4]]);
  assert.equal(messages.filter(m=>m.type==="render-applied").length,0);
  p.process([],[[new Float32Array(128)]]);
  const rendered=messages.filter(m=>m.type==="render-applied");
  assert.equal(rendered.length,1);
  assert.equal(rendered[0].requestId,4);
  assert.equal(rendered[0].sourceFrame,101);
  assert.equal(rendered[0].running,true);
});

test("pause receipt reports a silent output quantum without pretending sound played",()=>{
  const {p,messages}=processor({sourceFrames:1024,sourceSampleRate:48000,
    channelCount:1,speed:1});
  p.port.onmessage({data:{type:"command",op:"pause",requestId:19}});
  const out=[new Float32Array(128).fill(.2)];
  p.process([],[out]);
  assert.ok(out[0].every(x=>x===0));
  const observed=messages.find(m=>m.type==="render-applied");
  assert.equal(observed.requestId,19);
  assert.equal(observed.running,false);
  assert.equal(observed.missingFramesInBlock,0);
});

test("atomic scratch preserves Granular overlap and renders the held destination PCM",()=>{
  const frames=65536,sr=48000;
  const channels=[new Float32Array(frames),new Float32Array(frames)];
  for(let i=0;i<frames;i++){
    const value=i<32768?.17:.63;
    channels[0][i]=value;
    channels[1][i]=-value*.5;
  }
  const {p,messages}=processor({sourceFrames:frames,sourceSampleRate:sr,
    channelCount:2,startFrame:10000,speed:0,processingMode:"granular"});
  p.port.onmessage({data:{type:"window",requestId:1,start:0,channels}});
  p.port.onmessage({data:{type:"command",op:"play",requestId:2}});
  for(let i=0;i<4;i++)
    p.process([],[[new Float32Array(128),new Float32Array(128)]]);
  const grainEpoch=p.granular.state.outputFrames;
  assert.ok(grainEpoch>=512);
  p.port.onmessage({data:{type:"scrub",requestId:3,frame:40000,speed:0}});
  const ack=messages.find(m=>m.type==="command-accepted"&&m.requestId===3);
  assert.equal(ack.op,"scrub");assert.equal(ack.speed,0);
  assert.equal(ack.sourceFrame,40000);
  assert.equal(p.granular.state.outputFrames,grainEpoch,
    "scrubbing must not clear the overlap epoch at every pointer movement");
  let output;
  for(let i=0;i<3;i++){
    output=[new Float32Array(128),new Float32Array(128)];
    p.process([],[output]);
  }
  assert.ok(output[0].every(x=>Math.abs(x-.63)<.015),
    {output:Array.from(output[0].slice(0,4))});
  assert.ok(output[1].every(x=>Math.abs(x+.315)<.015));
  assert.equal(p.renderer.statistics.missingFrames,0);
  const receipt=messages.find(m=>m.type==="render-applied"&&m.requestId===3);
  assert.equal(receipt.missingFramesInBlock,0);
  assert.equal(receipt.running,true);
  p.port.onmessage({data:{type:"scrub",requestId:4,frame:40000,speed:-1}});
  assert.equal(messages.find(m=>m.type==="command-accepted"&&m.requestId===4).speed,-1);
  assert.equal(p.granular.state.outputFrames,grainEpoch+384);
  p.process([],[[new Float32Array(128),new Float32Array(128)]]);
  assert.ok(p.renderer.timeline.state.sourceFrame<40000,
    "reverse scratch must advance actual audio source time backwards");
  assert.equal(messages.filter(m=>m.type==="error").length,0);
});

test("render progress publishes the actual signed source speed and A/B bounds for display",()=>{
  const {p,messages}=processor({sourceFrames:4096,sourceSampleRate:48000,
    channelCount:1,startFrame:1000,speed:-1,loopEnabled:true,
    loopStartFrame:500,loopEndFrame:3000});
  p.port.onmessage({data:{type:"command",op:"play",requestId:1}});
  for(let i=0;i<8;i++)p.process([],[[new Float32Array(128)]]);
  const progress=messages.find(x=>x.type==="progress");
  assert.ok(progress,"render thread must send a snapshot after eight real blocks");
  assert.equal(progress.running,true);
  assert.equal(progress.speed,-1);
  assert.equal(progress.loopEnabled,true);
  assert.equal(progress.loopStartFrame,500);
  assert.equal(progress.loopEndFrame,3000);
  assert.equal(progress.sourceFrame,p.renderer.timeline.state.sourceFrame);
  assert.equal(progress.revision,p.renderer.timeline.state.revision);
  assert.equal(progress.outputTime,null,
    "non-browser Worklet harness has no real audio clock and must not invent it");
});
