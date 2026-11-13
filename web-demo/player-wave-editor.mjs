// Audio Lab #36 R4: whole-track overview is the legacy #wave, while this
// detailed viewport follows the fixed CENTER playhead. No transport state is
// duplicated: sample coordinates and callback actions belong to app.mjs.
// Interaction patterns reference AudioStretch / Apple Voice Memos; no assets
// or proprietary UI imagery are copied.
import {scrubSpeed,releaseScrubSpeed} from "./scrub-kinetics.mjs";
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
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
  visibleStart,visibleEnd,getPosition,onPosition,onStart,onAB,onScrubState,
  onScrubMotion=()=>{}
}){
  let channels=null,rate=48000,levels=null,frames=0,spanFrames=rate*8;
  let lastDraw=0,lastFrame=NaN,lastSpan=NaN,lastWidth=0,lastHeight=0;
  const pointers=new Map();
  let gesture=null,dragged=false,active=false;
  const center=()=>clamp(Math.round(getPosition()*rate),0,Math.max(0,frames-1));
  function setSource(nextChannels,nextRate){
    channels=nextChannels;rate=nextRate||48000;frames=channels?.[0]?.length||0;
    levels=frames?peakHierarchy(channels):null;
    spanFrames=Math.max(2,Math.min(frames,rate*12));
    lastFrame=NaN;lastSpan=NaN;refresh(true);
  }
  function boundsToX(frame,c,w){
    return w*(.5+(frame-c)/spanFrames);
  }
  function sampledPeak(from,to,level){
    if(!channels||to<=from)return [0,0];
    let low=1,high=-1;
    if(level){
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
  function zoom(factor,pivotX=.5){
    if(!frames)return;
    onScrubMotion(0,"cancel");
    const c=center(),anchor=c+(pivotX-.5)*spanFrames;
    const next=clamp(spanFrames*factor,2,Math.max(2,frames));
    spanFrames=next;
    const relocated=clamp(anchor-(pivotX-.5)*next,0,frames-1);
    // Zoom centered on the fixed head is a VISUAL change, not a seek.
    // Avoid resetting active grain synthesis / legacy audio transport.
    if(Math.abs(relocated-c)>=.5)onPosition(relocated/rate,{start:false});
    lastFrame=NaN;refresh(true);
  }
  function refresh(force=false){
    if(!frames||!canvas.isConnected||!canvas.clientWidth)return;
    const now=performance.now(),c=center(),w=canvas.clientWidth,h=canvas.clientHeight;
    if(!force&&now-lastDraw<32)return;
    // A subpixel source movement does not alter the visible waveform; still
    // update marker positions, because A/B may have changed.
    const changed=force||w!==lastWidth||h!==lastHeight||spanFrames!==lastSpan||
      Math.abs(c-lastFrame)>spanFrames/Math.max(1,w)*.35;
    if(changed){
      lastDraw=now;lastFrame=c;lastSpan=spanFrames;lastWidth=w;lastHeight=h;
      const ratio=Math.min(devicePixelRatio||1,2);
      canvas.width=Math.max(1,Math.round(w*ratio));
      canvas.height=Math.max(1,Math.round(h*ratio));
      const context=canvas.getContext("2d"),width=canvas.width,height=canvas.height;
      const xScale=width/w,scale=height/h;
      context.clearRect(0,0,width,height);
      context.fillStyle="#0a1e27";context.fillRect(0,0,width,height);
      const start=c-spanFrames/2;
      const {a,b,enabled}=onAB();
      const xa=clamp(boundsToX(a,c,width),0,width);
      const xb=clamp(boundsToX(b,c,width),0,width);
      context.fillStyle=enabled?"#447d6b38":"#8b9e9c18";
      context.fillRect(xa,0,Math.max(0,xb-xa),height);
      context.strokeStyle="#33595f";context.lineWidth=ratio;
      context.beginPath();context.moveTo(0,height/2);context.lineTo(width,height/2);context.stroke();
      const samplesPerPixel=spanFrames/width;
      const level=samplesPerPixel>=256?levels.slice().reverse().find(x=>x.block<=samplesPerPixel*1.6)||levels[0]:null;
      context.strokeStyle="#75d9c5";context.lineWidth=Math.max(1,ratio);
      context.beginPath();
      for(let x=0;x<width;x++){
        const from=Math.max(0,Math.floor(start+x*samplesPerPixel));
        const to=Math.min(frames,Math.max(from+1,Math.ceil(start+(x+1)*samplesPerPixel)));
        if(to<=0||from>=frames)continue;
        const [lo,hi]=sampledPeak(from,to,level);
        const amp=Math.max(1,Math.abs(hi-lo)*height*.38);
        const y1=height/2-hi*height*.40,y2=height/2-lo*height*.40;
        context.moveTo(x,Math.min(y1,y2));
        context.lineTo(x,Math.max(y1+1,y2+1));
      }
      context.stroke();
      for(const [frame,color] of [[a,"#69e2c2"],[b,"#ffd38a"]]){
        const x=boundsToX(frame,c,width);
        if(x<0||x>width)continue;
        context.strokeStyle=color;context.lineWidth=2*ratio;
        context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke();
      }
      const font=Math.round(10*scale);
      context.fillStyle="#b2cecd";context.font=font+"px ui-monospace, monospace";
      for(let n=0;n<=4;n++){
        const x=n*width/4,time=(start+n*spanFrames/4)/rate;
        if(time>=0&&time<=frames/rate)
          context.fillText(timestamp(time),Math.min(width-50*scale,x+4*scale),height-6*scale);
      }
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
    visibleStart.textContent=timestamp(Math.max(0,c-spanFrames/2)/rate);
    visibleEnd.textContent=timestamp(Math.min(frames,c+spanFrames/2)/rate);
    zoomLabel.textContent=spanFrames/rate>=1?(spanFrames/rate).toFixed(1)+"秒":"ms "+Math.round(spanFrames/rate*1000);
    canvas.setAttribute("aria-valuemax",String(Math.max(0,frames-1)));
    canvas.setAttribute("aria-valuenow",String(c));
    canvas.setAttribute("aria-valuetext",timestamp(c/rate));
  }
  function pos(e){
    const r=canvas.getBoundingClientRect();
    return clamp(e.clientX-r.left,0,r.width);
  }
  function endGesture(id,reason="release"){
    if(gesture?.type==="pan"&&gesture.id===id){
      clearTimeout(gesture.idleTimer);
      if(active){
        const elapsed=performance.now()-(gesture.lastMovedAt??-Infinity);
        onScrubMotion(reason==="release"?releaseScrubSpeed(gesture.velocity??0,elapsed):0,reason);
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
  canvas.addEventListener("pointerdown",e=>{
    if(!frames||(e.pointerType==="mouse"&&e.button!==0))return;
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
      active=true;onScrubState(true);onScrubMotion(0,"hold");onStart();
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
        active=true;onScrubState(true);onScrubMotion(0,"hold");onStart();
      }
      const next=clamp(Math.round(gesture.frame-delta*spanFrames/canvas.clientWidth),0,frames-1);
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
          captured.velocity=0;onScrubMotion(0,"hold");
        }
      },90);
      onScrubMotion(value,"move");
      onPosition(next/rate,{start:false});
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
    e.preventDefault();onScrubMotion(0,"cancel");
    if(e.ctrlKey||e.metaKey)zoom(Math.exp(e.deltaY*.004),pos(e)/canvas.clientWidth);
    else onPosition(clamp(center()+e.deltaY*spanFrames/canvas.clientWidth,0,frames-1)/rate,{start:false});
    refresh(true);
  },{passive:false});
  canvas.addEventListener("keydown",e=>{
    if(!frames)return;
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
  zoomIn.addEventListener("click",()=>zoom(.5));
  zoomOut.addEventListener("click",()=>zoom(2));
  return {setSource,refresh,get spanFrames(){return spanFrames;},
    get isScrubbing(){return active;}};
}
