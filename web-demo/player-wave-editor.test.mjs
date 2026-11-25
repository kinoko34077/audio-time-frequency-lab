import test from "node:test";
import assert from "node:assert/strict";
import {createPlayerWaveEditor,sourceRulerTicks} from "./player-wave-editor.mjs";

function makeDrawingContext(segments,getWidth=()=>320){
  let lastPoint=null,fullClears=0;
  return new Proxy({}, {get:(target,key)=>{
    if(key==="clearRect")return (x,_y,width)=>{
      if(x<=0&&width>=getWidth()){segments.length=0;fullClears++;}
      else for(let i=segments.length-1;i>=0;i--)
        if(segments[i].x>=x&&segments[i].x<x+width)segments.splice(i,1);
      lastPoint=null;
    };
    if(key==="fullClears")return fullClears;
    if(key==="moveTo")return (x,y)=>{lastPoint={x,y};};
    if(key==="lineTo")return (x,y)=>{
      if(target.strokeStyle==="#75d9c5"&&lastPoint)
        segments.push({x:lastPoint.x,y1:lastPoint.y,y2:y});
      lastPoint=null;
    };
    return target[key]??(()=>{});
  },
    set:(target,key,value)=>(target[key]=value,true)});
}

function makeEditor(source,position=.5,callbacks={}){
  const noop=()=>{};
  let currentPosition=position;
  const waveSegments=[];let canvas;
  const context=makeDrawingContext(waveSegments,()=>canvas.width);
  const listeners=new Map();
  canvas={isConnected:true,clientWidth:320,clientHeight:120,width:0,height:0,
    addEventListener:(name,handler)=>listeners.set(name,handler),
    getContext:()=>context,getBoundingClientRect:()=>({left:0,width:320}),
    setAttribute:noop,hasPointerCapture:()=>false,releasePointerCapture:noop,
    setPointerCapture:noop};
  const node=()=>{
    const handlers=new Map();
    return {hidden:false,style:{},textContent:"",
      addEventListener:(name,handler)=>handlers.set(name,handler),
      dispatch:(name,event)=>handlers.get(name)?.(event),
      click:()=>handlers.get("click")?.({detail:0})};
  };
  const zoomIn=node(),zoomOut=node();
  const wrap={dataset:{},removeAttribute:noop};
  const overviewSelection={style:{}};
  const editor=createPlayerWaveEditor({canvas,wrap,overviewSelection,
    markerA:node(),markerB:node(),zoomIn,zoomOut,zoomLabel:node(),
    visibleStart:node(),visibleEnd:node(),getPosition:()=>currentPosition,
    onPosition:(value,options)=>{
      currentPosition=value;callbacks.onPosition?.(value,options);
    },onStart:callbacks.onStart??noop,
    onAB:()=>({a:0,b:source.sourceFrames,enabled:false}),
    onScrubState:callbacks.onScrubState??noop,
    onScrubMotion:callbacks.onScrubMotion??noop});
  editor.setSource(source,48000);
  return {editor,zoomIn,zoomOut,waveSegments,wrap,
    pointer(type,id,x){
      const handler=listeners.get(type);
      assert.ok(handler,"missing pointer listener "+type);
      handler({pointerId:id,pointerType:"touch",button:0,isPrimary:true,
        clientX:x,clientY:60,buttons:type==="pointerup"?0:1,
        preventDefault:noop});
    },
    setPosition(value){currentPosition=value;},
    get fullClears(){return context.fullClears;}};
}

