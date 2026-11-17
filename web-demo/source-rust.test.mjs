import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRustTimePitch} from "./source-rust.mjs";
import {createSpectralTimePitch} from "./source-spectral.mjs";
import {createSourcePCMRenderer} from "./source-pcm-renderer.mjs";
import {fullBandPartialOptions} from "./lab-contract.mjs";

async function loadWasm(){
  const root=process.env.WARP_WEB_ROOT||"web-demo";
  const bytes=await readFile(root+"/dsp_core.wasm");
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}

function rustSettings(sampleRate){
  return {
    low:1,high:Math.min(20000,sampleRate*.49),curvature:1,invert:0,
    mode:"blend",outside:"pass",qualityIndex:1,hopDiv:8,
    engine:3,shiftHz:0,carrierHz:350,zeroMode:0,
    axisShift:0,axisReference:350,ringEnabled:false,rationalEnabled:true,
    axisPivot:350,axisSlope:1,zeroReflectGain:1,zeroReflectDecay:0,
    crusherBits:0,crusherHold:1,...fullBandPartialOptions(sampleRate)
  };
}

function peakFrequency(samples,rate,low,high){
  let peak=0,peakHz=0;
  for(let hz=low;hz<=high;hz++){
    let re=0,im=0;
    for(let i=0;i<samples.length;i++){
      const phase=2*Math.PI*hz*i/rate;
      re+=samples[i]*Math.cos(phase);im-=samples[i]*Math.sin(phase);
    }
    const magnitude=Math.hypot(re,im);
    if(magnitude>peak){peak=magnitude;peakHz=hz;}
  }
  return {frequency:peakHz,magnitude:peak};
}

test("Rust engine 3 uses the shared PCM cursor and sounds distinct from PV",async()=>{
  const wasmBytes=await loadWasm();
  const sourceRate=44100,outputRate=48000,sourceFrames=sourceRate;
  const source=Float32Array.from({length:sourceFrames},(_,i)=>
    .4*Math.sin(2*Math.PI*440*i/sourceRate));
  const renderer=createSourcePCMRenderer({
    sourceFrames,sourceSampleRate:sourceRate,outputSampleRate:outputRate,
    channelCount:1,speed:0,startFrame:sourceRate/2
  });
  renderer.installWindow(0,[source]);
  const rust=createRustTimePitch({
    wasmBytes,rustSettings:rustSettings(outputRate),
    sourceSampleRate:sourceRate,outputSampleRate:outputRate,
    channelCount:1,pitchSemitones:12
  });
  const block=new Float32Array(128),rustPcm=[];
  const cursor=renderer.timeline.state.sourceFrame;
  try{
    for(let i=0;i<48;i++){
      const missing=renderer.renderRust([block],rust);
      assert.equal(missing,0);
      rustPcm.push(...block);
    }
    assert.equal(renderer.timeline.state.sourceFrame,cursor,
      "the DSP must not advance the shared source cursor");
    assert.equal(rust.state.outputFrames,48*128);
    assert.equal(rust.state.pitchRatio,2);
    const steady=rustPcm.slice(2048);
    const measured=peakFrequency(steady,outputRate,840,920);
    assert.ok(Math.abs(measured.frequency-880)<=3,
      "Rust source-time pitch expected 880Hz, measured "+measured.frequency+"Hz");
    assert.ok(measured.magnitude>100);

    const pvRenderer=createSourcePCMRenderer({
      sourceFrames,sourceSampleRate:sourceRate,outputSampleRate:outputRate,
      channelCount:1,speed:0,startFrame:sourceRate/2
    });
    pvRenderer.installWindow(0,[source]);
    const pv=createSpectralTimePitch({
      sourceSampleRate:sourceRate,outputSampleRate:outputRate,
      channelCount:1,fftFrames:2048,hopFrames:256,pitchSemitones:0,
      phaseLock:true
    });
    const pvBlock=new Float32Array(128),pvPcm=[];
    for(let i=0;i<48;i++){
      assert.equal(pvRenderer.renderSpectral([pvBlock],pv),0);
      pvPcm.push(...pvBlock);
    }
    const pvFrequency=peakFrequency(pvPcm.slice(2048),outputRate,400,480);
    assert.ok(Math.abs(pvFrequency.frequency-440)<=3,pvFrequency);
    let difference=0;
    for(let i=2048;i<rustPcm.length;i++)
      difference+=Math.abs(rustPcm[i]-pvPcm[i]);
    difference/=(rustPcm.length-2048);
    assert.ok(difference>.1,
      "Rust engine 3 output must retain a distinct DSP identity from PV");

    rust.setPitch(0);
    assert.equal(rust.state.pitchSemitones,0);
    assert.equal(rust.state.pitchRevision,1);
    renderer.timeline.setSpeed(8);
    rust.beginTransition();
    for(let i=0;i<4;i++)renderer.renderRust([block],rust);
    assert.ok(renderer.timeline.state.sourceFrame>cursor,
      "forward transport follows the same shared source cursor");
    renderer.timeline.seek(sourceRate/2+3000);
    renderer.timeline.setSpeed(-8);
    rust.shiftSource(-3000);
    for(let i=0;i<4;i++)renderer.renderRust([block],rust);
    assert.ok(renderer.timeline.state.sourceFrame<sourceRate/2+3000,
      "reverse transport follows the same shared source cursor");

    const a=12000,b=12400;
    const endpoint=(frame)=>{
      const start=frame-2048;
      return {start,channels:[source.slice(start,start+4096)]};
    };
    renderer.beginOutputTransition();
    renderer.applyLoopConfiguration(a,b,true,[endpoint(a),endpoint(b-1)]);
    rust.reset();
    for(let i=0;i<4;i++)assert.equal(renderer.renderRust([block],rust),0);
    const loopFrame=renderer.timeline.state.sourceFrame;
    assert.ok(loopFrame>=a&&loopFrame<b,
      "Rust A/B transport escaped ["+a+", "+b+"): "+loopFrame);
  }finally{
    rust.dispose();
  }
});

