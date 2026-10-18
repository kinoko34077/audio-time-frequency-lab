import test from 'node:test';
import assert from 'node:assert/strict';
import {liveFactors,sourcePosition} from './lab-contract.mjs';
for(const speed of [.5,.75,1,1.5,2])for(const semitones of [-12,-7,0,5,12]){
 test('live independent speed/pitch factors '+speed+'/'+semitones,()=>{
   const f=liveFactors(speed,semitones);
   assert.ok(Math.abs(f.sourceRate*f.spectralRatio-f.targetPitchRatio)<1e-10);
   assert.ok(Math.abs(10/f.sourceRate-10/speed)<1e-10);
   assert.ok(Math.abs(sourcePosition(5,3,speed)-(5+3*speed))<1e-10);
 });
}
test('invalid independent factors rejected',()=>{
 assert.throws(()=>liveFactors(0,0),RangeError);
 assert.throws(()=>liveFactors(1,13),RangeError);
});
