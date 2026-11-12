import test from "node:test";
import assert from "node:assert/strict";
import {createGranularTimePitch} from "./source-granular.mjs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";

// One nonconstant stereo musical-content fixture used for all R3 test cases:
// two fundamental partials, overtone, stereo differential and a drum onset.
const SR=48000,FRAMES=192000;
const source=[new Float32Array(FRAMES),new Float32Array(FRAMES)];
for(let i=0;i<FRAMES;i++){
  const t=i/SR,beat=i%14400;
  const body=.32*Math.sin(2*Math.PI*440*t)+
    .08*Math.sin(2*Math.PI*660*t)+.04*Math.sin(2*Math.PI*1320*t);
  const onset=beat<90?.22*Math.exp(-beat/27):0;
  source[0][i]=body+onset;
  source[1][i]=.6*(body+onset)+.1*Math.sin(2*Math.PI*330*t+.3);
}
const energy=(pcm,frequency)=>{
  let re=0,im=0;
  for(let i=2048;i<pcm.length;i++){
    const angle=2*Math.PI*frequency*(i-2048)/SR;
    re+=pcm[i]*Math.cos(angle);
    im+=pcm[i]*Math.sin(angle);
  }
  return Math.hypot(re,im);
};
const synth=(speed,pitch)=>{
  const g=createGranularTimePitch({sourceSampleRate:SR,
    outputSampleRate:SR,channelCount:2,pitchSemitones:pitch});
  const audio=[new Float32Array(8192),new Float32Array(8192)];
  let frame=90000,misses=0;
  for(let i=0;i<8192;i+=128){
    const out=[new Float32Array(128),new Float32Array(128)];
    const r=g.render(out,{sourceFrame:frame,speed,
      loopEnabled:false,loopStartFrame:0,loopEndFrame:FRAMES},
      (ch,index)=>source[ch][index],FRAMES);
    misses+=r.missingFrames;
    for(let ch=0;ch<2;ch++)audio[ch].set(out[ch],i);
    frame+=128*speed;
  }
  return {audio,frame,misses};
};

test("signed -8..+8 and 0x keep pitched audio independent of source-time rate",()=>{
  for(const speed of [-8,-1,0,1,8]){
    for(const pitch of [0,7]){
      const {audio,frame,misses}=synth(speed,pitch);
      assert.equal(misses,0,{speed,pitch});
      assert.equal(frame,90000+8192*speed);
      const output=audio[0];
      const rms=Math.sqrt(output.slice(2048).
        reduce((sum,v)=>sum+v*v,0)/6144);
      assert.ok(rms>.07,{speed,pitch,rms});
      const raw440=energy(output,440),shift659=energy(output,659.26);
      if(pitch===0)assert.ok(raw440>2.5*shift659,
        {speed,pitch,raw440,shift659});
      else assert.ok(shift659>3*raw440,
        {speed,pitch,raw440,shift659});
      assert.ok(audio[1].some((v,i)=>i>2048&&Math.abs(v)>.01),
        "stereo differential must remain audible");
    }
  }
});

test("unit-rate ±1 at unshifted pitch follows exact forward/reverse input PCM",()=>{
  for(const speed of [-1,1]){
    const out=synth(speed,0).audio[0];
    let maxError=0;
    for(let i=2048;i<8192;i++)
      maxError=Math.max(maxError,
        Math.abs(out[i]-source[0][90000+i*speed]));
    assert.ok(maxError<.00001,{speed,maxError});
  }
});

test("pitch accepts canonical fractional semitones without display rounding",()=>{
  const g=createGranularTimePitch({sourceSampleRate:SR,outputSampleRate:SR});
  const a=g.setPitch(7.1234);
  assert.equal(a.pitchSemitones,7.1234);
  assert.equal(g.state.pitchSemitones,7.1234);
  assert.ok(Math.abs(a.pitchRatio-2**(7.1234/12))<1e-14);
  assert.throws(()=>g.setPitch(12.00001),/pitch/);
  assert.throws(()=>g.setPitch(-12.01),/pitch/);
  assert.throws(()=>g.setPitch(NaN),/pitch/);
  assert.equal(g.state.pitchSemitones,7.1234);
});

test("frozen transport retains source position while emitting non-DC sound",()=>{
  const sourceFrame=90000;
  const renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:sourceFrame,speed:0
  });
  const start=65536;
  renderer.installWindow(start,source.map(x=>x.slice(start,start+65536)));
  const grain=createGranularTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2
  });
  const output=[new Float32Array(128),new Float32Array(128)];
  const before=renderer.timeline.state.sourceFrame;
  for(let i=0;i<12;i++)
    assert.equal(renderer.renderGranular(output,grain),0);
  assert.equal(renderer.timeline.state.sourceFrame,before);
  assert.equal(renderer.statistics.missingFrames,0);
  const min=Math.min(...output[0]),max=Math.max(...output[0]);
  assert.ok(max-min>.15,
    "speed=0 must emit evolving, audible samples, not a held DC value");
});

test("one-sample A/B stays sample-accurate; musical pitch is not promised",()=>{
  const frame=90000;
  const g=createGranularTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,pitchSemitones:7
  });
  const pcm=[new Float32Array(128)];
  const r=g.render(pcm,{sourceFrame:frame,speed:0,
    loopEnabled:true,loopStartFrame:frame,loopEndFrame:frame+1},
    (ch,index)=>source[ch][index],FRAMES);
  assert.equal(r.missingFrames,0);
  for(const v of pcm[0])
    assert.ok(Math.abs(v-source[0][frame])<.00001,
      "one-source-sample loop is a held sample, not a new musical oscillator");
});

test("bounded-source misses are measured, not hidden as successful DSP",()=>{
  const renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:1,startFrame:90000,speed:0
  });
  const g=createGranularTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR
  });
  const block=[new Float32Array(128)];
  assert.equal(renderer.renderGranular(block,g),128);
  assert.ok(renderer.firstMissingFrame>=0);
  assert.equal(renderer.statistics.missingFrames,128);
});
