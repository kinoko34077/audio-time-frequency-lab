import test from "node:test";
import assert from "node:assert/strict";
import {createPlayerWaveEditor} from "./player-wave-editor.mjs";

function makeEditor(source){
  const noop=()=>{};
  const context=new Proxy({}, {get:(target,key)=>target[key]??noop,
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
      click:()=>handlers.get("click")?.({})};
  };
  const zoomIn=node();
  const wrap={dataset:{},removeAttribute:noop};
  const overviewSelection={style:{}};
  const editor=createPlayerWaveEditor({canvas,wrap,overviewSelection,
    markerA:node(),markerB:node(),zoomIn,zoomOut:node(),zoomLabel:node(),
    visibleStart:node(),visibleEnd:node(),getPosition:()=>.5,
    onPosition:noop,onStart:noop,onAB:()=>({a:0,b:source.sourceFrames,enabled:false}),
    onScrubState:noop});
  editor.setSource(source,48000);
  return {editor,zoomIn};
}

test("short-source detail waveform reads fixed-size PCM chunks and sharpens on zoom",async()=>{
  const sourceFrames=100_000,reads=[];
  const source={sourceFrames,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});
      return {startFrame,channels:[new Float32Array(frameCount).fill(.25)]};
    }};
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  try{
    const {zoomIn}=makeEditor(source);
    await new Promise(resolve=>setTimeout(resolve,0));
    const initialReads=reads.length;
    for(let i=0;i<6;i++)zoomIn.click();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(reads.length>initialReads,"zooming should request finer waveform peaks");
  }finally{
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
  assert.ok(reads.length>1,"detail PCM must be summarized in bounded pieces");
  assert.ok(reads.every(read=>read.frameCount<=32_768),reads);
  assert.ok(reads.every(read=>read.frameCount<sourceFrames),reads);
});

test("a preempted detail-waveform read retries once for the same viewport",async()=>{
  const reads=[];
  const source={sourceFrames:24_000,maxReadFrames:262_144,overviewPeaks:[],
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});
      if(reads.length===1){
        const error=new Error("PCM window decode aborted");
        error.name="AbortError";
        throw error;
      }
      const error=new Error("PCM window decode aborted");
      error.name="AbortError";
      throw error;
    }};
  const original=Object.getOwnPropertyDescriptor(globalThis,"devicePixelRatio");
  Object.defineProperty(globalThis,"devicePixelRatio",{configurable:true,value:1});
  try{
    makeEditor(source);
    await new Promise(resolve=>setTimeout(resolve,250));
  }finally{
    if(original)Object.defineProperty(globalThis,"devicePixelRatio",original);
    else delete globalThis.devicePixelRatio;
  }
  assert.equal(reads.length,2,"a repeatedly preempted view must stop after one retry");
});
