import test from "node:test";
import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {createSourceTimeline} from "./source-timeline.mjs";
import {createReflectedPCMSource} from "./reflected-pcm-source.mjs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {createAmTimePitch} from "./source-am.mjs";

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
function render(speed,pitch,frames=8192,{phaseLock=false}={}){
  const renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:CENTER,speed
  });
  renderer.installWindow(0,source.map(x=>x.slice(0,65536)));
  renderer.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  renderer.installWindow(START+65536,source.map(x=>x.slice(START+65536,START+131072)));
  const spectral=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2,pitchSemitones:pitch,
    phaseLock
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
test("live PV parameter edit keeps the output envelope through the control boundary",()=>{
  const frames=96_000,pcm=new Float32Array(frames);
  for(let i=0;i<frames;i++)pcm[i]=.3*Math.sin(2*Math.PI*440*i/SR)+
    .12*Math.sin(2*Math.PI*659.25*i/SR+.4);
  const renderer=createSourcePCMRenderer({sourceFrames:frames,
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:1,
    startFrame:24_000,speed:1});
  renderer.installWindow(0,[pcm.slice(0,65_536)]);
  renderer.installWindow(65_536,[pcm.slice(65_536)]);
  const pv=createSpectralTimePitch({sourceSampleRate:SR,
    outputSampleRate:SR,channelCount:1,phaseLock:true});
  const render=count=>{
    const output=new Float32Array(count);
    for(let at=0;at<count;at+=128){
      const block=new Float32Array(128);
      assert.equal(renderer.renderSpectral([block],pv),0);
      output.set(block,at);
    }
    return output;
  };
  render(8192);
  const beforePitch=render(2048);
  pv.setPitch(.25);
  const afterPitch=render(2048);
  const beforeSpeed=render(2048);
  renderer.timeline.setSpeed(.9);
  const afterSpeed=render(2048);
  const blockRms=buffer=>Array.from({length:buffer.length/128},(_,index)=>
    rms(buffer.subarray(index*128,(index+1)*128)));
  const maxStep=buffer=>{
    let max=0;
    for(let i=1;i<buffer.length;i++)max=Math.max(max,
      Math.abs(buffer[i]-buffer[i-1]));
    return max;
  };
  const evidence={beforePitch:blockRms(beforePitch),afterPitch:blockRms(afterPitch),
    beforeSpeed:blockRms(beforeSpeed),afterSpeed:blockRms(afterSpeed)};
  assert.ok(Object.values(evidence).flat().every(Number.isFinite));
  for(const [label,before,after] of [
    ["pitch",evidence.beforePitch,evidence.afterPitch],
    ["speed",evidence.beforeSpeed,evidence.afterSpeed]
  ]){
    const localLevel=rms(Float32Array.from(before.slice(-8)));
    assert.ok(after[0]>=localLevel*.85,
      label+" edit must not flatten the first 128 samples toward one held sample: "+
        JSON.stringify({localLevel,firstEditedBlock:after[0]}));
  }
  for(const [label,before,after] of [["pitch",beforePitch,afterPitch],
    ["speed",beforeSpeed,afterSpeed]]){
    const steadyStep=maxStep(before.subarray(-512));
    const editStep=maxStep(after.subarray(0,512));
    assert.ok(editStep<=steadyStep*2+.01,
      label+" edit must stay within the source's neighboring sample-step range: "+
        JSON.stringify({steadyStep,editStep}));
  }
});
test("44.1k source through 48k output preserves absolute pitch during a 0x spectral freeze",()=>{
  const sourceRate=44100,outputRate=48000,frames=110250;
  const mono=new Float32Array(frames);
  for(let i=0;i<frames;i++)mono[i]=.42*Math.sin(2*Math.PI*440*i/sourceRate);
  const reader=createSourcePCMRenderer({
    sourceFrames:frames,sourceSampleRate:sourceRate,outputSampleRate:outputRate,
    channelCount:1,startFrame:60000,speed:0
  });
  reader.installWindow(40000,[mono.slice(40000,40000+65536)]);
  const stft=createSpectralTimePitch({sourceSampleRate:sourceRate,
    outputSampleRate:outputRate,channelCount:1});
  const out=new Float32Array(8192);
  for(let i=0;i<8192;i+=128){
    const block=new Float32Array(128);
    assert.equal(reader.renderSpectral([block],stft),0);
    out.set(block,i);
  }
  const power=f=>{
    let re=0,im=0;
    for(let i=2048;i<out.length;i++){
      const angle=2*Math.PI*f*(i-2048)/outputRate;
      re+=out[i]*Math.cos(angle);
      im+=out[i]*Math.sin(angle);
    }
    return Math.hypot(re,im);
  };
  assert.ok(power(440)>power(479)*1.6,
    "source/output sample-rate conversion must not sharpen 440 Hz into 479 Hz");
});
test("one-sample A/B is a sample-exact spectral ANALYSIS CENTER; audible context is not an artificial DC/comb loop",()=>{
  const frame=90037,renderer=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:frame,speed:0,
    loopEnabled:true,loopStartFrame:frame,loopEndFrame:frame+1
  });
  renderer.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  const stft=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2,pitchSemitones:0
  });
  const out=[new Float32Array(8192),new Float32Array(8192)];
  for(let i=0;i<8192;i+=128){
    const block=[new Float32Array(128),new Float32Array(128)];
    assert.equal(renderer.renderSpectral(block,stft),0);
    for(let ch=0;ch<2;ch++)out[ch].set(block[ch],i);
  }
  assert.equal(renderer.timeline.state.sourceFrame,frame,
    "source-time center is exactly the selected single original sample");
  const body=out[0].subarray(2048);
  assert.ok(rms(body)>.045,{rms:rms(body)});
  assert.ok(Math.max(...body)-Math.min(...body)>.13,
    "a one-sample A/B must not synthesize a held PCM constant / DC");
  assert.ok(binEnergy(out[0],440)>binEnergy(out[0],200)*2,
    "frozen STFT must recover real local musical harmonics, not invented 1-sample grain rate");
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

