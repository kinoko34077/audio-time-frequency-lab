import test from "node:test";
import assert from "node:assert/strict";
import {displaySourceFrame} from "../web-demo/playhead-interpolation.mjs";
const rounded=(...args)=>{const f=displaySourceFrame(...args);return f===null?null:Math.round(f);};

test("display interpolation follows audio-clock progress for forward/0/reverse",()=>{
  const base={sourceFrame:12000,renderTime:4,ended:false,
    loopEnabled:false,speed:1};
  assert.equal(rounded(base,4.016,100000,48000),12768);
  assert.equal(rounded({...base,speed:0},4.016,100000,48000),12000);
  assert.equal(rounded({...base,speed:-1},4.016,100000,48000),11232);
  assert.equal(rounded({...base,speed:-8},4.016,100000,48000),5856);
  assert.equal(rounded(base,3.99,100000,48000),12000);
  assert.equal(rounded(base,4.5,100000,48000),14400,
    "a stalled UI must never extrapolate beyond 50ms");
  assert.equal(rounded({...base,ended:true},4.03,100000,48000),12000);
});

test("display projection handles A/B phase wrap, reverse and end-of-file",()=>{
  const p={sourceFrame:108,renderTime:1,speed:1,
    loopStartFrame:100,loopEndFrame:110,loopEnabled:true};
  assert.equal(rounded(p,1.000125,500,48000),104);
  assert.equal(rounded({...p,sourceFrame:102,speed:-1},
    1.000125,500,48000),106);
  assert.equal(rounded({...p,sourceFrame:105,speed:0},
    1.25,500,48000),105);
  assert.equal(rounded({...p,loopEnabled:false,sourceFrame:499},
    1.02,500,48000),499);
  assert.equal(rounded({...p,loopEnabled:false,sourceFrame:0,speed:-1},
    1.02,500,48000),0);
});

test("display projection is passive when progress lacks valid audio timestamp",()=>{
  const baseline={sourceFrame:234,renderTime:null,speed:1,ended:false};
  assert.equal(rounded(baseline,2,500,48000),234);
  assert.equal(rounded({...baseline,renderTime:NaN},2,500,48000),234);
  assert.equal(rounded(null,2,500,48000),null);
  assert.equal(rounded({...baseline,sourceFrame:NaN},2,500,48000),null);
  assert.equal(rounded(baseline,2,0,48000),null);
});