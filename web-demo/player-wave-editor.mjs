// Audio Lab #36 R4: whole-track overview is the legacy #wave, while this
// detailed viewport follows the fixed CENTER playhead. No transport state is
// duplicated: sample coordinates and callback actions belong to app.mjs.
// Interaction patterns reference AudioStretch / Apple Voice Memos; no assets
// or proprietary UI imagery are copied.
import {scrubSpeed,releaseScrubSpeed} from "./scrub-kinetics.mjs";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const DETAIL_READ_FRAMES=32_768;
const DETAIL_MAX_READS=64;
const DETAIL_MAX_CACHE_LEVELS=8;
const timestamp=seconds=>{
  const value=Math.max(0,seconds);
  return Math.floor(value/60)+":"+(value%60).toFixed(2).padStart(5,"0");
};
function peakHierarchy(channels){
  const n=channels[0].length,block=256,count=Math.ceil(n/block);
  const low=new Float32Array(count),high=new Float32Array(count);
  for(let k=0;k<count;k++){
    let lo=1,hi=-1;
    for(let i=k*block;i<Math.min(n,(k+1)*block);i++){
      for(const channel of channels){
        const value=channel[i];
        if(value<lo)lo=value;
        if(value>hi)hi=value;
      }
    }
    low[k]=lo;high[k]=hi;
  }
  const levels=[{block,low,high}];
  while(levels.at(-1).low.length>1){
    const last=levels.at(-1),size=Math.ceil(last.low.length/2);
    const nextLo=new Float32Array(size),nextHi=new Float32Array(size);
    for(let i=0;i<size;i++){
      const a=i*2,b=Math.min(last.low.length-1,a+1);
      nextLo[i]=Math.min(last.low[a],last.low[b]);
      nextHi[i]=Math.max(last.high[a],last.high[b]);
    }
    levels.push({block:last.block*2,low:nextLo,high:nextHi});
  }
  return levels;
}
export function createPlayerWaveEditor({
  canvas,wrap,overviewSelection,markerA,markerB,zoomIn,zoomOut,zoomLabel,
  rulerTicks=[],getMarkers=()=>[],getPosition,onPosition,onStart,onAB,onScrubState,
  onScrubMotion=()=>{},onHoverFrame=()=>false,onHoverEnd=()=>{},
  continuousRefresh=false
}){
  let channels=null,source=null,detailBuckets=new Map(),detailLevels=new Map(),
    detailBlockFrames=0;
  let detailPending=null,desiredDetailRange=null;
  let detailFailedKey=null,detailRetriedKey=null;
  let detailRetryTimer=null,detailRevision=0;
  let contentRevision=0,renderedContentRevision=-1,scheduledRefresh=0;
  let signalCanvas=null,signalShiftCanvas=null,signalFrame=NaN;
  let signalWidth=0,signalHeight=0,signalSpan=NaN;
  let signalNeedsFullPaint=true;
  const signalDirtyRanges=new Map();
  let rate=48000,levels=null,frames=0,spanFrames=rate*8;
  let lastFrame=NaN,lastSpan=NaN,lastWidth=0,lastHeight=0;
  const pointers=new Map();
  let gesture=null,dragged=false,active=false;
  // Anchor the unpressed hover to the waveform on pointer entry. Reusing a
  // shifting playhead on each event would multiply tiny mouse movements.
  let hover=null;
  const center=()=>clamp(Math.round(getPosition()*rate),0,Math.max(0,frames-1));
  function markSignalDirty(key,start,end){
    if(Number.isFinite(start)&&Number.isFinite(end)&&end>start)
      signalDirtyRanges.set(key,[start,end]);
  }
  function scheduleRefresh(){
    if(continuousRefresh)return;
    if(typeof requestAnimationFrame!=="function"){refresh();return;}
    if(scheduledRefresh)return;
    scheduledRefresh=requestAnimationFrame(()=>{
      scheduledRefresh=0;refresh();
    });
  }
  function setSource(nextChannels,nextRate){
    if(hover){hover=null;onHoverEnd(false);}
    source=nextChannels&&typeof nextChannels.read==='function'?
      nextChannels:null;
    channels=source?null:nextChannels;
    if(detailRetryTimer!==null)clearTimeout(detailRetryTimer);
    detailRetryTimer=null;
    detailBuckets.clear();detailLevels.clear();detailBuckets=new Map();
    detailBlockFrames=0;desiredDetailRange=null;
    detailPending=null;
    detailFailedKey=null;detailRetriedKey=null;detailRevision++;
    contentRevision++;
    signalNeedsFullPaint=true;signalDirtyRanges.clear();signalFrame=NaN;
    if(scheduledRefresh&&typeof cancelAnimationFrame==="function"){
      cancelAnimationFrame(scheduledRefresh);scheduledRefresh=0;
    }
    rate=nextRate||48000;
    frames=source?.sourceFrames||channels?.[0]?.length||0;
    if(rulerTicks[0]?.parentElement)rulerTicks[0].parentElement.hidden=!frames;
    markerA.hidden=!frames;markerB.hidden=!frames;
    levels=channels&&frames?peakHierarchy(channels):null;
    spanFrames=Math.max(2,Math.min(frames,rate*12));
    lastFrame=NaN;lastSpan=NaN;refresh(true);
  }
  function boundsToX(frame,c,w){
    return w*(.5+(frame-c)/spanFrames);
  }
  function sampledPeak(from,to,level){
    if(to<=from)return null;
    let low=1,high=-1;
    if(source){
      if(detailBlockFrames>0){
        // A finer resolution retained from the previous zoom level can cover
        // many bins per output pixel after zooming out. Try nearby cached
        // resolutions, but bound aggregation and fall back to the overview
        // instead of scanning an unbounded cache range on every paint.
        const candidates=[...detailLevels.keys()].sort((a,b)=>
          Math.abs(Math.log2(a/detailBlockFrames))-
          Math.abs(Math.log2(b/detailBlockFrames)));
        for(const blockFrames of candidates){
          const buckets=detailLevels.get(blockFrames);
          const begin=Math.floor(from/blockFrames);
          const end=Math.floor((to-1)/blockFrames);
          if(end-begin>256)continue;
          let complete=true,levelLow=1,levelHigh=-1;
          for(let bucket=begin;bucket<=end;bucket++){
            const peak=buckets.get(bucket);
            if(!peak){complete=false;break;}
            levelLow=Math.min(levelLow,peak[0]);
            levelHigh=Math.max(levelHigh,peak[1]);
          }
          if(complete)return [levelLow,levelHigh];
        }
        // Keep an existing absolute-source raster/overview visible while the
        // active-resolution detail read fills its cache.
      }
      if(source.overviewPeaks?.length){
        const peaks=source.overviewPeaks;
        const begin=clamp(Math.floor(from*peaks.length/frames),0,peaks.length-1);
        const end=clamp(Math.floor((to-1)*peaks.length/frames),begin,peaks.length-1);
        let hasPeak=false;
        for(let i=begin;i<=end;i++){
          const peak=peaks[i];if(!peak)continue;
          hasPeak=true;
          low=Math.min(low,peak[0]);high=Math.max(high,peak[1]);
        }
        if(!hasPeak)return null;
      }else return null;
    }else if(!channels)return null;
    else if(level){
      // Coarse hierarchy bins deliberately include partial border samples:
      // their visual envelope is conservative, and no raw whole-song scan is
      // repeated on each playback animation frame.
      const begin=clamp(Math.floor(from/level.block),0,level.low.length-1);
      const end=clamp(Math.floor((to-1)/level.block),begin,level.low.length-1);
      for(let i=begin;i<=end;i++){
        low=Math.min(low,level.low[i]);high=Math.max(high,level.high[i]);
      }
    }else{
      for(let i=from;i<to;i++){
        for(const channel of channels){
          const value=channel[i];
          if(value<low)low=value;
          if(value>high)high=value;
        }
      }
    }
    return [low===1&&high===-1?0:low,high===-1&&low===1?0:high];
  }
  function requestDetail(start,end){
    if(!source)return;
    const from=clamp(Math.floor(start),0,Math.max(0,frames-1));
    const to=clamp(Math.ceil(end),from+1,frames);
    const key=from+':'+to;
    const pixelRatio=Math.min(devicePixelRatio||1,2);
    const maxSummaryBins=Math.max(1,
      Math.ceil(canvas.clientWidth*pixelRatio));
    const reader=source;
    const maxRead=Number.isSafeInteger(reader.maxReadFrames)?
      reader.maxReadFrames:DETAIL_READ_FRAMES;
    const readFrames=Math.max(1,Math.min(DETAIL_READ_FRAMES,maxRead));
    // Peak resolution follows the complete viewport, not the portion that
    // currently intersects the source. Quantized bins avoid invalidating all
    // decoded peaks on every small pinch/held-button zoom step.
    const wantedBlock=Math.max(1,Math.ceil(spanFrames/maxSummaryBins));
    const requestedBlockFrames=Math.max(1,Math.min(readFrames,
      2**Math.ceil(Math.log2(wantedBlock))));
    // Keep each quantized grid separately. A zoom-out can reuse matching
    // coarse bins, or request bounded coarse PCM while a finer grid continues
    // to serve as the instant raster preview.
    if(requestedBlockFrames!==detailBlockFrames){
      let buckets=detailLevels.get(requestedBlockFrames);
      if(!buckets)buckets=new Map();
      detailLevels.delete(requestedBlockFrames);
      detailLevels.set(requestedBlockFrames,buckets);
      while(detailLevels.size>DETAIL_MAX_CACHE_LEVELS){
        const oldest=detailLevels.keys().next().value;
        detailLevels.delete(oldest);
      }
      detailBlockFrames=requestedBlockFrames;detailBuckets=buckets;
      signalDirtyRanges.clear();
      detailFailedKey=null;detailRetriedKey=null;
    }else if(!detailLevels.has(detailBlockFrames)){
      detailBuckets=new Map();detailLevels.set(detailBlockFrames,detailBuckets);
    }
    const blockFrames=detailBlockFrames;
    const summaryStart=Math.floor(from/blockFrames)*blockFrames;
    const summaryEnd=Math.min(frames,
      Math.ceil(to/blockFrames)*blockFrames);
    if(summaryEnd-summaryStart>readFrames*DETAIL_MAX_READS){
      // Wide zoom uses the whole-track overview. Stop the old bounded read
      // after its current chunk and keep cached detail available for a later
      // zoom-in. sampledPeak falls back to overview for wide pixels.
      desiredDetailRange=null;
      if(detailPending)detailRevision++;
      detailFailedKey=null;detailRetriedKey=null;
      return;
    }
    if(detailFailedKey&&detailFailedKey!==key){
      detailFailedKey=null;detailRetriedKey=null;
    }
    desiredDetailRange={start:summaryStart,end:summaryEnd,blockFrames,
      readFrames,maxSummaryBins,key};
    if(detailPending||detailFailedKey===key)return;
    const firstBucket=Math.floor(summaryStart/blockFrames);
    const afterLastBucket=Math.ceil(summaryEnd/blockFrames);
    let complete=true;
    for(let bucket=firstBucket;bucket<afterLastBucket;bucket++){
      if(!detailBuckets.has(bucket)){complete=false;break;}
    }
    if(complete){
      detailFailedKey=null;detailRetriedKey=null;
      if(detailRetryTimer!==null)clearTimeout(detailRetryTimer);
      detailRetryTimer=null;
      return;
    }
    const revision=detailRevision;
    const requestToken={};
    detailPending=requestToken;
    let activeKey=key;
    let obsoleteRequestFailed=false;
    (async()=>{
      let chunkIndex=0;
      while(true){
        if(source!==reader||revision!==detailRevision)return;
        const target=desiredDetailRange;
        if(!target||target.blockFrames!==detailBlockFrames)return;
        const firstBucket=Math.floor(target.start/blockFrames);
        const afterLastBucket=Math.ceil(target.end/blockFrames);
        const centerBucket=Math.floor(center()/blockFrames);
        let bucket=-1,distance=Infinity;
        for(let candidate=firstBucket;candidate<afterLastBucket;candidate++){
          if(detailBuckets.has(candidate))continue;
          const nextDistance=Math.abs(candidate-centerBucket);
          if(nextDistance<distance){bucket=candidate;distance=nextDistance;}
        }
        if(bucket<0){
          detailFailedKey=null;detailRetriedKey=null;
          return;
        }
        const maxReadBuckets=Math.max(1,
          Math.floor(target.readFrames/blockFrames));
        let afterBucket=bucket+1;
        while(afterBucket<afterLastBucket&&
              afterBucket-bucket<maxReadBuckets&&
              !detailBuckets.has(afterBucket))afterBucket++;
        let firstReadBucket=bucket;
        while(firstReadBucket>firstBucket&&
              afterBucket-firstReadBucket<maxReadBuckets&&
              !detailBuckets.has(firstReadBucket-1))firstReadBucket--;
        const chunkStart=firstReadBucket*blockFrames;
        const count=Math.min(target.readFrames,frames-chunkStart,
          (afterBucket-firstReadBucket)*blockFrames);
        activeKey=target.key;
        const range=await reader.read(chunkStart,count,{priority:'waveform'});
        if(source!==reader||revision!==detailRevision||
           detailBlockFrames!==blockFrames)return;
        if(range?.startFrame!==chunkStart||!Array.isArray(range.channels)||
           !range.channels.length||
           !range.channels.every(channel=>channel instanceof Float32Array&&
             channel.length===count))
          throw Error('progressive waveform source returned an invalid PCM range');
        const chunkEnd=chunkStart+count;
        const afterChunkBucket=Math.ceil(chunkEnd/blockFrames);
        const visibleFirstBucket=Math.floor(Math.max(0,center()-spanFrames/2)/blockFrames);
        const visibleAfterLastBucket=Math.ceil(Math.min(frames,
          center()+spanFrames/2)/blockFrames);
        let visiblePeaksChanged=false;
        for(let index=firstReadBucket;index<afterChunkBucket;index++){
          if(detailBuckets.has(index))continue;
          const bucketStart=index*blockFrames;
          const offset=bucketStart-chunkStart;
          const length=Math.min(blockFrames,frames-bucketStart);
          let low=1,high=-1;
          for(const channel of range.channels){
            for(let sample=offset;sample<offset+length;sample++){
              const value=channel[sample];
              if(value<low)low=value;
              if(value>high)high=value;
            }
          }
          detailBuckets.set(index,low===1&&high===-1?[0,0]:[low,high]);
          if(index>=visibleFirstBucket&&index<visibleAfterLastBucket){
            visiblePeaksChanged=true;
            markSignalDirty("detail:"+index,bucketStart,bucketStart+length);
          }
        }
        chunkIndex++;
        const maxCachedBuckets=Math.min(8192,
          Math.max(1024,target.maxSummaryBins*4));
        if(detailBuckets.size>maxCachedBuckets){
          const currentCenter=Math.floor(center()/blockFrames);
          const keep=new Set([...detailBuckets.keys()].sort((a,b)=>
            Math.abs(a-currentCenter)-Math.abs(b-currentCenter))
            .slice(0,maxCachedBuckets));
          for(const cached of detailBuckets.keys()){
            if(keep.has(cached))continue;
            detailBuckets.delete(cached);
            if(cached>=visibleFirstBucket&&cached<visibleAfterLastBucket){
              visiblePeaksChanged=true;
              const bucketStart=cached*blockFrames;
              markSignalDirty("detail:"+cached,bucketStart,
                Math.min(frames,bucketStart+blockFrames));
            }
          }
        }
        // Retain completed absolute source buckets so a moving viewport only
        // needs the newly exposed edge, not a full rescan on every pan.
        if(chunkIndex%4===0)await new Promise(resolve=>setTimeout(resolve,0));
        if(visiblePeaksChanged){contentRevision++;scheduleRefresh();}
      }
    })().catch(error=>{
      if(source!==reader||revision!==detailRevision)return;
      const failedKey=activeKey;
      if(desiredDetailRange?.key!==failedKey){
        obsoleteRequestFailed=true;
        detailFailedKey=null;detailRetriedKey=null;
        return;
      }
      detailFailedKey=failedKey;
      if(error?.name==='AbortError'&&detailRetriedKey!==failedKey){
        if(detailRetryTimer!==null)clearTimeout(detailRetryTimer);
        detailRetryTimer=setTimeout(()=>{
          detailRetryTimer=null;
          if(source!==reader||revision!==detailRevision||
             desiredDetailRange?.key!==failedKey)return;
          detailRetriedKey=failedKey;detailFailedKey=null;refresh(true);
        },160);
      }
    }).finally(()=>{
      if(detailPending===requestToken){
        detailPending=null;
        const target=desiredDetailRange;
        // A zoom can invalidate the pending block resolution or cancel it
        // while switching to the overview. Restart only when that obsolete
        // read settles; ordinary completion and failed-key retry handling
        // must not recurse into another request here.
        if(source===reader&&target&&
           (revision!==detailRevision||detailBlockFrames!==blockFrames||
            obsoleteRequestFailed))
          requestDetail(target.start,target.end);
      }
    });
  }
  function zoom(factor,pivotX=.5){
    if(!frames)return false;
    const c=center(),anchor=c+(pivotX-.5)*spanFrames;
    const next=clamp(spanFrames*factor,2,Math.max(2,frames));
    if(next===spanFrames)return false;
    if(hover){hover=null;onHoverEnd(false);}
    spanFrames=next;
    const relocated=clamp(anchor-(pivotX-.5)*next,0,frames-1);
    // Zoom centered on the fixed head is a VISUAL change, not a seek.
    // Avoid resetting active grain synthesis / legacy audio transport.
    if(Math.abs(relocated-c)>=.5)onPosition(relocated/rate,{start:false});
    lastFrame=NaN;refresh(true);
    return true;
  }
  function ensureSignalCanvases(width,height){
    if(typeof document==="undefined")return null;
    if(!signalCanvas){
      signalCanvas=document.createElement("canvas");
      signalCanvas.id="wave-detail-buffer";
      signalShiftCanvas=document.createElement("canvas");
      signalShiftCanvas.id="wave-detail-shift-buffer";
    }
    for(const buffer of [signalCanvas,signalShiftCanvas]){
      if(buffer.width!==width)buffer.width=width;
      if(buffer.height!==height)buffer.height=height;
    }
    return {signal:signalCanvas.getContext("2d"),
      shift:signalShiftCanvas.getContext("2d")};
  }
  function drawSignal(context,width,height,c,ratio,clipStart=0,clipEnd=width){
    const fromX=clamp(Math.floor(clipStart),0,width);
    const toX=clamp(Math.ceil(clipEnd),fromX,width);
    if(toX<=fromX)return;
    context.save();
    context.beginPath();context.rect(fromX,0,toX-fromX,height);context.clip();
    context.clearRect(fromX,0,toX-fromX,height);
    const start=c-spanFrames/2,samplesPerPixel=spanFrames/width;
    const level=levels&&samplesPerPixel>=256?
      levels.slice().reverse().find(x=>x.block<=samplesPerPixel*1.6)||levels[0]:null;
    context.strokeStyle="#75d9c5";context.lineWidth=Math.max(1,ratio);
    context.beginPath();
    for(let x=fromX;x<toX;x++){
      const pixelStart=start+x*samplesPerPixel;
      const pixelEnd=start+(x+1)*samplesPerPixel;
      // Time outside the source has no signal. Keeping this region transparent
      // lets the destination paint a stable background at either file edge.
      if(pixelEnd<=0||pixelStart>=frames)continue;
      const from=clamp(Math.floor(pixelStart),0,frames-1);
      const to=clamp(Math.ceil(pixelEnd),from+1,frames);
      const peak=sampledPeak(from,to,level);
      if(!peak||(peak[0]===0&&peak[1]===0))continue;
      const [lo,hi]=peak;
      const y1=height/2-hi*height*.40,y2=height/2-lo*height*.40;
      context.moveTo(x,Math.min(y1,y2));
      context.lineTo(x,Math.max(y1+ratio,y2+ratio));
    }
    context.stroke();context.restore();
  }
  function drawZoomPreview(context,width,height,c){
    const oldStart=signalFrame-signalSpan/2,oldEnd=signalFrame+signalSpan/2;
    const nextStart=c-spanFrames/2,nextEnd=c+spanFrames/2;
    // Only reuse pixels whose time belongs to the source. A previous raster
    // may contain stale edge pixels while a zoom is being coalesced; carrying
    // those past frame 0 or EOF makes the blank margin visibly flicker.
    const from=Math.max(oldStart,nextStart,0);
    const to=Math.min(oldEnd,nextEnd,frames);
    if(to<=from)return;
    const sourceX=(from-oldStart)/signalSpan*width;
    const sourceWidth=(to-from)/signalSpan*width;
    const targetX=(from-nextStart)/spanFrames*width;
    const targetWidth=(to-from)/spanFrames*width;
    context.drawImage(signalShiftCanvas,sourceX,0,sourceWidth,height,
      targetX,0,targetWidth,height);
  }
  function updateSignalBuffer(buffers,c,width,height,ratio,baseChanged,positionChanged){
    if(!buffers)return false;
    const {signal,shift}=buffers;
    const dimensionsChanged=signalWidth!==width||signalHeight!==height;
    const spanChanged=signalSpan!==spanFrames;
    const canZoomPreview=spanChanged&&!dimensionsChanged&&
      Number.isFinite(signalFrame)&&signalSpan>0&&!signalNeedsFullPaint;
    if(canZoomPreview){
      shift.clearRect(0,0,width,height);
      shift.drawImage(signalCanvas,0,0);
      signal.clearRect(0,0,width,height);
      drawZoomPreview(signal,width,height,c);
      const oldStart=signalFrame-signalSpan/2,oldEnd=signalFrame+signalSpan/2;
      const nextStart=c-spanFrames/2,nextEnd=c+spanFrames/2;
      const overlapStart=Math.max(oldStart,nextStart);
      const overlapEnd=Math.min(oldEnd,nextEnd);
      if(overlapEnd>overlapStart){
        const leftEnd=(overlapStart-nextStart)/spanFrames*width;
        const rightStart=(overlapEnd-nextStart)/spanFrames*width;
        drawSignal(signal,width,height,c,ratio,0,leftEnd);
        drawSignal(signal,width,height,c,ratio,rightStart,width);
      }else drawSignal(signal,width,height,c,ratio);
      signalFrame=c;signalSpan=spanFrames;
    }else if(baseChanged||dimensionsChanged||!Number.isFinite(signalFrame)){
      signal.clearRect(0,0,width,height);
      drawSignal(signal,width,height,c,ratio);
      signalFrame=c;signalWidth=width;signalHeight=height;
      signalSpan=spanFrames;signalNeedsFullPaint=false;signalDirtyRanges.clear();
      return true;
    }
    signalWidth=width;signalHeight=height;
    if(positionChanged){
      // Reuse the PCM raster while the playhead advances. Move whole backing
      // pixels to avoid repeated full-width path generation and resampling blur,
      // then compute only the newly exposed strip from the same sampled PCM.
      const shiftX=Math.round((signalFrame-c)*width/spanFrames);
      if(Math.abs(shiftX)>=width/2){
        signal.clearRect(0,0,width,height);
        drawSignal(signal,width,height,c,ratio);
        signalFrame=c;signalDirtyRanges.clear();
      }else if(shiftX){
        shift.clearRect(0,0,width,height);
        shift.drawImage(signalCanvas,shiftX,0);
        signal.clearRect(0,0,width,height);
        signal.drawImage(signalShiftCanvas,0,0);
        signalFrame-=shiftX*spanFrames/width;
        if(shiftX>0)drawSignal(signal,width,height,signalFrame,ratio,0,shiftX+1);
        else drawSignal(signal,width,height,signalFrame,ratio,width+shiftX-1,width);
      }
    }
    const dirty=[];
    for(const [key,[start,end]] of signalDirtyRanges){
      const left=boundsToX(start,signalFrame,width);
      const right=boundsToX(end,signalFrame,width);
      if(right<=0||left>=width)continue;
      dirty.push([Math.max(0,Math.floor(left)-1),
        Math.min(width,Math.ceil(right)+1)]);
      signalDirtyRanges.delete(key);
    }
    dirty.sort((a,b)=>a[0]-b[0]);
    for(let index=0;index<dirty.length;){
      let [left,right]=dirty[index++];
      while(index<dirty.length&&dirty[index][0]<=right){
        right=Math.max(right,dirty[index++][1]);
      }
      drawSignal(signal,width,height,signalFrame,ratio,left,right);
    }
    return true;
  }
  function refresh(force=false){
    if(!frames||!canvas.isConnected||!canvas.clientWidth)return;
    const c=center(),w=canvas.clientWidth,h=canvas.clientHeight;
    // Already invoked once per browser RAF by app.mjs. The former 32ms
    // throttle added an avoidable 30Hz stair-step to a 60Hz playhead.
    // A subpixel source movement does not alter the visible waveform; still
    // update marker positions, because A/B may have changed.
    const positionChanged=Math.abs(c-lastFrame)>
      spanFrames/Math.max(1,w)*.35;
    const dimensionsChanged=w!==lastWidth||h!==lastHeight;
    const spanChanged=spanFrames!==lastSpan;
    const contentChanged=contentRevision!==renderedContentRevision;
    const changed=force||dimensionsChanged||spanChanged||contentChanged||positionChanged;
    if(changed){
      lastFrame=c;lastSpan=spanFrames;lastWidth=w;lastHeight=h;
      const ratio=Math.min(devicePixelRatio||1,2);
      const pixelWidth=Math.max(1,Math.round(w*ratio));
      const pixelHeight=Math.max(1,Math.round(h*ratio));
      // Setting canvas.width or height *always clears the backing buffer*
      // and resets canvas state. Reallocate only on actual pixel resize.
      // This prevents a complete canvas reconstruction on every playhead RAF.
      if(canvas.width!==pixelWidth)canvas.width=pixelWidth;
      if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
      const context=canvas.getContext("2d"),width=canvas.width,height=canvas.height;
      const xScale=width/w,scale=height/h;
      const start=c-spanFrames/2;
      const visibleStart=Math.max(0,start),visibleEnd=Math.min(frames,start+spanFrames);
      if(visibleEnd>visibleStart)requestDetail(visibleStart,visibleEnd);
      const buffers=ensureSignalCanvases(width,height);
      if(contentChanged&&!signalNeedsFullPaint&&!signalDirtyRanges.size)
        signalNeedsFullPaint=true;
      const signalBaseChanged=dimensionsChanged||signalNeedsFullPaint||
        (force&&!spanChanged);
      const signalUpdated=updateSignalBuffer(buffers,c,width,height,ratio,
        signalBaseChanged,positionChanged);
      context.clearRect(0,0,width,height);
      context.fillStyle="#0a1e27";context.fillRect(0,0,width,height);
      const {a,b,enabled}=onAB();
      const xa=clamp(boundsToX(a,c,width),0,width);
      const xb=clamp(boundsToX(b,c,width),0,width);
      context.fillStyle=enabled?"#447d6b38":"#8b9e9c18";
      context.fillRect(xa,0,Math.max(0,xb-xa),height);
      context.strokeStyle="#33595f";context.lineWidth=ratio;
      context.beginPath();context.moveTo(0,height/2);context.lineTo(width,height/2);context.stroke();
      if(signalUpdated)context.drawImage(signalCanvas,0,0);
      else drawSignal(context,width,height,c,ratio);
      for(const [frame,color] of [[a,"#69e2c2"],[b,"#ffd38a"]]){
        const x=boundsToX(frame,c,width);
        if(x<0||x>width)continue;
        context.strokeStyle=color;context.lineWidth=2*ratio;
        context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke();
      }
      context.strokeStyle="#c69cffb0";context.lineWidth=ratio;
      context.setLineDash([3*ratio,3*ratio]);
      for(const frame of getMarkers()){
        const x=boundsToX(frame,c,width);
        if(x<0||x>width)continue;
        context.beginPath();context.moveTo(x,28*scale);
        context.lineTo(x,height-25*scale);context.stroke();
      }
      context.setLineDash([]);
      context.strokeStyle="#507075";context.lineWidth=ratio;
      for(let n=0;n<=4;n++){
        const x=n*width/4,time=(start+n*spanFrames/4)/rate;
        const tick=rulerTicks[n];
        if(tick){
          tick.textContent=time>=0&&time<=frames/rate?timestamp(time):"";
          tick.style.left=25*n+"%";
          tick.style.transform=n===0?"none":n===4?"translateX(-100%)":"translateX(-50%)";
        }
        if(time>=0&&time<=frames/rate){
          context.beginPath();context.moveTo(x,20*scale);
          context.lineTo(x,27*scale);context.stroke();
        }
      }
      renderedContentRevision=contentRevision;
    }
    const {a,b}=onAB();
    const xA=boundsToX(a,c,w),xB=boundsToX(b,c,w);
    for(const [node,x] of [[markerA,xA],[markerB,xB]]){
      node.hidden=x<0||x>w;
      node.style.left=clamp(x,0,w)+"px";
    }
    const overview=overviewSelection;
    overview.style.left=100*a/frames+"%";
    overview.style.width=100*(b-a)/frames+"%";
    zoomLabel.textContent=spanFrames/rate>=1?(spanFrames/rate).toFixed(1)+"秒":"ms "+Math.round(spanFrames/rate*1000);
    canvas.setAttribute("aria-valuemax",String(Math.max(0,frames-1)));
    canvas.setAttribute("aria-valuenow",String(c));
    canvas.setAttribute("aria-valuetext",timestamp(c/rate));
  }
  function refreshOverview(startFrame=null,endFrame=null,bin=null){
    // Overview bins only feed the fallback renderer at very wide zoom. While
    // the detailed waveform has its own PCM buckets, repainting it for every
    // four overview bins needlessly clears the live canvas dozens of times
    // during source analysis and can look like edge flicker during playback.
    if(source&&detailBlockFrames>0&&Number.isFinite(startFrame)&&
       Number.isFinite(endFrame)&&endFrame>startFrame){
      const visibleStart=Math.max(startFrame,center()-spanFrames/2,0);
      const visibleEnd=Math.min(endFrame,center()+spanFrames/2,frames);
      if(visibleEnd<=visibleStart)return;
      const first=Math.floor(visibleStart/detailBlockFrames);
      const afterLast=Math.ceil(visibleEnd/detailBlockFrames);
      let complete=afterLast-first<=256;
      for(let index=first;complete&&index<afterLast;index++){
        if(!detailBuckets.has(index))complete=false;
      }
      if(complete)return;
      startFrame=visibleStart;endFrame=visibleEnd;
    }
    // The app's shared display RAF observes this revision, including while
    // paused. Let it paint instead of starting another canvas render path.
    if(Number.isFinite(startFrame)&&Number.isFinite(endFrame)&&endFrame>startFrame)
      markSignalDirty("overview:"+(bin??startFrame),startFrame,endFrame);
    else signalNeedsFullPaint=true;
    contentRevision++;
    scheduleRefresh();
  }
  function pos(e){
    const r=canvas.getBoundingClientRect();
    return clamp(e.clientX-r.left,0,r.width);
  }
  function endGesture(id,reason="release"){
    if(gesture?.type==="pan"&&gesture.id===id){
      clearTimeout(gesture.idleTimer);
      if(active){
        if(reason==="release"&&gesture.moved){
          const elapsed=performance.now()-(gesture.lastMovedAt??-Infinity);
          onScrubMotion(releaseScrubSpeed(gesture.velocity??0,elapsed),"release");
        }else{
          // No movement means no record throw. Do not schedule a 480ms
          // inertia tail after a simple tap or an interrupted gesture.
          onScrubMotion(0,"cancel");
        }
      }
    }
    pointers.delete(id);
    try{if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}catch{}
    if(pointers.size===0){gesture=null;wrap.removeAttribute("data-interaction");
      if(active){active=false;onScrubState(false);}
    }else if(pointers.size===1){
      const [firstId,p]=pointers.entries().next().value;
      // A remaining finger after pinch is not a new tap on the waveform.
      // It may begin a deliberate pan, but lifting without movement must
      // never accidentally seek to that finger's horizontal position.
      gesture={type:"pan",id:firstId,x:p.x,frame:center(),moved:false,suppressTap:true};
      wrap.dataset.interaction="pan";
    }
    refresh(true);
  }
  const pointerHover=e=>{
    if(!frames||pointers.size||e.pointerType!=="mouse"||e.buttons!==0||
       !e.isTrusted)return;
    if(!hover)hover={x:pos(e),frame:center()};
    const sample=clamp(Math.round(hover.frame+
      (pos(e)-hover.x)*spanFrames/Math.max(1,canvas.clientWidth)),0,frames-1);
    if(!onHoverFrame(sample))hover=null;
  };
  canvas.addEventListener("pointerenter",pointerHover);
  canvas.addEventListener("pointermove",pointerHover);
  canvas.addEventListener("pointerleave",e=>{
    if(e.pointerType==="mouse"&&hover){
      hover=null;onHoverEnd(true);
    }
  });
  canvas.addEventListener("pointerdown",e=>{
    if(!frames||(e.pointerType==="mouse"&&e.button!==0))return;
    if(hover){hover=null;onHoverEnd(false);}
    const x=pos(e);
    pointers.set(e.pointerId,{x});
    try{canvas.setPointerCapture(e.pointerId);}catch{}
    if(pointers.size===2){
      if(active){
        clearTimeout(gesture?.idleTimer);
        onScrubMotion(0,"cancel");onScrubState(false);active=false;
      }
      const pts=[...pointers.values()],mid=(pts[0].x+pts[1].x)/2;
      gesture={type:"pinch",distance:Math.max(1,Math.abs(pts[0].x-pts[1].x)),
        span:spanFrames,center:center(),mid,anchor:center()+(mid/canvas.clientWidth-.5)*spanFrames};
      wrap.dataset.interaction="pinch";e.preventDefault();return;
    }
    const c=center(),w=canvas.clientWidth,{a,b}=onAB();
    const distanceA=Math.abs(boundsToX(a,c,w)-x),distanceB=Math.abs(boundsToX(b,c,w)-x);
    const target=Math.min(distanceA,distanceB)<=24?(distanceA<=distanceB?"a":"b"):"pan";
    if(target!=="pan")onScrubMotion(0,"cancel");
    gesture={type:target,id:e.pointerId,x,frame:c,moved:false,
      lastSeekFrame:c,lastMoveTime:performance.now(),lastMovedAt:-Infinity,
      velocity:0,idleTimer:null};
    wrap.dataset.interaction=target;
    if(target==="pan"){
      // A stationary tap selects a frame, it does NOT mean Play.
      // While an engine is already playing, keep the held scratch at 0x;
      // the audition launch itself is deferred until a real drag (>3px).
      active=true;onScrubState(true);onScrubMotion(0,"hold",c);
    }
    e.preventDefault();
  });
  canvas.addEventListener("pointermove",e=>{
    if(!pointers.has(e.pointerId)||!frames)return;
    pointers.get(e.pointerId).x=pos(e);
    if(!gesture)return;
    if(gesture.type==="pinch"&&pointers.size>=2){
      const pts=[...pointers.values()],mid=(pts[0].x+pts[1].x)/2;
      const length=Math.max(1,Math.abs(pts[0].x-pts[1].x));
      spanFrames=clamp(gesture.span*gesture.distance/length,2,Math.max(2,frames));
      const newCenter=clamp(gesture.anchor-(mid/canvas.clientWidth-.5)*spanFrames,0,frames-1);
      if(Math.abs(newCenter-center())>=.5)
        onPosition(newCenter/rate,{start:false});
      lastFrame=NaN;refresh(true);e.preventDefault();return;
    }
    if(gesture.id!==e.pointerId)return;
    const delta=pos(e)-gesture.x;
    if(Math.abs(delta)>3)gesture.moved=true;
    if(!gesture.moved)return;
    if(gesture.type==="pan"){
      if(!active){ // A deliberate pan after a pinch may begin a new scrub.
        active=true;onScrubState(true);onScrubMotion(0,"hold",center());onStart();
      }
      const next=clamp(Math.round(gesture.frame-delta*spanFrames/canvas.clientWidth),0,frames-1);
      if(!gesture.auditionStarted){
        gesture.auditionStarted=true;
        onStart(next/rate);
      }
      const now=performance.now();
      const value=scrubSpeed(gesture.lastSeekFrame,next,now-gesture.lastMoveTime,rate);
      gesture.lastSeekFrame=next;gesture.lastMoveTime=now;
      gesture.lastMovedAt=now;gesture.velocity=value;
      clearTimeout(gesture.idleTimer);
      // A held finger must freeze source time instead of allowing the last
      // movement velocity (or saved transport speed) to continue drifting.
      const captured=gesture;
      gesture.idleTimer=setTimeout(()=>{
        if(active&&gesture===captured){
          captured.velocity=0;onScrubMotion(0,"hold",captured.lastSeekFrame);
        }
      },90);
      // One atomic source-frame + signed-velocity transaction owns audio.
      // The following display update MUST NOT send another reset/seek.
      onScrubMotion(value,"move",next);
      onPosition(next/rate,{start:false,scrub:true});
    }else{
      const pointerFrame=clamp(Math.round(center()+(pos(e)/canvas.clientWidth-.5)*spanFrames),0,frames);
      // The shared A/B owner reconciles crossed handles atomically.
      // Do not pin A to old B-1 (or B to old A+1): dragging the user's
      // chosen handle beyond its peer must move that peer automatically.
      onAB(gesture.type,pointerFrame);
    }
    refresh(true);e.preventDefault();
  });
  canvas.addEventListener("pointerup",e=>{
    if(!pointers.has(e.pointerId))return;
    if(gesture?.id===e.pointerId&&gesture.type==="pan"&&
       !gesture.moved&&!gesture.suppressTap){
      const x=pos(e),where=center()+(x/canvas.clientWidth-.5)*spanFrames;
      onPosition(clamp(where,0,frames-1)/rate,{start:false});
    }
    endGesture(e.pointerId,"release");
  });
  for(const name of ["pointercancel","lostpointercapture"])
    canvas.addEventListener(name,e=>{if(pointers.has(e.pointerId))endGesture(e.pointerId,"cancel");});
  canvas.addEventListener("wheel",e=>{
    if(!frames)return;
    if(hover){hover=null;onHoverEnd(false);}
    e.preventDefault();onScrubMotion(0,"cancel");
    if(e.ctrlKey||e.metaKey){
      zoom(Math.exp(e.deltaY*.004),pos(e)/canvas.clientWidth);
    }else{
      onPosition(clamp(center()+e.deltaY*spanFrames/canvas.clientWidth,0,frames-1)/rate,{start:false});
      refresh(true);
    }
  },{passive:false});
  canvas.addEventListener("keydown",e=>{
    if(!frames)return;
    if(hover){hover=null;onHoverEnd(false);}
    onScrubMotion(0,"cancel");
    if(e.key==="+"||e.key==="="){zoom(.5);e.preventDefault();return;}
    if(e.key==="-"){zoom(2);e.preventDefault();return;}
    let next=null;
    const step=Math.max(1,Math.round(e.shiftKey?spanFrames/5:rate/10));
    if(e.key==="ArrowLeft")next=center()-step;
    if(e.key==="ArrowRight")next=center()+step;
    if(e.key==="Home")next=0;
    if(e.key==="End")next=frames-1;
    if(next===null)return;
    e.preventDefault();
    onPosition(clamp(next,0,frames-1)/rate,{start:false});
    refresh(true);
  });
  function bindZoomButton(button,direction){
    let pointerId=null,startTimer=0,animation=0,held=false,lastTime=0;
    const singleStep=()=>{
      onScrubMotion(0,"cancel");
      zoom(direction>0?.5:2);
    };
    const repeat=time=>{
      const elapsed=Math.max(0,Math.min(40,time-lastTime));
      lastTime=time;
      // A timer may start RAF in the same frame timestamp. Ignore that zero
      // interval instead of mistaking it for a clamped zoom bound.
      if(elapsed<1){animation=requestAnimationFrame(repeat);return;}
      if(!zoom(Math.exp(-direction*Math.LN2*elapsed/550))){
        animation=0;return;
      }
      animation=requestAnimationFrame(repeat);
    };
    const stopGlobalTracking=()=>{
      if(typeof window!="undefined"){
        window.removeEventListener("pointerup",finishPointer);
        window.removeEventListener("pointercancel",finishPointer);
        window.removeEventListener("blur",finishBlur);
      }
      if(typeof document!="undefined")
        document.removeEventListener("visibilitychange",finishVisibility);
    };
    const finish=(event,applyTap)=>{
      if(pointerId===null||
        (event&&event.pointerId!==pointerId))return;
      clearTimeout(startTimer);startTimer=0;
      if(animation)cancelAnimationFrame(animation);
      animation=0;
      stopGlobalTracking();
      if(applyTap&&!held)singleStep();
      pointerId=null;held=false;
    };
    const finishPointer=event=>finish(event,false);
    const finishBlur=()=>finish(null,false);
    const finishVisibility=()=>{
      if(document.hidden)finish(null,false);
    };
    button.addEventListener("pointerdown",event=>{
      if(pointerId!==null||
        (event.pointerType==="mouse"&&event.button!==0))return;
      pointerId=event.pointerId;held=false;
      onScrubMotion(0,"cancel");
      try{button.setPointerCapture(event.pointerId);}catch{}
      if(typeof window!="undefined"){
        window.addEventListener("pointerup",finishPointer);
        window.addEventListener("pointercancel",finishPointer);
        window.addEventListener("blur",finishBlur);
      }
      if(typeof document!="undefined")
        document.addEventListener("visibilitychange",finishVisibility);
      startTimer=setTimeout(()=>{
        held=true;lastTime=performance.now();
        animation=requestAnimationFrame(repeat);
      },220);
      event.preventDefault();
    });
    button.addEventListener("pointerup",event=>finish(event,true));
    button.addEventListener("pointercancel",event=>finish(event,false));
    button.addEventListener("lostpointercapture",event=>finish(event,false));
    // Native keyboard activation dispatches click with detail=0.
    button.addEventListener("click",event=>{
      if(event.detail===0)singleStep();
    });
  }
  bindZoomButton(zoomIn,1);bindZoomButton(zoomOut,-1);
  return {setSource,refresh,refreshOverview,get spanFrames(){return spanFrames;},
    get isScrubbing(){return active;}};
}
