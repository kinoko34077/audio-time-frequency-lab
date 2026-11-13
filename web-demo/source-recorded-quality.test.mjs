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

/* #36 R2/R3: derive short-loop transport evidence from the SAME rights-cleared
 * actual piano recording. Read the unmodified source by its accepted WAV hash.
 * Raw PCM has a sample-exact independent oracle; pitched granular output
 * cannot correctly be expected to equal raw samples or be clickless when
 * the source interval itself is discontinuous. */
test("recorded piano source: 1..256-frame signed/zero loops distinguish source boundary from underrun",async()=>{
  const wav=await readFile(FIXTURE);
  assert.equal(createHash("sha256").update(wav).digest("hex"),EXPECT_SHA);
  const pcm=recordedPCM(wav);
  // Pick a genuinely present piano peak in the middle of this recording,
  // rather than asserting that a quiet one-frame A/B interval is audible.
  let anchor=60000,peak=0;
  for(let i=60000;i<Math.min(pcm.length-1024,120000);i++){
    const amplitude=Math.abs(pcm[i]);
    if(amplitude>peak){anchor=i;peak=amplitude;}
  }
  assert.ok(peak>.01,{anchor,peak});
  const spanValues=[1,2,16,127,128,129,256];
  const block=128,frames=1024;
  const summaries={raw:[],granular:[]};
  const loopSource=(a,b,start,speed,i)=>{
    const size=b-a;
    return a+(((start-a+i*speed)%size)+size)%size;
  };
  const makeRenderer=(a,b,speed)=>{
    const startFrame=speed<0?b-1:a;
    const renderer=createSourcePCMRenderer({
      sourceFrames:pcm.length,sourceSampleRate:RATE,outputSampleRate:RATE,
      channelCount:1,speed,startFrame,
      loopEnabled:true,loopStartFrame:a,loopEndFrame:b
    });
    // Source windows are from the original recording, never a repeated
    // synthetic loop sample. Adjacent true source PCM is cached.
    const winStart=Math.max(0,Math.min(pcm.length-SOURCE_WINDOW_FRAMES,a-2048));
    renderer.installWindow(winStart,[pcm.slice(winStart,winStart+SOURCE_WINDOW_FRAMES)]);
    return {renderer,startFrame};
  };
  const qualityStats=(out)=>{
    let energy=0,peak=0,maxJump=0,run=0,maxZeroRun=0;
    for(let i=0;i<out.length;i++){
      const sample=out[i],abs=Math.abs(sample);
      energy+=sample*sample;
      peak=Math.max(peak,abs);
      if(i)maxJump=Math.max(maxJump,Math.abs(sample-out[i-1]));
      if(abs<1e-7){run++;maxZeroRun=Math.max(maxZeroRun,run);}
      else run=0;
    }
    return {rms:round(Math.sqrt(energy/out.length)),peak:round(peak),
      maxAdjacentStep:round(maxJump),maxZeroRun};
  };
  for(const span of spanValues){
    const a=anchor,b=a+span;
    const naturalBoundary=round(Math.abs(pcm[b-1]-pcm[a]));
    for(const speed of [-8,-1,0,1,8]){
      const {renderer,startFrame}=makeRenderer(a,b,speed);
      const output=new Float32Array(frames);
      let missing=0,largestError=0;
      for(let pos=0;pos<frames;pos+=block){
        const pcmBlock=[new Float32Array(block)];
        missing+=renderer.render(pcmBlock);
        output.set(pcmBlock[0],pos);
      }
      assert.equal(missing,0,{span,speed,mode:"raw"});
      assert.equal(renderer.statistics.missingFrames,0);
      for(let i=0;i<frames;i++){
        const expected=pcm[loopSource(a,b,startFrame,speed,i)];
        largestError=Math.max(largestError,Math.abs(output[i]-expected));
      }
      assert.ok(largestError<1e-6,{span,speed,largestError});
      const measured=qualityStats(output);
      summaries.raw.push({span,speed,
        sourceBoundaryStep:naturalBoundary,
        largestError:round(largestError),missing,...measured});
      // This equality is the actual zero-insertion oracle: legitimate
      // source zeros, held 0x and boundary clicks stay part of reference.
    }
    for(const speed of [-1,0,1]){
      for(const pitch of [0,7.1234]){
        const {renderer}=makeRenderer(a,b,speed);
        const grain=createGranularTimePitch({
          sourceSampleRate:RATE,outputSampleRate:RATE,
          channelCount:1,pitchSemitones:pitch
        });
        const output=new Float32Array(frames),blockDurations=[];
        let missing=0;
        for(let pos=0;pos<frames;pos+=block){
          const buf=[new Float32Array(block)],t=performance.now();
          missing+=renderer.renderGranular(buf,grain);
          blockDurations.push(performance.now()-t);
          output.set(buf[0],pos);
        }
        assert.equal(missing,0,{span,speed,pitch,mode:"granular"});
        assert.equal(renderer.statistics.missingFrames,0);
        assert.ok(output.every(Number.isFinite),{span,speed,pitch});
        const startupMs=blockDurations[0];
        const steady=blockDurations.slice(1).sort((x,y)=>x-y);
        const ordered=blockDurations.slice().sort((x,y)=>x-y);
        const budgetMs=block/RATE*1000;
        const stats=qualityStats(output);
        summaries.granular.push({span,speed,pitch,
          sourceBoundaryStep:naturalBoundary,
          missing,firstCallbackMs:round(startupMs),
          subsequentP95Ms:round(steady[Math.floor(steady.length*.95)]),
          overBudgetCallbacks:blockDurations.filter(ms=>ms>budgetMs).length,
          renderP95Ms:round(ordered[Math.floor(ordered.length*.95)]),
          renderMaxMs:round(ordered.at(-1)),
          ...stats});
      }
    }
  }
  assert.equal(summaries.raw.length,35);
  assert.equal(summaries.granular.length,42);
  console.log("RECORDED_ULTRASHORT_BOUNDARY_AUDIT "+JSON.stringify({
    fixtureSha:EXPECT_SHA,source:"Meta Piano A0 CC0",
    anchor,sourcePeak:round(peak),sourceRate:RATE,outputQuantum:block,
    outputFramesPerCase:frames,outputQuantumBudgetMs:round(block/RATE*1000),
    raw:summaries.raw,granular:summaries.granular,
    acceptance:"RAW_SOURCE_REFERENCE_EXACT_AND_NO_CACHE_MISSES; GRANULAR_FINITE_AND_NO_CACHE_MISSES_ONLY",
    caveats:"Source-implied boundary discontinuities are allowed; a one-frame loop has no musical pitch guarantee; Node wall-clock time is not realtime audio-thread CPU or subjective sound-quality proof"
  }));
});


