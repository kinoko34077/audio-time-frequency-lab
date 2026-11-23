const DEFAULT_WINDOW_FRAMES=65_536;
const DEFAULT_MAX_CACHED_WINDOWS=2;
const PRIORITY={background:0,waveform:0,playback:2,scrub:3};

export function createProgressivePCMCache({
  sourceFrames,channelCount,windowFrames=DEFAULT_WINDOW_FRAMES,
  maxCachedWindows=DEFAULT_MAX_CACHED_WINDOWS,
  maxReadFrames=windowFrames*4,maxConcurrentDecodes=2,decodeWindow
}={}){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1||
     !Number.isInteger(channelCount)||channelCount<1||channelCount>2||
     !Number.isSafeInteger(windowFrames)||windowFrames<1||
     !Number.isInteger(maxCachedWindows)||maxCachedWindows<1||
     !Number.isSafeInteger(maxReadFrames)||maxReadFrames<windowFrames||
     !Number.isInteger(maxConcurrentDecodes)||maxConcurrentDecodes<1||
     typeof decodeWindow!=="function")
    throw new RangeError("invalid progressive PCM source");

  const cache=new Map(),pending=new Map(),queue=[],active=new Set();
  let disposed=false;
  const assertLive=()=>{
    if(disposed)throw Error("progressive PCM source disposed");
  };
  const readWindow=async(start,options,size=windowFrames)=>{
    assertLive();
    const key=`${size}:${start}`;
    const resident=cache.get(key);
    if(resident){
      cache.delete(key);cache.set(key,resident);
      return resident;
    }
    const priority=PRIORITY[options?.priority]??PRIORITY.background;
    const inflight=pending.get(key);
    if(inflight){
      if(inflight.controller.signal.aborted)
        return inflight.cleanup.then(()=>readWindow(start,options,size));
      if(priority>inflight.priority){
        inflight.priority=priority;
        inflight.options={...inflight.options,...options};
        queue.sort((a,b)=>b.priority-a.priority);
        preemptFor(priority);
        pump();
      }
      return inflight.promise;
    }

    const entry={key,start,length:Math.min(size,sourceFrames-start),
      priority,options:{...options},controller:new AbortController(),
      promise:null,resolve:null,reject:null};
    entry.promise=new Promise((resolve,reject)=>{
      entry.resolve=resolve;entry.reject=reject;
    });
    pending.set(key,entry);
    queue.push(entry);queue.sort((a,b)=>b.priority-a.priority);
    preemptFor(priority);pump();
    return entry.promise;
  };
  const decode=entry=>{
    active.add(entry);
    entry.cleanup=Promise.resolve().then(()=>decodeWindow(entry.start,entry.length,{
      ...entry.options,priority:entry.priority,signal:entry.controller.signal
    })).then(channels=>{
        assertLive();
        if(entry.controller.signal.aborted)throw Error("PCM window decode aborted");
        assertLive();
        if(!Array.isArray(channels)||channels.length!==channelCount||
           !channels.every(channel=>channel instanceof Float32Array&&
             channel.length===entry.length))
          throw new RangeError("decoded PCM window does not match its source range");
        const window={start:entry.start,channels};
        while(cache.size>=maxCachedWindows)
          cache.delete(cache.keys().next().value);
        cache.set(entry.key,window);
        entry.resolve(window);
      }).catch(error=>entry.reject(error))
      .finally(()=>{
        active.delete(entry);
        if(pending.get(entry.key)===entry)pending.delete(entry.key);
        pump();
      });
  };
  const pump=()=>{
    if(disposed)return;
    while(active.size<maxConcurrentDecodes&&queue.length){
      const entry=queue.shift();
      if(entry.controller.signal.aborted)continue;
      decode(entry);
    }
  };
  const preemptFor=priority=>{
    if(active.size<maxConcurrentDecodes)return;
    const candidate=[...active].filter(entry=>entry.priority<priority)
      .sort((a,b)=>a.priority-b.priority)[0];
    candidate?.controller.abort();
  };

  return {
    sourceFrames,channelCount,windowFrames,
    async read(startFrame,frameCount,options={}){
      assertLive();
      if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(frameCount)||
         startFrame<0||frameCount<0||startFrame+frameCount>sourceFrames)
        throw new RangeError("invalid progressive PCM frame range");
      if(frameCount>maxReadFrames)
        throw new RangeError("progressive PCM range exceeds the bounded range limit");
      const readWindowFrames=options.windowFrames??windowFrames;
      if(!Number.isSafeInteger(readWindowFrames)||readWindowFrames<1||
         readWindowFrames>windowFrames)
        throw new RangeError("invalid progressive PCM read window size");
      const result=Array.from({length:channelCount},()=>new Float32Array(frameCount));
      let frame=startFrame,offset=0;
      while(offset<frameCount){
        assertLive();
        const windowStart=Math.floor(frame/readWindowFrames)*readWindowFrames;
        const window=await readWindow(windowStart,options,readWindowFrames);
        assertLive();
        const sourceOffset=frame-windowStart;
        const count=Math.min(frameCount-offset,window.channels[0].length-sourceOffset);
        for(let channel=0;channel<channelCount;channel++)
          result[channel].set(window.channels[channel].subarray(sourceOffset,
            sourceOffset+count),offset);
        frame+=count;offset+=count;
      }
      return {startFrame,channels:result};
    },
    stats(){
      let residentFrames=0;
      for(const {channels} of cache.values())residentFrames+=channels[0].length;
      return {residentFrames,residentWindows:cache.size,pendingWindows:pending.size,
        activeDecodes:active.size,queuedDecodes:queue.length};
    },
    dispose(){
      if(disposed)return;
      disposed=true;cache.clear();
      for(const entry of [...active,...queue]){
        entry.controller.abort();
        entry.reject(Error("progressive PCM source disposed"));
      }
      queue.length=0;pending.clear();
    }
  };
}
