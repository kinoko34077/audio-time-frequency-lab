import test from "node:test";
import assert from "node:assert/strict";
import {scaleScrubInertia} from "./scrub-kinetics.mjs";

test("scrub inertia scales throw speed and keeps transport within signed limits",()=>{
  assert.equal(scaleScrubInertia(4,0),0);
  assert.equal(scaleScrubInertia(2,1),2);
  assert.equal(scaleScrubInertia(-3,1.5),-4.5);
  assert.equal(scaleScrubInertia(7,2),8);
  assert.equal(scaleScrubInertia(-7,2),-8);
});
