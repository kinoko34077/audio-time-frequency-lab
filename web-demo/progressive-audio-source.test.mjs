import test from 'node:test';
import assert from 'node:assert/strict';
import {copyAudioSamplesIntoRange,createProgressiveAudioSource}
  from './progressive-audio-source.mjs';

function mockMedia({supported=true,channels=2,frames=8192,rate=48000,
  firstTimestamp=0}={}){
  let disposed=false;
  class Input{
    constructor(){this.disposed=false;}
    async canRead(){return true;}
    async getPrimaryAudioTrack(){
      return {
        canDecode:async()=>supported,
        getSampleRate:async()=>rate,
        getNumberOfChannels:async()=>channels
      };
    }
    async getFirstTimestamp(){return firstTimestamp;}
    async getDurationFromMetadata(){return frames/rate;}
    dispose(){this.disposed=true;disposed=true;}
  }
  class BlobSource{constructor(file){this.file=file;}}
  class AudioSampleSink{
    constructor(track){this.track=track;}
    async *samples(start,end){
      const rate=this.track.getSampleRate?await this.track.getSampleRate():rate;
      const from=Math.max(0,Math.floor(start*rate/1024)*1024);
      const to=Math.min(frames,Math.ceil(end*rate/1024)*1024);
      for(let base=from;base<to;base+=1024){
        const count=Math.min(1024,frames-base);
        yield {
          timestamp:base/rate,numberOfFrames:count,numberOfChannels:channels,
          sampleRate:rate,
          copyTo(destination,{planeIndex,format,frameOffset=0,frameCount=count}){
            assert.equal(format,'f32-planar');
            for(let i=0;i<frameCount;i++)
              destination[i]=((base+frameOffset+i)/frames)+planeIndex*2;
          },
          close(){}
        };
      }
    }
  }
  return {media:{ALL_FORMATS:[],Input,BlobSource,AudioSampleSink},
    isDisposed:()=>disposed};
}

test('opens long-source metadata without decoding the file and reads exact requested PCM ranges',async()=>{
  const harness=mockMedia({frames:48_000*60*60*10});
  const source=await createProgressiveAudioSource({name:'long.wav',size:3_000_000_000},
    {media:harness.media,windowFrames:1024,maxCachedWindows:2});

  assert.equal(source.duration,36_000);
  assert.equal(source.sourceFrames,48_000*60*60*10);
  assert.equal(source.stats().residentFrames,0);
  const start=source.sourceFrames-1500;
  const range=await source.read(start,1200,{priority:'playback'});

  assert.equal(range.startFrame,start);
  assert.equal(range.channels.length,2);
  assert.equal(range.channels[0].length,1200);
  assert.ok(Math.abs(range.channels[0][0]-start/source.sourceFrames)<1e-6);
  assert.ok(Math.abs(range.channels[0][1199]-(start+1199)/source.sourceFrames)<1e-6);
  assert.ok(Math.abs(range.channels[1][0]-(start/source.sourceFrames+2))<1e-6);
  assert.ok(source.stats().residentFrames<=2048);
  source.dispose();
  assert.equal(harness.isDisposed(),true);
});

test('negative codec priming timestamps map the first decoded PCM to source frame zero',async()=>{
  const harness=mockMedia({frames:8192,firstTimestamp:-312/48_000});
  const source=await createProgressiveAudioSource({name:'primed.ogg'},
    {media:harness.media,windowFrames:1024});
  assert.equal(source.sourceStartTime,0);
  const range=await source.read(0,512,{priority:'playback'});
  assert.equal(range.channels[0][0],0);
  assert.ok(Math.abs(range.channels[0][511]-511/8192)<1e-6);
  source.dispose();
});

test('rejects a format when the target browser has no decoder',async()=>{
  const harness=mockMedia({supported:false});
  await assert.rejects(createProgressiveAudioSource({name:'audio.flac'},
    {media:harness.media}),/このブラウザでは再生できない音声形式/);
  assert.equal(harness.isDisposed(),true);
});

test('replacement disposal prevents later reads from using the previous file',async()=>{
  const harness=mockMedia();
  const source=await createProgressiveAudioSource({name:'first.wav'},
    {media:harness.media});
  source.dispose();
  await assert.rejects(source.read(0,16),/disposed/);
});

test('closes an AudioSample that resolves after its PCM read is aborted',async()=>{
  let resolveNext,markNextCalled;
  const nextCalled=new Promise(resolve=>{markNextCalled=resolve;});
  let closeCount=0;
  const track={canDecode:async()=>true,getSampleRate:async()=>48_000,
    getNumberOfChannels:async()=>1};
  const media={ALL_FORMATS:[],
    Input:class{
      async canRead(){return true;}
      async getPrimaryAudioTrack(){return track;}
      async getFirstTimestamp(){return 0;}
      async getDurationFromMetadata(){return 8192/48_000;}
      dispose(){}
    },
    BlobSource:class{},
    AudioSampleSink:class{
      samples(){
        return {[Symbol.asyncIterator](){return this;},
          next(){markNextCalled();return new Promise(resolve=>{resolveNext=resolve;});},
          return(){return Promise.resolve({done:true});}};
      }
    }
  };
  const source=await createProgressiveAudioSource({name:'pending.wav'},
    {media,windowFrames:1024});
  const read=source.read(0,1024,{priority:'playback'});
  try{
    await nextCalled;
    source.dispose();
    await assert.rejects(read,/disposed/);
    resolveNext({done:false,value:{timestamp:0,sampleRate:48_000,
      numberOfFrames:1024,numberOfChannels:1,
      copyTo(){},close(){closeCount++;}}});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(closeCount,1);
  }finally{
    source.dispose();
  }
});

test('closes AudioSamples beyond the point where a PCM range is filled',()=>{
  let closeCount=0;
  const sample=(timestamp)=>({timestamp,sampleRate:48_000,
    numberOfFrames:512,numberOfChannels:1,copyTo(){},close(){closeCount++;}});
  copyAudioSamplesIntoRange([sample(0),sample(512/48_000)],{
    sourceStartTime:0,sampleRate:48_000,startFrame:0,
    channels:[new Float32Array(512)]});
  assert.equal(closeCount,2);
});
