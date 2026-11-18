import test from "node:test";
import assert from "node:assert/strict";
import {createSourcePCMRenderer,chooseSourceWindowStart,SOURCE_WINDOW_FRAMES,SOURCE_WINDOW_SLOTS} from "./source-pcm-renderer.mjs";

const mk=(source,opts={})=>{
  const channels=source.map(a=>Float32Array.from(a));
  const length=channels[0].length;
  const player=createSourcePCMRenderer({
    sourceFrames:length,sourceSampleRate:48000,outputSampleRate:48000,
    channelCount:channels.length,...opts
  });
  player.installWindow(0,channels);
  return player;
};
const block=(p,count=128,channels=1)=>{
  const output=Array.from({length:channels},()=>new Float32Array(count));
  const missing=p.render(output);
  return {missing,output};
};

test("no-loop PCM renderer reads source frame order exactly",()=>{
  const p=mk([[10,20,30,40,50]],{speed:1});
  const a=block(p,8);
  assert.equal(a.missing,0);
  assert.deepEqual(Array.from(a.output[0]),[10,20,30,40,50,0,0,0]);
  assert.equal(p.timeline.state.ended,true);
  assert.equal(block(p,8).missing,0);
  assert.equal(p.statistics.missingFrames,0);
});

test("reverse playback reads source frames backwards with no automatic looping",()=>{
  const p=mk([[1,2,3,4,5]],{speed:-1,startFrame:5});
  const r=block(p,8);
  assert.equal(r.missing,0);
  assert.deepEqual(Array.from(r.output[0]),[5,4,3,2,1,0,0,0]);
  assert.equal(p.timeline.state.ended,true);
});

test("one-source-sample A/B loop produces consecutive nonzero PCM without buffer refill",()=>{
  const p=mk([[1,2,3,4,5,6]],{
    speed:8,startFrame:2,loopStartFrame:2,loopEndFrame:3,loopEnabled:true
  });
  for(let iteration=0;iteration<40;iteration++){
    const out=block(p,128);
    assert.equal(out.missing,0);
    assert.ok(out.output[0].every(x=>x===3));
  }
  assert.equal(p.statistics.missingFrames,0);
  assert.equal(p.statistics.renderedFrames,5120);
  p.timeline.setSpeed(-8);
  assert.ok(block(p,128).output[0].every(x=>x===3));
});

test("2, 127, 128, 129 and 256-frame loops wrap without inserting output gaps",()=>{
  for(const loopLength of [2,127,128,129,256]){
    const samples=Float32Array.from({length:300},(_,i)=>i+1);
    for(const speed of [1,-1,8,-8]){
      const p=mk([samples],{speed,startFrame:speed<0?loopLength-1:0,
        loopStartFrame:0,loopEndFrame:loopLength,loopEnabled:true});
      for(let k=0;k<12;k++){
        const out=block(p,128);
        assert.equal(out.missing,0,`length ${loopLength} speed ${speed}`);
        assert.ok(out.output[0].every(x=>x>=1&&x<=loopLength),
          `unexpected silence outside loop length ${loopLength}`);
      }
      assert.equal(p.statistics.missingFrames,0);
    }
  }
});

test("stereo + output clock conversion and fractional interpolation",()=>{
  const p=mk([[0,2,4,6],[-1,-2,-3,-4]],{
    outputSampleRate:96000,speed:1
  });
  const a=block(p,6,2);
  assert.equal(a.missing,0);
  assert.deepEqual(Array.from(a.output[0]),[0,1,2,3,4,5]);
  assert.deepEqual(Array.from(a.output[1]),[-1,-1.5,-2,-2.5,-3,-3.5]);
});

test("Worker-rendered PCM follows the shared source clock and output-rate conversion",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:100,sourceSampleRate:48000,outputSampleRate:96000,
    channelCount:1,speed:1,startFrame:10
  });
  p.installRenderedChunk({generation:0,startFrame:10,endFrame:14,
    speed:1,coreFrames:4,channels:[Float32Array.from([0,2,4,6,8,10])]});
  const output=[new Float32Array(8)];
  assert.equal(p.renderBuffered(output),0);
  assert.deepEqual(Array.from(output[0]),[0,1,2,3,4,5,6,7]);
  assert.equal(p.timeline.state.sourceFrame,14,
    "the existing timeline advances once at the AudioWorklet output rate");
  assert.equal(p.statistics.renderedFrames,8);
  assert.equal(p.statistics.missingFrames,0);
});

