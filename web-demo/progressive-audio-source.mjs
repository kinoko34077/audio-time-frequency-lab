import {createProgressivePCMCache} from './progressive-source-cache.mjs';

const WINDOW_FRAMES=65_536;

export function copyAudioSamplesIntoRange(samples,{sourceStartTime,
  sampleRate,startFrame,channels}={}){
  if(!Array.isArray(samples)||!Number.isFinite(sourceStartTime)||
     !Number.isFinite(sampleRate)||sampleRate<=0||
     !Number.isSafeInteger(startFrame)||startFrame<0||
     !Array.isArray(channels)||channels.length<1||channels.length>2||
     !channels.every(channel=>channel instanceof Float32Array))
    throw new RangeError('invalid decoded PCM range');
  const frameCount=channels[0].length;
  if(!channels.every(channel=>channel.length===frameCount))
    throw new RangeError('PCM output channels must have equal lengths');
  const endFrame=startFrame+frameCount;
  let coveredTo=startFrame;
  for(const sample of samples){
    try{
      if(!sample||!Number.isFinite(sample.timestamp)||
         sample.sampleRate!==sampleRate||
         !Number.isSafeInteger(sample.numberOfFrames)||sample.numberOfFrames<1||
         !Number.isInteger(sample.numberOfChannels)||
         sample.numberOfChannels<channels.length||
         typeof sample.copyTo!=='function')
        throw new RangeError('decoded audio sample metadata is invalid');
      const sampleStart=Math.round((sample.timestamp-sourceStartTime)*sampleRate);
      const sampleEnd=sampleStart+sample.numberOfFrames;
      const overlapStart=Math.max(startFrame,sampleStart,coveredTo);
      const overlapEnd=Math.min(endFrame,sampleEnd);
      if(overlapEnd<=overlapStart)continue;
      if(overlapStart>coveredTo)
        throw new Error('音声デコーダが要求範囲のPCMを連続して返しませんでした');
      const sampleOffset=overlapStart-sampleStart;
      const destinationOffset=overlapStart-startFrame;
      const count=overlapEnd-overlapStart;
      for(let channel=0;channel<channels.length;channel++){
        sample.copyTo(channels[channel].subarray(destinationOffset,
          destinationOffset+count),{
          planeIndex:channel,format:'f32-planar',
          frameOffset:sampleOffset,frameCount:count
        });
      }
      coveredTo=overlapEnd;
      if(coveredTo===endFrame)break;
    }finally{
      sample?.close?.();
    }
  }
  if(coveredTo!==endFrame)
    throw new Error('音声デコーダが要求範囲のPCMを最後まで返しませんでした');
  return channels;
}

async function collectWindow({sink,sourceStartTime,sampleRate,startFrame,
  channels,signal}){
  const startTime=sourceStartTime+startFrame/sampleRate;
  const endTime=startTime+channels[0].length/sampleRate;
  const samples=sink.samples(startTime,endTime)[Symbol.asyncIterator]();
  const decoded=[];
  let abortHandler;
  const aborted=new Promise((_,reject)=>{
    abortHandler=()=>reject(new DOMException('PCM window decode aborted','AbortError'));
    if(signal?.aborted)abortHandler();
    else signal?.addEventListener('abort',abortHandler,{once:true});
  });
  try{
    while(true){
      if(signal?.aborted)throw new DOMException('PCM window decode aborted','AbortError');
      const next=await Promise.race([samples.next(),aborted]);
      if(next.done)break;
      decoded.push(next.value);
    }
    return copyAudioSamplesIntoRange(decoded,{sourceStartTime,sampleRate,
      startFrame,channels});
  }catch(error){
    for(const sample of decoded)sample?.close?.();
    throw error;
  }finally{
    signal?.removeEventListener('abort',abortHandler);
    try{await samples.return?.();}catch{}
  }
}

export async function createProgressiveAudioSource(file,{media,
  windowFrames=WINDOW_FRAMES,maxCachedWindows=2,
  maxConcurrentDecodes=2}={}){
  if(!file||typeof file!=='object')throw new TypeError('音源ファイルがありません');
  const api=media||await import('./vendor/mediabunny-1.66.1.mjs');
  const input=new api.Input({formats:api.ALL_FORMATS,source:new api.BlobSource(file)});
  let cache=null,disposed=false;
  try{
    if(!await input.canRead())
      throw new Error('対応していない音声形式です');
    const track=await input.getPrimaryAudioTrack();
    if(!track)throw new Error('音声トラックが見つかりません');
    if(!await track.canDecode())
      throw new Error('このブラウザでは再生できない音声形式です');
    const sampleRate=await track.getSampleRate();
    const sourceChannelCount=await track.getNumberOfChannels();
    const channelCount=Math.min(2,sourceChannelCount);
    // Negative packet timestamps represent codec priming, not playable source
    // frames. AudioSampleSink omits those packets and starts decoded PCM at 0.
    const sourceStartTime=Math.max(0,await input.getFirstTimestamp([track]));
    let endTime=await input.getDurationFromMetadata([track]);
    if(!Number.isFinite(endTime)||endTime<=sourceStartTime)
      endTime=await input.computeDuration([track]);
    const duration=endTime-sourceStartTime;
    const sourceFrames=Math.round(duration*sampleRate);
    if(!Number.isFinite(sampleRate)||sampleRate<=0||
       !Number.isInteger(channelCount)||channelCount<1||
       !Number.isFinite(duration)||duration<=0||
       !Number.isSafeInteger(sourceFrames)||sourceFrames<4096)
      throw new Error('音声の長さ・チャンネル情報を読み取れません');

    const sink=new api.AudioSampleSink(track);
    cache=createProgressivePCMCache({sourceFrames,channelCount,windowFrames,
      maxCachedWindows,maxReadFrames:Math.max(windowFrames,windowFrames*16),
      maxConcurrentDecodes,decodeWindow:async(start,length,{signal}={})=>{
        if(disposed)throw Error('progressive audio source disposed');
        const channels=Array.from({length:channelCount},()=>new Float32Array(length));
        return collectWindow({sink,sourceStartTime,sampleRate,startFrame:start,
          channels,signal});
      }});
    return {fileName:file.name||'audio',duration,sourceStartTime,sourceFrames,
      sampleRate,channelCount,windowFrames,
      maxReadFrames:Math.max(windowFrames,windowFrames*16),
      read:(start,count,options)=>cache.read(start,count,options),
      stats:()=>cache.stats(),dispose(){
        if(disposed)return;
        disposed=true;cache.dispose();input.dispose();
      }};
  }catch(error){
    cache?.dispose();input.dispose();
    throw error;
  }
}
