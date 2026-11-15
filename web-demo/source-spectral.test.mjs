import test from "node:test";
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";

const SR=48000,FRAMES=262144,CENTER=90000,START=65536;
const source=[new Float32Array(FRAMES),new Float32Array(FRAMES)];
for(let i=0;i<FRAMES;i++){
  const t=i/SR,onset=i%11000;
  const tonal=.32*Math.sin(2*Math.PI*440*t)+
    .07*Math.sin(2*Math.PI*660*t+.7);
  const attack=onset<70?.17*Math.exp(-onset/25):0;
  source[0][i]=tonal+attack;
  source[1][i]=.66*tonal+.13*Math.sin(2*Math.PI*330*t+.4)+attack*.3;
}
function render(speed,pitch,frames=8192){
  const renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:CENTER,speed
  });
  renderer.installWindow(0,source.map(x=>x.slice(0,65536)));
  renderer.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  renderer.installWindow(START+65536,source.map(x=>x.slice(START+65536,START+131072)));
  const spectral=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2,pitchSemitones:pitch
  });
  const output=[new Float32Array(frames),new Float32Array(frames)];
  const start=performance.now();
  let misses=0;
  for(let i=0;i<frames;i+=128){
    const block=[new Float32Array(128),new Float32Array(128)];
    misses+=renderer.renderSpectral(block,spectral);
    for(let ch=0;ch<2;ch++)output[ch].set(block[ch],i);
  }
  return {output,misses,elapsed:performance.now()-start,
    end:renderer.timeline.state.sourceFrame};
}
const rms=a=>Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)/a.length);
const binEnergy=(a,hz)=>{
  let re=0,im=0;
  for(let i=2048;i<a.length;i++){
    const p=2*Math.PI*hz*(i-2048)/SR;
    re+=a[i]*Math.cos(p);
    im+=a[i]*Math.sin(p);
  }
  return Math.hypot(re,im);
};
test("spectral renderer is actual source-time driven STFT: signed ±8/0 and stereo output",()=>{
  for(const speed of [-8,-1,-.02,0,.02,1,8]){
    const {output,misses,end,elapsed}=render(speed,0);
    assert.equal(misses,0,{speed,misses});
    assert.ok(output.every(ch=>ch.every(Number.isFinite)),{speed});
    assert.ok(rms(output[0].subarray(2048))>.025,{speed,
      rms:rms(output[0].subarray(2048))});
    assert.ok(output[1].some((x,i)=>i>2048&&Math.abs(x-output[0][i])>.015),
      "stereo channel differences cannot collapse into mono");
    assert.ok(Math.abs(end-(CENTER+8192*speed))<1,{speed,end});
    assert.ok(elapsed<12000,{speed,elapsed});
  }
});
test("0x freeze evolves non-DC tones without repeating a fixed granular window",()=>{
  const {output,misses,end}=render(0,0,16384),data=output[0];
  assert.equal(misses,0);
  assert.equal(end,CENTER);
  const body=data.subarray(4096),min=Math.min(...body),max=Math.max(...body);
  assert.ok(max-min>.12,{min,max,rms:rms(body)});
  const s=binEnergy(data,440),neighbor=binEnergy(data,400);
  assert.ok(s>neighbor*1.2,{s,neighbor});
  const repeated=body.slice(0,2048).reduce((v,x,i)=>v+
    (x-body[i+2048])**2,0)/2048;
  assert.ok(repeated>1e-4,{repeated});
});
test("fractional pitch value remains exact; spectral synthesis changes sounding pitch",()=>{
  const g=createSpectralTimePitch({sourceSampleRate:SR,outputSampleRate:SR});
  assert.equal(g.setPitch(7.1234).pitchSemitones,7.1234);
  assert.equal(g.state.pitchSemitones,7.1234);
  assert.throws(()=>g.setPitch(15),/pitch/);
  const {output,misses}=render(0,7,16384);
  assert.equal(misses,0);
  const a=binEnergy(output[0],659.26),b=binEnergy(output[0],440);
  assert.ok(a>b*1.2,{a,b});
});
test("one original source sample loop remains a held sample; never fake its original chord",()=>{
  const frame=90037,renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:frame,speed:0,
    loopEnabled:true,loopStartFrame:frame,loopEndFrame:frame+1
  });
  renderer.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  const stft=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2,pitchSemitones:7
  });
  const out=[new Float32Array(128),new Float32Array(128)];
  assert.equal(renderer.renderSpectral(out,stft),0);
  assert.equal(renderer.timeline.state.sourceFrame,frame);
  for(let ch=0;ch<2;ch++)for(const x of out[ch])
    assert.ok(Math.abs(x-source[ch][frame])<.00001);
});
test("source movement + reversal preserves continuous output and explicit fade boundary",()=>{
  const renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:CENTER,speed:0
  });
  renderer.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  const stft=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2
  });
  const out=[new Float32Array(128),new Float32Array(128)];
  for(let i=0;i<6;i++)assert.equal(renderer.renderSpectral(out,stft),0);
  const before=out[0].at(-1);
  renderer.timeline.scrub(CENTER+1000,-.75);
  stft.shiftSource(1000);
  assert.equal(renderer.renderSpectral(out,stft),0);
  assert.ok(Math.abs(out[0][0]-before)<.2,
    "scrub transition must avoid an arbitrary immediate full-scale discontinuity");
});