test("Worker PCM interpolates across the full-track loop boundary without freezing before wrap",()=>{
  const p=createSourcePCMRenderer({sourceFrames:4,sourceSampleRate:4,
    outputSampleRate:3,channelCount:1,speed:1,startFrame:2,
    loopStartFrame:0,loopEndFrame:4,loopEnabled:true});
  p.installRenderedChunk({generation:0,startFrame:2,endFrame:4,
    speed:1,coreFrames:2,channels:[Float32Array.from([10,20])]});
  p.installRenderedChunk({generation:0,startFrame:0,endFrame:2,
    speed:1,coreFrames:2,channels:[Float32Array.from([1,2])]});
  const boundary=[new Float32Array(2)];
  assert.equal(p.renderBuffered(boundary),0);
  assert.ok(Math.abs(boundary[0][0]-10)<1e-6);
  assert.ok(Math.abs(boundary[0][1]-(20+(1-20)/3))<1e-6);
  assert.ok(p.timeline.state.sourceFrame<1,
    "the shared source clock wraps to the start of the full-track loop");
  const resumed=[new Float32Array(1)];
  assert.equal(p.renderBuffered(resumed),0);
  assert.ok(Math.abs(resumed[0][0]-(1+2/3))<1e-6);
});

test("late Worker PCM holds the shared source clock and resumes at the missing frame",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:1000,sourceSampleRate:48000,outputSampleRate:48000,
    channelCount:1,speed:1,startFrame:10
  });
  let output=[new Float32Array(4)];
  assert.equal(p.renderBuffered(output),4);
  assert.deepEqual(Array.from(output[0]),[0,0,0,0]);
  assert.equal(p.timeline.state.sourceFrame,10,
    "an empty Worker queue must not advance source time");
  p.installRenderedChunk({generation:0,startFrame:10,endFrame:500,
    speed:1,coreFrames:490,channels:[Float32Array.from({length:494},(_,i)=>i+1)]});
  output=[new Float32Array(128)];
  assert.equal(p.renderBuffered(output),0);
  assert.ok(output[0][0]<1,"new audio fades in after the counted underrun");
  assert.equal(output[0][1],2/128,
    "the resumed segment starts from the held source frame");
  assert.equal(output[0][127],128*127/128,
    "the held source interval is rendered once after PCM arrives");
  assert.equal(p.timeline.state.sourceFrame,138);
  assert.equal(p.statistics.missingFrames,4);
});

