import test from "node:test";
import assert from "node:assert/strict";
import {scaleScrubInertia,scrubReturnDuration,returnToPlaySpeed} from "./scrub-kinetics.mjs";

test("scrub inertia scales throw speed and keeps transport within signed limits",()=>{
  assert.equal(scaleScrubInertia(4,0),0);
  assert.equal(scaleScrubInertia(2,1),2);
  assert.equal(scaleScrubInertia(-3,1.5),-4.5);
  assert.equal(scaleScrubInertia(7,2),8);
  assert.equal(scaleScrubInertia(-7,2),-8);
});

test("inertia baseline and maximum extend signed throw even when speed saturates",()=>{
  assert.equal(scrubReturnDuration(0,3),1000);
  assert.equal(scrubReturnDuration(4,0),1000);
  assert.equal(scrubReturnDuration(2,1),2000);
  assert.equal(scrubReturnDuration(-3,1.5),2500);
  assert.equal(scrubReturnDuration(-8,3),4000);
  for(const sign of [-1,1]){
    for(const strength of [1,3]){
      const from=scaleScrubInertia(sign*7,strength);
      const duration=scrubReturnDuration(from,strength);
      const old=1000;
      const distance=(time)=>Math.abs((from-0)*time/4000);
      assert.equal(distance(duration)/distance(old),1+strength);
      assert.ok(Math.abs(returnToPlaySpeed(from,0,1000,duration))>0);
      assert.equal(returnToPlaySpeed(from,0,duration,duration),0);
      assert.ok(Math.abs(returnToPlaySpeed(from,sign,500,duration))<=8);
    }
  }
  assert.equal(returnToPlaySpeed(-8,1,4000,scrubReturnDuration(-8,3)),1);
  assert.throws(()=>scrubReturnDuration(NaN,1),RangeError);
});
