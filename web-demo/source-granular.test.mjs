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

test("initial shifted-pitch one-frame loop has no artificial fade-in",()=>{
  const frame=90037;
  assert.ok(Math.abs(source[0][frame])>.05);
  const g=createGranularTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,pitchSemitones:7,channelCount:2
  });
  const out=[new Float32Array(128),new Float32Array(128)];
  const r=g.render(out,{sourceFrame:frame,speed:0,
    loopEnabled:true,loopStartFrame:frame,loopEndFrame:frame+1},
    (ch,index)=>source[ch][index],FRAMES);
  assert.equal(r.missingFrames,0);
  for(let ch=0;ch<2;ch++)for(const sample of out[ch])
    assert.ok(Math.abs(sample-source[ch][frame])<.00001,
      "initial pitch setting must not fade a held exact source sample");
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

test("unlooped granular EOF silences instead of pretending speed-zero freeze",()=>{
  const frames=8192;
  const renderer=createSourcePCMRenderer({
    sourceFrames:frames,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:1,startFrame:frames-256,speed:1
  });
  renderer.installWindow(0,[source[0].slice(0,frames)]);
  const g=createGranularTimePitch({sourceSampleRate:SR,outputSampleRate:SR});
  const pcm=[new Float32Array(128)];
  for(let i=0;i<4;i++)renderer.renderGranular(pcm,g);
  assert.equal(renderer.timeline.state.ended,true);
  pcm[0].fill(.5);
  assert.equal(renderer.renderGranular(pcm,g),0);
  assert.ok(pcm[0].every(x=>x===0),"EOF must not be endless last-grain replay");
  renderer.timeline.setSpeed(0);
  pcm[0].fill(.5);
  renderer.renderGranular(pcm,g);
  assert.equal(renderer.timeline.state.ended,true);
  assert.ok(pcm[0].every(x=>x===0),
    "changing an exhausted stream to 0x must not resurrect a held note");
  renderer.timeline.setSpeed(-1);
  g.reset();
  assert.equal(renderer.timeline.state.ended,false);
  renderer.renderGranular(pcm,g);
  assert.ok(pcm[0].some(x=>Math.abs(x)>.001),
    "genuine reversal from EOF may re-arm finite source playback");
});


// #36 R2: secondary diagnostic ONLY AFTER the real CC0 piano measurement
// found ambiguous extra spectral ridges. Reuse the existing nonconstant
// musical 440/660/1320Hz stereo source; do not replace real-recording
// quality acceptance with a synthetic-only 'good sounding' claim.
test("diagnostic known 440/660Hz musical partials disambiguate pitch ridge from granular sidebands",()=>{
  const N=8192-2048,window=new Float64Array(N);
  for(let i=0;i<N;i++)
    window[i]=.5-.5*Math.cos(2*Math.PI*i/(N-1));
  const total=window.reduce((a,b)=>a+b,0);
  const amplitude=(s,hz)=>{
    const c=2*Math.cos(2*Math.PI*hz/SR);
    let a=0,b=0;
    for(let i=0;i<N;i++){
      const x=s[i+2048]*window[i]+c*a-b;
      b=a;a=x;
    }
    return Math.sqrt(Math.max(0,a*a+b*b-c*a*b))*2/total;
  };
  const peakNear=(s,hz)=>{
    let best={hz:0,amp:-1};
    for(let offset=-.06;offset<=.060001;offset+=.001){
      const f=hz*(1+offset),amp=amplitude(s,f);
      if(amp>best.amp)best={hz:f,amp};
    }
    return best;
  };
  const rows=[];
  for(const speed of [-1,.5,1]){
    for(const semitones of [-5,0,7.1234]){
      const {audio,misses}=synth(speed,semitones);
      assert.equal(misses,0);
      const factor=2**(semitones/12);
      const partials=[440,660,1320].map(sourceHz=>{
        const target=sourceHz*factor,peak=peakNear(audio[0],target);
        return {sourceHz,targetHz:Number(target.toFixed(3)),
          peakHz:Number(peak.hz.toFixed(3)),
          centsError:Number((1200*Math.log2(peak.hz/target)).toFixed(3)),
          amplitude:Number(peak.amp.toFixed(6))};
      });
      for(const partial of partials){
        // These existing deterministic tones have KNOWN exact input
        // frequencies. Guard their output pitch ratio within the bounded
        // 6,144-frame Hann/0.1%-grid measurement precision (not MOS).
        assert.ok(Math.abs(partial.centsError)<12,
          {speed,semitones,partial,contract:"steady-known-partial pitch ratio"});
      }
      rows.push({speed,semitones,partials});
    }
  }
  console.log("KNOWN_PARTIAL_RIDGE_DIAGNOSTIC "+JSON.stringify({
    signal:"existing 440+660+1320 Hz stereo musical fixture with drum onset",
    rows,warning:"Known harmonic diagnostics isolate modulation sidebands; do not substitute for actual recorded-piano fidelity."
  }));
});

test("live pitch edits preserve active stereo overlap and synthesis time without artificial re-attack",()=>{
  for(const speed of [-1,0,1]){
    const g=createGranularTimePitch({sourceSampleRate:SR,outputSampleRate:SR,channelCount:2});
    let frame=90000,last=null;
    const render=()=>{
      const out=[new Float32Array(128),new Float32Array(128)];
      const result=g.render(out,{sourceFrame:frame,speed,
        loopEnabled:false,loopStartFrame:0,loopEndFrame:FRAMES},
        (ch,index)=>source[ch][index],FRAMES);
      assert.equal(result.missingFrames,0,{speed,frame});
      frame+=128*speed;
      for(const ch of out)assert.ok(ch.every(Number.isFinite));
      return out;
    };
    for(let i=0;i<16;i++)last=render();
    const before=g.state.outputFrames,old=last.map(ch=>ch[127]);
    assert.equal(before,2048);
    const changed=g.setPitch(7.1234);
    assert.equal(changed.pitchSemitones,7.1234);
    assert.equal(g.state.outputFrames,before,
      "a live pitch change must not destroy overlap grains or restart output time");
    let next=render();
    for(let ch=0;ch<2;ch++){
      const derivative=Math.max(.015,...Array.from(last[ch].slice(1),(
        value,i)=>Math.abs(value-last[ch][i])));
      const join=Math.abs(next[ch][0]-old[ch]);
      assert.ok(join<=derivative*3+.015,
        {speed,ch,join,derivative,
          reason:"old grains must continue across the actual emitted sample join"});
    }
    const after=new Float32Array(8192);
    for(let k=0;k<64;k++){
      next=render();after.set(next[0],k*128);
    }
    assert.equal(g.state.outputFrames,before+128+8192);
    const rms=Math.sqrt(after.slice(2048).
      reduce((sum,v)=>sum+v*v,0)/6144);
    assert.ok(rms>.05,{speed,rms});
    assert.ok(energy(after,659.26)>energy(after,440)*2,
      {speed,ratio:energy(after,659.26)/energy(after,440),
        reason:"incoming grains must actually reach the requested new pitch"});
    const secondBefore=g.state.outputFrames;
    g.setPitch(-5.125);
    assert.equal(g.state.outputFrames,secondBefore,
      "rapid subsequent pitch change must also preserve the active epoch");
    const lastAfter=next[0][127],oldDerivative=Math.abs(next[0][127]-next[0][126]);
    next=render();
    assert.ok(Math.abs(next[0][0]-lastAfter)<Math.max(.2,oldDerivative*5),
      {speed,reason:"no large new discontinuity at second live parameter edit"});
  }
});
