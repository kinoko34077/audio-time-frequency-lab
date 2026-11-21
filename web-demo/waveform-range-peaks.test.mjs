import test from "node:test";
import assert from "node:assert/strict";
import {overviewBinCount,overviewNeedsResample,readOverviewPeak} from "./waveform-range-peaks.mjs";

test("overview resolution follows physical display pixels within a bounded range",()=>{
  assert.equal(overviewBinCount(740),740);
  assert.equal(overviewBinCount(240),240);
  assert.equal(overviewBinCount(4096),2048);
});

test("same-resolution resize leaves an incomplete overview scan running",async()=>{
  const source={overviewBinCount:740,overviewPeaks:Array(740).fill(null)};
  assert.equal(overviewNeedsResample(source,740),false);
  assert.equal(overviewNeedsResample(source,741),true);
});

test("same-resolution resize retries bins left blank by completed read failures",()=>{
  const source={overviewBinCount:740,overviewBuildComplete:true,
    overviewPeaks:Array(740).fill(null)};
  source.overviewPeaks[12]=[-.5,.5];
  assert.equal(overviewNeedsResample(source,740),true);
  source.overviewPeaks[13]=[-.25,.25];
  assert.equal(overviewNeedsResample(source,740),true);
  source.overviewPeaks=Array(740).fill(null).map(()=>[-.1,.1]);
  assert.equal(overviewNeedsResample(source,740),false);
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
  assert.equal(await peak,null,"a resized overview must abandon the previous pixel range");
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
