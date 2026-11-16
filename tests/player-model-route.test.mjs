import test from "node:test";
import assert from "node:assert/strict";
import {MODEL_IDS,primaryModelCapability} from "../web-demo/model-route.mjs";

test("selected engine has explicit source-time and A/B capabilities, not Granular disguise",()=>{
  assert.deepEqual(MODEL_IDS,["spectral","granular","live","pv","wsola","dual","am"]);
  for(const speed of [-8,-1.125,0,1,7.25,8]){
    for(const model of ["spectral","granular","pv","wsola","dual","am"]){
      const cap=primaryModelCapability(model,speed);
      assert.equal(cap.supported,true);
      assert.equal(cap.signed,true);assert.equal(cap.sampleAB,true);
    }
  }
  for(const model of MODEL_IDS.filter(x=>!["spectral","granular","pv","wsola","dual","am"].includes(x))){
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
  assert.equal(primaryModelCapability("spectral",0).realtime,true);
  assert.equal(primaryModelCapability("live",1).realtime,true);
  assert.equal(primaryModelCapability("pv",1).realtime,true);
  assert.equal(primaryModelCapability("pv",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("pv",0,{individual:true}).realtime,false);
  assert.equal(primaryModelCapability("pv",1,{individual:true}).supported,true);
  assert.equal(primaryModelCapability("pv",1,{individual:true}).sampleAB,false);
  assert.equal(primaryModelCapability("wsola",0).realtime,true);
  assert.equal(primaryModelCapability("wsola",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("wsola",1,{individual:true}).sampleAB,false);
  assert.equal(primaryModelCapability("dual",0).realtime,true);
  assert.equal(primaryModelCapability("dual",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("dual",1,{individual:true}).sampleAB,false);
  assert.equal(primaryModelCapability("am",0).realtime,true);
  assert.equal(primaryModelCapability("am",-1).sampleAB,true);
  assert.equal(primaryModelCapability("am",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("am",1,{individual:true}).sampleAB,false);
  assert.throws(()=>primaryModelCapability("wrong",1),RangeError);
  assert.throws(()=>primaryModelCapability("live",9),RangeError);
});
