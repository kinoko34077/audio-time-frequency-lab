import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

async function waitForWorkerPCM(page,{backend=null,generation=null,
  minimumGeneration=0,missingBeforeFrames=null}={}){
  let matchHandle;
  try{matchHandle=await page.waitForFunction(expected=>{
    const audit=window.__labAudit;
    const generations=expected.generation===null?
      [...new Set(audit.jobs.filter(job=>
        job.generation>=expected.minimumGeneration&&
        (!expected.backend||job.jointBackend===expected.backend))
        .map(job=>job.generation))]:[expected.generation];
    const current=generations.find(current=>{
      const job=audit.jobs.filter(item=>item.generation===current&&
        (!expected.backend||item.jointBackend===expected.backend)).at(-1);
      return job&&audit.workerResults.some(result=>result.job===job.job&&
        result.ok)&&audit.messages.some(message=>
          message.type==="rendered-chunk-accepted"&&
          message.generation===current)&&audit.messages.some(message=>
          message.type==="progress"&&
          message.workerGeneration===current);
    });
    return current===undefined?false:{generation:current};
  },{timeout:15000},{backend,generation,minimumGeneration});}
  catch(error){
    const diagnostic=await page.evaluate(expected=>{
      const audit=window.__labAudit;
      const jobs=audit.jobs.filter(job=>(!expected.backend||
        job.jointBackend===expected.backend)&&
        (expected.generation===null||job.generation===expected.generation));
      const relevantJobs=new Set(jobs.map(job=>job.job));
      return {selectedModel:document.querySelector("#lab-model")?.value,
        status:document.querySelector("#lab-status")?.textContent,
        jobs:jobs.slice(-8),results:audit.workerResults.filter(result=>
          relevantJobs.has(result.job)).slice(-8),
        states:audit.messages.filter(message=>
          message.type==="worker-state-accepted").slice(-8),
        progress:audit.messages.filter(message=>message.type==="progress"&&
          message.processingMode==="worker").slice(-8)};
    },{backend,generation,minimumGeneration});
    throw Error("Worker PCM evidence timed out: "+JSON.stringify(diagnostic),
      {cause:error});
  }
  const selected=await matchHandle.jsonValue();
  await matchHandle.dispose();
  const evidence=await page.evaluate(async expected=>{
    const audit=window.__labAudit;
    const current=expected.generation;
    const job=audit.jobs.filter(item=>item.generation===current&&
      (!expected.backend||item.jointBackend===expected.backend)).at(-1);
    const start=audit.messages.filter(message=>message.type==="progress"&&
      message.workerGeneration===current).at(-1);
    let peakRms=0,lastProgress=start,advanceFrames=0;
    const probe=audit.probe,pcm=new Float32Array(probe?.fftSize||0);
    const deadline=performance.now()+12000;
    while(performance.now()<deadline){
      const currentProgress=audit.messages.filter(message=>
        message.type==="progress"&&message.workerGeneration===current).at(-1);
      if(currentProgress){
        lastProgress=currentProgress;
        advanceFrames=Math.max(advanceFrames,
          currentProgress.sourceFrame-start.sourceFrame);
      }
      if(probe&&pcm.length){
        probe.getFloatTimeDomainData(pcm);
        const rms=Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length);
        peakRms=Math.max(peakRms,rms);
      }
      if(peakRms>.01&&advanceFrames>0)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return {backend:job?.jointBackend,generation:current,
      peakRms,advanceFrames,
      missingFrames:Math.max(0,(lastProgress?.missingFrames||0)-
        (expected.missingBeforeFrames??start?.missingFrames??0)),
      accepted:audit.messages.some(message=>
        message.type==="rendered-chunk-accepted"&&
        message.generation===current),startSourceFrame:start?.sourceFrame,
      lastSourceFrame:lastProgress?.sourceFrame,
      missingTotal:lastProgress?.missingFrames||0,
      firstMissingFrame:lastProgress?.firstMissingFrame,
      matchingAcks:audit.messages.filter(message=>
        message.type==="rendered-chunk-accepted"&&
        message.generation===current).map(({stale,bufferedSegments,
          startFrame,endFrame,speed,coreFrames,outputFrames})=>({stale,
          bufferedSegments,startFrame,endFrame,speed,coreFrames,outputFrames})),
      matchingJobs:audit.jobs.filter(item=>item.generation===current).slice(-4),
      matchingResults:audit.workerResults.filter(item=>
        item.generation===current).slice(-4)};
  },{backend,generation:selected.generation,minimumGeneration,missingBeforeFrames});
  assert.ok(evidence.accepted&&evidence.peakRms>.01&&
    evidence.advanceFrames>0,JSON.stringify(evidence));
  return evidence;
}