test("real PV mode peak-locks neighboring spectral bins but retains signed source-time and non-DC freeze",()=>{
  for(const speed of [-1,0,1]){
    const a=render(speed,0,8192,{phaseLock:true});
    const b=render(speed,0,8192,{phaseLock:false});
    assert.equal(a.misses,0,{speed});
    assert.ok(Math.abs(a.end-(CENTER+8192*speed))<1,{speed,frame:a.end});
    assert.ok(rms(a.output[0].subarray(2048))>.04,{speed,
      rms:rms(a.output[0].subarray(2048))});
    assert.ok(a.output[0].every(Number.isFinite));
    const diff=rms(a.output[0].map((x,i)=>x-b.output[0][i]).subarray(1024));
    if(speed===1)
      assert.ok(diff<1e-5,{speed,diff},
        "1x/0 semitone must be original PCM in both models");
    else
      assert.ok(diff>1e-6,{speed,diff},
        "PV must apply real peak-phase locking when processing is requested");
  }
  const g=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,phaseLock:true
  });
  assert.equal(g.state.algorithm,"phase-vocoder-peak-locked");
});


test("neutral 1x/0-semitone STFT and PV output the original PCM, not overlapping phased copies",()=>{
  for(const phaseLock of [false,true]){
    const {output,misses,end}=render(1,0,8192,{phaseLock});
    assert.equal(misses,0);
    assert.equal(end,CENTER+8192);
    for(let ch=0;ch<2;ch++){
      let maxError=0;
      for(let i=0;i<8192;i++)
        maxError=Math.max(maxError,Math.abs(output[ch][i]-source[ch][CENTER+i]));
      assert.ok(maxError<1e-5,{phaseLock,ch,maxError});
    }
  }
});

test("neutral identity and short-loop spectral synthesis use the same source clock",()=>{
  const a=88000,b=96000,p=createSourcePCMRenderer({
    sourceFrames:FRAMES,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,speed:1,startFrame:b-48,
    loopStartFrame:a,loopEndFrame:b,loopEnabled:true
  });
  p.installWindow(START,source.map(x=>x.slice(START,START+65536)));
  const model=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2
  });
  const out=[new Float32Array(128),new Float32Array(128)];
  assert.equal(p.renderSpectral(out,model),0);
  for(let i=0;i<128;i++){
    const original=a+((b-48+i-a)%(b-a));
    for(let ch=0;ch<2;ch++)
      assert.ok(Math.abs(out[ch][i]-source[ch][original])<1e-5,{ch,i});
  }
  assert.equal(p.timeline.state.sourceFrame,a+80);
});