test("Worker PCM queue is generation-scoped and bounded",()=>{
  const p=createSourcePCMRenderer({sourceFrames:1000,sourceSampleRate:48000,
    outputSampleRate:48000,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,start)=>({generation,startFrame:start,
    endFrame:start+10,speed:1,coreFrames:10,
    channels:[new Float32Array(12)]});
  p.installRenderedChunk(chunk(0,0));
  p.resetRenderedChunks(1);
  assert.equal(p.installRenderedChunk(chunk(0,10)),false,
    "a stale Worker generation is ignored");
  assert.equal(p.installRenderedChunk(chunk(1,0)),1);
  assert.equal(p.installRenderedChunk(chunk(1,10)),2);
  assert.equal(p.installRenderedChunk(chunk(1,20)),3);
  assert.equal(p.installRenderedChunk(chunk(1,30)),4);
  assert.throws(()=>p.installRenderedChunk(chunk(1,40)),/queue full/);
  assert.equal(p.statistics.renderedChunkCount,4);
});

test("staged Worker settings keep queued PCM and switch the shared clock at the boundary",()=>{
  const p=createSourcePCMRenderer({sourceFrames:32,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  p.installRenderedChunk({generation:0,startFrame:0,endFrame:4,
    speed:1,coreFrames:4,channels:[Float32Array.from([1,1,1,1,1,1])]});
  assert.equal(typeof p.stageRenderedState,"function",
    "Worker settings must be staged separately from an immediate seek reset");
  assert.deepEqual(p.stageRenderedState({generation:1,speed:2,
    pitchSemitones:5}),{sourceFrame:4,sequence:1,bufferedSegments:1},
    "the current old chunk remains audible while the new generation prepares");
  assert.equal(p.installRenderedChunk({generation:1,startFrame:4,endFrame:8,
    speed:2,coreFrames:2,channels:[Float32Array.from([2,2,2,2])]}),2);
  const output=[new Float32Array(6)];
  assert.equal(p.renderBuffered(output),0,
    "contiguous staged PCM must not create missing output frames");
  assert.equal(p.workerState.generation,1);
  assert.equal(p.workerState.pitchSemitones,5);
  assert.equal(p.timeline.state.speed,2,
    "the shared source clock applies the new speed at the staged boundary");
  assert.equal(p.timeline.state.sourceFrame,8);
});

test("staged Worker settings target the next chunk and keep its PCM fallback",()=>{
  const p=createSourcePCMRenderer({sourceFrames:32,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,start,value,speed=1,coreFrames=4)=>({
    generation,startFrame:start,endFrame:start+4,speed,coreFrames,
    channels:[new Float32Array(coreFrames+2).fill(value)]
  });
  p.installRenderedChunk(chunk(0,0,1));
  p.installRenderedChunk(chunk(0,4,9));
  p.installRenderedChunk(chunk(0,8,9));
  const first=[new Float32Array(2)];
  assert.equal(p.renderBuffered(first),0);
  assert.deepEqual(Array.from(first[0]),[1,1]);

  const staged=p.stageRenderedState({generation:1,speed:2,pitchSemitones:5});
  assert.deepEqual(staged,{sourceFrame:4,sequence:1,bufferedSegments:2},
    "start rendering for the first upcoming boundary while retaining its old PCM fallback");
  assert.equal(p.installRenderedChunk(chunk(1,4,2,2,2)),2,
    "ready staged PCM replaces the matching fallback without growing the queue");
  const output=[new Float32Array(4)];
  assert.equal(p.renderBuffered(output),0);
  assert.deepEqual(Array.from(output[0].slice(0,2)),[1,1],
    "the currently audible PCM remains active up to the next chunk boundary");
  assert.equal(output[0][2],1,
    "the staged transition starts from the immediately preceding output sample");
  assert.ok(output[0][3]<1.02&&output[0][3]>1,
    "the in-quantum transition fades toward the new model without a jump");
  assert.equal(p.workerState.generation,1);
  assert.equal(p.timeline.state.speed,2);
  assert.equal(p.timeline.state.sourceFrame,8);
  assert.equal(p.statistics.missingFrames,0);
  assert.equal(p.installRenderedChunk({...chunk(1,8,3,2,2),sequence:2}),2,
    "later chunks in the staged generation remain contiguous after its first chunk");
});

test("staged Worker PCM replaces the matching old fallback without rewinding source time",()=>{
  const p=createSourcePCMRenderer({sourceFrames:16,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,start,end,value)=>({generation,startFrame:start,
    endFrame:end,speed:1,coreFrames:end-start,
    channels:[new Float32Array(end-start).fill(value)]});
  p.installRenderedChunk(chunk(0,0,4,1));
  const beforeStage=[new Float32Array(4)];
  assert.equal(p.renderBuffered(beforeStage),0);
  assert.equal(p.timeline.state.sourceFrame,4);
  assert.deepEqual(p.stageRenderedState({generation:1,speed:1,
    pitchSemitones:0}),{sourceFrame:4,sequence:1,bufferedSegments:1});
  p.installRenderedChunk(chunk(0,4,8,9));
  const fallback=[new Float32Array(2)];
  assert.equal(p.renderBuffered(fallback),0);
  assert.deepEqual(Array.from(fallback[0]),[9,9]);
  assert.equal(p.timeline.state.sourceFrame,6);
  assert.equal(p.installRenderedChunk(chunk(1,4,8,2)),1,
    "the staged chunk replaces, rather than queues behind, its old fallback");
  const switched=[new Float32Array(2)];
  assert.equal(p.renderBuffered(switched),0);
  assert.equal(switched[0][0],9,
    "the existing short transition fade starts from the last old-model PCM");
  assert.ok(switched[0][1]<9&&switched[0][1]>8.9,
    "the staged PCM blends in without a discontinuous sample jump");
  assert.equal(p.workerState.generation,1);
  assert.equal(p.timeline.state.sourceFrame,8,
    "late staged PCM activates at the current source frame without replay");
  assert.equal(p.takeWorkerActivation().sourceFrame,6);
  assert.equal(p.statistics.missingFrames,0);
});

test("staged Worker replacement follows queue order when a full-track source range repeats",()=>{
  const p=createSourcePCMRenderer({sourceFrames:8,sourceSampleRate:1,
    outputSampleRate:1,channelCount:1,speed:1,startFrame:0,
    loopStartFrame:0,loopEndFrame:8,loopEnabled:true});
  const chunk=(generation,sequence,start,end,value)=>({generation,sequence,
    startFrame:start,endFrame:end,speed:1,coreFrames:end-start,
    channels:[new Float32Array(end-start).fill(value)]});
  p.installRenderedChunk(chunk(0,0,0,4,1));
  p.installRenderedChunk(chunk(0,1,4,8,9));
  p.installRenderedChunk(chunk(0,2,0,4,7));
  const staged=p.stageRenderedState({generation:1,speed:1,pitchSemitones:0});
  assert.deepEqual(staged,{sourceFrame:4,sequence:1,bufferedSegments:2});
  assert.equal(p.installRenderedChunk(chunk(0,2,0,4,7)),3,
    "the in-flight old Worker result may still queue behind its fallback");
  assert.equal(p.installRenderedChunk(chunk(1,1,4,8,2)),2,
    "replace the first fallback and discard old-model tail PCM after the transition");
  assert.equal(p.installRenderedChunk(chunk(0,3,4,8,7)),false,
    "a late old-model result cannot append behind accepted staged PCM");
  const output=[new Float32Array(8)];
  assert.equal(p.renderBuffered(output),0);
  assert.deepEqual(Array.from(output[0].slice(0,4)),[1,1,1,1],
    "the old loop remains audible through the current chunk");
  assert.equal(p.workerState.generation,1);
  assert.equal(p.timeline.state.sourceFrame,0);
  assert.equal(p.takeWorkerActivation().sourceFrame,4);
});

test("late old Worker PCM beyond the retained staged boundary is ignored",()=>{
  const p=createSourcePCMRenderer({sourceFrames:32,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,sequence,startFrame,endFrame,value)=>({generation,
    sequence,startFrame,endFrame,speed:1,coreFrames:endFrame-startFrame,
    channels:[new Float32Array(endFrame-startFrame).fill(value)]});
  p.installRenderedChunk(chunk(0,0,0,4,1));
  p.installRenderedChunk(chunk(0,1,4,8,1));
  assert.deepEqual(p.stageRenderedState({generation:1,speed:1,
    pitchSemitones:0}),{sourceFrame:4,sequence:1,bufferedSegments:2});

  assert.equal(p.installRenderedChunk(chunk(0,3,12,16,1)),false,
    "a late in-flight chunk cannot jump over the fallback slots removed at staging");
  assert.equal(p.statistics.renderedChunkCount,2);
  assert.equal(p.installRenderedChunk(chunk(1,1,4,8,2)),2,
    "the selected generation can still replace the retained fallback");
});

test("late staged Worker PCM is rejected and can be re-staged at the live cursor",()=>{
  const p=createSourcePCMRenderer({sourceFrames:32,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,sequence,startFrame,endFrame,value)=>({generation,
    sequence,startFrame,endFrame,speed:1,coreFrames:endFrame-startFrame,
    channels:[new Float32Array(endFrame-startFrame).fill(value)]});
  p.installRenderedChunk(chunk(0,0,0,4,1));
  p.installRenderedChunk(chunk(0,1,4,8,1));
  p.installRenderedChunk(chunk(0,2,8,12,1));
  p.stageRenderedState({generation:1,speed:1,pitchSemitones:0});
  const playing=[new Float32Array(8)];
  assert.equal(p.renderBuffered(playing),0);
  assert.equal(p.timeline.state.sourceFrame,8);
  assert.equal(p.installRenderedChunk(chunk(1,1,4,8,2)),false,
    "a staged chunk whose retained fallback has already played is stale, not fatal");

  assert.deepEqual(p.stageRenderedState({generation:1,speed:1,
    pitchSemitones:0}),{sourceFrame:8,sequence:2,bufferedSegments:1});
  assert.equal(p.installRenderedChunk(chunk(1,2,8,12,2)),2);
  const resumed=[new Float32Array(2)];
  assert.equal(p.renderBuffered(resumed),0);
  assert.equal(p.workerState.generation,1);
  assert.equal(p.timeline.state.sourceFrame,10,
    "the re-staged model activates without rewinding the shared clock");
  assert.equal(p.statistics.missingFrames,0);
});

test("prepared Worker seek keeps old PCM playing until target PCM is ready",()=>{
  const p=createSourcePCMRenderer({sourceFrames:32,sourceSampleRate:4,
    outputSampleRate:4,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,sequence,startFrame,endFrame,value)=>({generation,
    sequence,startFrame,endFrame,speed:1,coreFrames:endFrame-startFrame,
    channels:[new Float32Array(endFrame-startFrame).fill(value)]});
  p.installRenderedChunk(chunk(0,0,0,4,1));
  p.installRenderedChunk(chunk(0,1,4,8,1));
  const before=[new Float32Array(2)];
  assert.equal(p.renderBuffered(before),0);
  assert.deepEqual(Array.from(before[0]),[1,1]);
  assert.deepEqual(p.stageRenderedSeekState({generation:1,frame:20,speed:1,
    pitchSemitones:3,requiredChunks:2}),{sourceFrame:20,sequence:0,
    nextFrame:20,nextSequence:0,bufferedSegments:2,reusedChunks:0});
  const waiting=[new Float32Array(2)];
  assert.equal(p.renderBuffered(waiting),0,
    "preparing a seek must not clear the currently audible PCM queue");
  assert.deepEqual(Array.from(waiting[0]),[1,1]);
  assert.equal(p.timeline.state.sourceFrame,4,
    "the shared clock keeps advancing on old PCM while the target renders");

  assert.equal(p.installRenderedChunk(chunk(1,0,20,24,9)),3,
    "target PCM is retained beside the old queue until atomic activation");
  const oldStillPlaying=[new Float32Array(2)];
  assert.equal(p.renderBuffered(oldStillPlaying),0,
    "a short loop-edge seek waits for its wrapped PCM before activation");
  assert.deepEqual(Array.from(oldStillPlaying[0]),[1,1]);
  assert.equal(p.timeline.state.sourceFrame,6);
  assert.equal(p.installRenderedChunk(chunk(0,2,8,12,1)),2,
    "an in-flight old generation can refill retained PCM during the seek");
  assert.equal(p.installRenderedChunk(chunk(1,1,24,28,11)),4,
    "the contiguous loop-start chunk is staged with the seek chunk");
  const after=[new Float32Array(8)];
  assert.equal(p.renderBuffered(after),0,
    "atomic seek activation must not insert missing output frames");
  assert.equal(p.workerState.generation,1);
  assert.equal(p.workerState.pitchSemitones,3);
  assert.equal(p.timeline.state.sourceFrame,28,
    "the shared clock advances across both prepared chunks");
  assert.equal(p.takeWorkerActivation().sourceFrame,20);
  assert.equal(after[0][0],1,
    "the target model transitions from the last audible old-model sample");
  assert.ok(after[0][3]>after[0][0]&&after[0][3]<9);
  assert.equal(p.statistics.missingFrames,0);
});

test("same-settings seek reuses a fully buffered PCM range",()=>{
  const p=createSourcePCMRenderer({sourceFrames:16,sourceSampleRate:8,
    outputSampleRate:8,channelCount:1,speed:1,startFrame:0});
  const chunk=(generation,sequence,startFrame,endFrame,value)=>({generation,
    sequence,startFrame,endFrame,speed:1,coreFrames:endFrame-startFrame,
    channels:[new Float32Array(endFrame-startFrame).fill(value)]});
  p.installRenderedChunk(chunk(0,0,0,8,1));
  p.installRenderedChunk(chunk(0,1,8,16,2));

  const staged=p.stageRenderedSeekState({generation:1,frame:4,speed:1,
    pitchSemitones:0,requiredChunks:1,reuseCompatible:true});
  assert.equal(staged.reusedChunks,1);

  const output=[new Float32Array(2)];
  assert.equal(p.renderBuffered(output),0);
  const activation=p.takeWorkerActivation();
  assert.equal(activation.generation,1);
  assert.equal(activation.sourceFrame,4);
  assert.equal(activation.reusedChunks,1);
  assert.equal(p.timeline.state.sourceFrame,6);
  assert.equal(p.statistics.missingFrames,0);
});

test("negative fractional speed wraps 1 frame loop instead of inventing dropped samples",()=>{
  const p=mk([[1,2,3]],{
    speed:-.001,startFrame:1,loopStartFrame:1,loopEndFrame:2,loopEnabled:true
  });
  const r=block(p,128);
  assert.equal(r.missing,0);
  assert.ok(r.output[0].every(x=>Math.abs(x-2)<1e-5));
});

test("0 speed freezes sample position but does NOT claim audible pitch-preserving freeze",()=>{
  const p=mk([[1,2,3]],{speed:0,startFrame:1});
  assert.equal(block(p,128).missing,0);
  assert.equal(p.timeline.state.sourceFrame,1);
  assert.equal(p.statistics.missingFrames,0);
});

test("cache misses are counted while output time advances without replay",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:1000,sourceSampleRate:48000,outputSampleRate:48000,
    channelCount:1,speed:1,startFrame:100
  });
  let r=block(p,128);
  assert.equal(r.missing,128);
  assert.equal(p.timeline.state.sourceFrame,228);
  assert.equal(p.statistics.missingFrames,128);
  assert.equal(p.needsSourceWindow(0),228);
  p.installWindow(0,[Float32Array.from({length:500},()=>.25)]);
  r=block(p,128);
  assert.equal(r.missing,0);
  assert.equal(p.timeline.state.sourceFrame,356);
  assert.ok(r.output[0].every(x=>x===.25));
});

test("window count and size stay bounded; invalid PCM windows fail closed",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:400000,sourceSampleRate:48000,outputSampleRate:48000,
    maxWindowFrames:1024,maxWindows:2,channelCount:1
  });
  p.timeline.seek(3072); // only source-window 3072 is currently needed
  for(let i=0;i<4;i++)p.installWindow(i*1024,[new Float32Array(1024)]);
  assert.equal(p.statistics.windowCount,2);
  assert.equal(p.hasFrame(0),false);
  assert.equal(p.hasFrame(3072),true);
  assert.throws(()=>p.installWindow(0,[new Float32Array(1025)]),RangeError);
  assert.throws(()=>p.installWindow(0,[new Float32Array(0)]),RangeError);
  assert.throws(()=>p.installWindow(-1,[new Float32Array(1)]),RangeError);
  assert.throws(()=>p.installWindow(399999,[new Float32Array(2)]),RangeError);
  assert.throws(()=>createSourcePCMRenderer({
    sourceFrames:1,sourceSampleRate:48000,outputSampleRate:48000,
    maxWindowFrames:SOURCE_WINDOW_FRAMES+1
  }),RangeError);
});

test("integral PCM sample at cache edge never interpolates missing neighbor into NaN",()=>{
  const p=createSourcePCMRenderer({sourceFrames:10,sourceSampleRate:48000,outputSampleRate:48000});
  p.installWindow(0,[Float32Array.from([.25,.75])]);
  p.timeline.seek(1);
  const out=block(p,1);
  assert.equal(out.missing,0);
  assert.equal(out.output[0][0],.75);
  assert.ok(Number.isFinite(out.output[0][0]));
});

test("crossing a cached chunk reports the real missing frame, not the cached head",()=>{
  const total=70000;
  const player=createSourcePCMRenderer({
    sourceFrames:total,sourceSampleRate:48000,outputSampleRate:48000,
    speed:7,startFrame:65408
  });
  player.installWindow(0,[Float32Array.from({length:65536},()=>.5)]);
  assert.equal(player.needsSourceWindow(0),null);
  const first=block(player,128);
  assert.ok(first.missing>0);
  assert.ok(player.firstMissingFrame>=65536);
  assert.equal(player.timeline.state.sourceFrame,65408+128*7);
  const from=chooseSourceWindowStart(player.firstMissingFrame,total,65536,7);
  player.installWindow(from,[Float32Array.from({length:total-from},()=>.5)]);
  const retry=block(player,128);
  assert.equal(retry.missing,0);
  assert.ok(retry.output[0].every(x=>x===.5));
  assert.ok(player.timeline.state.sourceFrame>65408+128*7);
  assert.equal(player.firstMissingFrame,null);
});

test("partial cache miss never replays emitted PCM after refill",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:256,sourceSampleRate:48000,outputSampleRate:48000,
    startFrame:60,speed:1
  });
  p.installWindow(0,[new Float32Array(64).fill(.25)]);
  const first=block(p,8);
  assert.equal(first.missing,4);
  assert.deepEqual(Array.from(first.output[0]),[.25,.25,.25,.25,0,0,0,0]);
  assert.equal(p.firstMissingFrame,64);
  assert.equal(p.timeline.state.sourceFrame,68);
  p.installWindow(64,[new Float32Array(64).fill(.5)]);
  const second=block(p,8);
  assert.equal(second.missing,0);
  assert.deepEqual(Array.from(second.output[0]),Array(8).fill(.5));
  assert.equal(p.timeline.state.sourceFrame,76);
  assert.equal(p.statistics.missingFrames,4);
});