test("pinch holds playback at the shared frame and only scrubs when its midpoint moves",async()=>{
  const sourceFrames=100_000,reads=[];let activeReads=0;
  const source={sourceFrames,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.2)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const originalRatio=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  const states=[],motions=[];
  const rig=makeEditor(source,1,{
    onScrubState:value=>states.push(value),
    onScrubMotion:(speed,phase,frame)=>motions.push({speed,phase,frame})
  });
  try{
    await waitForReadQuiet(source,reads);
    rig.pointer("pointerdown",1,64);
    assert.equal(rig.wrap.dataset.interaction,"pan");
    assert.deepEqual(states,[true]);
    rig.pointer("pointerdown",2,256);
    assert.deepEqual(states,[true],
      "adding a second finger must keep the transport held instead of restarting play");
    assert.deepEqual(motions.at(-1),{speed:0,phase:"hold",frame:48_000},
      "a two-finger gesture starts from the held source frame");

    // Symmetric finger movement changes zoom only; it cannot make the audio
    // cursor oscillate between pointer events.
    rig.pointer("pointermove",1,40);
    rig.pointer("pointermove",2,280);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(motions.every(motion=>motion.phase!=="move"||motion.speed===0),motions);

    // Moving the pinch midpoint deliberately scratches the shared clock.
    rig.pointer("pointermove",1,56);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(motions.at(-1).phase,"move");
    assert.notEqual(motions.at(-1).frame,48_000);

    // Releasing one finger keeps the remaining finger in the held gesture;
    // releasing the last finger returns to normal transport/inertia.
    const handoffFrame=motions.at(-1).frame;
    rig.pointer("pointerup",2,280);
    assert.deepEqual(states,[true]);
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.deepEqual(motions.at(-1),{speed:0,phase:"hold",frame:handoffFrame},
      "a stationary finger after pinch must re-arm the source-clock hold");
    rig.pointer("pointermove",1,40);
    assert.equal(motions.at(-1).phase,"move",
      "the remaining finger must continue scrubbing without ending the hold");
    assert.deepEqual(states,[true]);
    rig.pointer("pointerup",1,40);
    assert.deepEqual(states,[true,false]);
    assert.equal(motions.at(-1).phase,"release");
  }finally{
    rig.editor.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(originalRatio)Object.defineProperty(globalThis,"devicePixelRatio",originalRatio);
    else delete globalThis.devicePixelRatio;
  }
});

test("high-zoom pinch accumulates sub-sample midpoint movement",async()=>{
  const sourceFrames=100_000,reads=[];let activeReads=0;
  const source={sourceFrames,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.2)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const originalRatio=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  const motions=[];
  const rig=makeEditor(source,1,{onScrubMotion:(speed,phase,frame)=>
    motions.push({speed,phase,frame})});
  try{
    await waitForReadQuiet(source,reads);
    for(let i=0;i<20;i++)rig.zoomIn.click();
    rig.pointer("pointerdown",1,200);
    rig.pointer("pointerdown",2,280);
    assert.deepEqual(motions.at(-1),{speed:0,phase:"hold",frame:48_000});
    for(let i=1;i<=160;i++){
      rig.pointer("pointermove",1,200-i);
      rig.pointer("pointermove",2,280-i);
      await new Promise(resolve=>setTimeout(resolve,1));
    }
    assert.ok(motions.some(motion=>motion.phase==="move"&&motion.frame===48_001),motions);
    assert.equal(motions.at(-1).frame,48_001,
      "160px midpoint travel across a 2-frame view must accumulate to one source sample");
  }finally{
    rig.pointer("pointerup",2,120);
    rig.pointer("pointerup",1,40);
    rig.editor.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(originalRatio)Object.defineProperty(globalThis,"devicePixelRatio",originalRatio);
    else delete globalThis.devicePixelRatio;
  }
});

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

