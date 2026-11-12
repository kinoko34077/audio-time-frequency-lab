import test from "node:test";
import assert from "node:assert/strict";
import {createSourceTimeline,validatePlaybackSpeed,validateSpeedRailRange,
        speedOnRail,formatPlaybackSpeed} from "./source-timeline.mjs";

const make=(o={})=>createSourceTimeline({
  sourceFrames:48000,sourceSampleRate:48000,...o
});

test("speed -8..8 and frozen 0 preserve canonical precision",()=>{
  for(const s of [-8,-2,-1,-.001,0,.001,1,2,8])
    assert.equal(validatePlaybackSpeed(s),s);
  for(const bad of [-8.001,8.001,NaN,Infinity,-Infinity,"1",null])
    assert.throws(()=>validatePlaybackSpeed(bad),RangeError);
  assert.equal(validatePlaybackSpeed(-0),0);
  assert.equal(formatPlaybackSpeed(1.237),"1.24");
  assert.equal(formatPlaybackSpeed(1.237,{editing:true}),"1.237");
  assert.equal(formatPlaybackSpeed(-.001),"-0.00");
});

test("rail operating range cannot mutate accepted speed",()=>{
  const t=make({speed:1.237});
  assert.equal(speedOnRail(t.state.speed,1),1);
  assert.equal(t.state.speed,1.237);
  assert.equal(speedOnRail(-8,2),-2);
  for(const range of [1,2,4,8])
    assert.equal(validateSpeedRailRange(range),range);
  assert.equal(validateSpeedRailRange(3),3);
  assert.equal(validateSpeedRailRange(3.75),3.75);
  for(const bad of [0,-1,8.001,NaN,Infinity])
    assert.throws(()=>validateSpeedRailRange(bad),RangeError);
});

test("forward, reverse, and zero source-time advancement",()=>{
  const t=make({startFrame:4,speed:1});
  assert.equal(t.sampleIndexAt(2),6);
  assert.equal(t.advance(3).sourceFrame,7);
  t.setSpeed(-1);
  assert.equal(t.sampleIndexAt(2),5);
  assert.equal(t.advance(2).sourceFrame,5);
  t.setSpeed(0);
  assert.equal(t.sampleIndexAt(8192),5);
  assert.equal(t.advance(8192).sourceFrame,5);
  assert.equal(t.state.revision,2);
});

test("unlooped bounds stop; reverse from EOF starts at last source sample",()=>{
  const t=make({startFrame:48000,speed:-1});
  assert.equal(t.sampleIndexAt(0),47999);
  assert.equal(t.sampleIndexAt(47999),0);
  assert.equal(t.sampleIndexAt(48000),null);
  t.advance(48001);
  assert.equal(t.state.sourceFrame,0);
  const f=make({startFrame:47999,speed:1});
  assert.equal(f.sampleIndexAt(1),null);
  assert.equal(f.advance(2).sourceFrame,48000);
});

test("ordered A/B sample boundaries including one-sample loops",()=>{
  const t=make({speed:8,loopEnabled:true,loopStartFrame:37,loopEndFrame:38});
  for(let i=0;i<256;i++)assert.equal(t.sampleIndexAt(i),37);
  assert.equal(t.advance(128).sourceFrame,37);
  t.setSpeed(-8);
  for(let i=0;i<256;i++)assert.equal(t.sampleIndexAt(i),37);
  for(const [a,b] of [[10,10],[11,10],[-1,10],[1,48001],[1.1,2]])
    assert.throws(()=>t.setLoopBounds(a,b),RangeError);
});

test("128-frame quantum can cross many laps in both directions",()=>{
  const t=make({startFrame:2,loopStartFrame:2,loopEndFrame:5,loopEnabled:true,speed:8});
  assert.deepEqual(Array.from({length:6},(_,i)=>t.sampleIndexAt(i)),[2,4,3,2,4,3]);
  assert.equal(t.advance(128).sourceFrame,3);
  t.setSpeed(-8);
  assert.deepEqual(Array.from({length:6},(_,i)=>t.sampleIndexAt(i)),[3,4,2,3,4,2]);
});

test("fractional reverse wraps within a 129-sample interval without changing endpoints",()=>{
  const t=make({speed:-.001,loopEnabled:true,loopStartFrame:100,loopEndFrame:229,startFrame:100});
  assert.equal(t.sampleIndexAt(0),100);
  assert.equal(t.sampleIndexAt(1),228);
  t.advance(129);
  assert.ok(t.state.sourceFrame>=100&&t.state.sourceFrame<229);
  assert.deepEqual([t.state.loopStartFrame,t.state.loopEndFrame],[100,229]);
});

test("no-op commands and render clock never send a new revision",()=>{
  const t=make();
  t.setSpeed(1);t.seek(0);t.setLoopEnabled(false);t.setLoopBounds(0,48000);
  t.advance(128);
  assert.equal(t.state.revision,0);
  t.setSpeed(1.237);assert.equal(t.state.revision,1);
  t.setLoopBounds(16,127);assert.equal(t.state.revision,2);
  t.setLoopEnabled(true);assert.equal(t.state.revision,3);
  t.seek(500);assert.equal(t.state.sourceFrame,16);
  // The effective position was already 16, so this seek is a no-op.
  assert.equal(t.state.revision,3);
  t.seek(50);assert.equal(t.state.sourceFrame,50);
  assert.equal(t.state.revision,4);
  t.seek(500);assert.equal(t.state.sourceFrame,16);
  assert.equal(t.state.revision,5);
  t.seek(500);assert.equal(t.state.revision,5);
});

test("source/sample rate conversion and malformed inputs",()=>{
  const t=createSourceTimeline({sourceFrames:48000,sourceSampleRate:48000,
    outputSampleRate:44100,speed:1});
  assert.ok(Math.abs(t.sourceFrameAt(441)-480)<1e-9);
  assert.ok(Math.abs(t.advance(441).sourceFrame-480)<1e-9);
  assert.throws(()=>make({sourceFrames:0}),RangeError);
  assert.throws(()=>make({loopStartFrame:2,loopEndFrame:2}),RangeError);
  assert.throws(()=>make({speed:9}),RangeError);
  assert.throws(()=>t.advance(-1),RangeError);
  assert.throws(()=>t.seek(.5),RangeError);
  assert.throws(()=>t.sourceFrameAt(NaN),RangeError);
});