test("reverse and loop cache misses never rewind committed source time",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:300,sourceSampleRate:48000,outputSampleRate:48000,
    startFrame:132,speed:-1,loopStartFrame:0,loopEndFrame:300,
    loopEnabled:true
  });
  p.installWindow(125,[new Float32Array(8).fill(.75)]);
  const first=block(p,12);
  assert.equal(first.missing,4);
  assert.equal(p.timeline.state.sourceFrame,120);
  p.installWindow(112,[new Float32Array(13).fill(.6)]);
  const second=block(p,8);
  assert.equal(second.missing,0);
  assert.ok(second.output[0].every(x=>Math.abs(x-.6)<1e-5));
  assert.equal(p.timeline.state.sourceFrame,112);
});

test("A/B endpoint windows remain pinned while the moving source cache advances",()=>{
  const p=createSourcePCMRenderer({sourceFrames:200000,
    sourceSampleRate:48000,outputSampleRate:48000,
    maxWindowFrames:20,maxWindows:3});
  p.installWindow(100,[new Float32Array(20)],"A");
  p.installWindow(199900,[new Float32Array(20)],"B");
  p.installWindow(100,[new Float32Array(20)]); // same range, no pin arg
  p.timeline.seek(50020); // moving cursor now needs the future window
  p.installWindow(50000,[new Float32Array(20)]);
  p.installWindow(50020,[new Float32Array(20)]);
  assert.equal(p.statistics.windowCount,3);
  assert.equal(p.hasFrame(100),true);
  assert.equal(p.hasFrame(199900),true);
  assert.equal(p.hasFrame(50000),false);
  assert.equal(p.hasFrame(50020),true);
  p.installWindow(120,[new Float32Array(20)],"A");
  assert.equal(p.hasFrame(100),false);
  assert.equal(p.hasFrame(120),true);
  assert.equal(p.hasFrame(199900),true);
  assert.throws(()=>p.installWindow(200,[new Float32Array(20)],"invalid"),RangeError);
});

