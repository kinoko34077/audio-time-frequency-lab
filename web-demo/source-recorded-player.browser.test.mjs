import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const WEB_ROOT=path.resolve(process.env.WARP_WEB_ROOT||"_site");
const pythonCommand=process.env.PYTHON||
  (process.platform==="win32"?"python":"python3");
test("recorded CC0 upright piano goes through the real granular file picker and live Worklet",async()=>{
  let resolveServerPort,rejectServerPort;
  const serverReady=new Promise((resolve,reject)=>{
    resolveServerPort=resolve;rejectServerPort=reject;
  });
  const serverLog=[],workerEvents=[];
  const server=spawn(pythonCommand,["-c",
    "from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer; s=ThreadingHTTPServer(('127.0.0.1',0),SimpleHTTPRequestHandler); print('READY='+str(s.server_port),flush=True); s.serve_forever()"],{
    cwd:WEB_ROOT,stdio:["ignore","pipe","pipe"]
  });
  server.on("error",rejectServerPort);
  for(const stream of [server.stdout,server.stderr])stream.on("data",chunk=>{
    const text=chunk.toString();
    serverLog.push(text);
    if(serverLog.length>200)serverLog.splice(0,serverLog.length-200);
    const match=text.match(/READY=(\d+)/);
    if(match)resolveServerPort(Number(match[1]));
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
    const consoleErrors=[],failedRequests=[];
    const serverTimeout=setTimeout(()=>rejectServerPort(
      Error("local Pages server did not become ready")),10000);
    serverTimeout.unref?.();
    const port=await serverReady;
    clearTimeout(serverTimeout);
    await page.evaluateOnNewDocument(()=>{
      window.__labWorkletProgress=[];
      window.__labWorkletActivations=[];
      window.__labWorkletStages=[];
      window.__labWorkletReceipts=[];
      window.__labWorkerJobs=[];
      window.__labWorkerResults=[];
      window.__labWorkerCreations=[];
      window.__labWorkerErrors=[];
      window.__labWorkerTrace=[];
      window.__labWorkerCounter=0;
      window.__labWorkletCounter=0;
      window.__labLatestSourceWorkletId=0;
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{
        constructor(url,options){
          super(url,options);
          this.__labWorkerId=String(url).includes("lab-processor.worker.mjs")?
            ++window.__labWorkerCounter:0;
          window.__labWorkerCreations.push({id:this.__labWorkerId,
            url:String(url),at:performance.now()});
          this.addEventListener("error",event=>
            window.__labWorkerErrors.push({id:this.__labWorkerId,
              at:performance.now(),message:event.message,filename:event.filename,
              lineno:event.lineno}));
          this.addEventListener("messageerror",event=>
            window.__labWorkerErrors.push({id:this.__labWorkerId,
              at:performance.now(),type:"messageerror",message:event.message}));
          this.addEventListener("message",({data})=>{
            if(data?.type==="__labWorkerTrace")
              window.__labWorkerTrace.push({id:this.__labWorkerId,
                at:performance.now(),...data});
            if(!this.__labWorkerId||!Number.isSafeInteger(data?.job))return;
            window.__labWorkerResults.push({id:this.__labWorkerId,
              at:performance.now(),job:data.job,generation:data.generation,
              startFrame:data.plan?.start,ok:data.ok===true,
              workerElapsedMs:data.workerElapsedMs,
              outputFrames:data.channels?.[0]?.length||0});
          });
        }
        postMessage(...args){
          const [data]=args;
          if(this.__labWorkerId&&Number.isSafeInteger(data?.job))
            window.__labWorkerJobs.push({id:this.__labWorkerId,
              at:performance.now(),job:data.job,generation:data.generation,
              startFrame:data.plan?.start,model:data.model,
              jointBackend:data.jointBackend,speed:data.speed,
              semitones:data.semitones});
          return super.postMessage(...args);
        }
      };
      const NativeWorklet=window.AudioWorkletNode;
      window.AudioWorkletNode=class extends NativeWorklet{
        constructor(ctx,name,options){
          super(ctx,name,options);
          if(name!=="audio-lab-source-pcm")return;
          const id=++window.__labWorkletCounter;
          window.__labLatestSourceWorkletId=id;
          this.port.addEventListener("message",({data})=>{
            if(data?.type==="worker-state-staged")
              window.__labWorkletStages.push({id,at:performance.now(),
                generation:data.generation,sourceFrame:data.sourceFrame,
                speed:data.speed,bufferedSegments:data.bufferedSegments});
            if(data?.type==="worker-state-activated")
              window.__labWorkletActivations.push({id,at:performance.now(),
                generation:data.generation,sourceFrame:data.sourceFrame,
                speed:data.speed});
            if(data?.type==="rendered-chunk-accepted")
              window.__labWorkletReceipts.push({id,at:performance.now(),
                generation:data.generation,startFrame:data.startFrame,
                endFrame:data.endFrame,outputFrames:data.outputFrames,
                stale:data.stale===true});
            if(data?.type==="progress"&&data.processingMode==="worker")
              window.__labWorkletProgress.push({id,
                at:performance.now(),
                sourceFrame:data.sourceFrame,
                firstMissingFrame:data.firstMissingFrame,
                renderedFrames:data.renderedFrames,
                missingFrames:data.missingFrames,
                bufferedSegments:data.bufferedSegments,
                speed:data.speed,
                workerGeneration:data.workerGeneration});
          });
          this.port.start();
        }
      };
    });
    page.on("pageerror",e=>errors.push(e.message));
    page.on("workercreated",worker=>workerEvents.push({event:"created",url:worker.url()}));
    page.on("workerdestroyed",worker=>workerEvents.push({event:"destroyed",url:worker.url()}));
    page.on("console",message=>{
      if(message.type()==="error")consoleErrors.push({
        text:message.text(),location:message.location()});
    });
    page.on("response",response=>{
      if(response.status()>=400)consoleErrors.push({
        status:response.status(),url:response.url()});
    });
    page.on("requestfailed",request=>failedRequests.push({
      url:request.url(),error:request.failure()?.errorText
    }));
    await page.goto("http://127.0.0.1:"+port+"/?pcmTransport=granular",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    try{
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
        {timeout:20000});
    }catch(error){
      const boot=await page.evaluate(()=>(
        {fwBoot:document.documentElement.dataset.fwBoot,
         status:document.querySelector("#status")?.textContent,
         loaded:performance.getEntriesByType("resource").map(x=>x.name)
           .filter(x=>/app\.mjs|dsp_core|source-pcm|lab-stream/.test(x))
        })).catch(()=>null);
      console.log("RECORDED_APP_BOOT_DIAGNOSTIC "+JSON.stringify({boot,
        errors,consoleErrors,failedRequests,serverLog:serverLog.slice(-40)}));
      throw error;
    }
    const input=await page.$("#audio-file");
    assert.ok(input);
    await input.uploadFile(WAV);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav · 3.0秒"),
      {timeout:20000});
    const meta=await page.$eval("#file-meta",e=>e.textContent);
    const decodedRate=Number(meta.match(/(\d+)Hz/)?.[1]);
    const durationSeconds=Number(meta.match(/(\d+(?:\.\d+)?)秒/)?.[1]);
    const totalSourceFrames=Math.round(decodedRate*durationSeconds);
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
    const startupProbes=[],probeTimers=[];
    const probeTasks=[1500,8000].map(delay=>new Promise(resolve=>{
      probeTimers.push(setTimeout(async()=>{
        const contexts=await Promise.all(page.workers().map(async worker=>{
          const state=await Promise.race([
            worker.evaluate(()=>({now:performance.now(),
              messageHandlerType:typeof self.onmessage,
              messageHandler:String(self.onmessage).slice(0,180),
              location:self.location.href
            })).then(value=>({state:value})).catch(error=>({error:error.message})),
            new Promise(done=>setTimeout(()=>done({inspectTimeout:true}),750))
          ]);
          return {url:worker.url(),...state};
        }));
        startupProbes.push({delay,contexts,
          jobs:await page.evaluate(()=>window.__labWorkerJobs.slice()),
          results:await page.evaluate(()=>window.__labWorkerResults.slice()),
          errors:await page.evaluate(()=>window.__labWorkerErrors.slice()),
          trace:await page.evaluate(()=>window.__labWorkerTrace.slice())});
        resolve();
      },delay));
    }));
    try{
      await page.waitForFunction(()=>document.querySelector("#rt-indicator")
        ?.textContent.includes("モデル再生中"),{timeout:30000});
      probeTimers.forEach(clearTimeout);
    }catch(error){
      await Promise.all(probeTasks);
      probeTimers.forEach(clearTimeout);
      const boot=await page.evaluate(()=>({
        indicator:document.querySelector("#rt-indicator")?.textContent,
        status:document.querySelector("#status")?.textContent,
        modelStatus:document.querySelector("#lab-status")?.textContent,
        playButton:{disabled:document.querySelector("#play-main")?.disabled,
          text:document.querySelector("#play-main")?.textContent},
        telemetry:document.querySelector("#rt-telemetry")?.textContent,
        workletCount:window.__labWorkletCounter,
        workerProbe:{counter:window.__labWorkerCounter,
          creations:window.__labWorkerCreations,
          jobs:window.__labWorkerJobs,results:window.__labWorkerResults,
          errors:window.__labWorkerErrors,trace:window.__labWorkerTrace},
        progress:window.__labWorkletProgress,
        receipts:window.__labWorkletReceipts,
        loaded:performance.getEntriesByType("resource")
          .map(x=>x.name).filter(x=>/lab-processor|lab-dsp|source-pcm/.test(x))
      }));
      const workerContexts=await Promise.all(page.workers().map(async worker=>{
        const result=await Promise.race([
          worker.evaluate(()=>({
            now:performance.now(),
            messageHandlerType:typeof self.onmessage,
            messageHandler:String(self.onmessage).slice(0,180),
            messageListeners:Object.getOwnPropertyNames(self)
              .filter(key=>/message|diagnostic/i.test(key)).slice(0,20)
          })).then(state=>({state})).catch(cause=>({inspectError:cause.message})),
          new Promise(resolve=>setTimeout(()=>resolve({inspectTimeout:true}),1500))
        ]);
        return {url:worker.url(),...result};
      }));
      console.log("RECORDED_WORKER_START_DIAGNOSTIC "+JSON.stringify({
        boot,startupProbes,
        workerTargets:page.workers().map(worker=>worker.url()),
        workerContexts,
        workerEvents,serverLog:serverLog.slice(-40),
        errors,consoleErrors,failedRequests}));
      throw error;
    }
    const workletId=await page.evaluate(()=>window.__labLatestSourceWorkletId);
    await page.waitForFunction(({workletId})=>
      window.__labWorkletReceipts.some(x=>x.id===workletId&&
        x.generation===0&&x.outputFrames>0&&!x.stale)&&
      window.__labWorkletProgress.some(x=>x.id===workletId&&
        x.workerGeneration===0),
      {timeout:30000},{workletId});
    await new Promise(resolve=>setTimeout(resolve,1800));
    const steady=await page.evaluate(({workletId})=>{
      const chunks=window.__labWorkletReceipts.filter(x=>
        x.id===workletId&&x.generation===0&&x.outputFrames>0&&!x.stale);
      const progress=window.__labWorkletProgress.filter(x=>
        x.id===workletId&&x.workerGeneration===0);
      return {generation:0,completedChunks:chunks.length,
        distinctChunkStarts:new Set(chunks.map(x=>x.startFrame)).size,
        outputFrames:chunks.reduce((n,x)=>n+x.outputFrames,0),
        progressSamples:progress.length,
        renderedFrames:progress.at(-1)?.renderedFrames||0,
        missingFrames:progress.at(-1)?.missingFrames,
        sourceStart:progress[0]?.sourceFrame,
        sourceEnd:progress.at(-1)?.sourceFrame};
    },{workletId});
    assert.ok(steady.completedChunks>0&&steady.outputFrames>0,steady);
    assert.ok(steady.progressSamples>0&&steady.renderedFrames>0,steady);
    const previousGeneration=steady.generation;
    await page.waitForFunction(({workletId,previousGeneration})=>{
      const progress=window.__labWorkletProgress.filter(x=>
        x.id===workletId&&x.workerGeneration===previousGeneration).at(-1);
      return progress?.sourceFrame>=34000&&progress.sourceFrame<36000;
    },{timeout:12000},{workletId,previousGeneration});
    const changeRequest=await page.evaluate(()=>({
      at:performance.now(),
      progress:window.__labWorkletProgress.filter(x=>
        x.id===window.__labLatestSourceWorkletId).at(-1)||null
    }));
    await page.select("#lab-model","wsola");
    try{
      await page.waitForFunction(({workletId,previousGeneration})=>
        window.__labWorkletActivations.some(x=>x.id===workletId&&
          x.generation>previousGeneration),
        {timeout:30000},{workletId,previousGeneration});
    }catch(error){
      const transitionBoot=await page.evaluate(({workletId,
        previousGeneration})=>({
        model:document.querySelector("#lab-model")?.value,
        modelStatus:document.querySelector("#lab-status")?.textContent,
        workerJobs:window.__labWorkerJobs,
        workerResults:window.__labWorkerResults,
        workerTrace:window.__labWorkerTrace,
        workerErrors:window.__labWorkerErrors,
        stages:window.__labWorkletStages.filter(x=>x.id===workletId&&
          x.generation>previousGeneration),
        activations:window.__labWorkletActivations.filter(x=>
          x.id===workletId&&x.generation>previousGeneration),
        receipts:window.__labWorkletReceipts.filter(x=>x.id===workletId&&
          x.generation>previousGeneration),
        progress:window.__labWorkletProgress.filter(x=>x.id===workletId)
          .slice(-20),
        worklets:window.__labWorkletCounter,
        workerCounter:window.__labWorkerCounter
      }),{workletId,previousGeneration});
      console.log("RECORDED_WORKER_ACTIVATION_TIMEOUT "+JSON.stringify({
        transitionBoot,workerEvents,
        workerTargets:page.workers().map(worker=>worker.url()),
        serverLog:serverLog.slice(-20),errors,consoleErrors,failedRequests}));
      throw error;
    }
    const nextGeneration=await page.evaluate(({workletId,previousGeneration})=>
      window.__labWorkletActivations.filter(x=>x.id===workletId&&
        x.generation>previousGeneration).at(-1)?.generation,
      {workletId,previousGeneration});
    await page.waitForFunction(({workletId,nextGeneration})=>
      window.__labWorkletProgress.some(x=>x.id===workletId&&
        x.workerGeneration===nextGeneration),
      {timeout:20000},{workletId,nextGeneration});
    await new Promise(resolve=>setTimeout(resolve,1800));
    const transition=await page.evaluate(({workletId,nextGeneration,
      baselineMissingFrames,changeRequest,decodedRate,totalSourceFrames,
      workerCount})=>{
      const chunks=window.__labWorkletReceipts.filter(x=>
        x.id===workletId&&x.generation===nextGeneration&&
        x.outputFrames>0&&!x.stale);
      const worklet=window.__labWorkletProgress.filter(x=>x.id===workletId);
      const progress=window.__labWorkletProgress.filter(x=>
        x.id===workletId&&x.workerGeneration===nextGeneration);
      const missingFrames=progress.at(-1)?.missingFrames;
      const activation=window.__labWorkletActivations.filter(x=>
        x.id===workletId&&x.generation===nextGeneration).at(-1)||null;
      const stage=window.__labWorkletStages.filter(x=>
        x.id===workletId&&x.generation===nextGeneration).at(-1)||null;
        const handoffJob=stage?window.__labWorkerJobs.find(x=>
          x.generation===nextGeneration&&x.startFrame===stage.sourceFrame)||null:null;
        const handoffResult=handoffJob?window.__labWorkerResults.find(x=>
          x.id===handoffJob.id&&x.job===handoffJob.job)||null:null;
        const installedChunk=handoffJob?window.__labWorkletReceipts.find(x=>
          x.id===workletId&&x.generation===nextGeneration&&
          x.startFrame===handoffJob.startFrame)||null:null;
      const stageProgress=stage?worklet.filter(x=>
        x.id===workletId&&x.at<=stage.at).at(-1)||null:null;
      const firstNextProgress=worklet.findIndex(x=>
        x.workerGeneration===nextGeneration);
      const progressTrace=worklet.slice(Math.max(0,firstNextProgress-6),
        firstNextProgress+12).map(({at,sourceFrame,firstMissingFrame,
          renderedFrames,missingFrames,bufferedSegments,speed,workerGeneration})=>({
            at,sourceFrame,firstMissingFrame,renderedFrames,missingFrames,
            bufferedSegments,speed,workerGeneration}));
      let stagedDistanceFrames=stage&&changeRequest.progress?
        stage.sourceFrame-changeRequest.progress.sourceFrame:null;
      if(stagedDistanceFrames!==null&&stagedDistanceFrames<0)
        stagedDistanceFrames+=totalSourceFrames;
      let stagedDistanceAtStageFrames=stage&&stageProgress?
        stage.sourceFrame-stageProgress.sourceFrame:null;
      if(stagedDistanceAtStageFrames!==null&&stagedDistanceAtStageFrames<0)
        stagedDistanceAtStageFrames+=totalSourceFrames;
      return {fromModel:"pv",toModel:document.querySelector("#lab-model").value,
        fromGeneration:nextGeneration-1,toGeneration:nextGeneration,
        workerCount,
        completedChunks:chunks.length,
        distinctChunkStarts:new Set(chunks.map(x=>x.startFrame)).size,
        outputFrames:chunks.reduce((n,x)=>n+x.outputFrames,0),
        progressSamples:progress.length,
        renderedFrames:progress.at(-1)?.renderedFrames||0,
        missingFrames,
        missingFrameDelta:missingFrames-baselineMissingFrames,
        activationDelayMs:activation?activation.at-changeRequest.at:null,
        activation,stage,
          timing:{requestToStageMs:stage?stage.at-changeRequest.at:null,
            stageToWorkerStartMs:stage&&handoffJob?handoffJob.at-stage.at:null,
            workerWallMs:handoffJob&&handoffResult?
              handoffResult.at-handoffJob.at:null,
            workerReportedMs:handoffResult?.workerElapsedMs??null,
            resultToInstallMs:handoffResult&&installedChunk?
              installedChunk.at-handoffResult.at:null,
            resultToActivationMs:handoffResult&&activation?
              activation.at-handoffResult.at:null,
            workerTrace:handoffJob?window.__labWorkerTrace.filter(x=>
              x.diagnosticJob===handoffJob.job):[],
            handoffJob,handoffResult,installedChunk},
        changeRequest:{at:changeRequest.at,
          sourceFrame:changeRequest.progress?.sourceFrame,
          bufferedSegments:changeRequest.progress?.bufferedSegments},
        stageProgress,
        stagedDistanceFrames,
        stagedDistanceMs:stagedDistanceFrames===null?null:
          stagedDistanceFrames/(decodedRate||1)/
            (changeRequest.progress?.speed||1)*1000,
        stagedDistanceAtStageFrames,
        stagedDistanceAtStageMs:stagedDistanceAtStageFrames===null?null:
          stagedDistanceAtStageFrames/(decodedRate||1)/
            (changeRequest.progress?.speed||1)*1000,
        stageToActivationMs:stage&&activation?activation.at-stage.at:null,
        sourceStart:progress[0]?.sourceFrame,
        sourceEnd:progress.at(-1)?.sourceFrame,
        progressTrace};
    },{workletId,nextGeneration,
      baselineMissingFrames:steady.missingFrames,changeRequest,
      decodedRate,totalSourceFrames,
      workerCount:workerEvents.filter(x=>x.event==="created"&&
        /lab-processor\.worker/.test(x.url)).length});
    console.log("RECORDED_PERIOD_WORKER_CHROME "+JSON.stringify({
      input:meta,decodedRate,steady,transition,
      proof:"REAL_CC0_FILE_TO_WORKER_PCM_AND_SHARED_WORKLET_PROGRESS_NOT_DAC_CAPTURE"
    }));
    assert.ok(transition.completedChunks>0&&transition.outputFrames>0,transition);
    assert.ok(transition.progressSamples>0&&transition.renderedFrames>0,transition);
      assert.ok(transition.timing.handoffJob&&transition.timing.handoffResult&&
        transition.timing.installedChunk,
        "handoff Worker timing must cover start, result and shared-Worklet acceptance");
    assert.ok(transition.workerCount>=1,
      "the staged generation is rendered by the active or parallel handoff Worker");
    assert.equal(transition.missingFrameDelta,0,
      "a recorded PV→WSOLA generation change must preserve audible PCM frames");
    assert.ok(transition.activationDelayMs<totalSourceFrames/decodedRate*1000,
      "a settings change must activate before waiting an extra full source loop");
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();server.kill();
  }
});
