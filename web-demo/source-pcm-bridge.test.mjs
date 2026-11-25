import test from "node:test";
import assert from "node:assert/strict";
import {createSourcePCMBridge} from "./source-pcm-bridge.mjs";
import {createProgressivePCMCache} from "./progressive-source-cache.mjs";

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

async function waitFor(predicate,timeoutMs=1000){
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>=deadline)throw Error("timed out waiting for test state");
    await new Promise(resolve=>setTimeout(resolve,0));
  }
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

test("pending A/B preparation and rejected commands preserve the current refill until Worklet acceptance",async()=>{
  await withFakeWorklet(async nodes=>{
    let prime=true,holdNext=true,abortRefill,releaseEndpoints;
    const endpointGate=new Promise(resolve=>{releaseEndpoints=resolve;});
    const reads=[],events=[];
    const source=pcmSource(async(startFrame,frameCount,{windowFrames})=>{
      if(prime){prime=false;return range(startFrame,frameCount);}
      if(windowFrames===8192){
        reads.push("endpoint");
        await endpointGate;
        return range(startFrame,frameCount);
      }
      reads.push("refill");
      if(holdNext){
        holdNext=false;
        return new Promise((_,reject)=>{
          abortRefill=()=>reject(new DOMException("PCM window decode aborted","AbortError"));
        });
      }
      return range(startFrame,frameCount);
    });
    let bridge,operation;
    try{
      bridge=await createSourcePCMBridge({ctx:context(),source,
        sourceSampleRate:48_000,startFrame:10_000,onEvent:e=>events.push(e)});
      const node=nodes[0];
      const need=id=>node.port.onmessage({data:{type:"need-window",frame:70_000,refillId:id}});
      const delivered=id=>node.sent.some(m=>m.type==="window"&&m.refillId===id);
      const count=()=>reads.filter(x=>x==="refill").length;
      const lastLoop=()=>node.sent.findLast(m=>m.type==="loop-config");
      const accept=m=>node.port.onmessage({data:{type:"command-accepted",requestId:m.requestId}});

      need(17);
      assert.equal(count(),1);
      operation=bridge.setLoopConfiguration(70_000,200_000,true);
      assert.equal(reads.filter(x=>x==="endpoint").length,2);
      abortRefill();
      await waitFor(()=>delivered(17));
      assert.equal(count(),2);
      assert.equal(lastLoop(),undefined,"retry must complete before endpoints are released");
      releaseEndpoints();
      await waitFor(()=>lastLoop());
      accept(lastLoop());await operation;

      // Once the Worklet has accepted the new configuration, it has cleared
      // its old pendingRequest. A late abort from that old generation must
      // not retry, and the next need-window remains independently serviceable.
      holdNext=true;need(18);assert.equal(count(),3);
      operation=bridge.setLoopEnabled(false);
      accept(lastLoop());await operation;
      abortRefill();
      await new Promise(resolve=>setTimeout(resolve,0));
      assert.equal(count(),3);
      assert.equal(delivered(18),false);
      need(19);await waitFor(()=>delivered(19));

      // A rejected command has not cleared pendingRequest.
      holdNext=true;need(20);const before=count();
      operation=bridge.setLoopEnabled(false);
      const rejected=assert.rejects(operation,/test rejection/);
      node.port.onmessage({data:{type:"error",requestId:lastLoop().requestId,message:"test rejection"}});
      await rejected;
      abortRefill();
      await waitFor(()=>delivered(20));
      assert.equal(count(),before+1);
      assert.equal(events.filter(e=>e.type==="fatal-error").length,0);
    }finally{
      releaseEndpoints();
      bridge?.dispose();
      await operation?.catch(()=>{});
    }
  });
});