test("two moving windows survive speculative prefetch while A/B endpoints are pinned",()=>{
  assert.equal(SOURCE_WINDOW_SLOTS,4);
  const p=createSourcePCMRenderer({sourceFrames:200,sourceSampleRate:48000,
    outputSampleRate:48000,channelCount:1,speed:1,startFrame:42,
    loopStartFrame:0,loopEndFrame:190,loopEnabled:true,
    maxWindowFrames:20,maxWindows:SOURCE_WINDOW_SLOTS});
  const fill=start=>new Float32Array(20).fill(.5);
  p.installWindow(0,[fill(0)],"A");
  p.installWindow(170,[fill(170)],"B");
  p.installWindow(40,[fill(40)]);
  assert.equal(block(p,5).missing,0); // position 47, actively in [40,60)
  p.installWindow(60,[fill(60)]); // prefetch the adjacent window
  assert.equal(p.statistics.windowCount,4);
  assert.equal(p.hasFrame(47),true);
  assert.equal(block(p,5).missing,0); // the old design inserted 5 silence frames
  p.installWindow(80,[fill(80)]); // too speculative: reject ahead, keep near
  assert.equal(p.hasFrame(52),true);
  assert.equal(p.hasFrame(60),true);
  assert.equal(p.hasFrame(80),false);
  assert.equal(block(p,9).missing,0); // crosses [40,60) -> [60,80)
  assert.equal(p.timeline.state.sourceFrame,61);
  p.installWindow(80,[fill(80)]); // old [40,60) now behind, safe to evict
  assert.equal(p.hasFrame(47),false);
  assert.equal(p.hasFrame(61),true);
  assert.equal(p.hasFrame(80),true);
  assert.equal(p.statistics.missingFrames,0);
});