/* #36 R2 real-recording sonic boundary diagnostic.
 * A parameter change is delivered between two output blocks in the actual
 * DSP route; a processor reset may introduce a NEW waveform step that is
 * absent from the input source. Measure it before choosing any repair.
 * These measurements alone are not an absolute hearing/MOS standard.
 */
test("recorded piano parameter changes: separate source waveform steps from synthesis reset spikes",async()=>{
  const wav=await readFile(FIXTURE);
  assert.equal(createHash("sha256").update(wav).digest("hex"),EXPECT_SHA);
  const pcm=recordedPCM(wav);
  const anchors=[70000,76000,82000,88000,94000,100000,106000,112000,118000];
  const modes=["pitch+7.1234","freeze0","reverse-1"];
  const observations=[];
  for(const anchor of anchors){
    for(const mode of modes){
      const renderer=createSourcePCMRenderer({
        sourceFrames:pcm.length,sourceSampleRate:RATE,outputSampleRate:RATE,
        channelCount:1,startFrame:anchor,speed:1,loopEnabled:false
      });
      for(let at=0;at<pcm.length;at+=SOURCE_WINDOW_FRAMES)
        renderer.installWindow(at,[pcm.slice(at,Math.min(pcm.length,at+SOURCE_WINDOW_FRAMES))]);
      const grain=createGranularTimePitch({
        sourceSampleRate:RATE,outputSampleRate:RATE,channelCount:1,
        pitchSemitones:0
      });
      const tail=new Float32Array(128);
      for(let i=0;i<24;i++)assert.equal(renderer.renderGranular([tail],grain),0);
      const previous=tail[127],lastSource=anchor+24*128-1;
      // Same source PCM, at exactly the true change boundary.
      const unmodifiedSourceStep=Math.abs(pcm[lastSource+1]-pcm[lastSource]);
      let preDerivative=0;
      for(let i=1;i<tail.length;i++)
        preDerivative=Math.max(preDerivative,Math.abs(tail[i]-tail[i-1]));
      if(mode==="pitch+7.1234")grain.setPitch(7.1234);
      else{
        renderer.timeline.setSpeed(mode==="freeze0"?0:-1);
        grain.reset();
      }
      // Observe the full next four grain hops, not only the first output
      // sample: epoch-reset artifacts may occur AFTER the exact join point.
      const next=new Float32Array(4096);
      for(let off=0;off<next.length;off+=128){
        const block=new Float32Array(128);
        assert.equal(renderer.renderGranular([block],grain),0);
        next.set(block,off);
      }
      assert.ok(next.every(Number.isFinite));
      const postStep=Math.abs(next[0]-previous);
      const excess=Math.max(0,postStep-unmodifiedSourceStep);
      const changes=[];
      for(let i=1;i<next.length;i++)
        changes.push(Math.abs(next[i]-next[i-1]));
      const ordered=changes.slice().sort((a,b)=>a-b);
      const sourceWindow=pcm.subarray(lastSource-4096,lastSource+4096);
      const sourceDerivative=maxStep(sourceWindow);
      const grainJoins=[1024,2048,3072].map(i=>Math.abs(next[i]-next[i-1]));
      observations.push({mode,anchor,
        sourceStep:round(unmodifiedSourceStep),
        preBlockMaxStep:round(preDerivative),
        sourceLocalMaxStep:round(sourceDerivative),
        afterResetStep:round(postStep),
        addedStepAboveSource:round(excess),
        excessVsSource:round(excess/Math.max(unmodifiedSourceStep,1e-5)),
        postMaxStep:round(ordered.at(-1)),
        postP99Step:round(ordered[Math.floor(ordered.length*.99)]),
        grainHopSteps:grainJoins.map(round),
        postStepOverSource:round(ordered.at(-1)/Math.max(sourceDerivative,1e-5)),
        nextBlockRms:round(rms(next))
      });
    }
  }
  const summary=modes.map(mode=>{
    const rows=observations.filter(x=>x.mode===mode);
    const steps=rows.map(x=>x.afterResetStep).sort((a,b)=>a-b);
    return {mode,count:rows.length,
      maxStep:Math.max(...steps),
      medianStep:steps[Math.floor(steps.length/2)],
      maxSourceStep:Math.max(...rows.map(x=>x.sourceStep)),
      maxExcessVsSource:Math.max(...rows.map(x=>x.excessVsSource)),
      maxPostToSourceStepRatio:Math.max(...rows.map(x=>x.postStepOverSource)),
      maxPostJoinStep:Math.max(...rows.flatMap(x=>x.grainHopSteps))
    };
  });
  console.log("RECORDED_PARAMETER_CHANGE_CLICK_DIAGNOSTIC "+JSON.stringify({
    source:"real CC0 Meta Piano A0",sha:EXPECT_SHA,
    anchors,summary,observations,
    interpretation:"Observed reset/sample join vs original source step; not subjective click proof or a prechosen arbitrary pass threshold"
  }));
});
