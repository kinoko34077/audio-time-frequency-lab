import test from "node:test";
import assert from "node:assert/strict";
import {toggleSourceMarker,nearestMarkerLoop,shiftLoopToFrame} from "./player-ab-markers.mjs";

test("Mark removes a marker at the current source sample and never duplicates it",()=>{
  assert.deepEqual(toggleSourceMarker([120,480],120),[480]);
  assert.deepEqual(toggleSourceMarker([120],121),[120,121],
    "adjacent source samples remain available for a one-sample interval");
  assert.deepEqual(toggleSourceMarker([120,120],120),[]);
  assert.deepEqual(toggleSourceMarker([],120),[120]);
});

test("Loop selects the adjacent marked interval around the current source frame",()=>{
  assert.deepEqual(nearestMarkerLoop([900,100,600,300,600],450,1000),
    {a:300,b:600});
  assert.deepEqual(nearestMarkerLoop([100,600],40,1000),{a:100,b:600});
  assert.deepEqual(nearestMarkerLoop([100,600],900,1000),{a:100,b:600});
  assert.equal(nearestMarkerLoop([100],500,1000),null);
});

test("double-tap loop shift preserves its length and clamps at source edges",()=>{
  assert.deepEqual(shiftLoopToFrame({a:300,b:600},"a",800,1000),
    {a:700,b:1000});
  assert.deepEqual(shiftLoopToFrame({a:300,b:600},"b",100,1000),
    {a:0,b:300});
});
