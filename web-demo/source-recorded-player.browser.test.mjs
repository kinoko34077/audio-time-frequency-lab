import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const pythonCommand=process.env.PYTHON||
  (process.platform==="win32"?"python":"python3");
test("recorded CC0 upright piano goes through the real granular file picker and live Worklet",async()=>{
  const port=18767;
  const server=spawn(pythonCommand,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage(),errors=[];
    await page.evaluateOnNewDocument(()=>{
      window.__labWorkerResults=[];
      window.__labWorkerCounter=0;
      window.__labLatestWorkerId=0;
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{
        constructor(url,options){
          super(url,options);
          if(!String(url).includes("lab-processor.worker.mjs"))return;
          const id=++window.__labWorkerCounter;
          window.__labLatestWorkerId=id;
          this.addEventListener("message",({data})=>{
            if(!Number.isSafeInteger(data?.job))return;
            window.__labWorkerResults.push({id,job:data.job,
              generation:data.generation,ok:data.ok===true,
              startFrame:data.plan?.start,
              outputFrames:data.channels?.[0]?.length||0,
              channelCount:data.channels?.length||0});
          });
        }
      };
      window.__labWorkletProgress=[];
      window.__labWorkletCounter=0;
      window.__labLatestSourceWorkletId=0;
      const NativeWorklet=window.AudioWorkletNode;
      window.AudioWorkletNode=class extends NativeWorklet{
        constructor(ctx,name,options){
          super(ctx,name,options);
          if(name!=="audio-lab-source-pcm")return;
          const id=++window.__labWorkletCounter;
          window.__labLatestSourceWorkletId=id;
          this.port.addEventListener("message",({data})=>{
            if(data?.type==="progress"&&data.processingMode==="worker")
              window.__labWorkletProgress.push({id,
                sourceFrame:data.sourceFrame,
                renderedFrames:data.renderedFrames,
                missingFrames:data.missingFrames,
                workerGeneration:data.workerGeneration});
          });
          this.port.start();
        }
      };
    });
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://127.0.0.1:"+port+"/?pcmTransport=granular",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    const input=await page.$("#audio-file");
    assert.ok(input);
    await input.uploadFile(WAV);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav · 3.0秒"),
      {timeout:20000});
    const meta=await page.$eval("#file-meta",e=>e.textContent);
    const decodedRate=Number(meta.match(/(\d+)Hz/)?.[1]);
    assert.ok(decodedRate>=8000&&decodedRate<=192000,
      "actual decoder sample rate required; native AudioContext may resample");
    assert.match(meta,/ · 1ch/,
      "real mono recording was decoded, not substituted with a generated fixture");
    await page.waitForSelector("#play-dry:not([disabled])",{timeout:10000});
    await page.evaluate(()=>{
      for(const [id,value] of [["granular-speed-value","0"],
        ["granular-pitch-value","7.1234"]]){
        const el=document.getElementById(id);
        el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
      }
    });
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="granular-experimental",{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderPitch==="7.1234"&&
      document.querySelector("#granular-optin-status")
        ?.dataset.renderRunning==="true",{timeout:20000});
    const initial=await page.evaluate(()=>({
      nodeStarts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      status:document.querySelector("#granular-optin-status").textContent,
      sourceFrame:Number(document.querySelector("#granular-optin-status").dataset.renderFrame),
      input:document.querySelector("#file-meta").textContent
    }));
    assert.equal(initial.nodeStarts,1);
    assert.ok(Number.isFinite(initial.sourceFrame));
    await page.$eval("#wave",e=>e.scrollIntoView({block:"center"}));
    const box=await page.$eval("#wave",e=>{
      const r=e.getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height};
    });
    const y=box.top+box.height/2;
    await page.mouse.move(box.left+box.width*.15,y);
    await page.mouse.down();
    for(let n=1;n<=8;n++)
      await page.mouse.move(box.left+box.width*(.15+.50*n/8),y);
    // A quick pointer-up is now intentionally a DJ throw: it keeps moving.
    // To test exact held-source-frame seeking, keep the finger still long
    // enough to suppress inertia before lifting.
    await new Promise(resolve=>setTimeout(resolve,160));
    await page.mouse.up();
    const expected=Math.round(decodedRate*3*.65);
    await page.waitForFunction(frame=>Math.abs(Number(
      document.querySelector("#granular-optin-status")?.dataset.renderFrame)-frame)<=2,
      {timeout:20000},expected);
    const priorRevision=await page.$eval("#granular-optin-status",
      el=>Number(el.dataset.renderRevision));
    await page.evaluate(()=>{
      const speed=document.getElementById("granular-speed-value");
      speed.value="-1";speed.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(prev=>
      Number(document.querySelector("#granular-optin-status")?.dataset.renderRevision)>prev&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000},priorRevision);
    const after=await page.evaluate(()=>({
      nodeStarts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      speed:document.querySelector("#granular-speed-value").value,
      pitch:document.querySelector("#granular-pitch-value").value,
      telemetry:document.querySelector("#rt-telemetry").textContent,
      sample:document.querySelector("#file-meta").textContent
    }));
    assert.equal(after.nodeStarts,1,"native recorded material must not restart Worklet");
    assert.equal(after.speed,"-1");
    assert.equal(after.pitch,"7.1234");
    assert.match(after.sample,/meta-piano/);
    // A negative-speed reverse lookup is not proof of perceptual fidelity.
    console.log("RECORDED_META_PIANO_CHROME "+JSON.stringify({
      input:meta,decodedRate,firstRenderFrame:initial.sourceFrame,
      scrubTargetFrame:expected,stereo:false,channels:1,
      after:after.telemetry,nodeStarts:after.nodeStarts,
      proof:"REAL_NATIVE_FILE_INPUT_AND_RENDER_ACK_NOT_DAC_AUDIO_CAPTURE"
    }));
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});

    // Exercise the same recorded file through the retained PV + individual-
    // period Worker and its shared source-clock Worklet. This reports real
    // generation-transition gaps without treating the diagnostic run as an
    // audible-quality acceptance or loosening a threshold.
    await page.$eval("#granular-speed-value",e=>{
      e.value="1";e.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.click("#main-tab-model");
    await page.waitForSelector("#audio-lab",{timeout:10000});
    await page.select("#lab-model","pv");
    await page.$eval("#lab-individual-periods",e=>{
      e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator")
      ?.textContent.includes("モデル再生中"),{timeout:30000});
    const workerId=await page.evaluate(()=>window.__labLatestWorkerId);
    const workletId=await page.evaluate(()=>window.__labLatestSourceWorkletId);
    await page.waitForFunction(({workerId,workletId})=>{
      const completed=window.__labWorkerResults.filter(x=>
        x.id===workerId&&x.ok&&x.channelCount===1&&x.outputFrames>0);
      const generation=completed.at(-1)?.generation;
      return Number.isSafeInteger(generation)&&window.__labWorkletProgress.some(x=>
        x.id===workletId&&x.workerGeneration===generation);
    },{timeout:30000},{workerId,workletId});
    await new Promise(resolve=>setTimeout(resolve,1800));
    const steady=await page.evaluate(({workerId,workletId})=>{
      const chunks=window.__labWorkerResults.filter(x=>
        x.id===workerId&&x.ok&&x.channelCount===1&&x.outputFrames>0);
      const generation=chunks.at(-1)?.generation;
      const progress=window.__labWorkletProgress.filter(x=>
        x.id===workletId&&x.workerGeneration===generation);
      return {generation,completedChunks:chunks.length,
        distinctChunkStarts:new Set(chunks.map(x=>x.startFrame)).size,
        outputFrames:chunks.reduce((n,x)=>n+x.outputFrames,0),
        progressSamples:progress.length,
        renderedFrames:progress.at(-1)?.renderedFrames||0,
        missingFrames:progress.at(-1)?.missingFrames,
        sourceStart:progress[0]?.sourceFrame,
        sourceEnd:progress.at(-1)?.sourceFrame,
        channels:chunks[0]?.channelCount||0};
    },{workerId,workletId});
    assert.ok(steady.completedChunks>0&&steady.outputFrames>0,steady);
    assert.ok(steady.progressSamples>0&&steady.renderedFrames>0,steady);
    const previousGeneration=steady.generation;
    await page.select("#lab-model","wsola");
    await page.waitForFunction(({workerId,previousGeneration})=>
      window.__labWorkerResults.some(x=>x.id===workerId&&x.ok&&
        x.generation>previousGeneration&&x.outputFrames>0),
      {timeout:30000},{workerId,previousGeneration});
    const nextGeneration=await page.evaluate(({workerId,previousGeneration})=>
      window.__labWorkerResults.filter(x=>x.id===workerId&&x.ok&&
        x.generation>previousGeneration).at(-1)?.generation,
      {workerId,previousGeneration});
    await page.waitForFunction(({workletId,nextGeneration})=>
      window.__labWorkletProgress.some(x=>x.id===workletId&&
        x.workerGeneration===nextGeneration),
      {timeout:20000},{workletId,nextGeneration});
    await new Promise(resolve=>setTimeout(resolve,1800));
    const transition=await page.evaluate(({workerId,workletId,nextGeneration})=>{
      const chunks=window.__labWorkerResults.filter(x=>x.id===workerId&&
        x.generation===nextGeneration&&x.ok&&x.outputFrames>0);
      const progress=window.__labWorkletProgress.filter(x=>
        x.id===workletId&&x.workerGeneration===nextGeneration);
      return {fromModel:"pv",toModel:document.querySelector("#lab-model").value,
        fromGeneration:nextGeneration-1,toGeneration:nextGeneration,
        completedChunks:chunks.length,
        distinctChunkStarts:new Set(chunks.map(x=>x.startFrame)).size,
        outputFrames:chunks.reduce((n,x)=>n+x.outputFrames,0),
        progressSamples:progress.length,
        renderedFrames:progress.at(-1)?.renderedFrames||0,
        missingFrames:progress.at(-1)?.missingFrames,
        sourceStart:progress[0]?.sourceFrame,
        sourceEnd:progress.at(-1)?.sourceFrame,
        channels:chunks[0]?.channelCount||0};
    },{workerId,workletId,nextGeneration});
    assert.ok(transition.completedChunks>0&&transition.outputFrames>0,transition);
    assert.ok(transition.progressSamples>0&&transition.renderedFrames>0,transition);
    console.log("RECORDED_PERIOD_WORKER_CHROME "+JSON.stringify({
      input:meta,decodedRate,steady,transition,
      proof:"REAL_CC0_FILE_TO_WORKER_PCM_AND_SHARED_WORKLET_PROGRESS_NOT_DAC_CAPTURE"
    }));
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();server.kill();
  }
});