test("zooming out within cached one-frame peaks repaints both exposed strips",async()=>{
  const sourceFrames=48_000*12,reads=[];let activeReads=0;
  const source={sourceFrames,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const originalRatio=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,"document");
  const rasterCanvases=[];
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  Object.defineProperty(globalThis,"document",{configurable:true,value:{
    createElement(){
      const segments=[];
      const raster={width:0,height:0,id:"",getContext:()=>
        makeDrawingContext(segments,()=>raster.width)};
      rasterCanvases.push({raster,segments});
      return raster;
    }
  }});
  let editor,zoomIn,zoomOut;
  try{
    ({editor,zoomIn,zoomOut}=makeEditor(source));
    await waitForReadQuiet(source,reads);
    for(let step=0;step<11;step++)zoomIn.click();
    await waitForReadQuiet(source,reads);
    assert.equal(editor.spanFrames,281.25,"wide view uses 1-frame peak bins");
    const cachedReadCount=reads.length;

    zoomIn.click();
    await waitForReadQuiet(source,reads);
    assert.equal(editor.spanFrames,140.625,"narrow view keeps the same peak resolution");
    assert.equal(reads.length,cachedReadCount,"narrow view uses already cached peaks");

    zoomOut.click();
    await waitForReadQuiet(source,reads);
    assert.equal(editor.spanFrames,281.25);
    assert.equal(reads.length,cachedReadCount,
      "zooming out within the same cached peak resolution must not reread PCM");
    const segments=rasterCanvases[0].segments;
    assert.ok(segments.some(segment=>segment.x<80),
      "cached PCM repaints the newly exposed left strip");
    assert.ok(segments.some(segment=>segment.x>=240),
      "cached PCM repaints the newly exposed right strip");
  }finally{
    editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(originalRatio)Object.defineProperty(globalThis,"devicePixelRatio",originalRatio);
    else delete globalThis.devicePixelRatio;
    if(originalDocument)Object.defineProperty(globalThis,"document",originalDocument);
    else delete globalThis.document;
  }
});