test("A/B endpoint reads retry when a scrub preempts a shared PCM decode",async()=>{
  await withFakeWorklet(async nodes=>{
    const sourceReads=[],started=[],aborted=[];
    let releaseA=null,releaseB=null;
    const source=createProgressivePCMCache({sourceFrames:524_288,channelCount:1,
      windowFrames:65_536,maxCachedWindows:2,maxConcurrentDecodes:2,
      decodeWindow:(startFrame,frameCount,{signal})=>{
        sourceReads.push(startFrame);
        if(startFrame!==65_536&&startFrame!==294_912)
          return Promise.resolve([new Float32Array(frameCount).fill(.2)]);
        started.push(startFrame);
        return new Promise((resolve,reject)=>{
          const onAbort=()=>{
            aborted.push(startFrame);
            reject(new DOMException("PCM window decode aborted","AbortError"));
          };
          signal.addEventListener("abort",onAbort,{once:true});
          const release=()=>{
            signal.removeEventListener("abort",onAbort);
            resolve([new Float32Array(frameCount).fill(.2)]);
          };
          if(startFrame===65_536)releaseA=release;
          else if(started.filter(frame=>frame===294_912).length===1)
            releaseB=release;
          else release();
        });
      }});
    let bridge;
    try{
      bridge=await createSourcePCMBridge({ctx:context(),source,
        sourceSampleRate:48_000,startFrame:10_000,loopStartFrame:0,
        loopEndFrame:524_288,loopEnabled:true});
      const node=nodes[0];
      const loopResult=bridge.setLoopBounds(70_000,300_000)
        .then(()=>({ok:true}),error=>({ok:false,error}));
      await waitFor(()=>started.includes(65_536)&&started.includes(294_912))
        .catch(error=>{throw Error(error.message+": "+JSON.stringify({started,
          sourceReads,stats:source.stats()}));});

      const scrubResult=bridge.scrub(70_000,1)
        .then(()=>({ok:true}),error=>({ok:false,error}));
      await waitFor(()=>aborted.length>0);
      const early=await Promise.race([loopResult.then(result=>({settled:true,result})),
        new Promise(resolve=>setTimeout(()=>resolve({settled:false}),50))]);
      assert.equal(early.settled,false,
        early.result?.error?.message||"A/B update must retry scheduler cancellation");

      releaseA();
      await waitFor(()=>node.sent.some(message=>message.type==="scrub"));
      const scrubMessage=node.sent.findLast(message=>message.type==="scrub");
      node.port.onmessage({data:{type:"command-accepted",
        requestId:scrubMessage.requestId}});
      assert.deepEqual(await scrubResult,{ok:true});
      releaseA();releaseB();
      await waitFor(()=>node.sent.some(message=>message.type==="loop-config"&&
        message.a===70_000&&message.b===300_000));
      const loopMessage=node.sent.findLast(message=>message.type==="loop-config");
      node.port.onmessage({data:{type:"command-accepted",
        requestId:loopMessage.requestId}});
      assert.deepEqual(await loopResult,{ok:true});
      assert.ok(sourceReads.filter(frame=>frame===aborted[0]).length>=2,
        "the preempted endpoint must be decoded again");
    }finally{
      releaseA?.();releaseB?.();
      bridge?.dispose();source.dispose();
    }
  });
});

test("one A/B edit applies bounds and loop state in one atomic Worklet command",async()=>{
  await withFakeWorklet(async nodes=>{
    const bridge=await createSourcePCMBridge({ctx:context(),
      source:pcmSource(async(startFrame,frameCount)=>range(startFrame,frameCount)),
      sourceSampleRate:48_000,startFrame:10_000});
    try{
      const update=bridge.setLoopConfiguration(70_000,80_000,true);
      await waitFor(()=>nodes[0].sent.some(m=>m.type==="loop-config"));
      const commands=nodes[0].sent.filter(m=>m.type==="loop-config");
      assert.equal(commands.length,1);
      assert.deepEqual({a:commands[0].a,b:commands[0].b,enabled:commands[0].enabled},
        {a:70_000,b:80_000,enabled:true});
      nodes[0].port.onmessage({data:{type:"command-accepted",
        requestId:commands[0].requestId}});
      await update;
    }finally{bridge.dispose();}
  });
});

