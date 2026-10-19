import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPCM,transientAnchors} from './lab-dsp.mjs';
import {renderPCM as renderBefore31} from './lab-dsp-pre31.mjs';

const sr=48000,TAU=Math.PI*2;
const wave=(count,fn)=>Float32Array.from({length:count},(_,i)=>fn(i/sr,i));
const rms=x=>Math.sqrt(x.reduce((v,q)=>v+q*q,0)/Math.max(1,x.length));
function modulation(samples,from=.24,to=.94) {
 const segment=sr*.1,step=sr*.025;const values=[];
 for(let i=Math.round(from*sr);i+segment<=Math.min(samples.length,to*sr);i+=step)
  values.push(rms(samples.subarray(i,i+segment)));
 const avg=values.reduce((a,b)=>a+b,0)/values.length;
 const std=Math.sqrt(values.reduce((a,b)=>a+(b-avg)**2,0)/values.length);
 return {cv:std/(avg+1e-12),range:(Math.max(...values)-Math.min(...values))/(avg+1e-12),avg};
}
function attackTrack() {
 const ch=wave(sr*1.15,(t)=>.16*Math.cos(TAU*108.41*t+.1)+.055*Math.cos(TAU*218.14*t));
 const hits=[.32,.342,.365,.58,.85];
 for(const t of hits){
  const index=Math.round(t*sr);
  for(let j=0;j<Math.round(sr*.009);j++){
   const env=.55*Math.exp(-j/(sr*.0019));
   ch[index+j]+=env*(.53*Math.sin(TAU*3110*j/sr+.4)+.47*Math.sin(TAU*6910*j/sr+.27));
  }
 }
 return {ch,hits};
}
function highChange(x,i){return Math.abs(x[i]-x[Math.max(0,i-1)]);}
function attackDiagnostic(x,hits,speed) {
 const centers=hits.map(t=>t/speed);
 const near=centers.map(t=>{
  const middle=Math.round(t*sr);
  let high=0,loc=middle,energy=0;
  for(let i=Math.max(1,middle-Math.round(sr*.01));i<Math.min(x.length,middle+Math.round(sr*.01));i++){
   const y=highChange(x,i);
   if(y>high){high=y;loc=i;}
   energy+=y*y;
  }
  return {errMs:(loc/sr-t)*1000,peak:high,energy};
 });
 let outside=0,total=0;
 for(let i=1;i<x.length;i+=4){
  const t=i/sr,yy=highChange(x,i)**2;
  total+=yy;
  if(!centers.some(c=>Math.abs(c-t)<.018))outside+=yy;
 }
 return {near,outsideRatio:outside/(total+1e-12),total};
}
test('AUDIT periodic bass amplitude beating with long1024/2048 across PV and dual, short256/512',()=>{
 const input=wave(sr*1.5,t=>.27*Math.cos(TAU*109.83*t+.13));
 for(const speed of [.5,1.5]){
  for(const longFftSize of [1024,2048]){
   for(const mode of ['pv','dual']){
    const shortSizes=mode==='dual'?[256,512]:[256];
    for(const shortFftSize of shortSizes){
     const x=renderPCM({channels:[input],sampleRate:sr,speed,semitones:0,model:mode,longFftSize,shortFftSize}).channels[0];
     const m=modulation(x,.26,Math.min(1.35,1.5/speed-.15));
     console.log('AUDIT_BASS_WOW',JSON.stringify({mode,speed,longFftSize,shortFftSize,...m}));
     assert.ok(x.every(Number.isFinite));
    }
   }
  }
 }
});
test('AUDIT transient train with 22ms pairs and bass carrier: WSOLA/dual short256/512 long1024/2048',()=>{
 const {ch,hits}=attackTrack();
 for(const speed of [.5,1.5])for(const shortFftSize of [256,512])
  for(const model of ['wsola','dual']){
   for(const longFftSize of model==='dual'?[1024,2048]:[2048]){
    const x=renderPCM({channels:[ch],sampleRate:sr,speed,semitones:0,model,longFftSize,shortFftSize}).channels[0];
    const d=attackDiagnostic(x,hits,speed);
    console.log('AUDIT_ATTACK_TRAIN',JSON.stringify({model,speed,shortFftSize,longFftSize,...d}));
    assert.ok(x.every(Number.isFinite));
   }
  }
 console.log('AUDIT_ANCHORS',JSON.stringify({actual:transientAnchors([ch],sr).map(i=>i/sr),expected:hits}));
});

test('A/B actual prePR31 vs now: no post-PR31 increase of rhythmic LF pumping or transient ghosts',()=>{
 const {ch,hits}=attackTrack();
 for(const speed of [.5,1.5])for(const shortFftSize of [256,512])for(const model of ['wsola','dual']){
  for(const longFftSize of model==='dual'?[1024,2048]:[2048]){
   const args={channels:[ch],sampleRate:sr,speed,semitones:0,model,shortFftSize,longFftSize};
   const current=renderPCM(args).channels[0];
   const prior=renderBefore31(args).channels[0];
   const now=attackDiagnostic(current,hits,speed);
   const before=attackDiagnostic(prior,hits,speed);
   console.log('AB_PR31_ATTACK',JSON.stringify({model,speed,shortFftSize,longFftSize,
    now:{outsideRatio:now.outsideRatio,peaks:now.near.map(x=>({errMs:x.errMs,peak:x.peak}))},
    before:{outsideRatio:before.outsideRatio,peaks:before.near.map(x=>({errMs:x.errMs,peak:x.peak}))}}));
  }
 }
});
test('A/B bass periodic gain modulation vs beforePR31 and across N1024/2048',()=>{
 const source=wave(sr*1.5,t=>.27*Math.cos(TAU*109.83*t+.13));
 for(const speed of [.5,1.5])for(const model of ['pv','dual'])for(const longFftSize of [1024,2048]){
  const args={channels:[source],sampleRate:sr,speed,semitones:0,model,shortFftSize:256,longFftSize};
  const current=renderPCM(args).channels[0];
  const previous=renderBefore31(args).channels[0];
  const now=modulation(current,.26,Math.min(1.35,1.5/speed-.15));
  const before=modulation(previous,.26,Math.min(1.35,1.5/speed-.15));
  console.log('AB_PR31_BASS',JSON.stringify({model,speed,longFftSize,now,before}));
 }
});

test('bass-backed closely spaced transients must actually be detected by the new source novelty detector',()=>{
 const {ch,hits}=attackTrack();
 const actual=transientAnchors([ch],sr).map(i=>i/sr);
 console.log('TRANSIENT_DETECTED_IN_MUSIC',JSON.stringify({actual,expected:hits}));
 for(const expected of hits)assert.ok(actual.some(v=>Math.abs(v-expected)<.003),'missed 20ms-separated attack at '+expected);
});