test("Rust source windows retain in-range PCM at both unlooped endpoints",async()=>{
  const wasmBytes=await loadWasm();
  const sourceRate=48000,sourceFrames=12000;
  const source=Float32Array.from({length:sourceFrames},(_,i)=>
    .4*Math.sin(2*Math.PI*440*i/sourceRate));
  const silentEndpoints=[];
  for(const {label,speed,startFrame} of [
    {label:"forward near EOF",speed:1,startFrame:sourceFrames-1000},
    {label:"reverse near start",speed:-1,startFrame:1000}
  ]){
    const renderer=createSourcePCMRenderer({
      sourceFrames,sourceSampleRate:sourceRate,outputSampleRate:sourceRate,
      channelCount:1,speed,startFrame
    });
    renderer.installWindow(0,[source]);
    const rust=createRustTimePitch({
      wasmBytes,rustSettings:rustSettings(sourceRate),
      sourceSampleRate:sourceRate,outputSampleRate:sourceRate,channelCount:1,
      pitchSemitones:5
    });
    const block=new Float32Array(128);
    let energy=0,frames=0;
    try{
      for(let i=0;i<4;i++){
        assert.equal(renderer.renderRust([block],rust),0);
        for(const sample of block){energy+=sample*sample;frames++;}
      }
      const rms=Math.sqrt(energy/frames);
      if(!(rms>.01))silentEndpoints.push(label+" RMS="+rms);
      assert.equal(renderer.timeline.state.ended,false,
        label+" reached the transport endpoint before the rendered PCM did");
    }finally{rust.dispose();}
  }
  assert.deepEqual(silentEndpoints,[],
    "Rust must keep rendering the valid part of unlooped endpoint analysis windows");
});

