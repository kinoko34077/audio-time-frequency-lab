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
