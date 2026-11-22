import test from "node:test";
import assert from "node:assert/strict";
import {createPlayerWaveEditor} from "./player-wave-editor.mjs";

function makeEditor(source,position=.5){
  const noop=()=>{};
  let currentPosition=position;
  const waveSegments=[];let lastPoint=null;
  const context=new Proxy({}, {get:(target,key)=>{
    if(key==="clearRect")return ()=>{waveSegments.length=0;lastPoint=null;};
    if(key==="moveTo")return (x,y)=>{lastPoint={x,y};};
    if(key==="lineTo")return (x,y)=>{
      if(target.strokeStyle==="#75d9c5"&&lastPoint)
        waveSegments.push({x:lastPoint.x,y1:lastPoint.y,y2:y});
      lastPoint=null;
    };
    return target[key]??noop;
  },
    set:(target,key,value)=>(target[key]=value,true)});
  const listeners=new Map();
  const canvas={isConnected:true,clientWidth:320,clientHeight:120,width:0,height:0,
    addEventListener:(name,handler)=>listeners.set(name,handler),
    getContext:()=>context,getBoundingClientRect:()=>({left:0,width:320}),
    setAttribute:noop,hasPointerCapture:()=>false,releasePointerCapture:noop,
    setPointerCapture:noop};
  const node=()=>{
    const handlers=new Map();
    return {hidden:false,style:{},textContent:"",
      addEventListener:(name,handler)=>handlers.set(name,handler),
      click:()=>handlers.get("click")?.({detail:0})};
  };
  const zoomIn=node(),zoomOut=node();
  const wrap={dataset:{},removeAttribute:noop};
  const overviewSelection={style:{}};
  const editor=createPlayerWaveEditor({canvas,wrap,overviewSelection,
    markerA:node(),markerB:node(),zoomIn,zoomOut,zoomLabel:node(),
    visibleStart:node(),visibleEnd:node(),getPosition:()=>currentPosition,
    onPosition:noop,onStart:noop,onAB:()=>({a:0,b:source.sourceFrames,enabled:false}),
    onScrubState:noop});
  editor.setSource(source,48000);
  return {editor,zoomIn,zoomOut,waveSegments,
    setPosition(value){currentPosition=value;}};
}

async function waitForReadQuiet(source,reads,{quietMs=400,timeoutMs=10_000}={}){
  const started=Date.now();
  let lastCount=reads.length,quietSince=Date.now();
  while(Date.now()-started<timeoutMs){
    await new Promise(resolve=>setTimeout(resolve,10));
    if(source.activeReads===0&&reads.length===lastCount){
      if(Date.now()-quietSince>=quietMs)return;
    }else{
      lastCount=reads.length;quietSince=Date.now();
    }
  }
  throw Error(`waveform reads did not settle: ${JSON.stringify({
    activeReads:source.activeReads,readCount:reads.length})}`);
}

