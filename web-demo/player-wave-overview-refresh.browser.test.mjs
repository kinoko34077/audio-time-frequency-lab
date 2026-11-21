import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||"_site");

async function edgePixels(page,edge){
  return page.$eval("#wave-detail",(canvas,edge)=>{
    const {data}=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    const half=Math.floor(canvas.width/2),width=canvas.width,height=canvas.height;
    let outside=0,source=0;
    const count=(from,to)=>{
      let total=0;
      for(let x=Math.max(0,from);x<Math.min(width,to);x++)
        for(let y=0;y<height;y++){
          const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
          if(g>150&&g>r*1.25&&b>r*1.1)total++;
        }
      return total;
    };
    if(edge==="start"){
      outside=count(0,half-2);source=count(half+2,half+82);
    }else{
      const center=Number(canvas.getAttribute("aria-valuenow"));
      const zoomText=document.querySelector("#wave-zoom-label")?.textContent||"";
      const spanValue=Number.parseFloat(zoomText.replace(/^ms\s*/,""));
      const spanSeconds=zoomText.startsWith("ms ")?spanValue/1000:spanValue;
      const sourceEndX=width*(.5+(144_000-center)/(spanSeconds*48_000));
      outside=count(Math.ceil(sourceEndX)+2,width);
      source=count(Math.floor(sourceEndX)-82,Math.floor(sourceEndX)-2);
      return {outside,source,sourceEndX,center,spanSeconds,width};
    }
    return {outside,source};
  },edge);
}

async function waitForSourcePixels(page,edge){
  await page.waitForFunction(edge=>{
    const canvas=document.querySelector("#wave-detail");
    if(!canvas?.width||!canvas.height)return false;
    const {data}=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    const half=Math.floor(canvas.width/2),height=canvas.height;
    const from=edge==="start"?half+2:half-82;
    const to=edge==="start"?half+82:half-2;
    for(let x=Math.max(0,from);x<Math.min(canvas.width,to);x++)
      for(let y=0;y<height;y++){
        const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
        if(g>150&&g>r*1.25&&b>r*1.1)return true;
      }
    return false;
  },{timeout:15000},edge);
}

