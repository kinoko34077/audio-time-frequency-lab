import test from 'node:test';
import assert from 'node:assert/strict';
import {toSourceSeconds,fromSourceSeconds} from '../timeline.mjs';
for(const speed of [0.5,0.75,1,1.5,2])test('same original time at '+speed+'x',()=>{
  const sourceTime=8,processedTime=fromSourceSeconds(sourceTime,true,speed);
  assert.equal(toSourceSeconds(processedTime,true,speed),sourceTime);
  assert.equal(fromSourceSeconds(sourceTime,false,speed),sourceTime);
  assert.equal(toSourceSeconds(4,true,speed),4*speed);
});
test('bad speed cannot silently corrupt comparisons',()=>{
 assert.throws(()=>toSourceSeconds(3,true,NaN),RangeError);
 assert.throws(()=>fromSourceSeconds(8,true,0),RangeError);
});