test("short-source detail waveform reads fixed-size PCM chunks and sharpens on zoom",async()=>{
  const sourceFrames=100_000,reads=[];let activeReads=0;
  const source={sourceFrames,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,zoomIn;
  try{
    ({editor,zoomIn}=makeEditor(source));
    await waitForReadQuiet(source,reads);
    const initialReads=reads.length;
    for(let i=0;i<6;i++)zoomIn.click();
    await waitForReadQuiet(source,reads);
    assert.ok(reads.length>initialReads,"zooming should request finer waveform peaks");
  }finally{
    editor?.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
  assert.ok(reads.length>1,"detail PCM must be summarized in bounded pieces");
  assert.ok(reads.every(read=>read.frameCount<=32_768),reads);
  assert.ok(reads.every(read=>read.frameCount<sourceFrames),reads);
});

test("a preempted detail-waveform read retries once for the same viewport",async()=>{
  const reads=[];let activeReads=0;
  const source={sourceFrames:24_000,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        const error=new Error("PCM window decode aborted");
        error.name="AbortError";
        throw error;
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor;
  try{
    ({editor}=makeEditor(source));
    await waitForReadQuiet(source,reads);
    assert.equal(reads.length,2,"a repeatedly preempted view must stop after one retry");
  }finally{
    editor?.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("wide waveform views use the fixed-size overview instead of reading the full source",async()=>{
  const reads=[],sourceFrames=48_000*60*60*10;let activeReads=0;
  const source={sourceFrames,maxReadFrames:262_144,
    overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,zoomOut,waveSegments;
  try{
    ({editor,zoomOut,waveSegments}=makeEditor(source,sourceFrames/(2*48_000)));
    await waitForReadQuiet(source,reads);
    const narrowViewReads=reads.length;
    assert.ok(narrowViewReads>0,"the initial detailed viewport should read PCM");
    assert.ok(narrowViewReads<40,"the initial viewport should stay within a small read budget");
    zoomOut.click();
    await waitForReadQuiet(source,reads);
    const widerViewReads=reads.length;
    zoomOut.click();
    await waitForReadQuiet(source,reads);
    assert.equal(reads.length,widerViewReads,
      "zooming out beyond the detailed range must render from the bounded overview");
    const overviewRightEdge=waveSegments.filter(segment=>segment.x===319).at(-1);
    assert.ok(overviewRightEdge&&
      Math.abs(overviewRightEdge.y2-overviewRightEdge.y1)>8,
      "wide zoom must keep drawing the overview peaks after detail reads are disabled: "+
        JSON.stringify(overviewRightEdge));
  }finally{
    editor?.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("rapid zoom changes never overlap stale detail PCM reads",async()=>{
  const reads=[];let activeReads=0,maxActiveReads=0;
  const sourceFrames=48_000*60*60*10;
  const source={sourceFrames,maxReadFrames:262_144,
    overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});
      activeReads++;maxActiveReads=Math.max(maxActiveReads,activeReads);
      try{
        await new Promise(resolve=>setTimeout(resolve,10));
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,zoomIn,zoomOut;
  try{
    ({editor,zoomIn,zoomOut}=makeEditor(source,sourceFrames/(2*48_000)));
    await new Promise(resolve=>setTimeout(resolve,0));
    const readsBeforeZoom=reads.length;
    zoomOut.click();zoomOut.click();zoomIn.click();zoomIn.click();
    await waitForReadQuiet(source,reads);
    assert.equal(maxActiveReads,1,
      "a canceled detail pass must settle before the current viewport starts another read");
    assert.ok(reads.length>readsBeforeZoom,
      "the latest detail viewport must resume after the canceled PCM chunk settles");
  }finally{
    editor?.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("a moving detail viewport redirects the next waveform read to the current playhead",async()=>{
  const reads=[];let activeReads=0,releaseFirst;
  const firstRead=new Promise(resolve=>{releaseFirst=resolve;});
  const source={sourceFrames:48_000*120,maxReadFrames:262_144,
    overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});activeReads++;
      try{
        if(reads.length===1)await firstRead;
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor;
  try{
    const created=makeEditor(source,30);
    editor=created.editor;
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(reads.length,1,"the first detail tile should be pending");
    created.setPosition(32);
    editor.refresh(true);
    const pendingRightEdge=created.waveSegments.filter(segment=>segment.x===319).at(-1);
    assert.equal(pendingRightEdge,undefined,
      "an unread detailed edge must stay blank, without a false centerline while PCM is pending");
    releaseFirst();
    await waitForReadQuiet(source,reads);
    const newCenter=32*48_000;
    assert.ok(Math.abs(reads[1].startFrame-newCenter)<=2*48_000,
      "after the in-flight bounded read, detail decoding must follow the newest viewport instead of finishing the stale one: "+
        JSON.stringify(reads.slice(0,3)));
    const newRightEdge=36*48_000;
    assert.ok(reads.some(read=>read.startFrame+read.frameCount>=newRightEdge),
      "the newest viewport's right edge must receive detailed PCM peaks: "+
        JSON.stringify(reads.slice(-3)));
    const rightEdge=created.waveSegments.filter(segment=>segment.x===319).at(-1);
    assert.ok(rightEdge,"the rightmost detailed waveform pixel must be painted");
    assert.ok((rightEdge.y1+rightEdge.y2)/2<52,
      "the right edge must use its detailed positive PCM instead of the centered coarse overview: "+
        JSON.stringify(rightEdge));
  }finally{
    releaseFirst();editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("an aborted obsolete detail read restarts the latest paused viewport",async()=>{
  const reads=[];let activeReads=0,rejectFirst;
  const firstRead=new Promise((_,reject)=>{rejectFirst=reject;});
  const source={sourceFrames:48_000*120,maxReadFrames:262_144,
    overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});activeReads++;
      try{
        if(reads.length===1)await firstRead;
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor;
  try{
    const created=makeEditor(source,30);
    editor=created.editor;
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(reads.length,1,"the original viewport read should be pending");
    created.setPosition(70);
    editor.refresh(true);
    const error=new Error("playback decode preempted the stale waveform read");
    error.name="AbortError";
    rejectFirst(error);
    await waitForReadQuiet(source,reads);
    assert.ok(reads.length>=2,
      "the newest paused viewport must be read after the obsolete request aborts");
    assert.ok(Math.abs(reads[1].startFrame-70*48_000)<=2*48_000,
      "the restarted read should follow the latest seek instead of repeating the old range: "+
        JSON.stringify(reads.slice(0,3)));
  }finally{
    if(rejectFirst){
      const error=new Error("test cleanup");error.name="AbortError";
      rejectFirst(error);rejectFirst=null;
    }
    editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("source-edge viewports keep one peak resolution and leave out-of-source time blank",async()=>{
  const sampleRate=48_000,sourceFrames=sampleRate*20,reads=[];
  let activeReads=0;
  const source={sourceFrames,maxReadFrames:32_768,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,created;
  try{
    created=makeEditor(source,.5);
    editor=created.editor;
    await waitForReadQuiet(source,reads);
    const firstReads=reads.slice();
    created.setPosition(6.5);
    editor.refresh(true);
    await waitForReadQuiet(source,reads);
    const repeatedSourceFrames=reads.slice(firstReads.length).reduce((total,next)=>
      total+firstReads.reduce((overlap,prior)=>overlap+
        Math.max(0,Math.min(next.startFrame+next.frameCount,
          prior.startFrame+prior.frameCount)-Math.max(next.startFrame,prior.startFrame)),0),0);
    assert.equal(repeatedSourceFrames,0,
      "moving the viewport through the source-start edge must reuse absolute peak buckets; "+
        "re-read PCM frames: "+repeatedSourceFrames);

    created.setPosition(.5);
    editor.refresh(true);
    await waitForReadQuiet(source,reads);
    const outsideStartX=(created.editor.spanFrames/2-.5*sampleRate)/
      created.editor.spanFrames*320;
    const renderedOutside=created.waveSegments.filter(segment=>
      segment.x<Math.floor(outsideStartX));
    assert.equal(renderedOutside.length,0,
      "pixels before source frame zero must stay blank: "+
        JSON.stringify(renderedOutside.slice(0,3)));
  }finally{
    editor?.setSource(null,sampleRate);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});
