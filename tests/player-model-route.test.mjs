import test from "node:test";
import assert from "node:assert/strict";
import {MODEL_IDS,MODEL_LABELS,isContinuousPCMModel,primaryModelCapability} from "../web-demo/model-route.mjs";

test("selected engine has explicit source-time and A/B capabilities, not Granular disguise",()=>{
  assert.deepEqual(MODEL_IDS,["spectral","granular","live","pv","wsola","dual","am"]);
  for(const speed of [-8,-1.125,0,1,7.25,8]){
    for(const model of ["spectral","granular","live","pv","wsola","dual","am"]){
      const cap=primaryModelCapability(model,speed);
      assert.equal(cap.supported,true);
      assert.equal(cap.signed,true);assert.equal(cap.sampleAB,true);
    }
  }
  for(const model of ["pv","wsola","dual","am"]){
    for(const speed of [-8,-1,0,.499,2.001,8]){
      const cap=primaryModelCapability(model,speed,{individual:true});
      assert.equal(cap.supported,false);
      assert.match(cap.reason,/未対応/);
      // A/B belongs to the legacy Worker route; speed support is checked separately.
      assert.equal(cap.sampleAB,true);
      assert.equal(cap.signed,false);
    }
    for(const speed of [.5,1,1.237,2]){
      const cap=primaryModelCapability(model,speed,{individual:true});
      assert.equal(cap.supported,true);
      assert.equal(cap.sampleAB,true);
    }
  }
  assert.equal(primaryModelCapability("spectral",0).realtime,true);
  assert.equal(primaryModelCapability("live",1).realtime,true);
  assert.equal(primaryModelCapability("live",0).sampleAB,true);
  assert.equal(primaryModelCapability("live",-8).signed,true);
  assert.equal(primaryModelCapability("live",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("live",1,{individual:true}).sampleAB,false);
  assert.equal(primaryModelCapability("pv",1).realtime,true);
  assert.equal(primaryModelCapability("pv",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("pv",0,{individual:true}).realtime,false);
  assert.equal(primaryModelCapability("pv",1,{individual:true}).supported,true);
  assert.equal(primaryModelCapability("pv",1,{individual:true}).sampleAB,true);
  assert.equal(primaryModelCapability("wsola",0).realtime,true);
  assert.equal(primaryModelCapability("wsola",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("wsola",1,{individual:true}).sampleAB,true);
  assert.equal(primaryModelCapability("dual",0).realtime,true);
  assert.equal(primaryModelCapability("dual",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("dual",1,{individual:true}).sampleAB,true);
  assert.equal(primaryModelCapability("am",0).realtime,true);
  assert.equal(primaryModelCapability("am",-1).sampleAB,true);
  assert.equal(primaryModelCapability("am",0,{individual:true}).supported,false);
  assert.equal(primaryModelCapability("am",1,{individual:true}).sampleAB,true);
  assert.throws(()=>primaryModelCapability("wrong",1),RangeError);
  assert.throws(()=>primaryModelCapability("live",9),RangeError);
});

test("canonical model metadata keeps labels, PCM route membership, and legacy capabilities aligned",()=>{
  const labels=[
    ["spectral","STFT"],["granular","Granular"],["live","Rust/WASM"],
    ["pv","PV"],["wsola","WSOLA"],["dual","Dual"],["am","AM"]
  ];
  assert.deepEqual(MODEL_IDS,labels.map(([id])=>id));
  assert.deepEqual(MODEL_LABELS,Object.fromEntries(labels));
  for(const [mode] of labels){
    assert.equal(isContinuousPCMModel(mode),true,mode);
    assert.equal(isContinuousPCMModel(mode,{individual:true}),
      mode==="spectral"||mode==="granular",mode);
    for(const individual of [false,true]){
      const cap=primaryModelCapability(mode,1,{individual});
      assert.equal(cap.signed,isContinuousPCMModel(mode,{individual}),mode);
      assert.equal(cap.zeroAudible,cap.signed,mode);
      assert.equal(cap.sampleAB,cap.signed||mode!=="live",mode);
    }
  }
  // These are real renderer identifiers, not user-selectable DSP models.
  for(const mode of ["raw","worker","unknown","__proto__"]){
    assert.equal(isContinuousPCMModel(mode),false,mode);
  }
});
