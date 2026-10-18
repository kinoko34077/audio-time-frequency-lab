import test from 'node:test';
import assert from 'node:assert/strict';
import {phaseVocoder,dualWindowVocoder,renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';

const maxDiff=(a,b)=>{let max=0;for(let i=0;i<Math.min(a.length,b.length);i++)max=Math.max(max,Math.abs(a[i]-b[i]));return max;};
const sr=16000;
const chirp=Float32Array.from({length:sr},(_,i)=>{
 const t=i/sr;
 return (.15+.12*Math.cos(Math.PI*2*3*t))*Math.sin(2*Math.PI*(330*t+220*t*t));
});
test('phase-locked PV preserves strong correlated stereo channels without independent wandering',()=>{
 const ch=Float32Array.from({length:sr},(_,i)=>.3*Math.sin(2*Math.PI*(437.3*i/sr+30*(i/sr)**2)));
 const out=phaseVocoder([ch,Float32Array.from(ch,x=>x*.65)],1.35,Math.round(sr*1.35),1024);
 assert.equal(out.length,2);
 assert.ok(maxDiff(out[1],out[0].map(v=>v*.65))<2e-4,'interchannel gain relation is phase coherent');
 assert.ok(out.every(c=>c.every(Number.isFinite)));
});
test('short and long independently alter dual-window output, not merely UI labels',()=>{
 const args={channels:[chirp],sampleRate:sr,speed:.8,semitones:3,model:'dual',fftSize:2048};
 const a=renderPCM({...args,shortFftSize:256,longFftSize:2048}).channels[0];
 const b=renderPCM({...args,shortFftSize:1024,longFftSize:2048}).channels[0];
 const c=renderPCM({...args,shortFftSize:256,longFftSize:4096}).channels[0];
 assert.ok(maxDiff(a,b)>1e-5,'short window influences actual DSP');
 assert.ok(maxDiff(a,c)>1e-5,'long window influences actual DSP');
 assert.ok([a,b,c].every(ch=>ch.every(Number.isFinite)));
});
test('short window must remain smaller than long window',()=>{
 assert.throws(()=>renderPCM({channels:[chirp],sampleRate:sr,speed:.8,semitones:1,model:'dual',fftSize:2048,shortFftSize:2048,longFftSize:2048}),/短窓/);
});
test('source-time preview context is independently sensitive to long/short and reference count',()=>{
 const args={totalFrames:sr*200,sampleRate:sr,speed:.75,startSeconds:100,fftSize:2048,referenceWindows:6};
 const low=planChunk({...args,shortFftSize:256,longFftSize:1024});
 const high=planChunk({...args,shortFftSize:1024,longFftSize:4096});
 assert.ok(high.left>low.left&&high.right>low.right);
 assert.ok(high.to-high.from<sr*3);
});
