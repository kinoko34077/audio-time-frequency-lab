const yieldToBrowser=()=>new Promise(resolve=>setTimeout(resolve,0));
const MAX_OVERVIEW_BINS=2048;

// Source-coordinate grid, independent of viewport size or device pixel ratio.
export function overviewBinCount(sourceFrames){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1)
    throw new RangeError("invalid overview source length");
  return Math.min(MAX_OVERVIEW_BINS,sourceFrames);
}

export function overviewNeedsResample(source){
  if(!source)return false;
  const bins=overviewBinCount(source.sourceFrames);
  if(source.overviewBinCount!==bins||
     !Array.isArray(source.overviewPeaks)||source.overviewPeaks.length!==bins)return true;
  if(source.overviewBuildComplete!==true)return false;
  return source.overviewPeaks.some(peak=>!Array.isArray(peak)||peak.length!==2);
}

export function advanceOverviewBuildToken(source){
  const current=Number.isSafeInteger(source?.overviewBuildToken)?
    source.overviewBuildToken:0;
  source.overviewBuildToken=current+1;
  return source.overviewBuildToken;
}

/** Measure adjacent half-open source bins using bounded contiguous PCM reads.
 * No sample from a neighboring bin may affect its peak.
 */
export async function readOverviewPeaks(source,first,after,bins,{shouldContinue=()=>true,
  yieldToBrowser:yieldControl=yieldToBrowser,onRead=()=>{}}={}){
  const frames=source?.sourceFrames;
  if(!Number.isSafeInteger(frames)||frames<1||
     !Number.isSafeInteger(first)||!Number.isSafeInteger(after)||
     !Number.isSafeInteger(bins)||bins<1||first<0||first>=after||after>bins||
     typeof source.read!=="function")
    throw new RangeError("invalid waveform overview range");
  const start=Math.floor(first*frames/bins),end=Math.floor(after*frames/bins);
  const maxRead=Math.min(65_536,
    Number.isSafeInteger(source.maxReadFrames)&&source.maxReadFrames>0?
      source.maxReadFrames:65_536,
    Number.isSafeInteger(source.windowFrames)&&source.windowFrames>0?
      source.windowFrames:65_536);
  const peaks=Array.from({length:after-first},()=>[1,-1]);
  let bin=first,chunkIndex=0;
  for(let chunkStart=start;chunkStart<end;){
    if(!shouldContinue())return null;
    const count=Math.min(maxRead,end-chunkStart);
    onRead(chunkStart,count);
    const range=await source.read(chunkStart,count,{priority:"waveform"});
    if(!shouldContinue())return null;
    if(range?.startFrame!==chunkStart||!Array.isArray(range.channels)||
       !range.channels.length||!range.channels.every(channel=>
         channel instanceof Float32Array&&channel.length===count))
      throw Error("progressive waveform source returned an invalid PCM range");
    const chunkEnd=chunkStart+count;
    let position=chunkStart;
    while(position<chunkEnd){
      const binEnd=Math.floor((bin+1)*frames/bins);
      if(binEnd<=position){bin++;continue;}
      const stop=Math.min(chunkEnd,binEnd),peak=peaks[bin-first];
      let low=peak[0],high=peak[1];
      for(const channel of range.channels)
        for(let i=position-chunkStart;i<stop-chunkStart;i++){
          const sample=channel[i];
          if(sample<low)low=sample;
          if(sample>high)high=sample;
        }
      peak[0]=low;peak[1]=high;
      position=stop;
      if(position===binEnd)bin++;
    }
    chunkStart=chunkEnd;
    if(++chunkIndex%4===0&&chunkStart<end)await yieldControl();
  }
  return peaks.map(peak=>peak[0]===1&&peak[1]===-1?[0,0]:peak);
}

export async function readOverviewPeak(source,bin,bins,options){
  const peaks=await readOverviewPeaks(source,bin,bin+1,bins,options);
  return peaks?.[0]??null;
}