test("neutral identity output fades from last audible PCM on an abrupt seek",()=>{
  // Independent review: the synth resets on seek but 1x / 0-semitone raw
  // identity had bypassed the synth fade, joining +0.8 to -0.8 instantly.
  const n=32768,mid=n/2;
  const pcm=[
    Float32Array.from({length:n},(_,i)=>i<mid?.8:-.8),
    Float32Array.from({length:n},(_,i)=>i<mid?.4:-.4)
  ];
  const renderer=createSourcePCMRenderer({
    sourceFrames:n,sourceSampleRate:SR,outputSampleRate:SR,
    channelCount:2,startFrame:512,speed:1
  });
  renderer.installWindow(0,pcm);
  const synth=createSpectralTimePitch({
    sourceSampleRate:SR,outputSampleRate:SR,channelCount:2,
    pitchSemitones:0
  });
  const output=()=>[new Float32Array(128),new Float32Array(128)];
  const before=output();
  assert.equal(renderer.renderSpectral(before,synth),0);
  assert.ok(Math.abs(before[0][127]-.8)<1e-6);
  assert.ok(Math.abs(before[1][127]-.4)<1e-6);
  // Mirrors the worklet's seek-window handler; do not recreate its node.
  renderer.beginOutputTransition();
  renderer.timeline.seek(mid+256);
  synth.reset();
  const after=output();
  assert.equal(renderer.renderSpectral(after,synth),0);
  assert.ok(Math.abs(after[0][0]-before[0][127])<.02,
    "first sample after seek must preserve previous audible PCM");
  assert.ok(Math.abs(after[1][0]-before[1][127])<.02);
  assert.ok(Math.abs(after[0][127]+.8)<.03,
    "transition must complete at the new source, not hold the old note");
  assert.ok(Math.abs(after[1][127]+.4)<.02);
  for(let i=1;i<128;i++){
    assert.ok(Math.abs(after[0][i]-after[0][i-1])<.02,
      "neutral seek crossfade must not introduce a sharp PCM step");
  }
  const steady=output();
  assert.equal(renderer.renderSpectral(steady,synth),0);
  assert.ok(steady[0].every(x=>Math.abs(x+.8)<1e-5));
  assert.ok(steady[1].every(x=>Math.abs(x+.4)<1e-5));
});