test("individual-period Worker plays through one shared PCM Worklet in Chrome",async()=>{
  const port=18749;
  const server=spawn(process.env.PYTHON||"python3",
    ["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("web-demo"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage();
    const pageErrors=[];
    page.on("pageerror",error=>pageErrors.push(error.message));
    page.on("console",message=>{
      if(message.type()==="error"&&
         !message.text().startsWith("Failed to load resource: the server responded with a status of 404"))
        pageErrors.push(message.text());
    });
    await page.evaluateOnNewDocument(()=>{
      const audit={worklets:[],workers:[],jobs:[],workerResults:[],messages:[],bufferSources:0,probe:null};
      Object.defineProperty(window,"__labAudit",{value:audit});
      const NativeWorklet=window.AudioWorkletNode;
      const nativeConnect=NativeWorklet.prototype.connect;
      NativeWorklet.prototype.connect=function(destination,...rest){
        const result=nativeConnect.call(this,destination,...rest);
        if(this.__labWorkerMode&&!this.__labProbe){
          const analyser=this.context.createAnalyser();analyser.fftSize=2048;
          const mute=this.context.createGain();mute.gain.value=0;
          nativeConnect.call(this,analyser);analyser.connect(mute);
          mute.connect(this.context.destination);
          this.__labProbe=true;audit.probe=analyser;
        }
        return result;
      };
      window.AudioWorkletNode=class extends NativeWorklet{
        constructor(ctx,name,options){
          super(ctx,name,options);
          const mode=options?.processorOptions?.processingMode||"raw";
          this.__labWorkerMode=mode==="worker";
          audit.worklets.push({name,mode});
          this.port.addEventListener("message",event=>audit.messages.push({
            ...(event.data||{}),receivedAt:performance.now()
          }));
          this.port.start();
        }
      };
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{
        constructor(url,options){
          super(url,options);this.__labUrl=String(url);
          audit.workers.push(this.__labUrl);
          this.addEventListener("message",event=>audit.workerResults.push({
            receivedAt:performance.now(),job:event.data?.job,
            generation:event.data?.generation,ok:event.data?.ok
          }));
        }
        postMessage(payload,...rest){
          if(this.__labUrl.includes("lab-processor.worker"))
            audit.jobs.push({job:payload.job,generation:payload.generation,
              model:payload.model,jointBackend:payload.jointBackend,
              speed:payload.speed,semitones:payload.semitones,
            sentAt:performance.now(),coreFrames:payload.plan?.core,
              planStart:payload.plan?.start,
              planEnd:payload.plan?.start+payload.plan?.core,
              outputFrames:payload.plan?.outputFrames,
              sourceFrames:payload.plan?.to-payload.plan?.from+
                (payload.plan?.wrapRight||0)});
          return super.postMessage(payload,...rest);
        }
      };
      const nativeBufferSource=AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(...args){
        audit.bufferSources++;
        return nativeBufferSource.apply(this,args);
      };
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>
      document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await page.evaluate(async()=>{
      const select=document.querySelector("#lab-model");
      select.value="pv";select.dispatchEvent(new Event("change",{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,40));
      const individual=document.querySelector("#lab-individual-periods");
      individual.checked=true;
      individual.dispatchEvent(new Event("change",{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,40));
      const sampleRate=48000,frames=sampleRate*6;
      const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);
      view.setUint32(0,0x46464952,true);view.setUint32(4,bytes.byteLength-8,true);
      view.setUint32(8,0x45564157,true);view.setUint32(12,0x20746d66,true);
      view.setUint32(16,16,true);view.setUint16(20,1,true);
      view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);
      view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);
      view.setUint16(34,16,true);view.setUint32(36,0x61746164,true);
      view.setUint32(40,frames*2,true);
      for(let i=0;i<frames;i++)
        view.setInt16(44+i*2,Math.round(.2*Math.sin(2*Math.PI*440*i/sampleRate)*32767),true);
      const file=new File([bytes],"worker-source-tone.wav",{type:"audio/wav"});
      const transfer=new DataTransfer();transfer.items.add(file);
      const input=document.querySelector("#audio-file");input.files=transfer.files;
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    try{
      await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
        .includes("worker-source-tone.wav")&&
        !document.querySelector("#file-meta").textContent.includes("読み込み中"),
        {timeout:15000});
    }catch(error){
      const diagnostic=await page.evaluate(()=>({
        title:document.title,meta:document.querySelector("#file-meta")?.textContent,
        status:document.querySelector("#status")?.textContent,
        body:document.body.innerText.slice(0,1200)
      }));
      console.log("Chrome file-load diagnostic",JSON.stringify({diagnostic,pageErrors}));
      throw error;
    }
    const compatibility=await page.$eval("#lab-model-compatibility",node=>node.textContent);
    assert.match(compatibility,/0\.5〜2倍/);
    assert.match(compatibility,/A\/B/);
    assert.match(compatibility,/即時スクラブは未対応/);

    await page.evaluate(()=>document.querySelector("#play-wet").click());
    try{
      await page.waitForFunction(()=>document.querySelector("#rt-indicator")?.textContent
        .includes("モデル再生中")&&window.__labAudit.worklets.length===1,
        {timeout:20000});
    }catch(error){
      const diagnostic=await page.evaluate(()=>({
        indicator:document.querySelector("#rt-indicator")?.textContent,
        status:document.querySelector("#lab-status")?.textContent,
        file:document.querySelector("#file-meta")?.textContent,
        worklets:window.__labAudit.worklets,workers:window.__labAudit.workers,
        jobs:window.__labAudit.jobs.slice(-5),
        results:window.__labAudit.workerResults.slice(-5)
      }));
      console.log("Chrome playback-start diagnostic",JSON.stringify(diagnostic));
      throw error;
    }
    await page.waitForFunction(()=>window.__labAudit.messages.some(message=>
      message.type==="progress"&&message.processingMode==="worker"),
      {timeout:10000});
    await page.waitForFunction(()=>{
      const probe=window.__labAudit.probe;
      if(!probe)return false;
      const pcm=new Float32Array(probe.fftSize);probe.getFloatTimeDomainData(pcm);
      const rms=Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length);
      window.__labAudit.maxRms=Math.max(window.__labAudit.maxRms||0,rms);
      return window.__labAudit.maxRms>.01;
    },{timeout:5000});
    let evidence=await page.evaluate(()=>{
      const probe=window.__labAudit.probe;
      const pcm=new Float32Array(probe?.fftSize||0);
      probe?.getFloatTimeDomainData(pcm);
      return {
        worklets:window.__labAudit.worklets,
        workers:window.__labAudit.workers,
        jobs:window.__labAudit.jobs,
        bufferSources:window.__labAudit.bufferSources,
        rms:window.__labAudit.maxRms||
          (pcm.length?Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length):0),
        frames:window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker")
          .map(message=>message.sourceFrame),
        indicator:document.querySelector("#rt-indicator")?.textContent
      };
    });
    assert.equal(evidence.worklets.length,1,evidence);
    assert.equal(evidence.worklets[0].mode,"worker",evidence);
    assert.equal(evidence.workers.filter(url=>url.includes("lab-processor.worker")).length,1,evidence);
    assert.equal(evidence.bufferSources,0,evidence);
    assert.ok(evidence.rms>.01,evidence);
    assert.ok(evidence.frames.length>=2&&
      evidence.frames.at(-1)>evidence.frames[0],evidence);
    assert.match(evidence.jobs[0].model,/period-joint/);
    assert.equal(evidence.jobs[0].jointBackend,"pv");
    assert.ok(evidence.jobs.every(job=>job.coreFrames<=72000&&job.sourceFrames<200000),evidence.jobs);
    const loopControls=await page.evaluate(()=>({
      a:document.querySelector("#player-loop-a").disabled,
      b:document.querySelector("#player-loop-b").disabled,
      enabled:document.querySelector("#player-loop-enabled").disabled,
      aNow:document.querySelector("#player-loop-a-now").disabled,
      bNow:document.querySelector("#player-loop-b-now").disabled,
      hint:document.querySelector("#player-loop-hint").textContent
    }));
    assert.ok(loopControls.a&&loopControls.b&&loopControls.enabled&&
      loopControls.aNow&&loopControls.bNow,
      loopControls);
    assert.match(loopControls.hint,/Worker.*A\/B.*未対応/);
    const startupEvidence={...evidence};
    const startProgress=await page.evaluate(()=>{
      const progress=window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.processingMode==="worker").at(-1);
      return {sourceFrame:progress?.sourceFrame,missingFrames:progress?.missingFrames||0};
    });
    await new Promise(resolve=>setTimeout(resolve,5000));
    const steadyEvidence=await page.evaluate(()=>{
      const progress=window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.processingMode==="worker").at(-1);
      return {sourceFrame:progress?.sourceFrame,missingFrames:progress?.missingFrames||0};
    });
    assert.ok(steadyEvidence.sourceFrame>startProgress.sourceFrame,
      {startProgress,steadyEvidence});

    // Model and pitch/speed edits reset only the Worker generation. The same
    // Worklet remains the single source clock and applies each actual setting.
    await page.$eval("#granular-speed-value",node=>{
      node.value="1.33";node.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>window.__labAudit.messages.some(message=>
      message.type==="worker-state-accepted"&&message.speed===1.33),
      {timeout:10000});
    const speedGeneration=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="worker-state-accepted"&&
        message.speed===1.33).at(-1).generation);
    await page.waitForFunction(({generation,frame})=>window.__labAudit.messages.some(
      message=>message.type==="progress"&&
        message.workerGeneration===generation&&
        message.sourceFrame>frame+12000&&
        !Number.isInteger(message.sourceFrame)),
      {timeout:15000},{generation:speedGeneration,frame:steadyEvidence.sourceFrame});
    const fractionalProgress=await page.evaluate(generation=>{
      const messages=window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.workerGeneration===generation&&
        !Number.isInteger(message.sourceFrame));
      return messages.at(-1)?.sourceFrame;
    },speedGeneration);
    assert.ok(Number.isFinite(fractionalProgress),fractionalProgress);
    await page.$eval("#granular-pitch-value",node=>{
      node.value="2";node.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(generation=>window.__labAudit.messages.some(message=>
      message.type==="worker-state-accepted"&&message.pitchSemitones===2&&
      message.generation>generation),
      {timeout:10000},speedGeneration);
    const pitchAccepted=await page.evaluate(generation=>window.__labAudit.messages
      .filter(message=>message.type==="worker-state-accepted"&&
        message.pitchSemitones===2&&message.generation>generation).at(-1),
      speedGeneration);
    assert.ok(Math.abs(pitchAccepted.sourceFrame-fractionalProgress)<8192,
      JSON.stringify({fractionalProgress,pitchAccepted}));
    const backendPcmEvidence=[];
    let missingBeforeModel=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="progress"&&
        message.processingMode==="worker").at(-1)?.missingFrames||0);
    await page.$eval("#lab-model",node=>{
      node.value="wsola";node.dispatchEvent(new Event("change",{bubbles:true}));
    });
    backendPcmEvidence.push(await waitForWorkerPCM(page,{backend:"wsola",
      minimumGeneration:0,missingBeforeFrames:missingBeforeModel}));
    for(const model of ["dual","am"]){
      missingBeforeModel=await page.evaluate(()=>window.__labAudit.messages
        .filter(message=>message.type==="progress"&&
          message.processingMode==="worker").at(-1)?.missingFrames||0);
      await page.$eval("#lab-model",(node,value)=>{
        node.value=value;node.dispatchEvent(new Event("change",{bubbles:true}));
      },model);
      backendPcmEvidence.push(await waitForWorkerPCM(page,{backend:model,
        minimumGeneration:0,missingBeforeFrames:missingBeforeModel}));
    }
    evidence=await page.evaluate(()=>({
      worklets:window.__labAudit.worklets,
      workletStates:window.__labAudit.messages.filter(message=>
        message.type==="worker-state-accepted"),
      retainedBackendJobs:window.__labAudit.jobs.filter(job=>
        ["pv","wsola","dual","am"].includes(job.jointBackend)),
      successfulBackendJobs:window.__labAudit.workerResults.map(result=>({
        ...result,job:window.__labAudit.jobs.find(item=>item.job===result.job)
      })).filter(result=>result.ok&&["pv","wsola","dual","am"]
        .includes(result.job?.jointBackend)),
      maxMissingFrames:Math.max(0,...window.__labAudit.messages
        .filter(message=>message.type==="progress"&&message.processingMode==="worker")
        .map(message=>message.missingFrames||0)),
      buffers:window.__labAudit.bufferSources,
      status:document.querySelector("#lab-status")?.textContent
    }));
    assert.equal(evidence.worklets.length,1,evidence);
    assert.equal(evidence.buffers,0,evidence);
    assert.ok(evidence.workletStates.length>=5,evidence);
    for(const model of ["pv","wsola","dual","am"])
      assert.ok(evidence.retainedBackendJobs.some(job=>job.jointBackend===model),
        {model,evidence});
    assert.deepEqual([...new Set(evidence.successfulBackendJobs
      .map(result=>result.job.jointBackend))].sort(),
      ["am","dual","pv","wsola"],evidence.successfulBackendJobs);
    assert.ok(backendPcmEvidence.every(item=>item.accepted&&
      item.peakRms>.01&&item.advanceFrames>0),backendPcmEvidence);
    if(evidence.maxMissingFrames>0)
      assert.match(evidence.status,/欠落PCMを記録しました/);

    await page.$eval("#wave",canvas=>canvas.scrollIntoView({block:"center"}));
    const missingBeforeSeek=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="progress"&&
        message.processingMode==="worker").at(-1)?.missingFrames||0);
    const wave=await page.$eval("#wave",canvas=>{
      const rect=canvas.getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
    });
    await page.mouse.click(wave.x+wave.width*.75,wave.y+wave.height/2);
    await page.waitForFunction(()=>window.__labAudit.messages.some(message=>
      message.type==="worker-state-accepted"&&
      Math.abs(message.sourceFrame-216000)<=100),{timeout:10000});
    const seekGeneration=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="worker-state-accepted"&&
        Math.abs(message.sourceFrame-216000)<=100).at(-1).generation);
    const seekPcmEvidence=await waitForWorkerPCM(page,{generation:seekGeneration,
      missingBeforeFrames:missingBeforeSeek});
    const missingBeforeLoop=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="progress"&&
        message.processingMode==="worker").at(-1)?.missingFrames||0);
    await page.mouse.click(wave.x+wave.width*.98,wave.y+wave.height/2);
    await page.waitForFunction(generation=>window.__labAudit.messages.some(message=>
      message.type==="worker-state-accepted"&&message.generation>generation&&
      Math.abs(message.sourceFrame-282240)<=100),
      {timeout:10000},seekGeneration);
    const loopGeneration=await page.evaluate(()=>window.__labAudit.messages
      .filter(message=>message.type==="worker-state-accepted"&&
        Math.abs(message.sourceFrame-282240)<=100).at(-1).generation);
    await page.waitForFunction(generation=>{
      const progress=window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.workerGeneration===generation);
      const endIndex=progress.findIndex(message=>message.sourceFrame>287000);
      const wrapped=endIndex>=0&&progress.slice(endIndex+1).some(message=>
        message.sourceFrame<4096);
      if(!wrapped)return false;
      const probe=window.__labAudit.probe,pcm=new Float32Array(probe?.fftSize||0);
      if(!probe||!pcm.length)return false;
      probe.getFloatTimeDomainData(pcm);
      return Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/pcm.length)>.01;
    },{timeout:15000},loopGeneration);
    const loopWrapEvidence=await page.evaluate((generation,missingBefore)=>{
      const progress=window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.workerGeneration===generation);
      const endIndex=progress.findIndex(message=>message.sourceFrame>287000);
      const nearEnd=progress[endIndex],afterWrap=progress.slice(endIndex+1)
        .find(message=>message.sourceFrame<4096);
      return {generation,nearEndFrame:nearEnd?.sourceFrame,
        afterWrapFrame:afterWrap?.sourceFrame,
        missingFrames:(afterWrap?.missingFrames||0)-missingBefore};
    },loopGeneration,missingBeforeLoop);
    assert.ok(loopWrapEvidence.nearEndFrame>287000&&
      loopWrapEvidence.afterWrapFrame<4096,loopWrapEvidence);

    // A decode failure must leave the current Worker audio stream and source
    // file intact so the listener can resume without reselecting it.
    await page.evaluate(()=>{
      const broken=new File([Uint8Array.from([1,2,3,4])],"broken.wav",{type:"audio/wav"});
      const transfer=new DataTransfer();transfer.items.add(broken);
      const input=document.querySelector("#audio-file");input.files=transfer.files;
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#status")?.textContent
      .includes("以前の音声は保持しています"),{timeout:10000});
    const recovery=await page.evaluate(()=>({
      file:document.querySelector("#file-meta")?.textContent,
      worklets:window.__labAudit.worklets,
      status:document.querySelector("#status")?.textContent,
      sourceFrames:window.__labAudit.messages.filter(message=>
        message.type==="progress"&&message.processingMode==="worker")
        .map(message=>message.sourceFrame)
    }));
    assert.match(recovery.file,/worker-source-tone\.wav/);
    assert.equal(recovery.worklets.length,1,recovery);
    assert.deepEqual(pageErrors,[]);
    console.log("Chrome legacy Worker PCM evidence",JSON.stringify({
      startup:{mode:startupEvidence.worklets[0]?.mode,
        workerCount:startupEvidence.workers.filter(url=>
          url.includes("lab-processor.worker")).length,
        firstOutputRms:startupEvidence.rms,
        sourceFrameStart:startupEvidence.frames[0],
        sourceFrameEnd:startupEvidence.frames.at(-1),
        firstModel:startupEvidence.jobs[0]?.jointBackend},
      selectedDSPs:["pv","wsola","dual","am"],
      successfulDSPs:[...new Set(evidence.successfulBackendJobs
        .map(result=>result.job.jointBackend))],
      steadyFiveSeconds:{sourceFramesAdvanced:
        steadyEvidence.sourceFrame-startProgress.sourceFrame,
        missingOutputFrames:steadyEvidence.missingFrames-startProgress.missingFrames},
      backendPcmEvidence,seekPcmEvidence,loopWrapEvidence,
      workerRenderMs:["pv","wsola","dual","am"].map(backend=>{
        const samples=evidence.successfulBackendJobs.filter(result=>
          result.job.jointBackend===backend).map(result=>
          Math.round(result.receivedAt-result.job.sentAt)).sort((a,b)=>a-b);
        return {backend,jobs:samples.length,
          medianMs:samples[Math.floor(samples.length/2)],
          maxMs:samples.at(-1)};
      }),
      generationUpdates:evidence.workletStates.length,
      maxObservedUnderrunFrames:evidence.maxMissingFrames,
      seekFrame:recovery.sourceFrames.at(-1),
      failedReplacementRetainedSource:recovery.file,
      workletCountAfterRecovery:recovery.worklets.length
    }));
    await page.evaluate(()=>document.querySelector("#stop").click());
  }finally{
    if(browser)await browser.close();
    server.kill();
  }
});
