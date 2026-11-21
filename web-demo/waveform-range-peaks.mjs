const yieldToBrowser=()=>new Promise(resolve=>setTimeout(resolve,0));

export function overviewBinCount(pixelWidth){
  if(!Number.isFinite(pixelWidth)||pixelWidth<=0)return 96;
  return Math.max(96,Math.min(2048,Math.round(pixelWidth)));
}

export function overviewNeedsResample(source,pixelWidth){
  if(!source)return false;
  const bins=overviewBinCount(pixelWidth);
  if(source.overviewBinCount!==bins)return true;
  if(source.overviewBuildComplete!==true)return false;
  return !Array.isArray(source.overviewPeaks)||source.overviewPeaks.length!==bins||
    source.overviewPeaks.some(peak=>!Array.isArray(peak)||peak.length!==2);
}

export function advanceOverviewBuildToken(source){
  const current=Number.isSafeInteger(source?.overviewBuildToken)?
    source.overviewBuildToken:0;
  source.overviewBuildToken=current+1;
  return source.overviewBuildToken;
}

/** Measure one overview bin from exactly its half-open source-frame range. */
export async function readOverviewPeak(source,bin,bins,{shouldContinue=()=>true,
  yieldToBrowser:yieldControl=yieldToBrowser}={}){
  const frames=source?.sourceFrames;
  if(!Number.isSafeInteger(frames)||frames<1||
     !Number.isSafeInteger(bin)||!Number.isSafeInteger(bins)||
     bins<1||bin<0||bin>=bins||typeof source.read!=="function")
    throw new RangeError("invalid waveform overview range");
  const start=Math.floor(bin*frames/bins);
  const end=Math.floor((bin+1)*frames/bins);
  if(end<=start)return [0,0];
  const maxRead=Number.isSafeInteger(source.maxReadFrames)&&source.maxReadFrames>0?
    source.maxReadFrames:Number.isSafeInteger(source.windowFrames)&&source.windowFrames>0?
      source.windowFrames:65_536;
  let low=1,high=-1,chunkIndex=0;
  for(let chunkStart=start;chunkStart<end;){
    if(!shouldContinue())return null;
    const count=Math.min(maxRead,end-chunkStart);
    const range=await source.read(chunkStart,count,{priority:"waveform"});
    if(!shouldContinue())return null;
    if(range?.startFrame!==chunkStart||!Array.isArray(range.channels)||
       !range.channels.length||!range.channels.every(channel=>
         channel instanceof Float32Array&&channel.length===count))
      throw Error("progressive waveform source returned an invalid PCM range");
    for(const channel of range.channels)for(const sample of channel){
      if(sample<low)low=sample;
      if(sample>high)high=sample;
    }
    chunkStart+=count;
    if(++chunkIndex%4===0&&chunkStart<end)await yieldControl();
  }
  return low===1&&high===-1?[0,0]:[low,high];
}
