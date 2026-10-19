import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MODELS,renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
const sr=16000;
const tone=Float32Array.from({length:sr},(_,i)=>.3*Math.sin(2*Math.PI*440.4*i/sr));
const base={channels:[tone],sampleRate:sr,speed:.8,semitones:3};
test('opt-in joint model is distinct from existing dual and processed on actual render path',()=>{
 assert.ok(MODELS.some(m=>m.id==='period-joint'));
 const own=renderPCM({...base,model:'period-joint'});
 const dual=renderPCM({...base,model:'dual',shortFftSize:512,longFftSize:2048});
 assert.equal(own.channels[0].length,dual.channels[0].length);
 assert.ok(own.channels[0].every(Number.isFinite));
 assert.ok(own.channels[0].some((v,i)=>Math.abs(v-dual.channels[0][i])>1e-4));
});
test('checkbox has exact label/default OFF and selects experimental branch of playback',()=>{
 const html=readFileSync(new URL('index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
 assert.match(html,/<input id="lab-individual-periods" type="checkbox"/);
 assert.match(html,/周波数ごとの個別波長/);
 assert.doesNotMatch(html,/<input id="lab-individual-periods"[^>]*checked/);
 assert.match(app,/const nextIndividual=labIndividual.checked/);
 assert.match(app,/jointBackend:lab.individual\?lab.mode:null/);
 assert.match(app,/labModel.disabled=false/);
});
test('opted-in mixed tone renders rather than refusing the requested audio',()=>{
 const other=Float32Array.from(tone,(v,i)=>v+.3*Math.cos(2*Math.PI*660*i/sr));
 const rendered=renderPCM({...base,channels:[other],model:'period-joint'});
 assert.equal(rendered.channels[0].length,Math.round(sr/base.speed));
 assert.ok(rendered.channels[0].every(Number.isFinite));
 assert.ok(rendered.channels[0].some(v=>Math.abs(v)>.01));
});

test('real preview plan crops preserve stationary phase across adjacent source chunks',()=>{
 const duration=sr*4,f=440.4,speed=.75;
 const source=Float32Array.from({length:duration},(_,i)=>.25*Math.cos(2*Math.PI*f*i/sr+.25));
 function central(startSeconds){
  const plan=planChunk({totalFrames:duration,sampleRate:sr,speed,startSeconds,
   model:'period-joint',fftSize:2048,shortFftSize:512,longFftSize:2048,referenceWindows:8});
  const cropped=source.slice(plan.from,plan.to);
  const result=renderPCM({channels:[cropped],sampleRate:sr,speed,semitones:0,
   model:'period-joint',sourceStartSeconds:plan.from/sr});
  return result.channels[0].subarray(plan.outputStart,plan.outputStart+plan.coreFrames);
 }
 const first=central(0),second=central(1.5);
 assert.ok(first.length>0&&second.length>0);
 assert.ok(Math.abs(first[first.length-1]-second[0])<.07,'chunk seam should not reset stationary oscillator');
});
