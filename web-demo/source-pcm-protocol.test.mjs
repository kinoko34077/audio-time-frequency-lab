import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";

// A deterministic real Worklet-class harness: no wall-clock sleeps, mock only
// AudioWorkletProcessor's port. The imported renderer is the production module.
const source=readFileSync(new URL("./source-pcm.worklet.js",import.meta.url),"utf8")
  .replace(/^import [^\n]+\n/m,"");
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
    "createSourcePCMRenderer","sampleRate",source)(
    FakeAudioWorkletProcessor,
    (name,constructor)=>{assert.equal(name,"audio-lab-source-pcm");Worklet=constructor;},
    createSourcePCMRenderer,48000
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
