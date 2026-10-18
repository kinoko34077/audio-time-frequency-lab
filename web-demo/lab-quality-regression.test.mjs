import test from 'node:test';
import assert from 'node:assert/strict';
import {resampleBandlimited,wsola,phaseVocoder,amVocoder,renderPCM} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
import {fullBandPartialOptions} from './lab-contract.mjs';
const sr=16000;
const signal=(freq,length=sr)=>Float32Array.from({length},(_,i)=>.4*Math.sin(2*Math.PI*freq*i/sr));
const finite=x=>x.every(Number.isFinite);
function zeroFrequency(x,start,end){let z=0;for(let i=start+1;i<end;i++)if(x[i-1]<=0&&x[i]>0)z++;return z*sr/(end-start);}
test('WSOLA 2x stretch stays pitch-consistent and stereo-aligned',()=>{
 const tone=signal(440),stretch=2,frameCount=tone.length*stretch;
 const [a,b]=wsola([tone,Float32Array.from(tone,v=>v*.7)],stretch,frameCount,512);
 assert.ok(finite(a)&&finite(b));assert.equal(a.length,frameCount);
 const hz=zeroFrequency(a,4000,24000);
 assert.ok(hz>405&&hz<475,'WSOLA must preserve mean pitch (measured '+hz+')');
 const relative=Math.max(...a.slice(4000,24000).map((v,i)=>Math.abs(b[i+4000]-.7*v)));
 assert.ok(relative<1e-5,'WSOLA must retain interchannel relation '+relative);
});
test('WSOLA short window is not constrained by disabled long window',()=>{
 const args={channels:[signal(330)],sampleRate:sr,speed:.8,semitones:0,model:'wsola',shortFftSize:2048,longFftSize:1024,fftSize:1024};
 const result=renderPCM(args);assert.ok(result.channels[0].length>sr&&finite(result.channels[0]));
 const p=planChunk({totalFrames:sr*200,sampleRate:sr,speed:.8,startSeconds:90,model:'wsola',shortFftSize:2048,longFftSize:1024});
 assert.ok(p.to-p.from<sr*3);
 assert.throws(()=>renderPCM({...args,model:'dual'}),/短窓/);
});
test('AM mode does not impose rapid repeated phase-envelope modulation',()=>{
 const input=Float32Array.from({length:sr*2},(_,i)=>{
   const t=i/sr;return (.2+.1*Math.sin(2*Math.PI*2*t))*(Math.sin(2*Math.PI*437*t)+.5*Math.sin(2*Math.PI*880*t));
 });
 const stretch=1.35,outLen=Math.round(input.length*stretch);
 const carrier=phaseVocoder([input],stretch,outLen,2048)[0];
 const corrected=amVocoder([input],stretch,outLen,sr,2048)[0];
 assert.ok(finite(corrected));
 let prev=null,maxJump=0,seen=0;
 for(let i=3000;i<corrected.length-2000;i++){
   if(Math.abs(carrier[i])<.1)continue;
   const ratio=corrected[i]/carrier[i];
   if(prev!==null&&Math.abs(ratio-prev)<.3)maxJump=Math.max(maxJump,Math.abs(ratio-prev));
   prev=ratio;seen++;
 }
 assert.ok(seen>500&&maxJump<.015,'AM gain must vary slowly without comb-frequency jumps: '+maxJump);
});
test('anti-aliased upward pitch resampling attenuates the ultrasonic foldback',()=>{
 const x=signal(6000);
 const y=resampleBandlimited(x,2);
 assert.ok(finite(y));
 let energy=0;for(const v of y)energy+=v*v;
 const rms=Math.sqrt(energy/y.length);
 assert.ok(rms<.1,'upper band beyond new Nyquist must be attenuated rather than alias ('+rms+')');
});
test('live partial/residual is full-band and independent from hidden Warp controls',()=>{
 const p=fullBandPartialOptions(48000);
 assert.equal(p.aQuality,100);assert.equal(p.aBandBins,1);
 assert.equal(p.crusherBits,0);assert.equal(p.aReverb,0);
 assert.equal(p.low,1);assert.equal(p.high,20000);
 const lo=fullBandPartialOptions(16000);
 assert.ok(lo.high<8000);
});