test("reverse prefetch never evicts the current window before crossing backward",()=>{
  const p=createSourcePCMRenderer({sourceFrames:200,sourceSampleRate:48000,
    outputSampleRate:48000,channelCount:1,speed:-1,startFrame:135,
    loopStartFrame:0,loopEndFrame:190,loopEnabled:true,
    maxWindowFrames:20,maxWindows:SOURCE_WINDOW_SLOTS});
  p.installWindow(0,[new Float32Array(20).fill(.5)],"A");
  p.installWindow(170,[new Float32Array(20).fill(.5)],"B");
  p.installWindow(120,[new Float32Array(20).fill(.5)]);
  assert.equal(block(p,5).missing,0);
  p.installWindow(100,[new Float32Array(20).fill(.5)]);
  assert.equal(block(p,5).missing,0);
  p.installWindow(80,[new Float32Array(20).fill(.5)]);
  assert.equal(p.hasFrame(125),true);
  assert.equal(p.hasFrame(115),true);
  assert.equal(p.hasFrame(85),false);
  assert.equal(block(p,12).missing,0); // crosses from 120 down to 119
  assert.equal(p.timeline.state.sourceFrame,113);
  p.installWindow(80,[new Float32Array(20).fill(.5)]);
  assert.equal(p.hasFrame(130),false);
  assert.equal(p.hasFrame(110),true);
  assert.equal(p.hasFrame(85),true);
});