test("micro-pitch actual PCM diagnostics: stable tones must be measured, not inferred from a mode label",()=>{
  const sampleCount=65536,sourceAt=10000,outFrames=16384,f0=440;
  const pcm=Float32Array.from({length:sampleCount},(_,i)=>
    .35*Math.sin(2*Math.PI*f0*i/SR));
  const fitTone=(out,atHz)=>{
    const begin=4096,count=out.length-begin,omega=2*Math.PI*atHz/SR;
    let cos=0,sin=0,power=0;
    for(let i=begin;i<out.length;i++){
      const v=out[i];cos+=v*Math.cos(omega*i);
      sin+=v*Math.sin(omega*i);power+=v*v;
    }
    const a=2*cos/count,b=2*sin/count;
    let residual=0;
    for(let i=begin;i<out.length;i++){
      const err=out[i]-a*Math.cos(omega*i)-b*Math.sin(omega*i);
      residual+=err*err;
    }
    const amplitude=Math.hypot(a,b),rms=Math.sqrt(power/count);
    const residualDb=20*Math.log10(Math.max(1e-15,Math.sqrt(residual/count))/Math.max(rms,1e-15));
    const windowRms=[];
    for(let i=begin;i+2048<=out.length;i+=2048){
      let power=0;for(let j=0;j<2048;j++)power+=out[i+j]*out[i+j];
      windowRms.push(Math.sqrt(power/2048));
    }
    const avg=windowRms.reduce((a,b)=>a+b,0)/windowRms.length;
    const variance=windowRms.reduce((a,b)=>a+(b-avg)**2,0)/windowRms.length;
    return {amplitude:Number(amplitude.toFixed(5)),
      rms:Number(rms.toFixed(5)),
      residualDb:Number(residualDb.toFixed(2)),
      rmsCV:Number((Math.sqrt(variance)/avg).toFixed(4))};
  };
  const measurements=[];
  for(const phaseLock of [false,true]){
    for(const pitch of [-.1,-.02,.02,.1]){
      const renderer=createSourcePCMRenderer({
        sourceFrames:sampleCount,sourceSampleRate:SR,outputSampleRate:SR,
        channelCount:1,startFrame:sourceAt,speed:1
      });
      renderer.installWindow(0,[pcm]);
      const synth=createSpectralTimePitch({sourceSampleRate:SR,
        outputSampleRate:SR,channelCount:1,pitchSemitones:pitch,phaseLock});
      const output=new Float32Array(outFrames);
      let misses=0;
      const start=performance.now();
      for(let i=0;i<outFrames;i+=128){
        const block=new Float32Array(128);
        misses+=renderer.renderSpectral([block],synth);
        output.set(block,i);
      }
      assert.equal(misses,0,{phaseLock,pitch});
      assert.equal(renderer.timeline.state.sourceFrame,sourceAt+outFrames);
      const result=fitTone(output,f0*2**(pitch/12));
      assert.ok(Object.values(result).every(Number.isFinite),{phaseLock,pitch,result});
      measurements.push({mode:phaseLock?"pv":"spectral",pitch,...result,
        renderMs:Number((performance.now()-start).toFixed(1))});
    }
  }
  console.log("MICROPITCH_BASELINE_PCM "+JSON.stringify(measurements));
});


test("small fractional pitch changes retain harmonic amplitudes across low and high bins",()=>{
  // The old unrotated j/j+1 deposition causes near-half-bin cancellation.
  // This is heard as a comb-like EQ when harmonic numbers differ.
  const frequencies=[220,440,880,1760,3520],amplitude=.12;
  const n=65536,startFrame=10000,total=16384;
  const pcm=Float32Array.from({length:n},(_,i)=>frequencies.reduce(
    (sum,hz)=>sum+amplitude*Math.sin(2*Math.PI*hz*i/SR),0));
  const measure=(out,f)=>{
    const begin=4096,count=out.length-begin;
    let a=0,b=0;
    for(let i=begin;i<out.length;i++){
      const theta=2*Math.PI*f*i/SR;
      a+=out[i]*Math.cos(theta);b+=out[i]*Math.sin(theta);
    }
    return 2*Math.hypot(a,b)/count;
  };
  const gains=[];
  for(const phaseLock of [false,true]){
    for(const pitch of [-.1,.1]){
      const renderer=createSourcePCMRenderer({
        sourceFrames:n,sourceSampleRate:SR,outputSampleRate:SR,
        channelCount:1,startFrame,speed:1
      });
      renderer.installWindow(0,[pcm]);
      const synth=createSpectralTimePitch({sourceSampleRate:SR,
        outputSampleRate:SR,channelCount:1,pitchSemitones:pitch,phaseLock});
      const out=new Float32Array(total);
      for(let i=0;i<total;i+=128){
        const block=new Float32Array(128);
        assert.equal(renderer.renderSpectral([block],synth),0);
        out.set(block,i);
      }
      const ratios=frequencies.map(hz=>measure(out,hz*2**(pitch/12))/amplitude);
      gains.push({model:phaseLock?"pv":"spectral",pitch,
        gains:ratios.map(v=>Number(v.toFixed(4)))});
      for(let i=0;i<ratios.length;i++)
        assert.ok(ratios[i]>.8&&ratios[i]<1.2,
          "tiny pitch must not cause comb-like harmonic notch"+
          JSON.stringify({phaseLock,pitch,hz:frequencies[i],gain:ratios[i]}));
    }
  }
  console.log("MICROPITCH_HARMONIC_GAIN "+JSON.stringify(gains));
});