test("a newer waveform scrub invalidates an in-flight seek",async()=>{
  await withFakeWorklet(async nodes=>{
    let releaseSeek,releaseScrub;
    let reads=0;
    const source=pcmSource((startFrame,frameCount)=>{
      reads++;
      if(reads===1)return Promise.resolve(range(startFrame,frameCount));
      if(reads===2)return new Promise(resolve=>{
        releaseSeek=()=>resolve(range(startFrame,frameCount));
      });
      if(reads===3)return new Promise(resolve=>{
        releaseScrub=()=>resolve(range(startFrame,frameCount));
      });
      return Promise.resolve(range(startFrame,frameCount));
    });
    const bridge=await createSourcePCMBridge({ctx:context(),source,
      sourceSampleRate:48_000,startFrame:10_000});
    const seek=bridge.seek(100_000).then(result=>({ok:true,result}),
      error=>({ok:false,error}));
    await waitFor(()=>typeof releaseSeek==="function");
    const scrub=bridge.scrub(200_000,1).then(result=>({ok:true,result}),
      error=>({ok:false,error}));
    await waitFor(()=>typeof releaseScrub==="function");
    releaseScrub();
    const node=nodes[0];
    await waitFor(()=>node.sent.some(message=>message.type==="scrub"));
    const scrubMessage=node.sent.findLast(message=>message.type==="scrub");
    node.port.onmessage({data:{type:"command-accepted",
      requestId:scrubMessage.requestId}});
    assert.equal((await scrub).ok,true);

    releaseSeek();
    await new Promise(resolve=>setTimeout(resolve,0));
    const obsoleteSeek=node.sent.findLast(message=>
      message.type==="seek-window"&&message.frame===100_000);
    if(obsoleteSeek)node.port.onmessage({data:{type:"command-accepted",
      requestId:obsoleteSeek.requestId}});
    assert.deepEqual(await seek,{ok:true,result:{stale:true}});
    assert.equal(obsoleteSeek,undefined,
      "the older keyboard seek must not replace the newer waveform position");
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

test("latest A/B intent stays bounded and Loop OFF bypasses obsolete cold endpoints",async()=>{
  await withFakeWorklet(async nodes=>{
    let release=[];
    const source=pcmSource((startFrame,frameCount)=>{
      if(frameCount===8192)return new Promise(resolve=>{
        release.push(()=>resolve(range(startFrame,frameCount)));
      });
      return Promise.resolve(range(startFrame,frameCount));
    });
    const bridge=await createSourcePCMBridge({ctx:context(),source,
      sourceSampleRate:48_000,startFrame:10_000});
    const node=nodes[0];
    try{
      const old=bridge.setLoopConfiguration(70_000,180_000,true);
      await waitFor(()=>release.length===2);
      const queued=bridge.setLoopConfiguration(80_000,190_000,true);
      const latest=bridge.setLoopConfiguration(90_000,200_000,true);
      assert.deepEqual(await queued,{stale:true});
      const off=bridge.setLoopConfiguration(90_000,200_000,false);
      assert.deepEqual(await latest,{stale:true});
      await waitFor(()=>node.sent.some(m=>m.type==="loop-config"));
      const sent=node.sent.filter(m=>m.type==="loop-config");
      assert.equal(sent.length,1);
      assert.deepEqual({a:sent[0].a,b:sent[0].b,enabled:sent[0].enabled},
        {a:90_000,b:200_000,enabled:false});
      assert.equal(release.length,2,"no queued obsolete endpoint reads");
      node.port.onmessage({data:{type:"command-accepted",requestId:sent[0].requestId}});
      assert.equal((await off).type,"command-accepted");
      release.forEach(fn=>fn());
      assert.deepEqual(await old,{stale:true});
      assert.equal(node.sent.filter(m=>m.type==="loop-config").length,1,
        "old cold result must not re-enable the loop");
    }finally{release.forEach(fn=>fn());bridge.dispose();}
  });
});

test("unchanged endpoint windows are reused without rereading or transferring retained buffers",async()=>{
  await withFakeWorklet(async nodes=>{
    const reads=[];
    const source=pcmSource(async(startFrame,frameCount)=>{
      reads.push({startFrame,frameCount});
      return range(startFrame,frameCount);
    });
    const bridge=await createSourcePCMBridge({ctx:context(),source,
      sourceSampleRate:48_000,startFrame:10_000});
    const node=nodes[0];
    const nativePost=node.port.postMessage;
    // Mimic actual ownership transfer: every posted PCM buffer is detached.
    node.port.postMessage=(m,transfers=[])=>{
      nativePost.call(node.port,structuredClone(m,{transfer:transfers}));
    };
    const apply=async(a,b,enabled=true)=>{
      const before=node.sent.filter(m=>m.type==="loop-config").length;
      const pending=bridge.setLoopConfiguration(a,b,enabled);
      await waitFor(()=>node.sent.filter(m=>m.type==="loop-config").length>before);
      const msg=node.sent.findLast(m=>m.type==="loop-config");
      node.port.onmessage({data:{type:"command-accepted",requestId:msg.requestId}});
      await pending;
      return msg;
    };
    try{
      const initial=await apply(70_000,180_000);
      const afterInitial=reads.length;
      const changed=await apply(90_000,180_000);
      assert.equal(reads.length-afterInitial,1,"unchanged B must not reread");
      assert.deepEqual(changed.endpoints[1],initial.endpoints[1]);
      const afterChange=reads.length;
      await apply(90_000,180_000,false);
      const reenabled=await apply(90_000,180_000);
      assert.equal(reads.length,afterChange,"same endpoints reuse both retained windows");
      assert.deepEqual(reenabled.endpoints,changed.endpoints);
      assert.ok(reenabled.endpoints.every(w=>w.channels[0].length===8192));
    }finally{bridge.dispose();}
  });
});
