import test from "node:test";
import assert from "node:assert/strict";
import {scrubSpeed,releaseScrubSpeed,returnToPlaySpeed} from "../web-demo/scrub-kinetics.mjs";

test("source-frame movement sets signed speed and stationary hold is 0x",()=>{
  assert.equal(scrubSpeed(1000,2000,100,1000),8); // physical rate capped at +8
  assert.equal(scrubSpeed(2000,1000,100,1000),-8);
  assert.equal(scrubSpeed(1000,1000,100,48000),0);
  assert.equal(scrubSpeed(1000,1240,20,48000),.25);
  assert.equal(scrubSpeed(1000,500,0,48000),0);
});
test("only deliberate recent throws retain momentum",()=>{
  assert.equal(releaseScrubSpeed(-3,30),-3);
  assert.equal(releaseScrubSpeed(2,150),0);
  assert.equal(releaseScrubSpeed(.1,10),0);
});
test("kinetic release blends from reverse/forward to canonical speed without overwriting it",()=>{
  assert.equal(returnToPlaySpeed(-5,1.237,0),-5);
  assert.ok(returnToPlaySpeed(-5,1.237,200)<1.237);
  assert.equal(returnToPlaySpeed(-5,1.237,480),1.237);
  assert.equal(returnToPlaySpeed(5,-1,480),-1);
  assert.equal(returnToPlaySpeed(5,0,600),0);
  assert.throws(()=>returnToPlaySpeed(1,2,4,0),RangeError);
});
