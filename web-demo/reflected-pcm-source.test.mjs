import test from "node:test";
import assert from "node:assert/strict";
import {createReflectedPCMSource} from "./reflected-pcm-source.mjs";
import {createSourceTimeline} from "./source-timeline.mjs";

const pcm=()=>[Float32Array.of(99,10,20,30,40,88),Float32Array.of(-99,-10,-20,-30,-40,-88)];
test("virtual ping-pong period excludes duplicate endpoints and retains stereo",async()=>{
  const channels=pcm(),r=createReflectedPCMSource({channels,startFrame:1,endFrame:5});
  assert.equal(r.sourceFrames,6);assert.equal(r.channelCount,2);
  const whole=await r.read(0,6);
  assert.equal(whole.startFrame,0);
  assert.deepEqual(Array.from(whole.channels[0]),[10,20,30,40,30,20]);
  assert.deepEqual(Array.from(whole.channels[1]),[-10,-20,-30,-40,-30,-20]);
  const a=await r.read(0,2),b=await r.read(2,4);
  assert.deepEqual([...a.channels[0],...b.channels[0]],Array.from(whole.channels[0]));
  whole.channels[0][0]=0;assert.equal(channels[0][1],10);
  assert.equal((await r.read(0,1)).channels[0][0],10);
});
test("mapping composes with canonical clock for signed and fractional speed",()=>{
  const r=createReflectedPCMSource({channels:pcm(),startFrame:1,endFrame:5});
  for(const speed of [1,-1,0.5,-2,8]){
    const t=createSourceTimeline({sourceFrames:r.sourceFrames,sourceSampleRate:48000,
      startFrame:0,speed,loopEnabled:true});
    const expected=p=>{const q=((p%6)+6)%6;return [1,2,3,4,3,2,1][Math.floor(q)]+([1,2,3,4,3,2,1][Math.floor(q)+1]-[1,2,3,4,3,2,1][Math.floor(q)])*(q-Math.floor(q));};
    for(let n=0;n<40;n++){
      assert.equal(r.toSourceFrame(t.sourceFrameAt(0)),expected(n*speed));
      t.advance(1);
    }
  }
  assert.equal(r.toSourceFrame(-.5),1.5);
  assert.equal(r.toVirtualFrame(2.5,{returning:true}),4.5);
  assert.equal(r.toSourceFrame(r.toVirtualFrame(2.5,{returning:true})),2.5);
  assert.equal(r.isReturning(4.5),true);assert.equal(r.isReturning(1.5),false);
});
test("one-frame and two-frame intervals, rejected bounds and read requests",async()=>{
  const r=createReflectedPCMSource({channels:pcm(),startFrame:2,endFrame:3});
  assert.equal(r.sourceFrames,1);assert.equal(r.toSourceFrame(-100.25),2);
  assert.deepEqual(Array.from((await r.read(0,1)).channels[0]),[20]);
  const two=createReflectedPCMSource({channels:pcm(),startFrame:2,endFrame:4});
  assert.deepEqual(Array.from((await two.read(0,2)).channels[0]),[20,30]);
  assert.throws(()=>createReflectedPCMSource({channels:pcm(),startFrame:3,endFrame:3}));
  assert.throws(()=>r.toSourceFrame(NaN));assert.throws(()=>r.toVirtualFrame(1));
  await assert.rejects(r.read(1,1));await assert.rejects(r.read(0,2));
});
