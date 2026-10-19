import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
import {readFileSync} from 'node:fs';
const sampleRate=16000;
const tone=Float32Array.from({length:Math.round(sampleRate*1.4)},(_,i)=>{
 const t=i/sampleRate;
 const base=.19*Math.sin(2*Math.PI*310.4*t+.2);
 const added=t<.64?0:.18*Math.min(1,(t-.64)/.03)*Math.sin(2*Math.PI*515.7*(t-.64));
 const transient=t>.95&&t<.972?.12*Math.cos((t-.95)*2400):0;
 return base+added+transient+.035*Math.sin(i*2.2);
});
const params={channels:[tone],sampleRate,speed:.8,semitones:3,model:'period-joint',periodCycles:2};
const backend=['pv','wsola','dual','am'];
const rms=(samples,a,b)=>{const start=Math.floor(a*sampleRate),end=Math.min(samples.length,Math.floor(b*sampleRate));let e=0;for(let i=start;i<end;i++)e+=samples[i]*samples[i];return Math.sqrt(e/Math.max(1,end-start));};
test('all four residual engines are actually composable with the joint frequency-specific tonal model',()=>{
 const outputs=new Map();
 for(const jointBackend of backend){
  const rendered=renderPCM({...params,jointBackend,shortFftSize:512,longFftSize:2048});
  assert.equal(rendered.channels[0].length,Math.round(tone.length/.8),jointBackend);
  assert.ok(rendered.channels[0].every(Number.isFinite),jointBackend);
  assert.ok(rms(rendered.channels[0],.87,1.24)>.015,jointBackend+' lost late sound');
  outputs.set(jointBackend,rendered.channels[0]);
 }
 for(const [a,b] of [['pv','wsola'],['pv','dual'],['pv','am']]){
  const left=outputs.get(a),right=outputs.get(b);let delta=0;
  for(let i=0;i<left.length;i+=16)delta+=(left[i]-right[i])**2;
  assert.ok(delta>1e-5,'selected '+a+'/'+b+' did not affect actual output');
 }
});
test('Rust backend is rejected, not silently swapped to PV under Rust label',()=>{
 assert.throws(()=>renderPCM({...params,jointBackend:'live'}),/Rust\/WASMリアルタイムは未対応/);
 assert.throws(()=>renderPCM({...params,jointBackend:'period-joint'}),/個別波長の残差モデル/);
});
test('existing direct period-joint default and all non-joint modes remain bit-identical',()=>{
 const legacy=renderPCM({...params});
 const explicit=renderPCM({...params,jointBackend:null});
 assert.deepEqual(legacy.channels[0],explicit.channels[0]);
 for(const mode of backend){
  const cfg={channels:[tone],sampleRate,speed:.8,semitones:3,model:mode};
  assert.deepEqual(renderPCM(cfg).channels[0],renderPCM({...cfg,jointBackend:'am',periodCycles:.5}).channels[0],mode+' OFF modified');
 }
});
test('actual selected backend FFT/grain sizes impact joint residual audio where enabled',()=>{
 const a=renderPCM({...params,jointBackend:'wsola',shortFftSize:256});
 const b=renderPCM({...params,jointBackend:'wsola',shortFftSize:1024});
 let difference=0;for(let i=0;i<a.channels[0].length;i+=20)difference+=Math.abs(a.channels[0][i]-b.channels[0][i]);
 assert.ok(difference>.01,'WSOLA short grain slider is inert in combined mode');
});
test('combined source context derives from active backend without hidden referenceWindows influence',()=>{
 const common={totalFrames:sampleRate*5,sampleRate,speed:.8,startSeconds:2,model:'period-joint',shortFftSize:512,longFftSize:4096};
 const a=planChunk({...common,jointBackend:'dual',referenceWindows:2});
 const b=planChunk({...common,jointBackend:'dual',referenceWindows:16});
 assert.deepEqual([a.from,a.to,a.outputStart],[b.from,b.to,b.outputStart]);
 assert.ok(a.left>Math.round(sampleRate*.12),'large dual FFT needs context');
 const c=planChunk({...common,jointBackend:null,referenceWindows:2});
 assert.equal(c.left,Math.ceil(sampleRate*.12),'old standalone joint context preserved');
});
test('UI model selection and worker handoff are separated from individual checkbox',()=>{
 const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
 const worker=readFileSync(new URL('lab-processor.worker.mjs',import.meta.url),'utf8');
 assert.match(app,/labModel.disabled=false/);
 assert.match(app,/const nextIndividual=labIndividual.checked/);
 assert.match(app,/jointBackend:lab.individual\?lab.mode:null/);
 assert.match(worker,/sourceStartSeconds:plan.from\/sampleRate,periodCycles,jointBackend/);
});
