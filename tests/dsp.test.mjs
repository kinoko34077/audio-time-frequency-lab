import test from 'node:test';import assert from 'node:assert/strict';import {renderPCM,wav16} from '../dsp.mjs';
const sr=16000,L=16000,sine=f=>Float32Array.from({length:L},(_,i)=>.4*Math.sin(2*Math.PI*f*i/sr));
function peakFreq(a){let start=Math.floor(a.length*.2),count=Math.min(3500,a.length-start-10),best=-1,freq=0;for(let f=180;f<=1000;f++){let re=0,im=0;for(let i=0;i<count;i++){let p=2*Math.PI*f*i/sr;re+=a[start+i]*Math.cos(p);im-=a[start+i]*Math.sin(p);}let e=re*re+im*im;if(e>best){best=e;freq=f;}}return freq;}
for(let model of ['pv','wsola','dual','am']){
test(model+': independent time stretch',()=>{let a=renderPCM({channels:[sine(440)],sampleRate:sr,model,speed:1.5,semitones:0});assert.ok(Math.abs(a.channels[0].length-sr/1.5)<=1);assert.ok(Math.abs(peakFreq(a.channels[0])-440)<18);});
test(model+': independent pitch shift',()=>{let a=renderPCM({channels:[sine(440)],sampleRate:sr,model,speed:1,semitones:12});assert.equal(a.channels[0].length,L);assert.ok(Math.abs(peakFreq(a.channels[0])-880)<22);});
test(model+': neutral stereo is exact',()=>{let s=sine(440),b=renderPCM({channels:[s,s],sampleRate:sr,model});assert.deepEqual(b.channels[0],s);assert.deepEqual(b.channels[1],s);});
test(model+': impulse stereo finite',()=>{let a=new Float32Array(L);a[2000]=.8;let b=renderPCM({channels:[a,Float32Array.from(a,x=>-x)],sampleRate:sr,model,speed:.8});assert.equal(b.channels.length,2);assert.ok(b.channels.every(x=>x.every(Number.isFinite)));});
}
test('WAV 16-bit channel and rate',()=>{let a=wav16({channels:[sine(440),sine(220)],sampleRate:sr}),v=new DataView(a);assert.equal(v.getUint16(22,true),2);assert.equal(v.getUint32(24,true),sr);assert.equal(v.getUint32(40,true),L*4);});
test('invalid model and channel counts rejected',()=>{assert.throws(()=>renderPCM({channels:[],sampleRate:sr}),/音声/);assert.throws(()=>renderPCM({channels:[sine(440)],sampleRate:sr,model:'not-present'}),/未知/);});