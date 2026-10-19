import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM,transientAnchors} from './lab-dsp.mjs';
import {planChunk} from './lab-stream.mjs';
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

test('steady bass tones do not produce repeated false onset markers every period',()=>{
 for(const frequency of [55,110,193.7,440]){
  const wave=Float32Array.from({length:Math.round(sr*1.4)},(_,i)=>.3*Math.sin(TAU*frequency*i/sr+.11));
  const anchors=transientAnchors([wave],sr);
  const late=anchors.filter(i=>i>sr*.10);
  console.log('TRANSIENT_BASS_FALSE_TRIGGERS',JSON.stringify({frequency,late:late.length,at:late.slice(0,12).map(i=>i/sr)}));
  assert.ok(late.length<2,'periodic sine must not be classified as repeated broadband attacks');
 }
});
test('N256 transient correction keeps attack timing with a concurrent tonal carrier, in stereo',()=>{
 const at=.53,toneHz=191.37,speed=.5;
 const input=attacks({seconds:1.3,times:[at],stereo:true,tone:true});
 for(const model of ['wsola','dual']){
  const out=renderPCM({channels:input,sampleRate:sr,speed,semitones:0,model,shortFftSize:256,longFftSize:2048});
  const peak=diagnostic(out.channels,[at],speed).peaks[0];
  console.log('TRANSIENT_TONAL_CARRIER',JSON.stringify({model,peakError:peak.peakErrorMs,secondaryRatio:peak.secondRatio}));
  assert.ok(Math.abs(peak.peakErrorMs)<5,model+' dispersed an onset inside a sustained carrier');
  const lhs=out.channels[0],rhs=out.channels[1];
  assert.ok(lhs.every(Number.isFinite)&&rhs.every(Number.isFinite));
 }
});
test('pitch tracking of N256 WSOLA with low sustained pitch remains unmodified',()=>{
 const sr=48000,f=110,speed=.5;
 const source=Float32Array.from({length:sr},(_,i)=>.3*Math.cos(TAU*f*i/sr));
 const output=renderPCM({channels:[source],sampleRate:sr,speed,semitones:0,model:'wsola',shortFftSize:256}).channels[0];
 let crossings=0;
 const a=Math.floor(.2*sr),b=Math.floor(.8*sr);
 for(let i=a+1;i<b;i++)if(output[i-1]<=0&&output[i]>0)crossings++;
 const hz=crossings/((b-a)/sr);
 console.log('TRANSIENT_BASS_PITCH',JSON.stringify({actual:hz,expected:f}));
 assert.ok(Math.abs(hz-f)<8,'onset anchor incorrectly scaled sustained 110Hz pitch');
});

test('actual 1.5s Worker core seam does not replay a late attack before its absolute timestamp',()=>{
 const seconds=3.4,at=1.508,channels=attacks({seconds,times:[at],stereo:true});
 for(const mode of ['wsola','dual'])for(const speed of [.5,1.5]){
  const next=planChunk({totalFrames:channels[0].length,sampleRate:sr,speed,startSeconds:1.5,
   model:mode,fftSize:2048,shortFftSize:256,longFftSize:2048,referenceWindows:8});
  const sliced=channels.map(x=>x.subarray(next.from,next.to));
  const out=renderPCM({channels:sliced,sampleRate:sr,speed,semitones:0,model:mode,
   shortFftSize:256,longFftSize:2048}).channels;
  const core=out.map(x=>x.subarray(next.outputStart,next.outputStart+next.coreFrames));
  const relative=(at-1.5)/speed;
  const detail=diagnostic(core,[at-1.5],speed);
  const attack=detail.peaks[0];
  console.log('TRANSIENT_SEAM',JSON.stringify({mode,speed,relative,peakError:attack.peakErrorMs,secondary:attack.secondRatio}));
  assert.ok(Math.abs(attack.peakErrorMs)<5,'relative chunk attack moved or repeated');
  assert.ok(detail.nearRatio>.82,'seam created outside attack energy');
 }
});
