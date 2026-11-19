import test from "node:test";
import assert from "node:assert/strict";
import {createSourcePCMBridge} from "./source-pcm-bridge.mjs";

class FakeAudioWorkletNode{
  constructor(){
    this.listeners=new Map();
    this.sent=[];
    this.port={onmessage:null,postMessage:(message)=>this.sent.push(message)};
  }
  addEventListener(name,listener){this.listeners.set(name,listener);}
  removeEventListener(name){this.listeners.delete(name);}
  dispatchEvent(event){this.listeners.get(event.type)?.(event);return true;}
  connect(){return this;}
  disconnect(){}
}

async function withFakeWorklet(run){
  const original=globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode=FakeAudioWorkletNode;
  try{
    const nodes=[];
    class TrackedAudioWorkletNode extends FakeAudioWorkletNode{
      constructor(...args){super(...args);nodes.push(this);}
    }
    globalThis.AudioWorkletNode=TrackedAudioWorkletNode;
    await run(nodes);
  }finally{
    if(original===undefined)delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode=original;
  }
}

function context(){
  return {sampleRate:48_000,audioWorklet:{addModule:async()=>{}},resume:async()=>{}};
}

function pcmSource(read){
  return {sourceFrames:262_144,channelCount:1,read};
}

function range(startFrame,frameCount){
  return {startFrame,channels:[new Float32Array(frameCount).fill(.2)]};
}

test("a preempted playback refill retries without failing the audio processor",async()=>{
  await withFakeWorklet(async nodes=>{
    const reads=[];
    const source=pcmSource(async(startFrame,frameCount,{priority})=>{
      reads.push({startFrame,frameCount,priority});
      if(reads.length===2){
        const error=new Error("PCM window decode aborted");
        error.name="AbortError";
        throw error;
      }
      return range(startFrame,frameCount);
    });
    const events=[];
    const bridge=await createSourcePCMBridge({ctx:context(),source,
      sourceSampleRate:48_000,startFrame:10_000,onEvent:event=>events.push(event)});
    const node=nodes[0];
    node.port.onmessage({data:{type:"need-window",frame:70_000,refillId:17}});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(reads.length,3,reads);
    assert.ok(node.sent.some(message=>message.type==="window"&&
      message.refillId===17),node.sent);
    assert.equal(events.filter(event=>event.type==="fatal-error").length,0,events);
    bridge.dispose();
  });
});

test("an in-flight seek preserves the processor failure after an asynchronous read",async()=>{
  await withFakeWorklet(async nodes=>{
    let finishSeekRead;
    let readCount=0;
    const source=pcmSource((startFrame,frameCount)=>{
      readCount++;
      if(readCount===1)return Promise.resolve(range(startFrame,frameCount));
      return new Promise(resolve=>{finishSeekRead=()=>resolve(range(startFrame,frameCount));});
    });
    const bridge=await createSourcePCMBridge({ctx:context(),source,
      sourceSampleRate:48_000,startFrame:10_000});
    const pending=bridge.seek(1_234);
    nodes[0].dispatchEvent(new Event("processorerror"));
    finishSeekRead();
    await assert.rejects(pending,/processor unexpectedly terminated/);
    bridge.dispose();
  });
});