test("AM uses its own smoothed envelope DSP against one signed shared source-time clock",()=>{
  const sr=48000,length=65536,A=10000,B=60000,start=30000;
  const src=[new Float32Array(length),new Float32Array(length)];
  for(let i=0;i<length;i++){
    const time=i/sr,accent=.3+.4*Math.sin(2*Math.PI*4*time)**2;
    const hit=i%7000<90?.22*Math.exp(-(i%7000)/40):0;
    src[0][i]=accent*(.28*Math.sin(2*Math.PI*440*time))+hit;
    src[1][i]=accent*(.24*Math.sin(2*Math.PI*330*time+.5))+hit*.5;
  }
  const run=(mode,speed,pitch=3.25)=>{
    const reader=createSourcePCMRenderer({sourceFrames:length,
      sourceSampleRate:sr,outputSampleRate:sr,channelCount:2,
      startFrame:start,speed,loopEnabled:true,loopStartFrame:A,loopEndFrame:B});
    reader.installWindow(0,src);
    const dsp=mode==="am"?createAmTimePitch({sourceSampleRate:sr,
      outputSampleRate:sr,channelCount:2,pitchSemitones:pitch}):
      createSpectralTimePitch({sourceSampleRate:sr,outputSampleRate:sr,
        channelCount:2,pitchSemitones:pitch,phaseLock:true});
    const out=[new Float32Array(8192),new Float32Array(8192)];
    let misses=0;
    for(let i=0;i<8192;i+=128){
      const frames=[new Float32Array(128),new Float32Array(128)];
      misses+=reader.renderGranular(frames,dsp);
      for(let ch=0;ch<2;ch++)out[ch].set(frames[ch],i);
    }
    return {out,misses,frame:reader.timeline.state.sourceFrame,state:dsp.state};
  };
  for(const speed of [-8,-1,0,1,8]){
    const rendered=run("am",speed);
    assert.equal(rendered.misses,0,{speed});
    assert.equal(rendered.state.algorithm,"am-envelope-pv-continuous");
    assert.equal(rendered.state.carrierAlgorithm,"phase-vocoder-peak-locked");
    assert.ok(rendered.out.every(x=>x.every(Number.isFinite)));
    assert.ok(rms(rendered.out[0].subarray(2048))>.01,{speed});
    assert.ok(rendered.frame>=A&&rendered.frame<B,{speed,frame:rendered.frame});
  }
  const a=run("am",.65),p=run("pv",.65);
  const difference=rms(a.out[0].map((value,i)=>value-p.out[0][i]).subarray(2048));
  assert.ok(difference>1e-5,{difference,state:a.state},
    "AM must apply audible gain-envelope changes, not alias PV by name");
  assert.ok(a.state.correctionFrames>0,a.state);
  const changed=createAmTimePitch({sourceSampleRate:sr,outputSampleRate:sr,
    channelCount:2,pitchSemitones:0});
  assert.equal(changed.setPitch(7.1234).pitchSemitones,7.1234);
  assert.throws(()=>changed.setPitch(13),/pitch/);
  assert.throws(()=>changed.shiftSource(Number.NaN),/scratch/);
});


