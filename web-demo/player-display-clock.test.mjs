import test from "node:test";
import assert from "node:assert/strict";
import {displaySourceFrameFromProgress as position,MAX_DISPLAY_LEAD_SECONDS} from "./player-display-clock.mjs";
const base={sourceFrame:1000,revision:4,speed:1,outputTime:10,running:true,
  ended:false,loopEnabled:false,loopStartFrame:0,loopEndFrame:48000};
const opts={sourceRate:48000,sourceFrames:48000};
const value=(p,at)=>position(p,{...opts,audioTime:at});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,
  `display frame ${actual} is not within one-millionth sample of ${expected}`);

test("display-only PCM head interpolates between sparse real audio reports",()=>{
  assert.equal(value(base,10),1000);
  near(value(base,10.016),1768);
  assert.equal(value(base,9.9),1000,"never extrapolate into past");
  near(value(base,10.5),1000+48000*MAX_DISPLAY_LEAD_SECONDS);

});
test("reverse, 0x, pause and exhausted source retain real transport semantics",()=>{
  near(value({...base,speed:-2},10.005),520);
  assert.equal(value({...base,speed:0},10.021),1000);
  assert.equal(value({...base,running:false},10.021),1000);
  assert.equal(value({...base,ended:true},10.021),1000);
  assert.equal(value({...base,sourceFrame:47990,speed:8},10.016),48000);
  assert.equal(value({...base,sourceFrame:10,speed:-8},10.016),0);
});
test("forward/reverse A/B wrap, even for a 1-sample loop",()=>{
  const loop={...base,loopEnabled:true,loopStartFrame:100,loopEndFrame:200,
    sourceFrame:195,speed:1};
  near(value(loop,10.010),175);
  near(value({...loop,sourceFrame:105,speed:-1},10.010),125);
  assert.equal(value({...loop,loopStartFrame:117,loopEndFrame:118,
    sourceFrame:117,speed:-8},10.020),117);
});
test("old/missing timing metadata gives exact authoritative report, never guessed time",()=>{
  assert.equal(value({...base,outputTime:null},10.05),1000);
  assert.equal(value({...base,speed:null},10.05),1000);
  assert.equal(value(null,10.05),null);
  assert.throws(()=>position(base,{...opts,sourceFrames:0,audioTime:10}),/invalid/);
});
