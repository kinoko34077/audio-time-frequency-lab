import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM} from './lab-dsp.mjs';
const sr=48000,TAU=Math.PI*2;
function attacks({seconds=1.7,times=[.47,1.12],stereo=false,tone=false}={}){
 const count=Math.round(seconds*sr);
 const left=new Float32Array(count),right=new Float32Array(count);
 for(let i=0;i<count;i++){
  const t=i/sr;
  const baseline=tone?.035*Math.sin(TAU*193.7*t):0;
  left[i]=baseline;right[i]=-baseline;
 }
 for(const [index,at] of times.entries()){
  const start=Math.round(at*sr),len=Math.floor(sr*.0025);
  for(let j=0;j<len;j++){
   const t=j/sr;
   // Intentionally finite broadband onset, sharp attack and smooth tail.
   const env=.8*Math.exp(-t*1900);
   const value=env*(.65*Math.sin(TAU*5300*t+.3)+.35*Math.sin(TAU*8470*t+.5));
   left[start+j]+=value;
   right[start+j]+=(index===0?-1:1)*.8*value;
  }
 }
 return stereo?[left,right]:[left];
}
function diagnostic(output,times,speed){
 const ch=output[0],expected=times.map(t=>t/speed);
 let energy=0,near=0,late=0,early=0;
 const peaks=[];
 for(let i=0;i<ch.length;i++){
  const time=i/sr,mag=ch[i]**2;
  const dx=Math.min(...expected.map(t=>Math.abs(time-t)));
  energy+=mag;
  if(dx<.012)near+=mag;
  else {if(dx<.055)late+=mag;else early+=mag;}
 }
 for(const t of expected){
  const middle=Math.round(t*sr),left=Math.max(1,middle-Math.round(.10*sr)),right=Math.min(ch.length-2,middle+Math.round(.10*sr));
  let sorted=[];
  for(let i=left;i<=right;i++){
   const v=Math.abs(ch[i]);
   if(v>=Math.abs(ch[i-1])&&v>Math.abs(ch[i+1]))sorted.push({time:i/sr,magnitude:v});
  }
  sorted.sort((a,b)=>b.magnitude-a.magnitude);
  const strongest=sorted[0]||{time:-1,magnitude:0};
  const second=sorted.find(x=>Math.abs(x.time-strongest.time)>.005)||{time:-1,magnitude:0};
  peaks.push({expected:t,strongest,second,peakErrorMs:1000*(strongest.time-t),secondRatio:second.magnitude/(strongest.magnitude+1e-12)});
 }
 return {energy,nearRatio:near/(energy+1e-12),near,late,early,ghostRatio:(late+early)/(energy+1e-12),peaks};
}
test('short 256 attack audit: quantify secondary energy, repeated attacks, onset offset and stereo all backends',()=>{
 const times=[.47,1.12],channels=attacks({times,stereo:true});
 for(const speed of [.5,1.5])for(const mode of ['wsola','dual'])for(const joint of [false,true]){
  const sample=renderPCM({channels,sampleRate:sr,speed,semitones:0,
   model:joint?'period-joint':mode,jointBackend:joint?mode:null,periodCycles:2,
   shortFftSize:256,longFftSize:2048});
  const d=diagnostic(sample.channels,times,speed);
  console.log('TRANSIENT_256_BASELINE',JSON.stringify({mode,joint,speed,near:d.nearRatio,ghost:d.ghostRatio,peaks:d.peaks.map(p=>({errMs:p.peakErrorMs,secondary:p.secondRatio,secondaryTime:p.second.time}))}));
  assert.ok(sample.channels.every(ch=>ch.every(Number.isFinite)),'nonfinite output');
  assert.ok(d.nearRatio>.12,'attack energy severely displaced '+mode+' '+speed+' '+d.nearRatio);
 }
});
test('strict transient onset fidelity at N256 across both source time maps',()=>{
 const input=attacks({times:[.6],seconds:1.3,stereo:false});
 for(const speed of [.5,1.5])for(const mode of ['wsola','dual']){
  const out=renderPCM({channels:input,sampleRate:sr,speed,semitones:0,model:mode,shortFftSize:256,longFftSize:2048});
  const d=diagnostic(out.channels,[.6],speed);
  console.log('TRANSIENT_256_STRICT',JSON.stringify({mode,speed,near:d.nearRatio,ghost:d.ghostRatio,peaks:d.peaks}));
  assert.ok(d.nearRatio>.80,mode+' disperses >20% impulse energy outside +/-12ms');
  assert.ok(d.peaks[0].peakErrorMs<7&&d.peaks[0].peakErrorMs>-7,mode+' moves attack >7ms');
 }
});
