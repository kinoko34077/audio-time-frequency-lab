import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {closeBrowserTree} from "./test-process-cleanup.mjs";
import {installTestAudioSilenceGuard} from "./test-audio-silence-guard.mjs";

const CONTENT_TYPES={
  ".css":"text/css; charset=utf-8",
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".mjs":"text/javascript; charset=utf-8",
  ".svg":"image/svg+xml",
  ".wasm":"application/wasm"
};

function startStaticServer(root){
  const server=createServer(async(request,response)=>{
    try{
      const pathname=decodeURIComponent(new URL(request.url,
        "http://127.0.0.1").pathname);
      const file=path.resolve(root,"."+pathname);
      if(file!==root&&!file.startsWith(root+path.sep)){
        response.writeHead(403).end();return;
      }
      const content=await readFile(file);
      response.writeHead(200,{"content-type":
        CONTENT_TYPES[path.extname(file)]||"application/octet-stream"});
      response.end(content);
    }catch{
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      server.removeListener("error",reject);
      resolve({server,port:server.address().port});
    });
  });
}

async function closeServer(server){
  if(!server?.listening)return;
  await new Promise((resolve,reject)=>server.close(error=>
    error?reject(error):resolve()));
  server.closeAllConnections?.();
}

test("individual-period Worker applies and wraps edited source-frame A/B without PCM gaps",
  {timeout:90000},async()=>{
    const root=path.resolve("web-demo");
    const {server,port}=await startStaticServer(root);
    let browser;
    try{
      browser=await puppeteer.launch({
        executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
        headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
          "--mute-audio","--autoplay-policy=no-user-gesture-required"]
      });
      const page=await browser.newPage();
      const errors=[];
      page.on("pageerror",error=>errors.push(error.message));
      page.on("console",message=>{
        if(message.type()==="error"&&!message.text().startsWith(
          "Failed to load resource: the server responded with a status of 404"))
          errors.push(message.text());
      });
      await page.evaluateOnNewDocument(guardSource=>{
        const audit={messages:[],jobs:[],results:[],worklets:[],workers:[],
          commands:[],
          probe:null,mutedOutputRoutes:0,audioOutputMuteGain:null,
          audioOutputMuteGains:[]};
        Object.defineProperty(window,"__labAudit",{value:audit});
        (0,eval)(`(${guardSource})`)(window,audit);
        const nativePortPostMessage=MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage=function(message,...args){
          if(message?.type==="worker-seek-stage")
            audit.commands.push({type:message.type,frame:message.frame,
              generation:message.generation,requestId:message.requestId,
              requiredChunks:message.requiredChunks,
              loopStartFrame:message.loopStartFrame,
              loopEndFrame:message.loopEndFrame,
              loopEnabled:message.loopEnabled});
          return nativePortPostMessage.call(this,message,...args);
        };
        const NativeWorklet=window.AudioWorkletNode;
        const guardedConnect=NativeWorklet.prototype.connect;
        NativeWorklet.prototype.connect=function(destination,...args){
          const result=guardedConnect.call(this,destination,...args);
          if(this.__labWorkerMode&&!this.__labProbe){
            const analyser=this.context.createAnalyser();
            analyser.fftSize=2048;
            const mute=this.context.createGain();mute.gain.value=0;
            guardedConnect.call(this,analyser);
            analyser.connect(mute);mute.connect(this.context.destination);
            this.__labProbe=true;audit.probe=analyser;
          }
          return result;
        };
        window.AudioWorkletNode=class extends NativeWorklet{
          constructor(context,name,options){
            super(context,name,options);
            audit.audioContext=context;
            this.__labWorkerMode=
              options?.processorOptions?.processingMode==="worker";
            audit.worklets.push({name,mode:
              options?.processorOptions?.processingMode||"raw"});
            this.port.addEventListener("message",event=>audit.messages.push({
              ...(event.data||{}),receivedAt:performance.now(),
              audioTime:context.currentTime
            }));
            this.port.start();
          }
        };
        const NativeWorker=window.Worker;
        window.Worker=class extends NativeWorker{
          constructor(url,options){
            super(url,options);this.__url=String(url);
            audit.workers.push(this.__url);
            this.addEventListener("message",event=>audit.results.push({
              job:event.data?.job,generation:event.data?.generation,
              ok:event.data?.ok,receivedAt:performance.now(),
              workerElapsedMs:event.data?.workerElapsedMs
            }));
          }
          postMessage(payload,...args){
            if(this.__url.includes("lab-processor.worker"))
              audit.jobs.push({job:payload.job,generation:payload.generation,
                model:payload.model,backend:payload.jointBackend,
                start:payload.plan?.start,end:payload.plan?.start+
                  payload.plan?.core,loopStartFrame:payload.plan?.loopStartFrame,
                loopEndFrame:payload.plan?.loopEndFrame,
                sourceStartFrame:payload.plan?.sourceStartFrame,
                loopEnabled:payload.plan?.loopEnabled,
                wrapLeft:payload.plan?.wrapLeft,wrapRight:payload.plan?.wrapRight});
            return super.postMessage(payload,...args);
          }
        };
      },installTestAudioSilenceGuard.toString());
      await page.goto(`http://127.0.0.1:${port}/index.html`,{
        waitUntil:"domcontentloaded",timeout:20000
      });
      await page.waitForFunction(()=>
        document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
      await page.evaluate(async()=>{
        const model=document.querySelector("#lab-model");
        model.value="pv";model.dispatchEvent(new Event("change",{bubbles:true}));
        const individual=document.querySelector("#lab-individual-periods");
        individual.checked=true;
        individual.dispatchEvent(new Event("change",{bubbles:true}));
        // Keep playback well away from EOF while the test exercises several
        // loop edits and the loop-off continuation path.
        const sampleRate=48000,frames=sampleRate*30;
        const bytes=new ArrayBuffer(44+frames*2),view=new DataView(bytes);
        view.setUint32(0,0x46464952,true);view.setUint32(4,bytes.byteLength-8,true);
        view.setUint32(8,0x45564157,true);view.setUint32(12,0x20746d66,true);
        view.setUint32(16,16,true);view.setUint16(20,1,true);
        view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);
        view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);
        view.setUint16(34,16,true);view.setUint32(36,0x61746164,true);
        view.setUint32(40,frames*2,true);
        for(let i=0;i<frames;i++)
          view.setInt16(44+i*2,Math.round(.2*Math.sin(
            2*Math.PI*440*i/sampleRate)*32767),true);
        const file=new File([bytes],"ab-loop-source.wav",{type:"audio/wav"});
        const transfer=new DataTransfer();transfer.items.add(file);
        const input=document.querySelector("#audio-file");
        input.files=transfer.files;input.dispatchEvent(new Event("change",
          {bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
        .includes("ab-loop-source.wav")&&
        !document.querySelector("#file-meta").textContent.includes("読み込み中"),
        {timeout:15000});
      await page.evaluate(()=>document.querySelector("#play-wet").click());
      await page.waitForFunction(()=>window.__labAudit.worklets.some(item=>
        item.mode==="worker")&&window.__labAudit.messages.some(message=>
        message.type==="progress"&&message.processingMode==="worker"),
        {timeout:15000});
      const before=await page.evaluate(()=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker").at(-1);
        const probe=audit.probe,pcm=new Float32Array(probe?.fftSize||0);
        probe?.getFloatTimeDomainData(pcm);
        return {sampleRate:audit.audioContext?.sampleRate,
          sourceFrame:progress?.sourceFrame,
          missingFrames:progress?.missingFrames||0,
          worklets:audit.worklets.length,model:document.querySelector("#lab-model")?.value,
          rms:Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/
            Math.max(1,pcm.length))};
      });
      assert.equal(before.worklets,1,before);
      assert.equal(before.model,"pv",before);
      assert.ok(before.rms>.01,before);
      const a=before.sampleRate*2,b=before.sampleRate*4;
      await page.evaluate(({a,b})=>{
        for(const [edge,value] of [["a",a],["b",b]]){
          const input=document.querySelector("#player-loop-"+edge);
          input.value=String(value);
          input.dispatchEvent(new Event("change",{bubbles:true}));
        }
      },{a,b});
      try{
        await page.waitForFunction(({a,b})=>{
          const hint=document.querySelector("#player-loop-hint")?.textContent||"";
          const progress=window.__labAudit.messages.some(message=>
            message.type==="progress"&&message.processingMode==="worker"&&
            message.loopEnabled&&message.loopStartFrame===a&&
            message.loopEndFrame===b);
          return hint.includes("反映しました")&&progress;
        },{timeout:20000},{a,b});
      }catch(error){
        const diagnostic=await page.evaluate(({a,b,errors})=>{
          const audit=window.__labAudit;
          return {hint:document.querySelector("#player-loop-hint")?.textContent,
            status:document.querySelector("#lab-status")?.textContent,
            progress:audit.messages.filter(message=>
              message.type==="progress"&&message.processingMode==="worker")
              .slice(-8),
            states:audit.messages.filter(message=>
              message.type.includes("worker-state")).slice(-8),
            jobs:audit.jobs.slice(-8),errors};
        },{a,b,errors});
        throw Error("A/B configuration did not reach the Worker PCM clock: "+
          JSON.stringify(diagnostic),{cause:error});
      }
      const applied=await page.evaluate(({a,b,beforeMissing})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        return {generation,sourceFrame:progress.at(-1)?.sourceFrame,
          missingFrames:(progress.at(-1)?.missingFrames||0)-beforeMissing,
          jobs:audit.jobs.filter(job=>job.generation===generation&&
            job.loopEnabled&&job.loopStartFrame===a&&job.loopEndFrame===b)};
      },{a,b,beforeMissing:before.missingFrames});
      assert.ok(applied.jobs.some(job=>job.start>=a&&job.end===b&&
        job.wrapRight>0),applied);
      await page.waitForFunction(({a,b,generation})=>{
        const progress=window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.workerGeneration===generation&&message.loopEnabled&&
          message.loopStartFrame===a&&message.loopEndFrame===b);
        return progress.some((message,index)=>index>0&&
          message.sourceFrame<a+4096&&progress[index-1].sourceFrame>b-4096);
      },{timeout:12000},{a,b,generation:applied.generation});
      const wrap=await page.evaluate(({a,b,generation,beforeMissing})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.workerGeneration===generation&&message.loopEnabled&&
          message.loopStartFrame===a&&message.loopEndFrame===b);
        const index=progress.findIndex((message,i)=>i>0&&
          message.sourceFrame<a+4096&&progress[i-1].sourceFrame>b-4096);
        const probe=audit.probe,pcm=new Float32Array(probe?.fftSize||0);
        probe?.getFloatTimeDomainData(pcm);
        return {from:progress[index-1]?.sourceFrame,to:progress[index]?.sourceFrame,
          missingFrames:(progress.at(-1)?.missingFrames||0)-beforeMissing,
          rms:Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/
            Math.max(1,pcm.length)),worklets:audit.worklets.length,
          muteGains:audit.audioOutputMuteGains};
      },{a,b,generation:applied.generation,beforeMissing:before.missingFrames});
      assert.ok(wrap.from>b-4096&&wrap.to<a+4096,wrap);
      assert.equal(wrap.missingFrames,0,wrap);
      assert.ok(wrap.rms>.01,wrap);
      assert.equal(wrap.worklets,1,wrap);
      assert.ok(wrap.muteGains.length>0&&wrap.muteGains.every(gain=>gain===0),wrap);
      await page.evaluate(()=>{
        const loop=document.querySelector("#player-loop-enabled");
        loop.checked=false;loop.dispatchEvent(new Event("change",{bubbles:true}));
      });
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        const progress=window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          !message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        return hint.includes("反映しました")&&progress.some(message=>
          message.sourceFrame>=b);
      },{timeout:12000},{a,b});
      const disabled=await page.evaluate(({a,b,missingBefore})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          !message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const probe=audit.probe,pcm=new Float32Array(probe?.fftSize||0);
        probe?.getFloatTimeDomainData(pcm);
        return {sourceFrame:progress.at(-1)?.sourceFrame,
          missingFrames:(progress.at(-1)?.missingFrames||0)-missingBefore,
          worklets:audit.worklets.length,model:document.querySelector("#lab-model")?.value,
          rms:Math.sqrt(pcm.reduce((sum,value)=>sum+value*value,0)/
            Math.max(1,pcm.length))};
      },{a,b,missingBefore:wrap.missingFrames+before.missingFrames});
      assert.ok(disabled.sourceFrame>=b,disabled);
      assert.equal(disabled.missingFrames,0,disabled);
      assert.equal(disabled.worklets,1,disabled);
      assert.equal(disabled.model,"pv",disabled);
      assert.ok(disabled.rms>.01,disabled);

      const nearStartA=96,nearStartB=12000;
      await page.evaluate(({a,b})=>{
        for(const [edge,value] of [["a",a],["b",b]]){
          const input=document.querySelector("#player-loop-"+edge);
          input.value=String(value);
          input.dispatchEvent(new Event("change",{bubbles:true}));
        }
      },{a:nearStartA,b:nearStartB});
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        const progress=window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          !message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        return hint.includes("反映しました")&&progress;
      },{timeout:12000},{a:nearStartA,b:nearStartB});
      const missingBeforeNearStart=await page.evaluate(()=>window.__labAudit.messages
        .filter(message=>message.type==="progress"&&
          message.processingMode==="worker").at(-1)?.missingFrames||0);
      await page.evaluate(()=>{
        const loop=document.querySelector("#player-loop-enabled");
        loop.checked=true;loop.dispatchEvent(new Event("change",{bubbles:true}));
      });
      try{
        await page.waitForFunction(({a,b})=>{
          const hint=document.querySelector("#player-loop-hint")?.textContent||"";
          const progress=window.__labAudit.messages.filter(message=>
            message.type==="progress"&&message.processingMode==="worker"&&
            message.loopEnabled&&message.loopStartFrame===a&&
            message.loopEndFrame===b);
          return hint.includes("反映しました")&&progress.length>0;
        },{timeout:12000},{a:nearStartA,b:nearStartB});
      }catch(error){
        const snapshot=await page.evaluate(()=>{
          const audit=window.__labAudit;
          const compact=message=>Object.fromEntries(Object.entries(message)
            .filter(([key])=>["type","processingMode","sourceFrame",
              "loopStartFrame","loopEndFrame","loopEnabled","generation",
              "workerGeneration","missingFrames","revision","text","error"]
              .includes(key)));
          return {hint:document.querySelector("#player-loop-hint")?.textContent,
            checkbox:document.querySelector("#player-loop-enabled")?.checked,
            recentMessages:audit.messages.slice(-12).map(compact),
            recentJobs:audit.jobs.slice(-6),recentResults:audit.results.slice(-6)};
        });
        error.message+=`\nA/B enable state: ${JSON.stringify(snapshot)}`;
        throw error;
      }
      await page.waitForFunction(({a,b})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        const job=audit.jobs.findLast(item=>item.generation===generation&&
          item.loopEnabled&&item.loopStartFrame===a&&item.loopEndFrame===b&&
          item.start===a);
        return Boolean(job&&audit.results.some(item=>item.job===job.job&&
          item.generation===generation));
      },{timeout:12000},{a:nearStartA,b:nearStartB});
      const nearStart=await page.evaluate(({a,b,missingBefore})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        const job=audit.jobs.findLast(item=>item.generation===generation&&
          item.loopEnabled&&item.loopStartFrame===a&&item.loopEndFrame===b&&
          item.start===a);
        const result=job&&audit.results.findLast(item=>item.job===job.job&&
          item.generation===generation);
        return {generation,sourceFrame:progress.at(-1)?.sourceFrame,
          missingFrames:(progress.at(-1)?.missingFrames||0)-missingBefore,
          job,result,model:document.querySelector("#lab-model")?.value,
          worklets:audit.worklets.length};
      },{a:nearStartA,b:nearStartB,missingBefore:missingBeforeNearStart});
      assert.ok(nearStart.job?.sourceStartFrame<0,JSON.stringify(nearStart));
      assert.equal(nearStart.result?.ok,true,JSON.stringify(nearStart));
      assert.equal(nearStart.missingFrames,0,JSON.stringify(nearStart));
      assert.equal(nearStart.model,"pv",JSON.stringify(nearStart));
      assert.equal(nearStart.worklets,1,JSON.stringify(nearStart));

      const shiftedA=4096,shortB=12000;
      await page.evaluate(a=>{
        const input=document.querySelector("#player-loop-a");
        input.value=String(a);input.dispatchEvent(new Event("change",
          {bubbles:true}));
      },shiftedA);
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        return hint.includes("反映しました")&&window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
      },{timeout:20000},{a:shiftedA,b:shortB});
      await page.waitForFunction(({a,b})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        const job=audit.jobs.findLast(item=>item.generation===generation&&
          item.loopEnabled&&item.loopStartFrame===a&&item.loopEndFrame===b&&
          item.start===a);
        return Boolean(job&&audit.results.some(item=>item.job===job.job&&
          item.generation===generation&&item.ok===true));
      },{timeout:15000},{a:shiftedA,b:shortB});
      const shiftedLoop=await page.evaluate(({a,b})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        const job=audit.jobs.findLast(item=>item.generation===generation&&
          item.loopEnabled&&item.loopStartFrame===a&&item.loopEndFrame===b&&
          item.start===a);
        const result=job&&audit.results.findLast(item=>item.job===job.job&&
          item.generation===generation);
        return {generation,sourceFrame:progress.at(-1)?.sourceFrame,
          missingFrames:progress.at(-1)?.missingFrames||0,job,result,
          worklets:audit.worklets.length};
      },{a:shiftedA,b:shortB});
      assert.equal(shiftedLoop.result?.ok,true,JSON.stringify(shiftedLoop));
      assert.ok(shiftedLoop.sourceFrame>=shiftedA&&
        shiftedLoop.sourceFrame<shortB,JSON.stringify(shiftedLoop));
      assert.equal(shiftedLoop.missingFrames,0,JSON.stringify(shiftedLoop));
      assert.equal(shiftedLoop.worklets,1,JSON.stringify(shiftedLoop));

      const extendedB=20000;
      await page.evaluate(b=>{
        const input=document.querySelector("#player-loop-b");
        input.value=String(b);input.dispatchEvent(new Event("change",
          {bubbles:true}));
      },extendedB);
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        return hint.includes("反映しました")&&window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
      },{timeout:20000},{a:shiftedA,b:extendedB});
      const extendedLoop=await page.evaluate(({a,b})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        const job=audit.jobs.findLast(item=>item.generation===generation&&
          item.loopEnabled&&item.loopStartFrame===a&&item.loopEndFrame===b&&
          item.start===12000&&item.end===b);
        return {generation,sourceFrame:progress.at(-1)?.sourceFrame,
          missingFrames:progress.at(-1)?.missingFrames||0,job,
          worklets:audit.worklets.length};
      },{a:shiftedA,b:extendedB});
      assert.ok(extendedLoop.job,JSON.stringify(extendedLoop));
      assert.equal(extendedLoop.missingFrames,0,JSON.stringify(extendedLoop));
      assert.equal(extendedLoop.worklets,1,JSON.stringify(extendedLoop));
      await page.waitForFunction(({a,b,generation})=>{
        const progress=window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.workerGeneration===generation&&message.loopEnabled&&
          message.loopStartFrame===a&&message.loopEndFrame===b);
        return progress.some((message,index)=>index>0&&
          message.sourceFrame<a+4096&&progress[index-1].sourceFrame>b-4096);
      },{timeout:15000},{a:shiftedA,b:extendedB,
        generation:extendedLoop.generation});

      const totalFrames=before.sampleRate*30;
      const terminalA=totalFrames-12000;
      await page.evaluate(b=>{
        const input=document.querySelector("#player-loop-b");
        input.value=String(b);input.dispatchEvent(new Event("change",
          {bubbles:true}));
      },totalFrames);
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        return hint.includes("反映しました")&&window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
      },{timeout:20000},{a:shiftedA,b:totalFrames});
      await page.evaluate(a=>{
        const input=document.querySelector("#player-loop-a");
        input.value=String(a);input.dispatchEvent(new Event("change",
          {bubbles:true}));
      },terminalA);
      await page.waitForFunction(({a,b})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        const generation=progress.at(-1)?.workerGeneration;
        return document.querySelector("#player-loop-hint")?.textContent
          .includes("反映しました")&&audit.jobs.some(job=>
            job.generation===generation&&job.start===a&&job.end===b&&
            audit.results.some(result=>result.job===job.job&&
              result.generation===generation&&result.ok===true));
      },{timeout:20000},{a:terminalA,b:totalFrames});
      const terminalLoopBefore=await page.evaluate(()=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker").at(-1);
        return {generation:progress?.workerGeneration,
          missingFrames:progress?.missingFrames||0,
          worklets:audit.worklets.length};
      });
      await page.evaluate(()=>{
        const loop=document.querySelector("#player-loop-enabled");
        loop.checked=false;
        loop.dispatchEvent(new Event("change",{bubbles:true}));
      });
      await page.waitForFunction(({a,b,generation})=>{
        const audit=window.__labAudit;
        const activated=audit.messages.some(message=>
          message.type==="worker-state-activated"&&
          message.generation>generation);
        const progress=audit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          !message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b);
        return !document.querySelector("#player-loop-enabled")?.checked&&
          activated&&progress&&document.querySelector("#player-loop-hint")
            ?.textContent.includes("反映しました");
      },{timeout:12000},{a:terminalA,b:totalFrames,
        generation:terminalLoopBefore.generation});
      const terminalGeneration=await page.evaluate(()=>{
        const event=window.__labAudit.messages.filter(message=>
          message.type==="worker-state-activated").at(-1);
        return event?.generation;
      });
      assert.equal(await page.evaluate(generation=>window.__labAudit.jobs.some(job=>
        job.generation===generation),terminalGeneration),false,
        "disabling a loop at EOF must not render a replacement chunk from A");
      assert.equal(await page.evaluate(()=>window.__labAudit.worklets.length),
        terminalLoopBefore.worklets,
        "terminal loop-off keeps the existing source-clock Worklet");
      await page.waitForFunction(({end,missingBefore})=>{
        const progress=window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker");
        const atEnd=progress.filter(message=>message.sourceFrame===end);
        return atEnd.length>0&&atEnd.at(-1).missingFrames===missingBefore&&
          progress.slice(progress.lastIndexOf(atEnd[0])).every(message=>
            message.sourceFrame===end);
      },{timeout:12000},{end:totalFrames,
        missingBefore:terminalLoopBefore.missingFrames});

      const missingBeforeEndSeek=await page.evaluate(()=>
        window.__labAudit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker")
          .at(-1)?.missingFrames||0);
      await page.focus("#wave-detail");
      await page.keyboard.press("End");
      await page.waitForFunction(({end,generation})=>
        window.__labAudit.commands.some(command=>
          command.type==="worker-seek-stage"&&
          command.generation>generation&&command.frame===end-1),
        {timeout:12000},{end:totalFrames,
          generation:terminalGeneration});
      const endSeek=await page.evaluate(generation=>
        window.__labAudit.commands.findLast(command=>
          command.type==="worker-seek-stage"&&
          command.generation>generation),terminalGeneration);
      assert.equal(endSeek.frame,totalFrames-1,JSON.stringify(endSeek));
      assert.equal(endSeek.requiredChunks,1,
        "the final unlooped seek requests only its available terminal chunk");
      await page.waitForFunction(({generation,frame,missingBefore})=>
        window.__labAudit.messages.some(message=>
          message.type==="worker-state-activated"&&
          message.generation===generation&&message.sourceFrame===frame&&
          message.missingFrames===missingBefore),
        {timeout:12000},{generation:endSeek.generation,
          frame:totalFrames-1,missingBefore:missingBeforeEndSeek});

      await page.waitForFunction(({end,generation})=>
        window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.workerGeneration===generation&&!message.loopEnabled&&
          message.sourceFrame===end),
        {timeout:12000},{end:totalFrames,generation:endSeek.generation});
      const editedTerminalA=terminalA+1200;
      await page.evaluate(a=>{
        const input=document.querySelector("#player-loop-a");
        input.value=String(a);input.dispatchEvent(new Event("change",
          {bubbles:true}));
      },editedTerminalA);
      await page.waitForFunction(({a,b})=>
        document.querySelector("#player-loop-hint")?.textContent
          .includes("反映しました")&&window.__labAudit.messages.some(message=>
            message.type==="progress"&&message.processingMode==="worker"&&
            !message.loopEnabled&&message.loopStartFrame===a&&
            message.loopEndFrame===b),
        {timeout:12000},{a:editedTerminalA,b:totalFrames});
      const beforeReenable=await page.evaluate(()=>window.__labAudit.messages
        .filter(message=>message.type==="progress"&&
          message.processingMode==="worker").at(-1)?.workerGeneration||0);
      await page.evaluate(()=>{
        const loop=document.querySelector("#player-loop-enabled");
        loop.checked=true;
        loop.dispatchEvent(new Event("change",{bubbles:true}));
        const wave=document.querySelector("#wave-detail");
        wave.focus();
        wave.dispatchEvent(new KeyboardEvent("keydown",{
          key:"End",bubbles:true,cancelable:true
        }));
      });
      const seekDuringLoopStageHandle=await page.waitForFunction(({a,b,generation})=>
        window.__labAudit.commands.findLast(command=>
          command.type==="worker-seek-stage"&&
          command.generation>generation&&command.loopEnabled===true&&
          command.loopStartFrame===a&&command.loopEndFrame===b),
        {timeout:12000},{a:editedTerminalA,b:totalFrames,
          generation:beforeReenable});
      const seekDuringLoopStage=await seekDuringLoopStageHandle.jsonValue();
      assert.equal(seekDuringLoopStage.frame,totalFrames-1,
        JSON.stringify(seekDuringLoopStage));
      assert.equal(seekDuringLoopStage.requiredChunks,2,
        "a short terminal seek prepares both the terminal and wrapped A/B chunks");
      await page.waitForFunction(({a,b,generation})=>{
        const audit=window.__labAudit;
        const progress=audit.messages.filter(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.loopEnabled&&message.loopStartFrame===a&&
          message.loopEndFrame===b&&
          message.workerGeneration===generation);
        const current=progress.at(-1);
        return current&&audit.jobs.some(job=>job.generation===current.workerGeneration&&
          job.start===a&&job.end===b&&audit.results.some(result=>
            result.job===job.job&&result.generation===job.generation&&
            result.ok===true))&&document.querySelector("#player-loop-hint")
              ?.textContent.includes("反映しました");
      },{timeout:20000},{a:editedTerminalA,b:totalFrames,
        generation:seekDuringLoopStage.generation});
      await page.waitForFunction(({a,generation})=>
        window.__labAudit.messages.some(message=>
          message.type==="progress"&&message.processingMode==="worker"&&
          message.workerGeneration===generation&&message.loopEnabled&&
          message.sourceFrame<a+4096),
        {timeout:12000},{a:editedTerminalA,
          generation:seekDuringLoopStage.generation});

      assert.deepEqual(errors,[]);
      await page.evaluate(()=>document.querySelector("#stop").click());
    }finally{
      const cleanup=await Promise.allSettled([
        closeBrowserTree(browser),closeServer(server)
      ]);
      const failures=cleanup.filter(result=>result.status==="rejected")
        .map(result=>result.reason);
      if(failures.length)throw new AggregateError(failures,
        "A/B browser test cleanup failed");
    }
  });