test("explicit seek window survives full cache and overrides old-cursor eviction",()=>{
  const p=createSourcePCMRenderer({sourceFrames:1000,sourceSampleRate:48000,
    outputSampleRate:48000,channelCount:1,speed:1,startFrame:340,
    loopStartFrame:0,loopEndFrame:990,loopEnabled:true,
    maxWindowFrames:20,maxWindows:SOURCE_WINDOW_SLOTS});
  const data=new Float32Array(20).fill(.5);
  p.installWindow(0,[data.slice()],"A");
  p.installWindow(970,[data.slice()],"B");
  p.installWindow(340,[data.slice()]);
  p.installWindow(390,[data.slice()]);
  assert.equal(p.statistics.windowCount,4);
  p.installWindow(700,[data.slice()]); // speculative: correctly rejected
  assert.equal(p.hasFrame(700),false);
  p.installWindow(700,[data.slice()],null,"seek");
  p.timeline.seek(700); // atomic with install in actual Worklet handler
  assert.equal(p.hasFrame(700),true);
  const out=block(p,16);
  assert.equal(out.missing,0);
  assert.ok(out.output[0].every(x=>x===.5));
  assert.equal(p.timeline.state.sourceFrame,716);
  assert.throws(()=>p.installWindow(100,[data.slice()],null,"invalid"),RangeError);
});

test("atomic A/B change preloads endpoints before the next output block",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:1000,sourceSampleRate:48000,outputSampleRate:48000,
    speed:1,startFrame:3,loopEnabled:true,loopStartFrame:0,
    loopEndFrame:990,maxWindowFrames:20,maxWindows:4
  });
  const old=new Float32Array(20).fill(.25);
  p.installWindow(0,[old],"A");
  p.installWindow(970,[old],"B");
  p.installWindow(40,[old]);p.installWindow(60,[old]);
  assert.equal(block(p,4).missing,0);
  assert.equal(p.timeline.state.sourceFrame,7);
  const newWindow={start:400,channels:[new Float32Array(20).fill(.5)]};
  const nextEnd={start:400,channels:[new Float32Array(20).fill(.5)]};
  const receipt=p.applyLoopConfiguration(400,420,true,[newWindow,nextEnd]);
  assert.equal(receipt.sourceFrame,400);
  assert.equal(receipt.loopStartFrame,400);
  assert.equal(receipt.loopEndFrame,420);
  const first=block(p,4);
  assert.equal(first.missing,0);
  assert.ok(first.output[0].every(x=>x===.5));
  assert.equal(p.timeline.state.sourceFrame,404);
});

