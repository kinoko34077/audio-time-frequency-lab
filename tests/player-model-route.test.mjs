import test from "node:test";
import assert from "node:assert/strict";
import {MODEL_IDS,primaryModelCapability} from "../web-demo/model-route.mjs";

test("selected engine has explicit source-time and A/B capabilities, not Granular disguise",()=>{
  assert.deepEqual(MODEL_IDS,["granular","live","pv","wsola","dual","am"]);
  for(const speed of [-8,-1.125,0,1,7.25,8]){
    const cap=primaryModelCapability("granular",speed);
    assert.equal(cap.supported,true);
    assert.equal(cap.signed,true);assert.equal(cap.sampleAB,true);
  }
  for(const model of MODEL_IDS.filter(x=>x!=="granular")){
    for(const speed of [-8,-1,0,.499,2.001,8]){
      const cap=primaryModelCapability(model,speed);
      assert.equal(cap.supported,false);
      assert.match(cap.reason,/未対応/);
      assert.equal(cap.sampleAB,false);
      assert.equal(cap.signed,false);
    }
    for(const speed of [.5,1,1.237,2])
      assert.equal(primaryModelCapability(model,speed).supported,true);
  }
  assert.equal(primaryModelCapability("live",1).realtime,true);
  assert.equal(primaryModelCapability("pv",1).realtime,false);
  assert.throws(()=>primaryModelCapability("wrong",1),RangeError);
  assert.throws(()=>primaryModelCapability("live",9),RangeError);
});
