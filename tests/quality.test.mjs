import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPCM } from '../dsp.mjs';

const sr=16000,len=16000;
const tone=(freq,scale=.36)=>Float32Array.from({length:len},(_,n)=>scale*Math.sin(2*Math.PI*freq*n/sr));
const maxDiff=(a,b)=>a.reduce((m,v,i)=>Math.max(m,Math.abs(v-b[i])),0);
function finiteChannels(result,expectedLength,count){
  assert.equal(result.channels.length,count);
  assert.equal(result.channels[0].length,expectedLength);
  for(const channel of result.channels)assert.ok(channel.every(Number.isFinite),'all outputs finite');
}

for(const model of ['pv','wsola','dual','am']){
  test(`${model}: speed+pitch two-dimensional length and stereo`,()=>{
    const source=[tone(440),tone(550)];
    for(const [speed,semitones] of [[.7,-7],[1.4,5],[2,0]]){
      const out=renderPCM({channels:source,sampleRate:sr,speed,semitones,model});
      finiteChannels(out,Math.round(len/speed),2);
    }
  });
  test(`${model}: short and silent input safe`,()=>{
    const out=renderPCM({channels:[new Float32Array(128)],sampleRate:sr,speed:.5,semitones:3,model});
    finiteChannels(out,256,1);
  });
}
test('distinct model engines produce different nonneutral processed waveforms',()=>{
  const x=Float32Array.from({length:len},(_,i)=>{
    const t=i/sr,carrier=Math.sin(2*Math.PI*(440*t+200*t*t));
    return (.25+.15*Math.sin(2*Math.PI*5*t))*carrier;
  });
  const outs=['pv','wsola','dual','am'].map(model=>renderPCM({channels:[x],sampleRate:sr,speed:.7,semitones:0,model}).channels[0]);
  for(let i=1;i<outs.length;i++)assert.ok(maxDiff(outs[0],outs[i])>1e-5,'model output must differ from phase vocoder');
});