test("rejected atomic bounds update leaves source time, loop and cache unchanged",()=>{
  const p=createSourcePCMRenderer({
    sourceFrames:1000,sourceSampleRate:48000,outputSampleRate:48000,
    speed:1,startFrame:3,loopEnabled:true,
    loopStartFrame:0,loopEndFrame:990,maxWindowFrames:20
  });
  const old=new Float32Array(20).fill(.5);
  p.installWindow(0,[old],"A");
  p.installWindow(970,[old],"B");
  const prev=p.timeline.state;
  assert.throws(()=>p.applyLoopConfiguration(400,420,true,[
    {start:400,channels:[new Float32Array(20)]},
    {start:400,channels:[new Float32Array(18)]}
  ]),RangeError);
  assert.deepEqual(p.timeline.state,prev);
  assert.equal(block(p,4).missing,0);
  assert.equal(p.hasFrame(3),true);
  assert.equal(p.hasFrame(400),false);
  p.applyLoopConfiguration(0,990,false,[]);
  assert.equal(p.timeline.state.loopEnabled,false);
  assert.equal(p.statistics.windowCount,2);
  p.timeline.seek(300); // old A is now behind playback, not protected
  p.installWindow(300,[new Float32Array(20)]);
  p.installWindow(400,[new Float32Array(20)]);
  p.installWindow(500,[new Float32Array(20)]);
  assert.equal(p.hasFrame(0),false,"old A pin must not survive loop disable");
});

test("directional window placement is bounded even at original source endpoints",()=>{
  const total=48000*600;
  for(const speed of [-8,-1,0,1,8]){
    for(const at of [0,1,total-1,total]){
      const begin=chooseSourceWindowStart(at,total,SOURCE_WINDOW_FRAMES,speed);
      assert.ok(begin>=0&&begin+SOURCE_WINDOW_FRAMES<=total);
    }
  }
  assert.equal(chooseSourceWindowStart(2,3,65536,1),0);
});

test("staged Worker generation activates after a loop-spanning queue and late fallback",()=>{
  const speed=1.33,p=createSourcePCMRenderer({sourceFrames:288000,
    sourceSampleRate:48000,outputSampleRate:48000,channelCount:1,speed,
    startFrame:263605,loopStartFrame:0,loopEndFrame:288000,loopEnabled:true});
  p.resetRenderedChunks(1,{speed,pitchSemitones:0});
  const chunk=(generation,sequence,startFrame,endFrame,value)=>{
    const coreFrames=Math.ceil((endFrame-startFrame)/speed);
    return {generation,sequence,startFrame,endFrame,speed,coreFrames,
      channels:[new Float32Array(coreFrames+2).fill(value)]};
  };
  assert.equal(p.installRenderedChunk(chunk(1,0,216000,288000,1)),1);
  assert.equal(p.installRenderedChunk(chunk(1,1,0,72000,1)),2);
  assert.deepEqual(p.stageRenderedState({generation:2,speed,
    pitchSemitones:2}),{sourceFrame:0,sequence:1,bufferedSegments:2});

  const render=frames=>p.renderBuffered([new Float32Array(frames)]);
  let guard=0;
  while(p.timeline.state.sourceFrame>72000&&guard++<1000)render(128);
  while(p.timeline.state.sourceFrame<70000&&guard++<2000)render(128);
  while(p.timeline.state.sourceFrame<71950&&guard++<3000)render(64);
  assert.ok(guard<3000,"playback reaches the staged loop boundary");
  assert.equal(p.installRenderedChunk(chunk(1,2,72000,144000,1)),2,
    "late active-generation PCM fills the fallback behind the current segment");
  const positionBeforeActivation=p.timeline.state.sourceFrame;
  assert.equal(p.installRenderedChunk(chunk(2,1,0,72000,2)),1,
    "staged PCM replaces the matching queued fallback occurrence");
  render(20);
  const activation=p.takeWorkerActivation();
  assert.equal(p.workerState.generation,2);
  assert.equal(p.workerState.pitchSemitones,2);
  assert.equal(activation.generation,2);
  assert.equal(activation.sourceFrame,positionBeforeActivation,
    "late activation preserves the fractional source position exactly");
  assert.ok(Math.abs(p.timeline.state.sourceFrame-
    (positionBeforeActivation+20*speed))<1e-7,
    "the shared clock keeps its fractional phase across the setting edit");
  assert.equal(p.statistics.missingFrames,0);
});
