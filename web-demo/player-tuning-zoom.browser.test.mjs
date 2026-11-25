import test from "node:test";
import assert from "node:assert/strict";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {createServer} from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {closeBrowserTree} from "./test-process-cleanup.mjs";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||"_site");

test("tuning rails stay fixed while compact fields change and held zoom redraws continuously",{
  timeout:45000
},async()=>{
  const server=createServer(async(req,res)=>{
    let requested=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(requested==="/")requested="/index.html";
    const file=path.resolve(siteRoot,"."+requested);
    if(file!==siteRoot&&!file.startsWith(siteRoot+path.sep)){
      res.writeHead(403).end();return;
    }
    try{
      const info=await stat(file);
      if(!info.isFile()){res.writeHead(404).end();return;}
      const ext=path.extname(file);
      const types={".html":"text/html",".css":"text/css",".js":"text/javascript",
        ".mjs":"text/javascript",".json":"application/json",".wasm":"application/wasm",
        ".svg":"image/svg+xml",".webmanifest":"application/manifest+json"};
      res.writeHead(200,{"content-type":types[ext]||"application/octet-stream",
        "content-length":info.size});
      createReadStream(file).pipe(res);
    }catch{res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);server.listen(18795,"127.0.0.1",resolve);
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required","--mute-audio"]
    });
    const page=await browser.newPage();
    await page.setViewport({width:393,height:853,deviceScaleFactor:1.5,
      isMobile:true,hasTouch:true});
    await page.goto("http://127.0.0.1:18795/",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    await (await page.$("#audio-file")).uploadFile(WAV);
    await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
    await new Promise(resolve=>setTimeout(resolve,500));
    const baseline=await page.evaluate(()=>({
      rails:["#granular-speed","#granular-pitch"].map(selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {x:r.x,width:r.width};
      }),
      inputStyle:(()=>{
        const s=getComputedStyle(document.querySelector("#granular-speed-value"));
        return {top:s.borderTopWidth,left:s.borderLeftWidth,
          right:s.borderRightWidth,bottom:s.borderBottomWidth};
      })()
    }));
    const snapshots=[];
    for(const value of ["8.000","-8.000","1.00","-0.001"]){
      snapshots.push(await page.evaluate(value=>{
        const input=document.querySelector("#granular-speed-value");
        input.value=value;input.dispatchEvent(new Event("input",{bubbles:true}));
        return ["#granular-speed","#granular-pitch"].map(selector=>{
          const r=document.querySelector(selector).getBoundingClientRect();
          return {x:r.x,width:r.width};
        });
      },value));
    }
    const rails=[baseline.rails,...snapshots];
    assert.ok(rails.every(pair=>pair.every((r,i)=>
      Math.abs(r.x-baseline.rails[i].x)<.25&&
      Math.abs(r.width-baseline.rails[i].width)<.25)),
      "changing speed digits must not move or resize either tuning rail: "+
        JSON.stringify(rails));
    assert.equal(baseline.inputStyle.top,"0px",
      "inline values use a bottom rule instead of a box");
    assert.equal(baseline.inputStyle.left,"0px");
    assert.equal(baseline.inputStyle.right,"0px");
    assert.notEqual(baseline.inputStyle.bottom,"0px");

    const zoomUserSelect=await page.$eval("#wave-zoom-in",
      button=>getComputedStyle(button).userSelect);
    assert.equal(zoomUserSelect,"none",
      "holding a zoom control must not select its plus/minus glyph");

    const zoomOutButton=await page.$("#wave-zoom-out");
    const zoomOutBounds=await zoomOutButton.boundingBox();
    const client=await page.createCDPSession();
    const boundedZoom=page.evaluate(async()=>{
      const label=document.querySelector("#wave-zoom-label");
      const before=label.textContent;
      await new Promise(resolve=>setTimeout(resolve,450));
      return {before,after:label.textContent};
    });
    await client.send("Input.dispatchTouchEvent",{type:"touchStart",
      touchPoints:[{x:zoomOutBounds.x+zoomOutBounds.width/2,
        y:zoomOutBounds.y+zoomOutBounds.height/2}]});
    await new Promise(resolve=>setTimeout(resolve,650));
    await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    const atBound=await boundedZoom;
    assert.equal(atBound.after,atBound.before,
      "a held zoom-out at the source bound must leave the visible span unchanged");

    await page.evaluate(()=>{
      window.__zoomTrace=[];
      const button=document.querySelector("#wave-zoom-in");
      for(const name of ["pointerdown","pointerup","pointercancel","lostpointercapture","click"])
        button.addEventListener(name,event=>window.__zoomTrace.push({name,
          pointerId:event.pointerId,pointerType:event.pointerType,detail:event.detail}));
      window.addEventListener("blur",()=>window.__zoomTrace.push({name:"blur"}));
    });
    const button=await page.$("#wave-zoom-in");
    const bounds=await button.boundingBox();
    const sampled=page.evaluate(async()=>{
      const canvas=document.querySelector("#wave-detail");
      const values=[];
      await new Promise(resolve=>{
        const started=performance.now();
        function frame(){
          const label=document.querySelector("#wave-zoom-label")?.textContent||"";
          const total=Number(canvas.getAttribute("aria-valuemax"))+1;
          const center=Number(canvas.getAttribute("aria-valuenow"));
          const seconds=label.startsWith("ms ")?
            Number.parseFloat(label.slice(3))/1000:Number.parseFloat(label);
          const span=seconds*48000,width=canvas.width,height=canvas.height;
          const left=Math.max(0,Math.floor(width*(.5-center/span)));
          const right=Math.min(width,Math.ceil(width*(.5+(total-center)/span)));
          const pixels=canvas.getContext("2d").getImageData(0,0,width,height).data;
          let signal=0;
          for(let x=left;x<right;x++){
            for(let y=0;y<height;y++){
              const i=(y*width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
              if(g>150&&g>r*1.25&&b>r*1.1){signal++;break;}
            }
          }
          values.push({seconds,signal,visible:right-left});
          if(performance.now()-started>=650)resolve();
          else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      return values;
    });
    await client.send("Input.dispatchTouchEvent",{type:"touchStart",
      touchPoints:[{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}]});
    await new Promise(resolve=>setTimeout(resolve,650));
    await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await client.detach();
    const samples=await sampled;
    const zoomTrace=await page.evaluate(()=>({trace:window.__zoomTrace,
      span:document.querySelector("#wave-zoom-label").textContent}));
    const moved=samples.filter((sample,index)=>index&&
      sample.seconds<samples[index-1].seconds*.98);
    assert.ok(moved.length>=2,
      "holding zoom-in repeatedly changes magnification before release: "+
        JSON.stringify({samples:samples.slice(0,8),zoomTrace}));
    assert.ok(samples.every(sample=>sample.visible===0||
      sample.signal/sample.visible>=.8),
      "the currently visible source waveform stays drawn during continuous zoom: "+
        JSON.stringify(samples.filter(sample=>sample.visible&&
          sample.signal/sample.visible<.8).slice(0,8)));

    // U09: real continuous zoom-out, with no per-frame pixel readback in
    // the timing probe. Count scaled copies into the signal raster itself.
    // The old recursive preview could remain visible yet progressively blur.
    await page.$eval("#wave-zoom-in",el=>{el.click();el.click();});
    await page.waitForFunction(()=>document.querySelector("#wave-detail").getAttribute("aria-busy")==="false",{timeout:5000});
    const measureIdle=await page.evaluate(()=>new Promise(resolve=>{
      const times=[];const frame=time=>{
        times.push(time);
        if(times.length>=16)resolve(times.slice(1).map((t,i)=>t-times[i]));
        else requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    }));
    const outClient=await page.createCDPSession();
    const outBounds=await (await page.$("#wave-zoom-out")).boundingBox();
    await page.evaluate(()=>{
      const original=CanvasRenderingContext2D.prototype.drawImage;
      window.__u09OriginalDraw=original;window.__u09ScaledCopies=0;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){
        if(this.canvas.id==="wave-detail-buffer"&&args.length===9&&
          (Math.abs(args[3]-args[7])>.001||Math.abs(args[4]-args[8])>.001))
          window.__u09ScaledCopies++;
        return original.apply(this,args);
      };
      window.__u09Frames=[];window.__u09Running=true;
      const frame=time=>{
        if(!window.__u09Running)return;
        window.__u09Frames.push({time,span:document.querySelector("#wave-zoom-label").textContent});
        requestAnimationFrame(frame);
      };requestAnimationFrame(frame);
    });
    let timing;
    try{
      await outClient.send("Input.dispatchTouchEvent",{type:"touchStart",
        touchPoints:[{x:outBounds.x+outBounds.width/2,y:outBounds.y+outBounds.height/2}]});
      await new Promise(resolve=>setTimeout(resolve,850));
      await outClient.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    }finally{
      timing=await page.evaluate(()=>{
        window.__u09Running=false;
        CanvasRenderingContext2D.prototype.drawImage=window.__u09OriginalDraw;
        return {frames:window.__u09Frames,scaledCopies:window.__u09ScaledCopies};
      });
      await outClient.detach();
    }
    const p95=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*.95)-1];};
    const firstMove=timing.frames.findIndex((v,i)=>i>0&&v.span!==timing.frames[i-1].span);
    assert.ok(firstMove>=0,"continuous zoom-out must actually change span");
    const active=timing.frames.slice(firstMove);
    const intervals=active.slice(1).map((v,i)=>v.time-active[i].time);
    const evidence={idleP95:p95(measureIdle),activeP95:p95(intervals),
      maxInterval:Math.max(...intervals),frames:active.length,
      distinctSpans:new Set(active.map(v=>v.span)).size,scaledCopies:timing.scaledCopies};
    console.log("U09_ZOOM_OUT "+JSON.stringify(evidence));
    assert.equal(evidence.scaledCopies,0,"zoom-out must not scale its previous signal raster");
    assert.ok(evidence.frames>=8&&evidence.distinctSpans>=4&&
      evidence.activeP95<=Math.max(50,evidence.idleP95*2.5)&&evidence.maxInterval<250,
      "held zoom-out should update continuously without long frame stalls: "+JSON.stringify(evidence));

    const adjacentWrites=await page.evaluate(()=>{
      const pitch=document.querySelector("#granular-pitch");
      const pitchValue=document.querySelector("#granular-pitch-value");
      const rangeDescriptor=Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,"value");
      const widthDescriptor=Object.getOwnPropertyDescriptor(
        CSSStyleDeclaration.prototype,"width");
      let rangeWrites=0,widthWrites=0;
      Object.defineProperty(pitch,"value",{configurable:true,
        get(){return rangeDescriptor.get.call(this);},
        set(value){rangeWrites++;rangeDescriptor.set.call(this,value);}});
      Object.defineProperty(pitchValue.style,"width",{configurable:true,
        get(){return widthDescriptor.get.call(this);},
        set(value){widthWrites++;widthDescriptor.set.call(this,value);}});
      const speed=document.querySelector("#granular-speed");
      for(const value of ["0.9","0.8","0.7"]){
        speed.value=value;
        speed.dispatchEvent(new Event("input",{bubbles:true}));
      }
      delete pitch.value;
      delete pitchValue.style.width;
      return {rangeWrites,widthWrites};
    });
    assert.deepEqual(adjacentWrites,{rangeWrites:0,widthWrites:0},
      "speed slider edits must not rewrite the independent pitch control or field");

    const zoomRefresh=await page.evaluate(async()=>{
      const {createPlayerWaveEditor}=await import("./player-wave-editor.mjs");
      const holder=document.createElement("div");
      holder.style.cssText="position:fixed;left:-1000px;top:0;width:320px;height:120px";
      const canvas=document.createElement("canvas");
      canvas.style.cssText="display:block;width:320px;height:120px";
      holder.append(canvas);document.body.append(holder);
      const makeNode=tag=>document.createElement(tag);
      const markerA=makeNode("span"),markerB=makeNode("span");
      const zoomIn=makeNode("button"),zoomOut=makeNode("button");
      const zoomLabel=makeNode("output");
      holder.append(markerA,markerB,zoomIn,zoomOut,zoomLabel);
      const sourceFrames=60*48000,reads=[];
      let activeReads=0,coarse=false;
      const source={sourceFrames,maxReadFrames:32768,
        overviewPeaks:Array.from({length:96},()=>[-.1,.1]),
        async read(startFrame,frameCount){
          activeReads++;reads.push({startFrame,frameCount});
          try{
            if(coarse)await new Promise(resolve=>setTimeout(resolve,25));
            return {startFrame,channels:[new Float32Array(frameCount).fill(
              coarse?-.5:.25)]};
          }finally{activeReads--;}
        }};
      const waitQuiet=async()=>{
        const started=performance.now();let count=reads.length,quiet=started;
        while(performance.now()-started<6000){
          await new Promise(resolve=>setTimeout(resolve,5));
          if(activeReads===0&&reads.length===count){
            if(performance.now()-quiet>100)return;
          }else{count=reads.length;quiet=performance.now();}
        }
        throw Error("synthetic waveform detail reads did not settle");
      };
      const centerY=()=>{
        const context=canvas.getContext("2d"),x=Math.floor(canvas.width/2);
        const pixels=context.getImageData(x,0,1,canvas.height).data;
        let total=0,count=0;
        for(let y=0;y<canvas.height;y++){
          const i=y*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
          if(g>150&&g>r*1.25&&b>r*1.1){total+=y;count++;}
        }
        return count?total/count/(canvas.height/120):null;
      };
      let editor;
      try{
        editor=createPlayerWaveEditor({canvas,wrap:holder,
          overviewSelection:makeNode("div"),markerA,markerB,zoomIn,zoomOut,
          zoomLabel,getPosition:()=>30,onPosition:()=>{},onStart:()=>{},
          onAB:()=>({a:0,b:sourceFrames,enabled:false})});
        editor.setSource(source,48000);await waitQuiet();
        zoomIn.click();await waitQuiet();
        zoomIn.click();await waitQuiet();
        zoomOut.click();await waitQuiet();
        zoomOut.click();await waitQuiet();
        const spanBefore=editor.spanFrames;
        coarse=true;
        const readCountBefore=reads.length,started=performance.now();
        zoomOut.click();
        const previewY=centerY(),startedReads=reads.length-readCountBefore;
        let updatedY=null;
        while(performance.now()-started<500){
          await new Promise(resolve=>setTimeout(resolve,5));
          updatedY=centerY();
          if(updatedY!==null&&updatedY>75)break;
        }
        const updateMs=performance.now()-started;
        await waitQuiet();
        const newReads=reads.slice(readCountBefore);
        const spanAfter=editor.spanFrames;
        zoomIn.click();
        const cachedResolutionY=centerY();
        await waitQuiet();
        const restoredCacheY=centerY();
        return {spanBefore,spanAfter,previewY,updatedY,updateMs,
          cachedResolutionY,restoredCacheY,
          readCount:newReads.length,readFrames:newReads.reduce((n,r)=>n+r.frameCount,0),
          maxReadFrames:Math.max(...newReads.map(r=>r.frameCount))};
      }finally{
        editor?.setSource(null,48000);await waitQuiet();holder.remove();
      }
    });
    assert.equal(zoomRefresh.spanBefore,576000);
    assert.equal(zoomRefresh.spanAfter,1152000);
    assert.ok(zoomRefresh.readCount>0,
      "the wider viewport must start a fresh bounded detail read immediately: "+
        JSON.stringify(zoomRefresh));
    assert.ok(zoomRefresh.previewY>43&&zoomRefresh.previewY<58,
      "cached waveform remains visible as an instant preview: "+JSON.stringify(zoomRefresh));
    assert.ok(zoomRefresh.updatedY>75,
      "the browser canvas must replace the stretched preview with new coarse PCM: "+
        JSON.stringify(zoomRefresh));
    assert.ok(zoomRefresh.updateMs<250,
      "fresh visible waveform PCM must repaint in under 250 ms: "+JSON.stringify(zoomRefresh));
    assert.ok(zoomRefresh.updatedY>75&&zoomRefresh.cachedResolutionY<58&&
      zoomRefresh.restoredCacheY<58,
      "switching back to a fully cached resolution must restore its PCM detail: "+
        JSON.stringify(zoomRefresh));
    assert.ok(zoomRefresh.maxReadFrames<=32768&&
      zoomRefresh.readFrames<=24*48000+32768,
      "zoom refresh remains bounded to its viewport: "+JSON.stringify(zoomRefresh));
  }finally{
    try{
      await closeBrowserTree(browser);
    }finally{
      // Do not leave the local test server holding the test process open if
      // an isolated browser shutdown reports an error.
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  }
});
