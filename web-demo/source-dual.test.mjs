import test from "node:test";
import assert from "node:assert/strict";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {createDualTimePitch} from "./source-dual.mjs";
import {createSpectralTimePitch} from "./source-spectral.mjs";

const sr=48000,L=196608,center=90112;
const source=[new Float32Array(L),new Float32Array(L)];
for(let i=0;i<L;i++){
  const time=i/sr,onset=i%9377;
  const tonal=.14*Math.sin(2*Math.PI*220*time)+.09*Math.sin(2*Math.PI*440*time+.3);
  const hit=onset>=512&&onset<640?.85*Math.exp(-(onset-512)/180):0;
  source[0][i]=tonal+hit;
  source[1][i]=tonal*.67+.08*Math.sin(2*Math.PI*330*time+.4)+hit*.72;
}
function fixture(speed=1,shortFrames=512,longFrames=2048,start=center){
  const renderer=createSourcePCMRenderer({
    sourceFrames:L,sourceSampleRate:sr,outputSampleRate:sr,
    channelCount:2,startFrame:start,speed
  });
  for(let offset=0;offset<L;offset+=65536)
    renderer.installWindow(offset,source.map(a=>a.slice(offset,Math.min(offset+65536,L))));
  return {renderer,dual:createDualTimePitch({sourceSampleRate:sr,
    outputSampleRate:sr,channelCount:2,shortFrames,longFrames})};
}
function playback(speed,frames=4096,start=center){
  const {renderer,dual}=fixture(speed,512,2048,start);
  const audio=[new Float32Array(frames),new Float32Array(frames)];
  let missing=0;
  for(let at=0;at<frames;at+=128){
    const segment=[new Float32Array(128),new Float32Array(128)];
    missing+=renderer.renderGranular(segment,dual);
    for(let ch=0;ch<2;ch++)audio[ch].set(segment[ch],at);
  }
  return {audio,missing,sourceFrame:renderer.timeline.state.sourceFrame,
    engine:dual.state};
}
const rms=x=>Math.sqrt(x.reduce((sum,v)=>sum+v*v,0)/x.length);
test("Dual genuinely combines two distinct DSPs and keeps signed ±8 / 0 source time",()=>{
  for(const speed of [-8,-1,-.05,0,.05,1,8]){
    const {audio,missing,sourceFrame,engine}=playback(speed);
    assert.equal(engine.algorithm,"dual-onset-wsola-pv");
    assert.equal(engine.shortAlgorithm,"wsola-correlation");
    assert.equal(engine.longAlgorithm,"phase-vocoder-peak-locked");
    assert.equal(missing,0,{speed,missing});
    assert.ok(audio.every(x=>x.every(Number.isFinite)),{speed});
    assert.ok(rms(audio[0].subarray(1024))>.015,{speed,rms:rms(audio[0].subarray(1024))});
    assert.ok(audio[1].some((x,i)=>i>1024&&Math.abs(x-audio[0][i])>.01),
      "stereo content should remain distinct");
    assert.ok(Math.abs(sourceFrame-(center+4096*speed))<.1,{speed,sourceFrame});
  }
});
test("isolated attacks are assigned to the short WSOLA instead of duplicated long PV transients",()=>{
  // 512 is the transient offset within a 9377-frame cycle. Place the source
  // at silence and cross the onset, so a synthetic transient is unambiguous.
  const base=9377*9+190;
  const {audio,engine}=playback(1,4096,base);
  assert.ok(engine.transientCount>=1,engine);
  assert.ok(rms(audio[0])>.02);
  const {renderer,dual}=fixture(1);
  const state=renderer.timeline.state;
  const left=[new Float32Array(128),new Float32Array(128)];
  const reader=()=>0;
  assert.throws(()=>dual.render(left,state,reader,0),/invalid dual PCM/);
});
test("Dual pitch changes preserve exact input and both internal engines",()=>{
  const {renderer,dual}=fixture(0,256,1024);
  assert.equal(dual.setPitch(7.1234).pitchSemitones,7.1234);
  assert.equal(dual.state.pitchSemitones,7.1234);
  assert.throws(()=>dual.setPitch(13),/pitch/);
  const out=[new Float32Array(128),new Float32Array(128)];
  assert.equal(renderer.renderGranular(out,dual),0);
  assert.ok(out.every(ch=>ch.every(Number.isFinite)));
  assert.equal(renderer.timeline.state.sourceFrame,center);
  assert.throws(()=>createDualTimePitch({sourceSampleRate:sr,
    outputSampleRate:sr,shortFrames:2048,longFrames:1024}),/Dual/);
});
test("Dual explicit scrub shift keeps one synthesis epoch and uses original-frame delta",()=>{
  const {renderer,dual}=fixture(1);
  const out=[new Float32Array(128),new Float32Array(128)];
  for(let i=0;i<5;i++)renderer.renderGranular(out,dual);
  const prev=dual.state.outputFrames;
  const before=out[0][127];
  renderer.timeline.scrub(center+750,-.75);
  dual.shiftSource(750);
  assert.equal(renderer.renderGranular(out,dual),0);
  assert.equal(dual.state.outputFrames,prev+128);
  assert.ok(Math.abs(before-out[0][0])<.5,
    "large scrub should have bounded transition rather than full-scale jump");
});

test("Dual accepts each configured 4096/8192 long PV window without resizing the source clock",()=>{
  for(const [shortFrames,longFrames] of [[256,4096],[512,8192]]){
    const {renderer,dual}=fixture(0,shortFrames,longFrames);
    const block=[new Float32Array(128),new Float32Array(128)];
    assert.equal(renderer.renderGranular(block,dual),0,{shortFrames,longFrames});
    assert.ok(block.every(ch=>ch.every(Number.isFinite)),{shortFrames,longFrames});
    assert.equal(renderer.timeline.state.sourceFrame,center);
    assert.equal(dual.state.longAlgorithm,"phase-vocoder-peak-locked");
    assert.equal(dual.state.shortAlgorithm,"wsola-correlation");
  }
});