test("PCM and overview progress are coalesced to a single waveform paint per frame",{
  timeout:45000
},async()=>{
  const port=18794;
  const server=spawn(process.env.PYTHON_EXECUTABLE||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],
    {cwd:siteRoot,stdio:"ignore",windowsHide:true});
  let browser;
  try{
    const deadline=Date.now()+10000;
    let ready=false;
    while(Date.now()<deadline){
      if(server.exitCode!==null)throw Error("waveform browser server exited");
      try{
        const response=await fetch("http://127.0.0.1:"+port);
        await response.arrayBuffer();
        if(response.ok){ready=true;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,"waveform browser server became ready");
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required","--mute-audio"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:393,height:853,deviceScaleFactor:1.5,
      isMobile:true,hasTouch:true});
    await page.evaluateOnNewDocument(()=>{
      const isWaveCanvas=canvas=>["wave-detail","wave-detail-buffer",
        "wave-detail-shift-buffer"].includes(canvas?.id);
      window.__waveFrameTime=null;
      window.__waveClearEvents=[];
      window.__waveStrokePaths=[];
      window.__waveCurrentStrokeLines=0;
      const nativeRaf=window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame=callback=>nativeRaf(time=>{
        window.__waveFrameTime=time;
        callback(time);
      });
      const clear=CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect=function(...args){
        if(this.canvas.id==="wave-detail")window.__waveClearEvents.push({
          time:performance.now(),frame:window.__waveFrameTime
        });
        return clear.apply(this,args);
      };
      const beginPath=CanvasRenderingContext2D.prototype.beginPath;
      CanvasRenderingContext2D.prototype.beginPath=function(...args){
        if(isWaveCanvas(this.canvas))window.__waveCurrentStrokeLines=0;
        return beginPath.apply(this,args);
      };
      const lineTo=CanvasRenderingContext2D.prototype.lineTo;
      CanvasRenderingContext2D.prototype.lineTo=function(...args){
        if(isWaveCanvas(this.canvas))window.__waveCurrentStrokeLines++;
        return lineTo.apply(this,args);
      };
      const stroke=CanvasRenderingContext2D.prototype.stroke;
      CanvasRenderingContext2D.prototype.stroke=function(...args){
        if(isWaveCanvas(this.canvas))
          window.__waveStrokePaths.push({canvas:this.canvas.id,
            lines:window.__waveCurrentStrokeLines});
        return stroke.apply(this,args);
      };
    });
    await page.goto("http://127.0.0.1:"+port+"/",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    await (await page.$("#audio-file")).uploadFile(WAV);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
    for(let i=0;i<3;i++)await page.click("#wave-zoom-in");
    await page.$eval("#granular-speed-value",input=>{
      input.value="0.1";
      input.dispatchEvent(new Event("input",{bubbles:true}));
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await new Promise(resolve=>setTimeout(resolve,150));
    const startEdge=await edgePixels(page,"start");
    assert.equal(startEdge.outside,0,"source-start margin stays empty when the file edge is visible");
    assert.ok(startEdge.source>0,"recorded PCM remains visible beyond source time zero");
    await page.waitForFunction(()=>{
      const last=window.__waveClearEvents.at(-1)?.time;
      return Number.isFinite(last)&&performance.now()-last>=200;
    },{timeout:10000});
    await page.evaluate(()=>{window.__waveClearEvents=[];});
    const startPlaybackFrame=await page.$eval("#wave-detail",canvas=>
      Number(canvas.getAttribute("aria-valuenow")));
    await page.evaluate(frame=>{
      window.__waveStartPlaybackFrame=frame;
      window.__waveStrokePaths=[];
    },startPlaybackFrame);
    await page.click("#play-main");
    await page.waitForFunction(frame=>{
      const canvas=document.querySelector("#wave-detail");
      return Number(canvas?.getAttribute("aria-valuenow"))>frame+128;
    },{timeout:5000},startPlaybackFrame);
    await page.evaluate(()=>{window.__waveStrokePaths=[];});
    await new Promise(resolve=>setTimeout(resolve,800));
    const edgeWaveformFrames=await page.evaluate(()=>new Promise(resolve=>{
      const canvas=document.querySelector("#wave-detail"),samples=[];
      function sample(){
        const center=Number(canvas.getAttribute("aria-valuenow"));
        const spanText=document.querySelector("#wave-zoom-label")?.textContent||"";
        const spanValue=Number.parseFloat(spanText.replace(/^ms\s*/,""));
        const span=spanText.startsWith("ms ")?spanValue/1000:spanValue;
        const width=canvas.width,height=canvas.height;
        const total=Number(canvas.getAttribute("aria-valuemax"))+1;
        const spanFrames=span*48_000;
        const left=Math.max(0,Math.floor(width*(.5-center/spanFrames)));
        const right=Math.min(width,Math.ceil(width*(.5+(total-center)/spanFrames)));
        const pixels=canvas.getContext("2d").getImageData(0,0,width,height).data;
        let columns=0;
        for(let x=left;x<right;x++){
          for(let y=0;y<height;y++){
            const index=(y*width+x)*4,r=pixels[index],g=pixels[index+1],b=pixels[index+2];
            if(g>150&&g>r*1.25&&b>r*1.1){columns++;break;}
          }
        }
        samples.push({signal:columns,source:right-left});
        if(samples.length>=24)resolve(samples);
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }));
    const result=await page.evaluate(()=>{
      const counts=new Map();
      for(const {frame} of window.__waveClearEvents){
        if(frame===null)continue;
        const key=Number(frame.toFixed(2));
        counts.set(key,(counts.get(key)||0)+1);
      }
      const canvas=document.querySelector("#wave-detail");
      return {clearCount:window.__waveClearEvents.length,
        renderedFrames:counts.size,
        maxClearsPerAnimationFrame:Math.max(0,...counts.values()),
        repeatedFrames:[...counts.values()].filter(count=>count>1).length,
        startPlaybackFrame:window.__waveStartPlaybackFrame,
        endPlaybackFrame:Number(canvas.getAttribute("aria-valuenow")),
        endPlaybackStatus:document.querySelector("#play-main")?.textContent,
        status:document.querySelector("#rt-indicator")?.textContent,
        timedEvents:window.__waveClearEvents.filter(event=>event.frame!==null).length,
        nullFrameEvents:window.__waveClearEvents.filter(event=>event.frame===null).length,
        widestStrokePath:Math.max(0,...window.__waveStrokePaths.map(path=>path.lines)),
        widestStrokeCanvas:window.__waveStrokePaths
          .toSorted((a,b)=>b.lines-a.lines).slice(0,5),
        waveformWidth:canvas.width,
        firstEvent:window.__waveClearEvents[0]||null,
        lastEvent:window.__waveClearEvents.at(-1)||null};
    });
    await page.click("#play-main");
    await page.waitForFunction(()=>{
      const button=document.querySelector("#play-main");
      return button&&!button.disabled&&button.textContent.includes("再開");
    },{timeout:10000});
    assert.ok(result.clearCount>=8,
      "the waveform moved and was rendered during playback: "+JSON.stringify(result));
    assert.ok(result.maxClearsPerAnimationFrame<=1,
      "overview peak batches must not force repeated detailed-wave paints: "+
      JSON.stringify(result));
    assert.ok(result.widestStrokePath<result.waveformWidth*.2,
      "steady source movement must reuse the waveform drawing and paint only its exposed edge: "+
      JSON.stringify(result));
    assert.ok(edgeWaveformFrames.every(frame=>frame.signal>=frame.source*.8),
      "the recorded source segment remains visible on every sampled playback frame: "+
      JSON.stringify(edgeWaveformFrames));
    await page.focus("#wave-detail");
    assert.equal(await page.evaluate(()=>document.activeElement?.id),"wave-detail",
      "the detailed waveform receives keyboard navigation");
    await page.keyboard.press("End");
    await page.waitForFunction(()=>{
      const canvas=document.querySelector("#wave-detail");
      return Number(canvas?.getAttribute("aria-valuenow"))>=
        Number(canvas?.getAttribute("aria-valuemax"))-1;
    },{timeout:5000});
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(()=>{
      const canvas=document.querySelector("#wave-detail");
      const value=Number(canvas?.getAttribute("aria-valuenow"));
      const max=Number(canvas?.getAttribute("aria-valuemax"));
      return value>max*.9&&value<max;
    },{timeout:5000});
    await waitForSourcePixels(page,"end");
    const endEdge=await edgePixels(page,"end");
    assert.equal(endEdge.outside,0,"source-end margin stays empty when zoomed in");
    assert.ok(endEdge.source>0,"recorded PCM remains visible before source end: "+
      JSON.stringify(endEdge));
  }finally{
    await cleanupTestProcesses(browser,[server],"waveform overview browser server");
  }
});
