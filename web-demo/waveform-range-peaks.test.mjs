import test from "node:test";
import assert from "node:assert/strict";
import {overviewBinCount,overviewNeedsResample,readOverviewPeak,readOverviewPeaks} from "./waveform-range-peaks.mjs";

test("overview grid belongs to source length, not display size",()=>{
  assert.equal(overviewBinCount(740),740);
  assert.equal(overviewBinCount(240),240);
  assert.equal(overviewBinCount(4096),2048);
  assert.equal(overviewBinCount(48_000*3600),2048);
});

test("resize does not restart an incomplete overview scan",()=>{
  const source={sourceFrames:4096,overviewBinCount:2048,
    overviewPeaks:Array(2048).fill(null),overviewBuildComplete:false};
  assert.equal(overviewNeedsResample(source,390),false);
  assert.equal(overviewNeedsResample(source,844),false);
});

test("completed partial overview retries only if bins remain missing",()=>{
  const source={sourceFrames:4096,overviewBinCount:2048,overviewBuildComplete:true,
    overviewPeaks:Array(2048).fill(null)};
  source.overviewPeaks[12]=[-.5,.5];
  assert.equal(overviewNeedsResample(source,390),true);
  assert.equal(overviewNeedsResample(source,844),true);
  source.overviewPeaks=Array.from({length:2048},()=>[-.1,.1]);
  assert.equal(overviewNeedsResample(source,390),false);
  assert.equal(overviewNeedsResample(source,844),false);
  assert.equal(overviewNeedsResample({sourceFrames:4096},390),true);
});

test("advancing the overview generation cancels a pending bounded read immediately",async()=>{
  const {advanceOverviewBuildToken}=await import("./waveform-range-peaks.mjs");
  assert.equal(typeof advanceOverviewBuildToken,"function");
  let releaseRead,markReadStarted,readCount=0;
  const pendingRead=new Promise(resolve=>{releaseRead=resolve;});
  const readStarted=new Promise(resolve=>{markReadStarted=resolve;});
  const source={sourceFrames:12,maxReadFrames:4,overviewBuildToken:0,
    async read(startFrame,frameCount){
      readCount++;markReadStarted();await pendingRead;
      return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
    }};
  const token=advanceOverviewBuildToken(source);
  const peak=readOverviewPeak(source,0,1,{
    shouldContinue:()=>source.overviewBuildToken===token
  });
  await readStarted;
  advanceOverviewBuildToken(source);
  releaseRead();
  assert.equal(await peak,null,"a replaced source generation must abandon the previous read");
  assert.equal(readCount,1,"cancellation must stop before requesting the next PCM chunk");
});

test("overview peak contains only the source frames assigned to its display bin",async()=>{
  const reads=[];
  const source={sourceFrames:9_600,maxReadFrames:40,
    async read(startFrame,frameCount,options){
      reads.push({startFrame,frameCount,priority:options?.priority});
      const channel=new Float32Array(frameCount);
      for(let i=0;i<frameCount;i++){
        const frame=startFrame+i;
        channel[i]=frame===99?1:frame===100?.25:frame===199?-.75:
          frame===200?.9:0;
      }
      return {startFrame,channels:[channel]};
    }};

  const peak=await readOverviewPeak(source,1,96,{yieldToBrowser:async()=>{}});

  assert.deepEqual(peak,[-.75,.25],
    "samples just outside the bin must not stretch neighboring peaks into it");
  assert.deepEqual(reads,[
    {startFrame:100,frameCount:40,priority:"waveform"},
    {startFrame:140,frameCount:40,priority:"waveform"},
    {startFrame:180,frameCount:20,priority:"waveform"}
  ],"the complete half-open source bin must be read in bounded contiguous ranges");
});

test("batched overview reads exact uneven bins in one bounded contiguous scan",async()=>{
  const samples=Float32Array.from([.1,.2,.3,-.4,.5,.6,-.7,.8,.9,-1,.25]);
  const reads=[];
  const source={sourceFrames:samples.length,maxReadFrames:4,
    async read(startFrame,frameCount){
      reads.push([startFrame,frameCount]);
      return {startFrame,channels:[samples.slice(startFrame,startFrame+frameCount)]};
    }};
  const expected=[];
  for(let bin=0;bin<4;bin++){
    expected.push(await readOverviewPeak(source,bin,4));
  }
  reads.length=0;
  assert.deepEqual(await readOverviewPeaks(source,0,4,4),expected);
  assert.deepEqual(reads,[[0,4],[4,4],[8,3]]);
});