test("AM 0x source RMS does not alias a 3 kHz 16-sample waveform period",()=>{
  // Codex PR84 P2: a 16-sample probe stride sampled only ONE 3 kHz
  // sine phase; 0x frozen at positions 24001/24004 drove the gain toward
  // opposite clamps despite identical steady source energy.
  const sr=48000,n=48000,amp=.25;
  const mono=Float32Array.from({length:n},(_,i)=>
    amp*Math.sin(2*Math.PI*3000*i/sr));
  const expectedRms=amp/Math.SQRT2;
  const observed=[];
  for(const frame of [24000,24001,24004,24007]){
    const reader=createSourcePCMRenderer({
      sourceFrames:n,sourceSampleRate:sr,outputSampleRate:sr,
      channelCount:1,startFrame:frame,speed:0
    });
    reader.installWindow(0,[mono]);
    const engine=createAmTimePitch({
      sourceSampleRate:sr,outputSampleRate:sr,channelCount:1,
      pitchSemitones:0
    });
    const t0=performance.now();
    let signalPower=0,missing=0;
    for(let offset=0;offset<8192;offset+=128){
      const out=new Float32Array(128);
      missing+=reader.renderGranular([out],engine);
      if(offset>=4096)for(const sample of out){
        assert.ok(Number.isFinite(sample));
        signalPower+=sample*sample;
      }
    }
    assert.equal(missing,0,{frame});
    assert.equal(reader.timeline.state.sourceFrame,frame,
      "0x keeps one canonical source frame for every AM update");
    const state=engine.state;
    assert.ok(Math.abs(state.sourcePeak-expectedRms)<.008,
      "AM source envelope must represent full-wave RMS at every freeze phase"+
      JSON.stringify({frame,peak:state.sourcePeak,expectedRms}));
    observed.push({frame,gain:state.gain,peak:state.sourcePeak,
      outputRms:Math.sqrt(signalPower/4096),
      renderMs:performance.now()-t0});
  }
  const gains=observed.map(o=>o.gain);
  assert.ok(Math.max(...gains)-Math.min(...gains)<.05,
    "equal source energy must not produce phase-dependent AM gain"+
    JSON.stringify(observed));
  console.log("AM_3KHZ_FREEZE_PHASE_RMS "+JSON.stringify(observed));
});

// A reflected *center*, not a reflected PCM analysis window.
test("mapped spectral center retains original context for one-sample and signed reflected intervals",()=>{
  const sr=48000,n=16000,center=8000;
  const l=Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*440*i/sr));
  const channels=[l,l.map(v=>-v)];
  function run({a,b,start=0,speed=0,mapped=true}){
    const reflected=createReflectedPCMSource({channels,startFrame:a,endFrame:b});
    const clock=createSourceTimeline({sourceFrames:mapped?reflected.sourceFrames:n,
      sourceSampleRate:sr,startFrame:mapped?start:a,speed,loopEnabled:mapped});
    const centers=[],reads=[];
    const synth=createSpectralTimePitch({sourceSampleRate:sr,outputSampleRate:sr,channelCount:2,phaseLock:true,
      mapAnalysisCenter:mapped?p=>{const x=reflected.toSourceFrame(p);centers.push(x);return x;}:null});
    const output=[new Float32Array(8192),new Float32Array(8192)];
    let lo=Infinity,hi=-Infinity;
    const read=(ch,i)=>{lo=Math.min(lo,i);hi=Math.max(hi,i);return channels[ch][i];};
    for(let p=0;p<8192;p+=128){
      const result=synth.render(output.map(c=>c.subarray(p,p+128)),clock.state,read,n);
      assert.equal(result.missingFrames,0);clock.advance(128);
    }
    return {output,centers,lo,hi};
  }
  const hold=run({a:center,b:center+1,speed:0,mapped:false});
  const one=run({a:center,b:center+1,speed:8});
  assert.deepEqual(one.output,hold.output);
  assert.ok(one.lo<center-500&&one.hi>center+500);
  for(const speed of [-1,1,.5]){
    const a=center-200,b=center+201,x=run({a,b,speed,start:100});
    assert.ok(x.centers.every(v=>v>=a&&v<=b-1));
    assert.ok(x.centers.some((v,i)=>i&&v<x.centers[i-1])&&x.centers.some((v,i)=>i&&v>x.centers[i-1]));
    assert.ok(x.lo<a&&x.hi>b);
    const left=x.output[0],right=x.output[1];
    assert.ok(rms(left.subarray(2048))>.04);
    assert.ok(binEnergy(left,440)>3*Math.max(binEnergy(left,220),binEnergy(left,880)));
    assert.ok(left.every((v,i)=>Math.abs(v+right[i])<1e-5));
  }
  assert.throws(()=>createSpectralTimePitch({sourceSampleRate:sr,outputSampleRate:sr,mapAnalysisCenter:1}),/configuration/);
  const bad=createSpectralTimePitch({sourceSampleRate:sr,outputSampleRate:sr,mapAnalysisCenter:()=>NaN});
  assert.throws(()=>bad.render([new Float32Array(128)],{sourceFrame:0,speed:0},()=>0,n),/mapped analysis center/);
});