test("zooming out across peak resolutions shows preview then refreshes from bounded coarse PCM",async()=>{
  const sourceFrames=48_000*60,reads=[];let activeReads=0,coarseRequested=false;
  const source={sourceFrames,maxReadFrames:32_768,
    overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
    async read(startFrame,frameCount){
      activeReads++;
      try{
        reads.push({startFrame,frameCount});
        if(coarseRequested)await new Promise(resolve=>setTimeout(resolve,25));
        return {startFrame,channels:[new Float32Array(frameCount).fill(
          coarseRequested?-.5:.25)]};
      }finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,zoomIn,zoomOut,waveSegments;
  try{
    ({editor,zoomIn,zoomOut,waveSegments}=makeEditor(source,30));
    await waitForReadQuiet(source,reads);
    zoomIn.click();await waitForReadQuiet(source,reads);
    zoomIn.click();await waitForReadQuiet(source,reads);
    assert.equal(editor.spanFrames,144_000,"the finer detail view is three seconds wide");
    zoomOut.click();await waitForReadQuiet(source,reads);
    zoomOut.click();await waitForReadQuiet(source,reads);
    assert.equal(editor.spanFrames,576_000,"the previously cached coarse view is twelve seconds wide");
    coarseRequested=true;
    const started=performance.now();
    const readCountBeforeZoomOut=reads.length;
    zoomOut.click();
    const readCountAfterZoomOut=reads.length;
    const zoomOutReads=reads.slice(readCountBeforeZoomOut);
    assert.ok(readCountAfterZoomOut>readCountBeforeZoomOut,
      "zooming out must start a fresh bounded read immediately");
    const leftPreview=waveSegments.filter(segment=>segment.x===0).at(-1);
    const finePreview=waveSegments.filter(segment=>segment.x===160).at(-1);
    assert.equal(leftPreview,undefined,
      "an unread edge must not magnify a coarse whole-track peak into a false detail block");
    assert.ok(finePreview&&(finePreview.y1+finePreview.y2)/2<52,
      "the cached fine waveform must remain as an immediate anti-flicker preview");
    const updateStarted=performance.now();
    let refreshedCenter;
    while(performance.now()-updateStarted<500){
      await new Promise(resolve=>setTimeout(resolve,5));
      refreshedCenter=waveSegments.filter(segment=>segment.x===160).at(-1);
      if(refreshedCenter&&(refreshedCenter.y1+refreshedCenter.y2)/2>75)break;
    }
    const updateMs=performance.now()-updateStarted;
    assert.ok(refreshedCenter&&(refreshedCenter.y1+refreshedCenter.y2)/2>75,
      "new coarse PCM must replace the stretched preview with the new waveform: "+
        JSON.stringify(refreshedCenter));
    assert.ok(updateMs<250,
      "fresh visible detail must arrive promptly instead of waiting for a whole-track overview: "+
        updateMs+"ms");
    await waitForReadQuiet(source,reads);
    const completedZoomOutReads=reads.slice(readCountBeforeZoomOut);
    assert.ok(completedZoomOutReads.every(read=>read.frameCount<=32_768),
      "coarse refresh must use bounded PCM windows");
    const totalZoomOutFrames=completedZoomOutReads.reduce((total,read)=>total+read.frameCount,0);
    assert.ok(totalZoomOutFrames<=24*48_000+32_768,
      "coarse refresh must stay near the twenty-four-second viewport, not rescan the full source: "+
        totalZoomOutFrames);
    assert.ok(performance.now()-started<5_000,
      "the six-second view's bounded detail pass must complete within five seconds");
  }finally{
    editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
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
      "unread detailed edges must not show an enlarged coarse overview block");
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

test("zooming beyond a source bound does not repaint the unchanged waveform",async()=>{
  const reads=[];let activeReads=0;
  const source={sourceFrames:24_000,maxReadFrames:32_768,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      reads.push({startFrame,frameCount});
      try{return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};}
      finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let editor,created;
  try{
    created=makeEditor(source,.5);editor=created.editor;
    await waitForReadQuiet(source,reads);
    const clearsBefore=created.fullClears;
    created.zoomOut.click();
    assert.equal(editor.spanFrames,24_000,"the initial span is already source-bounded");
    assert.equal(created.fullClears,clearsBefore,
      "a held/clicked zoom step at the clamped bound must not trigger a full repaint");
  }finally{
    editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
});

test("a held zoom button stops scheduling frames at the source bound",async()=>{
  const reads=[];let activeReads=0;
  const source={sourceFrames:24_000,maxReadFrames:32_768,overviewPeaks:[],
    async read(startFrame,frameCount){
      activeReads++;
      reads.push({startFrame,frameCount});
      try{return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};}
      finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const originalRatio=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  const originalRequest=Object.getOwnPropertyDescriptor(globalThis,"requestAnimationFrame");
  const originalCancel=Object.getOwnPropertyDescriptor(globalThis,"cancelAnimationFrame");
  const pending=new Map();let nextId=1;
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  Object.defineProperty(globalThis,"requestAnimationFrame",{configurable:true,
    value:callback=>{const id=nextId++;pending.set(id,callback);return id;}});
  Object.defineProperty(globalThis,"cancelAnimationFrame",{configurable:true,
    value:id=>pending.delete(id)});
  let editor,zoomOut,created;
  try{
    created=makeEditor(source);({editor,zoomOut}=created);
    await waitForReadQuiet(source,reads);
    while(pending.size){
      const [id,frame]=pending.entries().next().value;
      pending.delete(id);frame(performance.now());
    }
    const clearsBefore=created.fullClears;
    zoomOut.dispatch("pointerdown",{pointerId:3,pointerType:"touch",button:0,
      preventDefault(){}});
    await new Promise(resolve=>setTimeout(resolve,240));
    assert.equal(pending.size,1,"the long-press starts with one scheduled frame");
    const [id,frame]=pending.entries().next().value;
    pending.delete(id);frame(performance.now()+40);
    assert.equal(editor.spanFrames,24_000,"the zoom-out is already at its source bound");
    assert.equal(pending.size,0,
      "reaching a clamped zoom bound must stop the long-press animation loop");
    assert.equal(created.fullClears,clearsBefore,
      "the stopped hold must not repaint the waveform");
    zoomOut.dispatch("pointerup",{pointerId:3});
  }finally{
    zoomOut?.dispatch("pointercancel",{pointerId:3});
    editor?.setSource(null,48_000);
    await waitForReadQuiet(source,reads);
    if(originalRatio)Object.defineProperty(globalThis,"devicePixelRatio",originalRatio);
    else delete globalThis.devicePixelRatio;
    if(originalRequest)Object.defineProperty(globalThis,"requestAnimationFrame",originalRequest);
    else delete globalThis.requestAnimationFrame;
    if(originalCancel)Object.defineProperty(globalThis,"cancelAnimationFrame",originalCancel);
    else delete globalThis.cancelAnimationFrame;
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

test("high zoom prepares both edges and small forward/reverse scrubs reuse fine PCM",async()=>{
  const reads=[],sourceFrames=48_000*120;
  let activeReads=0;
  const source={sourceFrames,maxReadFrames:32_768,
    overviewPeaks:Array.from({length:96},()=>[-.95,.95]),
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});activeReads++;
      try{return {startFrame,channels:[new Float32Array(frameCount).fill(.2)]};}
      finally{activeReads--;}
    }};
  Object.defineProperty(source,"activeReads",{get:()=>activeReads});
  const ratio=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  let rig;
  try{
    rig=makeEditor(source,30);
    await waitForReadQuiet(source,reads);
    for(let i=0;i<10;i++)rig.zoomIn.click();
    await waitForReadQuiet(source,reads);
    const span=rig.editor.spanFrames;
    const before=reads.length;
    for(const direction of [1,-1]){
      rig.setPosition(30+direction*span/4/48_000);
      rig.editor.refresh(true);
      const left=rig.waveSegments.find(segment=>segment.x===0);
      const right=rig.waveSegments.find(segment=>segment.x===319);
      assert.ok(left&&right,"guarded detail must cover both edges");
      assert.ok([left,right].every(segment=>segment.y2-segment.y1<4),
        "do not paint coarse overview peaks at scrub edges");
    }
    await waitForReadQuiet(source,reads);
    assert.ok(reads.slice(before).every(read=>read.frameCount<=32768));
  }finally{
    rig?.editor.setSource(null,48000);
    await waitForReadQuiet(source,reads);
    if(ratio)Object.defineProperty(globalThis,"devicePixelRatio",ratio);
    else delete globalThis.devicePixelRatio;
  }
});

test("time ruler anchors fixed source frames, moving them with the viewport",()=>{
  const rate=48000,span=rate*4,source=rate*120;
  const a=sourceRulerTicks(rate*10,span,source,rate);
  const b=sourceRulerTicks(rate*10.25,span,source,rate);
  const shared=a.filter(t=>b.some(q=>q.frame===t.frame));
  assert.ok(shared.length>=2);
  for(const t of shared){
    const q=b.find(x=>x.frame===t.frame);
    assert.equal(t.label,q.label);
    assert.ok(Math.abs(q.fraction-t.fraction+.25/4)<1e-12);
  }
  assert.ok(sourceRulerTicks(0,span,source,rate).every(t=>t.frame>=0&&t.fraction>=.5));
  assert.ok(sourceRulerTicks(source,span,source,rate).every(t=>t.frame<=source&&t.fraction<=.5));
  const fine=sourceRulerTicks(48000,2,source,rate);
  assert.equal(fine.length,3);
  assert.equal(new Set(fine.map(t=>t.label)).size,3);
  assert.ok(fine.every(t=>t.fraction>=0&&t.fraction<=1));
  for(const ticks of [a,b,fine,sourceRulerTicks(rate*60,rate*25,source,rate,3)])
    assert.ok(ticks.length<=5&&ticks.every(t=>t.fraction>=0&&t.fraction<=1));
});
