import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {createSourcePCMRenderer,SOURCE_WINDOW_FRAMES} from "./source-pcm-renderer.mjs";
import {createGranularTimePitch} from "./source-granular.mjs";

// Audio Lab #36 R2/R3 — REAL RECORDED audio, not a synthesized oscillator.
// Exact CC0 fixture reused from frequency-warp-vst; not shipped in Pages.
// Musical/perceptual acceptance is NOT implied by deterministic measurements.
const FIXTURE="web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav";
const EXPECT_SHA="69bbdab7ee718e174a23850f5525ff87761ca904a4445e6ae9138ca42b7dd261";
const FRAMES=8192,BLOCK=128,RATE=48000;
const round=n=>Number(n.toFixed(6));
function recordedPCM(bytes){
  assert.equal(bytes.toString("ascii",0,4),"RIFF");
  assert.equal(bytes.toString("ascii",8,12),"WAVE");
  let fmt=null,data=null;
  for(let at=12;at+8<=bytes.length;){
    const type=bytes.toString("ascii",at,at+4);
    const count=bytes.readUInt32LE(at+4),body=at+8;
    assert.ok(body+count<=bytes.length,"WAV chunk bounds");
    if(type==="fmt "){
      assert.ok(count>=16,"valid PCM fmt");
      fmt={encoding:bytes.readUInt16LE(body),channels:bytes.readUInt16LE(body+2),
        sampleRate:bytes.readUInt32LE(body+4),bits:bytes.readUInt16LE(body+14)};
    }else if(type==="data")data=bytes.subarray(body,body+count);
    at=body+count+(count%2);
  }
  assert.deepEqual(fmt,{encoding:1,channels:1,sampleRate:RATE,bits:16});
  assert.ok(data&&data.length===RATE*3*2,"must be the 3 s recorded piano");
  const pcm=new Float32Array(data.length/2);
  for(let i=0;i<pcm.length;i++)pcm[i]=data.readInt16LE(i*2)/32768;
  return pcm;
}
const rms=x=>Math.sqrt(x.reduce((a,b)=>a+b*b,0)/x.length);
const acRms=x=>{
  const avg=x.reduce((a,b)=>a+b,0)/x.length;
  return Math.sqrt(x.reduce((a,b)=>a+(b-avg)**2,0)/x.length);
};
function maxStep(x){
  let max=0;
  for(let i=1;i<x.length;i++)max=Math.max(max,Math.abs(x[i]-x[i-1]));
  return max;
}
function frequencyAmplitude(x,hz){
  // Simple measured tone component; not a license to call harmonics artifact-free.
  let real=0,imag=0;
  for(let i=0;i<x.length;i++){
    const rad=2*Math.PI*hz*i/RATE;
    real+=x[i]*Math.cos(rad);
    imag-=x[i]*Math.sin(rad);
  }
  return 2*Math.hypot(real,imag)/x.length;
}
function renderRecording(pcm,{mode,speed,pitch=0,startFrame=8192}){
  const renderer=createSourcePCMRenderer({
    sourceFrames:pcm.length,sourceSampleRate:RATE,outputSampleRate:RATE,
    channelCount:1,speed,startFrame,loopEnabled:true,
    loopStartFrame:0,loopEndFrame:pcm.length
  });
  // A bounded cache can hold this 3 s fixture in three ordinary source windows.
  for(let at=0;at<pcm.length;at+=SOURCE_WINDOW_FRAMES)
    renderer.installWindow(at,[pcm.slice(at,Math.min(pcm.length,at+SOURCE_WINDOW_FRAMES))]);
  const grain=mode==="granular"?createGranularTimePitch({
    sourceSampleRate:RATE,outputSampleRate:RATE,channelCount:1,
    pitchSemitones:pitch
  }):null;
  const output=new Float32Array(FRAMES),durations=[],start=performance.now();
  for(let at=0;at<FRAMES;at+=BLOCK){
    const block=[new Float32Array(BLOCK)],t=performance.now();
    const missing=mode==="granular"?renderer.renderGranular(block,grain):
      renderer.render(block);
    durations.push(performance.now()-t);
    assert.equal(missing,0,"fully cached recorded source must not underrun");
    output.set(block[0],at);
  }
  const wallMs=performance.now()-start;
  assert.equal(renderer.statistics.missingFrames,0);
  assert.ok(output.every(Number.isFinite),"no NaN/Inf on recorded-source render");
  const ordered=durations.slice().sort((a,b)=>a-b);
  const first=output.subarray(0,4096),last=output.subarray(4096);
  return {
    output,stats:{
      mode,speed,pitch,sourceFrame:startFrame,frames:FRAMES,
      outputRms:round(rms(output)),outputAcRms:round(acRms(output)),
      firstHalfRms:round(rms(first)),secondHalfRms:round(rms(last)),
      maxAdjacentStep:round(maxStep(output)),
      pianoA0_27Hz:round(frequencyAmplitude(output,27.5)),
      shiftedA0_41Hz:round(frequencyAmplitude(output,27.5*2**(7/12))),
      renderWallMs:round(wallMs),
      per128p50Ms:round(ordered[Math.floor(ordered.length*.5)]),
      per128p95Ms:round(ordered[Math.floor(ordered.length*.95)]),
      per128MaxMs:round(ordered.at(-1)),
      callbackBudgetMs:round(128/RATE*1000),
      budgetEvidence:"OFFLINE_NODE_WALL_TIME_ONLY_NOT_AUDIO_THREAD_OR_DEVICE",
      missingFrames:renderer.statistics.missingFrames
    }
  };
}
test("CC0 actual upright-piano source feeds raw and granular renderers with objective quality axes",async()=>{
  const wav=await readFile(FIXTURE);
  assert.equal(createHash("sha256").update(wav).digest("hex"),EXPECT_SHA,
    "never silently substitute generated or modified audio for this recording");
  const pcm=recordedPCM(wav);
  const inputRms=rms(pcm);
  assert.ok(inputRms>1e-5,"fixture must contain audible real piano samples");
  // First establish strict neutral reference with the real source (NOT a constant tone).
  const startFrame=8192;
  const raw=renderRecording(pcm,{mode:"raw",speed:1,startFrame});
  const neutral=renderRecording(pcm,{mode:"granular",speed:1,pitch:0,startFrame});
  const backward=renderRecording(pcm,{mode:"granular",speed:-1,pitch:0,startFrame:90000});
  let rawErr=0,neutralErr=0,reverseErr=0;
  for(let i=0;i<FRAMES;i++){
    const expected=pcm[startFrame+i];
    rawErr=Math.max(rawErr,Math.abs(raw.output[i]-expected));
    neutralErr=Math.max(neutralErr,Math.abs(neutral.output[i]-expected));
    reverseErr=Math.max(reverseErr,Math.abs(backward.output[i]-pcm[90000-i]));
  }
  assert.ok(rawErr<1e-6,{rawErr});
  assert.ok(neutralErr<1e-5,{neutralErr});
  assert.ok(reverseErr<1e-5,{reverseErr});
  const pitched=renderRecording(pcm,{mode:"granular",speed:1,pitch:7,startFrame});
  const frozen=renderRecording(pcm,{mode:"granular",speed:0,pitch:0,startFrame});
  const fast=renderRecording(pcm,{mode:"granular",speed:8,pitch:0,startFrame});
  assert.ok(frozen.stats.outputAcRms>1e-7,
    "real recorded 0x must have AC content, not a held PCM sample");
  // No arbitrary MOS or uncalibrated absolute frequency quality gate.
  // Detect actual generated PCM, observe explicit recorded piano spectral and
  // transient quality axes for engineering review; fail on silence/nonfinite.
  for(const {stats} of [pitched,frozen,fast]){
    assert.ok(stats.outputRms>1e-7,{mode:stats.mode,speed:stats.speed,pitch:stats.pitch,
      rms:stats.outputRms});
  }
  console.log("RECORDED_META_PIANO_R2_R3 "+JSON.stringify({
    sha256:EXPECT_SHA,source:"Meta Open Sound upright piano A0",license:"CC0-1.0",
    rate:RATE,channels:1,originalFrames:pcm.length,
    originalRms:round(inputRms),
    inputAttackRms:round(rms(pcm.subarray(0,4096))),
    inputSustainRms:round(rms(pcm.subarray(48000,52096))),
    outputNeutralMaxError:round(neutralErr),
    outputRawMaxError:round(rawErr),
    outputReverseMaxError:round(reverseErr),
    testCases:[raw.stats,neutral.stats,backward.stats,
      pitched.stats,frozen.stats,fast.stats],
    qualityStatus:"RECORDED_SOURCE_MEASURED_NO_PERCEPTUAL_OR_HARDWARE_ACCEPTANCE",
    limitations:"Single real MONO piano A0 recording; not multitrack, speech, stereo, iPhone, CPU/GC realtime or DAC timing"
  }));
});