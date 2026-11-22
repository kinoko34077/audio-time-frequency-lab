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

    const button=await page.$("#wave-zoom-in");
    const bounds=await button.boundingBox();
    const client=await page.createCDPSession();
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
    const moved=samples.filter((sample,index)=>index&&
      sample.seconds<samples[index-1].seconds*.98);
    assert.ok(moved.length>=2,
      "holding zoom-in repeatedly changes magnification before release: "+
        JSON.stringify(samples.slice(0,8)));
    assert.ok(samples.every(sample=>sample.visible===0||
      sample.signal/sample.visible>=.8),
      "the currently visible source waveform stays drawn during continuous zoom: "+
        JSON.stringify(samples.filter(sample=>sample.visible&&
          sample.signal/sample.visible<.8).slice(0,8)));

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
  }finally{
    await closeBrowserTree(browser);
    await new Promise(resolve=>server.close(resolve));
  }
});
