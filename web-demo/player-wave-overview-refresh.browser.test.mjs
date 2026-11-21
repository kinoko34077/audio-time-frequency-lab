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
      outside=count(Math.ceil(width*.82),width);
      source=count(Math.floor(width*.68),Math.floor(width*.77));
    }
    return {outside,source};
  },edge);
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
      window.__waveFrameTime=null;
      window.__waveClearEvents=[];
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
    await new Promise(resolve=>setTimeout(resolve,150));
    const startEdge=await edgePixels(page,"start");
    assert.equal(startEdge.outside,0,"source-start margin stays empty when zoomed in");
    assert.ok(startEdge.source>0,"recorded PCM remains visible beyond source time zero");
    await page.evaluate(()=>{window.__waveClearEvents=[];});
    await page.click("#play-main");
    await new Promise(resolve=>setTimeout(resolve,800));
    const result=await page.evaluate(()=>{
      const counts=new Map();
      for(const {frame} of window.__waveClearEvents){
        if(frame===null)continue;
        const key=Number(frame.toFixed(2));
        counts.set(key,(counts.get(key)||0)+1);
      }
      return {clearCount:window.__waveClearEvents.length,
        renderedFrames:counts.size,
        maxClearsPerAnimationFrame:Math.max(0,...counts.values()),
        repeatedFrames:[...counts.values()].filter(count=>count>1).length};
    });
    await page.click("#play-main");
    assert.ok(result.clearCount>=8,"the waveform moved and was rendered during playback");
    assert.ok(result.maxClearsPerAnimationFrame<=1,
      "overview peak batches must not force repeated detailed-wave paints: "+
      JSON.stringify(result));
    await page.focus("#wave-detail");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await new Promise(resolve=>setTimeout(resolve,100));
    const endEdge=await edgePixels(page,"end");
    assert.equal(endEdge.outside,0,"source-end margin stays empty when zoomed in");
    assert.ok(endEdge.source>0,"recorded PCM remains visible before source end");
  }finally{
    await cleanupTestProcesses(browser,[server],"waveform overview browser server");
  }
});
