import test from "node:test";
import assert from "node:assert/strict";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {createWsolaTimePitch,createGranularTimePitch} from "./source-granular.mjs";

const sr=48000,len=192000,center=90000;
const input=[new Float32Array(len),new Float32Array(len)];
for(let i=0;i<len;i++){
  const t=i/sr;
  const pluck=i%12341<72?.1*Math.exp(-(i%12341)/20):0;
  input[0][i]=.25*Math.sin(2*Math.PI*220*t)+.09*Math.sin(2*Math.PI*660*t)+pluck;
  input[1][i]=.2*Math.sin(2*Math.PI*220*t+.25)+.07*Math.sin(2*Math.PI*550*t)+pluck*.3;
}
const energy=a=>Math.sqrt(a.reduce((acc,x)=>acc+x*x,0)/a.length);
const output=(mode,speed=0,pitch=0,frames=4096)=>{
  const engine=(mode==="wsola"?createWsolaTimePitch:createGranularTimePitch)({
    sourceSampleRate:sr,outputSampleRate:sr,channelCount:2,
    grainFrames:mode==="wsola"?1024:2048,
    hopFrames:mode==="wsola"?256:1024,pitchSemitones:pitch
  });
  const renderer=createSourcePCMRenderer({
    sourceFrames:len,sourceSampleRate:sr,outputSampleRate:sr,
    channelCount:2,startFrame:center,speed
  });
  for(let offset=0;offset<len;offset+=65536)
    renderer.installWindow(offset,input.map(ch=>ch.slice(offset,Math.min(len,offset+65536))));
  const channels=[new Float32Array(frames),new Float32Array(frames)];
  let missing=0;
  for(let i=0;i<frames;i+=128){
    const block=[new Float32Array(128),new Float32Array(128)];
    missing+=renderer.renderGranular(block,engine);
    for(let c=0;c<2;c++)channels[c].set(block[c],i);
  }
  return {channels,missing,position:renderer.timeline.state.sourceFrame,algorithm:engine.state.algorithm};
};
test("actual WSOLA overlap correlation generates finite stereo PCM on signed ±8 and 0x",()=>{
  for(const speed of [-8,-1,-.05,0,.05,1,8]){
    const x=output("wsola",speed,0);
    assert.equal(x.algorithm,"wsola-correlation");
    assert.equal(x.missing,0,JSON.stringify({speed,missing:x.missing}));
    assert.ok(x.channels.every(ch=>ch.every(Number.isFinite)));
    assert.ok(energy(x.channels[0].subarray(1024))>.02,
      JSON.stringify({speed,energy:energy(x.channels[0])}));
    assert.ok(x.channels[1].some((v,i)=>i>1024&&Math.abs(v-x.channels[0][i])>.01),
      "stereo relative content must not collapse");
    assert.ok(Math.abs(x.position-(center+4096*speed))<.1,
      JSON.stringify({speed,position:x.position}));
  }
});
test("WSOLA is a distinct long-reference phase-correlation synthesis, not renamed Granular",()=>{
  const w=output("wsola",.35,2.25),g=output("granular",.35,2.25);
  assert.equal(g.algorithm,"granular-overlap");
  assert.equal(w.algorithm,"wsola-correlation");
  const difference=Math.sqrt(w.channels[0].reduce((sum,s,i)=>sum+
    (s-g.channels[0][i])**2,0)/w.channels[0].length);
  assert.ok(difference>.01,{difference});
});
test("WSOLA accepts exact independent pitch while original sample clock holds at 0x",()=>{
  const a=output("wsola",0,7.1234),b=output("wsola",0,0);
  assert.equal(a.position,center);assert.equal(b.position,center);
  assert.ok(energy(a.channels[0].subarray(1024))>.02);
  const diff=Math.sqrt(a.channels[0].reduce((sum,v,i)=>sum+
    (v-b.channels[0][i])**2,0)/4096);
  assert.ok(diff>.01,{diff});
});
