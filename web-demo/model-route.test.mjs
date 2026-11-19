import test from 'node:test';
import assert from 'node:assert/strict';
import {primaryModelCapability} from './model-route.mjs';

test('legacy Worker models expose source-frame A/B without claiming signed, zero, or immediate scrub support',()=>{
  for(const mode of ['pv','wsola','dual','am']){
    const capability=primaryModelCapability(mode,1,{individual:true});
    assert.equal(capability.supported,true,mode);
    assert.equal(capability.sampleAB,true,mode);
    assert.equal(capability.signed,false,mode);
    assert.equal(capability.zeroAudible,false,mode);
  }
  const liveIndividual=primaryModelCapability('live',1,{individual:true});
  assert.equal(liveIndividual.sampleAB,false);
});