test("Rust analysis and probe windows follow the shared cursor at signed speeds",async()=>{
  const wasmBytes=await loadWasm();
  const sampleRate=48000,sourceFrames=60000,startFrame=30000;
  const source=Float32Array.from({length:sourceFrames},(_,i)=>{
    const hz=i<20000?233:i<40000?587:997;
    return .25*Math.sin(2*Math.PI*hz*i/sampleRate)+(i%997===0?.2:0);
  });
  const windowFrames=2048,hopFrames=256;
  for(const speed of [1,8,-1,-8,0]){
    const renderer=createSourcePCMRenderer({
      sourceFrames,sourceSampleRate:sampleRate,outputSampleRate:sampleRate,
      channelCount:1,speed,startFrame
    });
    const rust=createRustTimePitch({
      wasmBytes,rustSettings:rustSettings(sampleRate),
      sourceSampleRate:sampleRate,outputSampleRate:sampleRate,channelCount:1,
      pitchSemitones:5
    });
    const direction=speed<0?-1:1;
    const block=new Float32Array(256),reads=[];
    const read=(channel,index)=>{
      assert.equal(channel,0);
      reads.push(index);
      return source[index];
    };
    const sourceWindow=(start,step,count)=>
      Array.from({length:count},(_,i)=>start+step*i);
    try{
      for(let hop=0;hop<2;hop++){
        const cursor=renderer.timeline.state.sourceFrame;
        const firstSample=speed===0?cursor-windowFrames/2:cursor;
        const expected=sourceWindow(firstSample,direction,windowFrames);
        reads.length=0;
        const state=renderer.timeline.state;
        rust.render([block],state,read,sourceFrames,renderer.timeline.sourceFrameAt);
        const inputReads=reads.filter((_,index)=>index%2===0);
        const probeReads=reads.filter((_,index)=>index%2===1);
        assert.deepEqual(inputReads,expected,
          `${speed}x hop ${hop} analysis window must begin at the shared cursor`);
        const probeStart=firstSample+direction*windowFrames/4;
        assert.deepEqual(probeReads,sourceWindow(probeStart,direction,windowFrames),
          `${speed}x hop ${hop} probe must follow the same signed source direction`);
        renderer.timeline.advance(hopFrames);
      }
    }finally{rust.dispose();}
  }
});

test("Rust analysis windows read across short A/B loops as one periodic source",async()=>{
  const wasmBytes=await loadWasm();
  const sourceRate=44100,outputRate=48000,sourceFrames=sourceRate;
  const a=12000,b=13536,length=b-a;
  const loop=Float32Array.from({length},(_,i)=>
    .3*Math.sin(2*Math.PI*317*i/sourceRate)+
    .12*Math.sin(2*Math.PI*911*i/sourceRate));
  const bounded=new Float32Array(sourceFrames);
  bounded.set(loop,a);
  const periodic=Float32Array.from({length:sourceFrames},(_,i)=>{
    const offset=((i-a)%length+length)%length;
    return loop[offset];
  });
  const render=source=>{
    const renderer=createSourcePCMRenderer({
      sourceFrames,sourceSampleRate:sourceRate,outputSampleRate:outputRate,
      channelCount:1,speed:0,startFrame:a+length/2,
      loopStartFrame:a,loopEndFrame:b,loopEnabled:true
    });
    renderer.installWindow(0,[source]);
    const rust=createRustTimePitch({
      wasmBytes,rustSettings:rustSettings(outputRate),
      sourceSampleRate:sourceRate,outputSampleRate:outputRate,channelCount:1
    });
    const block=new Float32Array(128),pcm=[];
    try{
      for(let i=0;i<32;i++){
        assert.equal(renderer.renderRust([block],rust),0);
        pcm.push(...block);
      }
      assert.equal(renderer.timeline.state.sourceFrame,a+length/2);
      return pcm;
    }finally{rust.dispose();}
  };
  const looped=render(bounded),tiled=render(periodic);
  let maximumDifference=0;
  for(let i=0;i<looped.length;i++)
    maximumDifference=Math.max(maximumDifference,Math.abs(looped[i]-tiled[i]));
  assert.equal(maximumDifference,0,
    "analysis and probe windows must wrap at A/B instead of reading outside the loop");
});
