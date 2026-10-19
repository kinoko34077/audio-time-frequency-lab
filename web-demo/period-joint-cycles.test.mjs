import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PERIOD_K,PERIOD_CYCLE_CHOICES,theoreticalWindow,sampleInterval} from './period-joint.mjs';
import {estimateSharedPartials} from './period-joint-multi.mjs';
import {renderPCM} from './lab-dsp.mjs';

const sr=16000, duration=1.25;
function changingSignal(){
 return Float32Array.from({length:Math.round(duration*sr)},(_,i)=>{
  const t=i/sr,f=t<.52?237.6:312.4;
  return .22*Math.cos(2*Math.PI*f*t+.3)+.07*Math.cos(2*Math.PI*713.8*t+.5);
 });
}
test('seven exact selectable half/double periods use mathematically consistent window support',()=>{
 assert.equal(PERIOD_K,8);
 assert.deepEqual(PERIOD_CYCLE_CHOICES,[.5,1,2,4,8,16,32]);
 for(const k of PERIOD_CYCLE_CHOICES){
  assert.ok(Math.abs(theoreticalWindow(437.3,k)-k/437.3)<1e-13);
  const w=sampleInterval(.2,437.3,sr,k);
  assert.ok(Math.abs(w.rightSeconds-w.leftSeconds-k/437.3)<1e-12);
 }
 assert.ok(Math.abs(theoreticalWindow(250,.5)-.002)<1e-12);
});
test('all selected K values are accepted by model and reach actual offline output, with no fake fallback',()=>{
 const ch=changingSignal();
 for(const k of PERIOD_CYCLE_CHOICES){
  const m=estimateSharedPartials({channels:[ch],sampleRate:sr,K:k});
  assert.equal(m.periodCycles,k);
  assert.ok(m.residual[0].every(Number.isFinite),'residual invalid at K='+k);
  const render=renderPCM({channels:[ch],sampleRate:sr,speed:.8,semitones:3,model:'period-joint',periodCycles:k});
  assert.equal(render.diagnostics.periodCycles,k);
  assert.equal(render.channels[0].length,Math.round(ch.length/.8));
  assert.ok(render.channels[0].every(Number.isFinite));
 }
 for(const k of [0,.3,.75,3,64,Infinity,NaN]){
  assert.throws(()=>renderPCM({channels:[ch],sampleRate:sr,speed:.8,model:'period-joint',periodCycles:k}),/unsupported number of analysis cycles/);
 }
});
test('changing observation support modifies actual fitted shared-partial parameters',()=>{
 const ch=changingSignal();
 const a=estimateSharedPartials({channels:[ch],sampleRate:sr,K:.5});
 const b=estimateSharedPartials({channels:[ch],sampleRate:sr,K:32});
 // If both hypotheses are absent, a silent slider would pass; require that
 // shared frequency-dependent model is actually exposed to K.
 const compact=m=>JSON.stringify(m.partials.map(x=>[Number(x.frequency.toFixed(4)),Number(x.coefficients[0].a.toFixed(5))]));
 assert.ok(a.partials.length+b.partials.length>0,'candidate extraction must remain active');
 assert.notEqual(compact(a),compact(b),'K changes must affect estimation');
});
test('neutral preservation and other models are independent of periodCycles',()=>{
 const ch=changingSignal();
 const neutral=renderPCM({channels:[ch],sampleRate:sr,model:'period-joint',periodCycles:.5});
 assert.deepEqual(neutral.channels[0],ch);
 const args={channels:[ch],sampleRate:sr,speed:1.2,semitones:4,model:'pv'};
 assert.deepEqual(renderPCM({...args,periodCycles:.5}).channels[0],renderPCM({...args,periodCycles:32}).channels[0]);
});
test('browser slider appears in opt-in mode and forwards user-selected cycle count through Worker',()=>{
 const html=readFileSync(new URL('index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('app.mjs',import.meta.url),'utf8');
 const stream=readFileSync(new URL('lab-stream.mjs',import.meta.url),'utf8');
 const worker=readFileSync(new URL('lab-processor.worker.mjs',import.meta.url),'utf8');
 assert.match(html,/id="lab-period-cycles"[^>]+type="range"[^>]+min="-1"[^>]+max="5"/);
 assert.match(app,/labPeriodField.hidden=lab.mode!=="period-joint"/);
 assert.match(app,/labPeriod.disabled=lab.mode!=="period-joint"/);
 assert.match(app,/lab.periodCycles=nextCycles/);
 assert.match(app,/periodCycles:lab.periodCycles,startSeconds:where/);
 assert.match(stream,/longFftSize,periodCycles,plan/);
 assert.match(worker,/sourceStartSeconds:plan.from\/sampleRate,periodCycles/);
});
