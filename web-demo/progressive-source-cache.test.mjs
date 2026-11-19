import test from 'node:test';
import assert from 'node:assert/strict';
import {createProgressivePCMCache} from './progressive-source-cache.mjs';

test('reads exact source-frame ranges from a long source while retaining only bounded PCM windows',async()=>{
  const windowFrames=1024;
  const sourceFrames=48_000*60*60*10;
  const reads=[];
  const source=createProgressivePCMCache({
    sourceFrames,channelCount:2,windowFrames,maxCachedWindows:2,
    decodeWindow:async(start,frames)=>{
      reads.push({start,frames});
      return Array.from({length:2},(_,channel)=>{
        const samples=new Float32Array(frames);
        for(let i=0;i<frames;i++)samples[i]=(start+i)/sourceFrames+channel;
        return samples;
      });
    }
  });

  const nearEnd=sourceFrames-1700;
  const range=await source.read(nearEnd,1400);

  assert.equal(range.startFrame,nearEnd);
  assert.equal(range.channels[0].length,1400);
  assert.ok(Math.abs(range.channels[0][0]-nearEnd/sourceFrames)<1e-7);
  assert.ok(Math.abs(range.channels[0][1399]-(nearEnd+1399)/sourceFrames)<1e-7);
  assert.ok(Math.abs(range.channels[1][0]-(1+nearEnd/sourceFrames))<1e-7);
  assert.deepEqual(reads,[
    {start:sourceFrames-2048,frames:1024},
    {start:sourceFrames-1024,frames:1024}
  ]);
  assert.ok(source.stats().residentFrames<=windowFrames*2);
  source.dispose();
});

test('evicts the least recently used PCM window without changing source-frame values',async()=>{
  const reads=[];
  const source=createProgressivePCMCache({
    sourceFrames:4096,channelCount:1,windowFrames:1024,maxCachedWindows:2,
    decodeWindow:async(start,frames)=>{
      reads.push(start);
      return [Float32Array.from({length:frames},(_,i)=>start+i)];
    }
  });

  await source.read(10,1);
  await source.read(1034,1);
  await source.read(20,1);
  await source.read(2070,1);
  const again=await source.read(1050,1);

  assert.equal(again.channels[0][0],1050);
  assert.deepEqual(reads,[0,1024,2048,1024]);
  assert.ok(source.stats().residentFrames<=2048);
  source.dispose();
});

test('rejects oversized single reads instead of materializing a full track',async()=>{
  const source=createProgressivePCMCache({
    sourceFrames:100_000,channelCount:1,windowFrames:1024,maxCachedWindows:2,
    decodeWindow:async(_start,frames)=>[new Float32Array(frames)]
  });

  await assert.rejects(source.read(0,4097),/bounded range/);
  assert.equal(source.stats().residentFrames,0);
  source.dispose();
});

test('disposal prevents an in-flight decode from becoming a readable stale window',async()=>{
  let finishDecode;
  const source=createProgressivePCMCache({
    sourceFrames:1024,channelCount:1,windowFrames:1024,maxCachedWindows:1,
    decodeWindow:()=>new Promise(resolve=>{finishDecode=resolve;})
  });
  const pending=source.read(10,4);
  await new Promise(resolve=>setImmediate(resolve));
  source.dispose();
  finishDecode([new Float32Array(1024)]);

  await assert.rejects(pending,/disposed/);
  assert.equal(source.stats().residentFrames,0);
});

test('a playback read preempts an active lower-priority waveform read',async()=>{
  const started=[];
  const source=createProgressivePCMCache({
    sourceFrames:4096,channelCount:1,windowFrames:1024,maxCachedWindows:2,
    maxConcurrentDecodes:1,
    decodeWindow:(start,frames,{signal})=>{
      started.push(start);
      if(start===0)return new Promise((_resolve,reject)=>
        signal.addEventListener('abort',()=>reject(Error('preempted')),{once:true}));
      return Promise.resolve([new Float32Array(frames).fill(start)]);
    }
  });

  const overview=source.read(0,1,{priority:'waveform'});
  await new Promise(resolve=>setImmediate(resolve));
  const playback=source.read(2048,1,{priority:'playback'});

  await assert.rejects(overview,/preempted/);
  const result=await playback;
  assert.equal(result.channels[0][0],2048);
  assert.deepEqual(started,[0,2048]);
  source.dispose();
});

test('a scrub joining an aborted decode is retried after decoder cleanup',async()=>{
  const attempts=new Map();
  let releaseWaveform;
  const source=createProgressivePCMCache({
    sourceFrames:4096,channelCount:1,windowFrames:1024,maxCachedWindows:2,
    maxConcurrentDecodes:1,
    decodeWindow:(start,frames,{signal})=>{
      const attempt=(attempts.get(start)||0)+1;
      attempts.set(start,attempt);
      if(start===0&&attempt===1)return new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>{
          releaseWaveform=()=>reject(Error('preempted waveform'));
        },{once:true});
      });
      if(start===2048)return Promise.resolve([
        new Float32Array(frames).fill(.5)
      ]);
      return Promise.resolve([new Float32Array(frames).fill(start===0?.75:.5)]);
    }
  });

  const waveform=source.read(0,1,{priority:'waveform'});
  await new Promise(resolve=>setImmediate(resolve));
  const playback=source.read(2048,1,{priority:'playback'});
  assert.equal(attempts.get(0),1);
  assert.equal(source.stats().queuedDecodes,1);
  const scrub=source.read(0,1,{priority:'scrub'});
  assert.equal(typeof releaseWaveform,'function',
    'preemption must signal the active waveform decoder');
  releaseWaveform();
  const [waveformResult,,scrubResult]=await Promise.allSettled([
    waveform,playback,scrub
  ]);

  assert.equal(waveformResult.status,'rejected');
  assert.equal(scrubResult.status,'fulfilled',
    'the new scrub position must not inherit a rejected, aborted decode');
  assert.equal(scrubResult.value.channels[0][0],.75);
  assert.equal(attempts.get(0),2,
    'the same source window is decoded again for the higher-priority scrub');
  source.dispose();
});
