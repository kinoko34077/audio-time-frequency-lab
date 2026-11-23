import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";
import {installTestAudioSilenceGuard} from "./test-audio-silence-guard.mjs";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const pythonCommand=process.env.PYTHON||"python3";
const webRoot=path.resolve(process.env.WARP_WEB_ROOT||"_site");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// End-to-end R2/R3 observation: use the published player, not a laboratory
// function call. A unity AnalyserNode is inserted immediately BEFORE the
// AudioContext destination, so these are actual rendered output samples
// rather than a command-accepted or render-applied UI receipt.
// This does not measure a phone DAC or certify perceptual fidelity.
test("recorded piano main player: gesture/parameter receipts AND actual output PCM",async()=>{
  const port=18791;
  const server=spawn(pythonCommand,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:webRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.evaluateOnNewDocument(guardSource=>{
      const audit={mutedOutputRoutes:0,audioOutputMuteGain:null,
        audioOutputMuteGains:[]};
      window.__audioSilenceAudit=audit;
      (0,eval)(`(${guardSource})`)(window,audit);
      const nativeConnect=AudioNode.prototype.connect;
      window.__audioOutputPaths=[];
      AudioNode.prototype.connect=function(destination,...rest){
        const direct=destination===this.context.destination;
        const media=(typeof MediaStreamAudioDestinationNode!=="undefined"&&
          destination instanceof MediaStreamAudioDestinationNode);
        if(direct||media){
          // Audio Lab routes EITHER to AudioContext.destination OR via an
          // HTMLMediaElement backed by MediaStreamAudioDestinationNode.
          // Observing only the first route incorrectly reports silence after
          // the production media route becomes active.
          const analyser=this.context.createAnalyser();
          analyser.fftSize=2048;
          nativeConnect.call(this,analyser,...rest);
          nativeConnect.call(analyser,destination);
          window.__audioOutputPaths.push({kind:media?"media":"direct",analyser});
          return destination;
        }
        return nativeConnect.call(this,destination,...rest);
      };
    },installTestAudioSilenceGuard.toString());
    await page.goto("http://127.0.0.1:"+port+"/?legacyUi=1",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await (await page.$("#audio-file")).uploadFile(WAV);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
    assert.equal(await page.$eval("#lab-model",el=>el.value),"pv",
      "public Audio Time must select the actual Phase Vocoder renderer by default");
    const speedRails=await page.evaluate(()=>({
      railValue:document.querySelector("#granular-range").value,
      railOptions:[...document.querySelector("#granular-range").options].map(option=>option.value),
      min:document.querySelector("#granular-speed").min,
      max:document.querySelector("#granular-speed").max,
      preciseMin:document.querySelector("#granular-speed-value").min,
      preciseMax:document.querySelector("#granular-speed-value").max
    }));
    assert.deepEqual(speedRails,{
      railValue:"2",railOptions:["1","2","4","8"],min:"-2",max:"2",
      preciseMin:"-8",preciseMax:"8"
    },"the rail starts at ±2×, retains a selectable ±8×, and precise input keeps ±8×");
    const decodedRate=Number((await page.$eval("#file-meta",el=>el.textContent))
      .match(/(\d+)Hz/)?.[1]);
    assert.ok(decodedRate>=8000&&decodedRate<=192000);
    // The recorded piano begins around 1.5 s; the first 0.18 s is almost
    // silent. Use an objectively non-silent recorded section instead of
    // treating legitimate source silence as an audio-rendering defect.
    const loopA=Math.round(decodedRate*1.65);
    const loopB=Math.round(decodedRate*2.15);
    await page.evaluate(({loopA,loopB})=>{
      const set=(id,value)=>{
        const e=document.getElementById(id);
        e.value=String(value);
        e.dispatchEvent(new Event("change",{bubbles:true}));
      };
      set("player-loop-b",loopB);
      set("player-loop-a",loopA);
      set("granular-speed-value",1);
      set("granular-pitch-value",0);
    },{loopA,loopB});
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:20000});
    await page.waitForFunction(()=>window.__audioOutputPaths?.length>=2,{timeout:20000});
    const outputSilence=await page.evaluate(()=>({
      kinds:[...new Set(window.__audioOutputPaths.map(({kind})=>kind))],
      routeCount:window.__audioSilenceAudit.mutedOutputRoutes,
      gains:window.__audioSilenceAudit.audioOutputMuteGains
    }));
    assert.ok(outputSilence.kinds.includes("direct")&&
      outputSilence.kinds.includes("media"),outputSilence);
    assert.equal(outputSilence.gains.length,outputSilence.routeCount,outputSilence);
    assert.ok(outputSilence.gains.length>=2&&
      outputSilence.gains.every(value=>value===0),outputSilence);
    const route=await page.$eval("#rt-telemetry",el=>el.dataset.pcmTransport);
    assert.equal(route,"pv-phase-locked",
      "recorded music must use the real selected Phase Vocoder Worklet by default");
    const nodeStarts=await page.$eval("#rt-telemetry",
      el=>Number(el.dataset.pcmNodeStarts));
    assert.equal(nodeStarts,1);

    const readings=[];
    let previousAppliedRevision=-1;
    async function observe(tag,expectedSpeed,expectedPitch){
      await page.waitForFunction(({speed,pitch,previousAppliedRevision})=>{
        const node=document.querySelector("#granular-optin-status");
        return node?.dataset.renderRunning==="true"&&
          Number(document.querySelector("#granular-speed-value")?.value)===speed&&
          Number(node?.dataset.renderPitch)===pitch&&
          Number(node?.dataset.renderRevision)>previousAppliedRevision;
      },{timeout:20000},{speed:expectedSpeed,pitch:expectedPitch,
        previousAppliedRevision});
      previousAppliedRevision=Number(await page.$eval("#granular-optin-status",
        el=>el.dataset.renderRevision));
      const samples=[];
      for(let n=0;n<10;n++){
        await sleep(45);
        const value=await page.evaluate(()=>{
          const paths=window.__audioOutputPaths||[];
          if(!paths.length)return null;
          const readings=paths.map(({kind,analyser})=>{
            const data=new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            let power=0,peak=0,zeros=0;
            for(const v of data){power+=v*v;peak=Math.max(peak,Math.abs(v));if(v===0)zeros++;}
            return {kind,rms:Math.sqrt(power/data.length),peak,zeros};
          });
          return {rms:Math.max(...readings.map(x=>x.rms)),
            peak:Math.max(...readings.map(x=>x.peak)),
            paths:readings,
            htmlMediaRunning:!document.querySelector("#background-output")?.paused};
        });
        assert.ok(value,"the real Web Audio output node must be observable");
        samples.push(value);
      }
      const active=samples.filter(x=>x.rms>1e-4);
      const result={tag,expectedSpeed,expectedPitch,active:active.length,
        maxRms:Math.max(...samples.map(x=>x.rms)),
        maxPeak:Math.max(...samples.map(x=>x.peak)),
        outputPaths:samples.at(-1).paths.map(x=>x.kind),
        mediaStarted:samples.some(x=>x.htmlMediaRunning),
        lastFrame:Number(await page.$eval("#granular-optin-status",
          el=>el.dataset.renderFrame)),
        nodeStarts:await page.$eval("#rt-telemetry",
          el=>Number(el.dataset.pcmNodeStarts))};
      console.log("R2_R3_ACTUAL_OUTPUT "+JSON.stringify(result));
      assert.ok(result.active>=5,
        "known audible CC0 piano segment must produce sound for this velocity/pitch");
      assert.equal(result.nodeStarts,nodeStarts,
        "ordinary changes may not reinstantiate the audio Worklet");
      readings.push(result);
      return result;
    }
    await observe("forward",1,0);
    await page.evaluate(()=>{
      const e=document.querySelector("#granular-speed-value");
      e.value="0";e.dispatchEvent(new Event("change",{bubbles:true}));
      const p=document.querySelector("#granular-pitch-value");
      p.value="7.1234";p.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await observe("zero-sustain",0,7.1234);
    await page.evaluate(()=>{
      const e=document.querySelector("#granular-speed-value");
      e.value="-1";e.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await observe("reverse", -1,7.1234);
    const beforeFrame=await page.$eval("#wave-detail",
      el=>Number(el.getAttribute("aria-valuenow")));
    await page.$eval("#wave-detail",el=>el.scrollIntoView({block:"center"}));
    const box=await page.$eval("#wave-detail",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    // #63 regression: proof must reach the actual output and the atomic
    // Worklet port, not just a signed-speed command or an aria label.
    await page.evaluate(()=>{
      window.__scratchProtocol=[];
      const native=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(m,...args){
        if(m?.type==="scrub"||m?.type==="seek-window"||
           (m?.type==="command"&&m.op==="speed"))
          window.__scratchProtocol.push({type:m.type==="command"?"speed":m.type,
            frame:m.frame,speed:m.speed,
            bytes:m.channels?.reduce((n,c)=>n+c.byteLength,0)||0});
        return native.call(this,m,...args);
      };
    });
    // A/B handles have their own pointer capture within 24px. Select a
    // real pan position far from both handles, not one that drags an endpoint.
    const panStart=await page.evaluate(()=>{
      const canvas=document.querySelector("#wave-detail");
      const r=canvas.getBoundingClientRect();
      const bounds=["#wave-a-marker","#wave-b-marker"].map(selector=>{
        const el=document.querySelector(selector);
        return el?.hidden?null:el.getBoundingClientRect().left-r.left;
      }).filter(x=>x!==null);
      return [.20,.35,.50,.65,.80].map(fraction=>({
        fraction,distance:Math.min(...bounds.map(x=>Math.abs(fraction*r.width-x)),r.width)
      })).sort((a,b)=>b.distance-a.distance)[0].fraction;
    });
    await page.mouse.move(box.x+box.width*panStart,box.y+box.height*.73);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*(panStart-.12),
      box.y+box.height*.73,{steps:10});
    await page.mouse.up();
    await page.waitForFunction(()=>window.__scratchProtocol
      ?.some(x=>x.type==="scrub"&&x.speed>0),{timeout:10000});
    const actualScratch=await page.evaluate(()=>{
      const log=window.__scratchProtocol;
      const analyserPaths=window.__audioOutputPaths||[];
      const rms=analyserPaths.map(({analyser})=>{
        const pcm=new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(pcm);
        return Math.sqrt(pcm.reduce((n,v)=>n+v*v,0)/pcm.length);
      });
      return {log,rms,renderFrame:document.querySelector(
        "#granular-optin-status")?.dataset.renderFrame};
    });
    assert.ok(actualScratch.log.some(x=>x.type==="scrub"&&x.speed>0));
    // Non-pressed hover can prime the same PCM cache BEFORE pointerdown.
    // A pressed drag should reuse that cache, not demand a redundant copy.
    assert.ok(actualScratch.log.some(x=>x.type==="scrub"),
      "drag must still reach the real atomic scratch handler");
    assert.ok(actualScratch.log.some(x=>x.type==="scrub"&&x.bytes===0),
      "consecutive pointer positions must reuse PCM cache");
    assert.equal(actualScratch.log.filter(x=>x.type==="seek-window").length,0,
      "waveform drag must not separately reset granular synthesis per move");
    assert.ok(Math.max(...actualScratch.rms)>.0001,
      "rendered output must remain audible during/after the scratch");
    console.log("ATOMIC_REAL_OUTPUT_SCRATCH "+JSON.stringify(actualScratch));
    const afterFrame=await page.$eval("#wave-detail",
      el=>Number(el.getAttribute("aria-valuenow")));
    assert.notEqual(afterFrame,beforeFrame,
      "actual waveform scrub must move the canonical source-time viewport");
    assert.equal(await page.$eval("#rt-telemetry",
      el=>Number(el.dataset.pcmNodeStarts)),nodeStarts);
    // The full-song overview must also issue atomic sample+speed scrub:
    // old #wave pointermove still used seek-window and reset the grain state.
    await page.$eval("#wave",e=>e.scrollIntoView({block:"center"}));
    const overviewBox=await page.$eval("#wave",e=>{
      const r=e.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    const startOfOverview=await page.evaluate(()=>window.__scratchProtocol.length);
    await page.mouse.move(overviewBox.x+overviewBox.width*.52,
      overviewBox.y+overviewBox.height*.45);
    await page.mouse.down();
    await page.mouse.move(overviewBox.x+overviewBox.width*.58,
      overviewBox.y+overviewBox.height*.45,{steps:8});
    await page.mouse.up();
    await page.waitForFunction(i=>window.__scratchProtocol?.slice(i)
      .some(m=>m.type==="scrub"),{timeout:10000},startOfOverview);
    const overviewCommands=await page.evaluate(i=>
      window.__scratchProtocol.slice(i),startOfOverview);
    // The overview can legitimately reuse the detail editor's prior PCM
    // cache. Requiring a redundant copy here would regress the optimization.
    assert.ok(overviewCommands.some(x=>x.type==="scrub"),
      "overview touch must reach the atomic audio scratch handler");
    assert.equal(overviewCommands.filter(x=>x.type==="seek-window").length,0,
      "overview must not reset sound grain epoch on each pointer movement");
    console.log("ATOMIC_OVERVIEW_SCRATCH "+JSON.stringify({
      commands:overviewCommands.length,
      transfers:overviewCommands.filter(x=>x.bytes>0).length,
      positive:overviewCommands.some(x=>x.speed>0),
      negative:overviewCommands.some(x=>x.speed<0)
    }));
    // U9 follow-up: with NO pointer buttons down, real Chrome mouse hover
    // must reach the same live PCM processor. It is not a passive label edit.
    // Autoplay has already been unlocked through the explicit Play click.
    await page.mouse.move(2,2);
    await page.evaluate(()=>{
      const s=document.querySelector("#granular-speed-value");
      s.value="1";s.dispatchEvent(new Event("change",{bubbles:true}));
      const loop=document.querySelector("#player-loop-enabled");
      if(loop.checked)loop.click();
      window.__scratchProtocol=[];
    });
    const hoverY=overviewBox.y+overviewBox.height*.46;
    await page.mouse.move(overviewBox.x+overviewBox.width*.59,hoverY);
    await page.waitForFunction(()=>window.__scratchProtocol
      ?.some(x=>x.type==="scrub"&&x.speed===0),{timeout:10000});
    // A stationary pointer is 0x sustained source audio, not the saved 1x.
    await sleep(155);
    const heldHover=await page.evaluate(()=>{
      const paths=window.__audioOutputPaths||[];
      return {frame:Number(document.querySelector("#granular-optin-status")
        ?.dataset.renderFrame),
        rms:Math.max(...paths.map(({analyser})=>{
          const pcm=new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(pcm);
          return Math.sqrt(pcm.reduce((sum,v)=>sum+v*v,0)/pcm.length);
        })),speeds:window.__scratchProtocol.map(x=>x.speed),
        loop:document.querySelector("#player-loop-enabled").checked,
        starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts)};
    });
    assert.ok(Math.abs(heldHover.frame-Math.round(decodedRate*3*.59))<=2,
      "hover must hold the actual output source-frame under mouse");
    assert.ok(heldHover.rms>1e-4,
      "still 0x hover must render audible source PCM, not a frozen display");
    assert.equal(heldHover.loop,false);
    assert.equal(heldHover.starts,nodeStarts);
    await page.mouse.move(overviewBox.x+overviewBox.width*.66,hoverY,{steps:7});
    await page.mouse.move(overviewBox.x+overviewBox.width*.60,hoverY,{steps:7});
    await page.waitForFunction(()=>window.__scratchProtocol
      ?.some(x=>x.type==="scrub"&&x.speed>0)&&window.__scratchProtocol
      ?.some(x=>x.type==="scrub"&&x.speed<0),{timeout:10000});
    await sleep(150);
    const overviewHoverLog=await page.evaluate(()=>window.__scratchProtocol.slice());
    assert.equal(overviewHoverLog.filter(x=>x.type==="seek-window").length,0);
    assert.ok(overviewHoverLog.some(x=>x.type==="scrub"&&x.speed===0));
    assert.ok(overviewHoverLog.some(x=>x.type==="scrub"&&x.speed>0));
    assert.ok(overviewHoverLog.some(x=>x.type==="scrub"&&x.speed<0));
    await page.mouse.move(2,2);
    await page.waitForFunction(()=>window.__scratchProtocol.some(x=>
      x.type==="speed"&&Math.abs(x.speed-1)<1e-6),{timeout:10000});
    // The detailed fixed-head waveform must also preview with no button
    // press; its hover origin must not compound with a recentered viewport.
    await page.$eval("#wave-detail",el=>el.scrollIntoView({block:"center"}));
    const hoverDetail=await page.$eval("#wave-detail",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    const detailHoverStart=await page.evaluate(()=>window.__scratchProtocol.length);
    const detailY=hoverDetail.y+hoverDetail.height*.68;
    await page.mouse.move(hoverDetail.x+hoverDetail.width*.52,detailY);
    await page.waitForFunction(i=>window.__scratchProtocol.slice(i).some(x=>
      x.type==="scrub"&&x.speed===0),{timeout:10000},detailHoverStart);
    await page.mouse.move(hoverDetail.x+hoverDetail.width*.56,detailY,{steps:6});
    await page.waitForFunction(i=>window.__scratchProtocol.slice(i).some(x=>
      x.type==="scrub"&&x.speed>0),{timeout:10000},detailHoverStart);
    const detailHoverLog=await page.evaluate(i=>window.__scratchProtocol.slice(i),detailHoverStart);
    assert.equal(detailHoverLog.filter(x=>x.type==="seek-window").length,0);
    await page.mouse.move(2,2);
    await sleep(530);
    const hoverFinal=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      speed:document.querySelector("#granular-speed-value").value,
      errors:window.__scratchProtocol.filter(x=>x.type==="seek-window").length
    }));
    assert.equal(hoverFinal.starts,nodeStarts);
    assert.equal(hoverFinal.speed,"1");
    assert.equal(hoverFinal.errors,0);
    console.log("REAL_MOUSE_HOVER_AUDIO "+JSON.stringify({
      overviewHeld:heldHover,overviewCommands:overviewHoverLog.length,
      detailCommands:detailHoverLog.length,returnToSpeed:1,
      output:"CHROME_AUDIO_ANALYSER_NOT_PHYSICAL_DAC"
    }));
    // Explicitly distinguish the browser's audio samples, render receipt,
    // and the lack of actual mobile-device acoustic/latency measurement.
    assert.deepEqual(errors,[]);
    console.log("R2_R3_MAIN_PLAYER_RECEIPT_AND_OUTPUT "+JSON.stringify({
      source:"CC0 Meta Piano A0",decodedRate,readings,
      draggedFrames:[beforeFrame,afterFrame],workletStarts:nodeStarts,
      scope:"CHROMIUM_WEB_AUDIO_OUTPUT_PCMC_SAMPLES_NOT_PHYSICAL_DAC"
    }));
    await page.click("#stop");
  }finally{await cleanupTestProcesses(browser,[server],"audio output HTTP server");}
});

for(const profile of [
  {model:"pv",route:"pv-phase-locked",port:18793},
  {model:"wsola",route:"wsola-source-time",port:18794},
  {model:"dual",route:"dual-transient-source-time",port:18795},
  {model:"live",route:"rust-engine3-source-time",port:18796}
]){
test(`native Chrome actual ${profile.model} output follows 0×, reverse and signed scratch on ONE Worklet`,async()=>{
  const port=profile.port;
  const server=spawn(pythonCommand,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:webRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage(),errors=[],failedRequests=[];
    page.on("pageerror",e=>errors.push(e.message));
    page.on("requestfailed",request=>failedRequests.push({
      url:request.url(),error:request.failure()?.errorText
    }));
    await page.evaluateOnNewDocument(guardSource=>{
      const audit={mutedOutputRoutes:0,audioOutputMuteGain:null,
        audioOutputMuteGains:[]};
      window.__pvSilenceAudit=audit;
      (0,eval)(`(${guardSource})`)(window,audit);
      window.__pvAnalysers=[];window.__pvScratch=[];
      window.__pvOutputRoutes={direct:0,media:0};
      const connect=AudioNode.prototype.connect;
      AudioNode.prototype.connect=function(target,...args){
        const media=typeof MediaStreamAudioDestinationNode!=="undefined"&&
          target instanceof MediaStreamAudioDestinationNode;
        if(target===this.context.destination||media){
          const analyser=this.context.createAnalyser();analyser.fftSize=2048;
          connect.call(this,analyser,...args);connect.call(analyser,target);
          window.__pvAnalysers.push(analyser);
          window.__pvOutputRoutes[media?"media":"direct"]++;
          return target;
        }
        return connect.call(this,target,...args);
      };
      const post=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(message,...args){
        if(message?.type==="scrub"||
           message?.type==="command"&&message?.op==="speed")
          window.__pvScratch.push({kind:message.type,frame:message.frame,
            speed:message.speed});
        return post.call(this,message,...args);
      };
    },installTestAudioSilenceGuard.toString());
      await page.goto(`http://127.0.0.1:${port}/?legacyUi=1`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
    try{
      await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
        {timeout:20000});
    }catch(error){
      const boot=await page.evaluate(()=>({
        state:document.documentElement.dataset.fwBoot,
        body:document.body?.innerText?.slice(0,1000),
        status:document.querySelector("#status")?.textContent,
        scripts:[...document.scripts].map(script=>script.src||"inline")
      }));
      throw Error("Audio Lab did not finish booting: "+JSON.stringify({
        boot,errors,failedRequests
      })+" / "+error.message);
    }
    await (await page.$("#audio-file")).uploadFile(WAV);
    await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
    const set=(id,value)=>page.$eval("#"+id,(el,v)=>{
      el.value=String(v);el.dispatchEvent(new Event("change",{bubbles:true}));
    },value);
    await set("player-loop-b",103200);
    await set("player-loop-a",79200);
    await page.click("#main-tab-model");
    await set("lab-model",profile.model);
    await page.click("#play-main");
    await page.waitForFunction(route=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport===route&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000},profile.route);
    await page.waitForFunction(()=>window.__pvOutputRoutes?.direct>0&&
      window.__pvOutputRoutes?.media>0,{timeout:10000});
    const outputSilence=await page.evaluate(()=>({
      routes:window.__pvOutputRoutes,
      routeCount:window.__pvSilenceAudit.mutedOutputRoutes,
      gains:window.__pvSilenceAudit.audioOutputMuteGains
    }));
    assert.equal(outputSilence.gains.length,outputSilence.routeCount,outputSilence);
    assert.ok(outputSilence.gains.length>=2&&
      outputSilence.gains.every(value=>value===0),outputSilence);
    const start=Number(await page.$eval("#rt-telemetry",e=>e.dataset.pcmNodeStarts));
    const sound=()=>page.evaluate(()=>{
      const v=(window.__pvAnalysers||[]).map(analyser=>{
        const audio=new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(audio);
        return Math.sqrt(audio.reduce((sum,x)=>sum+x*x,0)/audio.length);
      });
      return Math.max(0,...v);
    });
    const measure=async()=>{
      const rms=[];
      for(let i=0;i<7;i++){await sleep(45);rms.push(await sound());}
      return Math.max(...rms);
    };
    const positive=await measure();
    assert.ok(positive>1e-4,{positive});
    await set("granular-speed-value",0);
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:10000});
    const frozen=await measure();
    assert.ok(frozen>1e-4,{frozen});
    await set("granular-speed-value",-1);
    const reverse=await measure();
    assert.ok(reverse>1e-4,{reverse});
    // The user's saved speed is +1; a negative record throw must continue
    // playing BACKWARD after release before returning toward +1.
    await set("granular-speed-value",1);
    await page.click("#main-tab-player");
    await page.evaluate(()=>{window.__pvScratch=[];});
    const bounds=await page.$eval("#wave-detail",e=>{
      e.scrollIntoView({block:"center"});
      const r=e.getBoundingClientRect();
      return {x:r.x,y:r.y,w:r.width,h:r.height};
    });
    const panStart=await page.evaluate(()=>{
      const canvas=document.querySelector("#wave-detail"),r=canvas.getBoundingClientRect();
      const markers=["#wave-a-marker","#wave-b-marker"].map(selector=>{
        const el=document.querySelector(selector);
        return el?.hidden?null:el.getBoundingClientRect().left-r.left;
      }).filter(x=>x!==null);
      return [.15,.27,.39,.61,.73,.85].map(fraction=>({
        fraction,distance:Math.min(...markers.map(x=>Math.abs(fraction*r.width-x)),r.width)
      })).sort((a,b)=>b.distance-a.distance)[0].fraction;
    });
    await page.mouse.move(bounds.x+bounds.w*panStart,bounds.y+bounds.h*.74);
    await page.mouse.down();
    // Fixed-head detail wave follows the opposite direction of the hand:
    // dragging RIGHT moves the source cursor backward (negative speed).
    // Keep the initial hit >24px from A/B handles, or they capture the drag.
    await page.mouse.move(bounds.x+bounds.w*(panStart+.09),bounds.y+bounds.h*.74,{steps:10});
    await page.mouse.up();
    try{
      await page.waitForFunction(()=>window.__pvScratch.some(x=>x.kind==="scrub"&&
        x.speed<0),{timeout:4000});
    }catch(error){
      const actual=await page.evaluate(()=>({
        commands:window.__pvScratch,route:document.querySelector("#rt-telemetry")?.dataset.pcmTransport,
        text:document.querySelector("#rt-indicator")?.textContent,
        render:document.querySelector("#granular-optin-status")?.dataset.renderRunning,
        interaction:document.querySelector("#wave-detail-wrap")?.dataset.interaction
      }));
      throw Error(profile.model+" signed drag not observed: "+JSON.stringify({panStart,...actual})+" / "+error.message);
    }
    // The release transition is fixed at one second; the user setting scales
    // throw strength rather than changing this convergence duration.
    await sleep(1120);
    const scratch=await page.evaluate(()=>window.__pvScratch.slice());
    const thrown=scratch.filter(x=>x.kind==="scrub"&&x.speed<0);
    const inertia=scratch.filter(x=>x.kind==="command"&&
      Number.isFinite(x.speed));
    assert.ok(thrown.length>=1,{scratch});
    assert.ok(inertia.length>=2&&inertia.some(x=>x.speed<0)&&
      inertia.some(x=>x.speed>0)&&inertia.some(x=>Math.abs(x.speed-1)<.01),
      "release must keep moving backward and smoothly regain saved +1× in actual Worklet");
    assert.equal(Number(await page.$eval("#rt-telemetry",e=>e.dataset.pcmNodeStarts)),start,
      "scrubbing cannot recreate a new PCM node for every pointer movement");
    if(profile.model==="pv"){
      await page.evaluate(()=>{window.__pvScratch=[];});
      await page.mouse.move(bounds.x+bounds.w*panStart,bounds.y+bounds.h*.74);
      await page.mouse.down();
      await page.mouse.move(bounds.x+bounds.w*(panStart+.06),
        bounds.y+bounds.h*.74,{steps:8});
      await page.mouse.up();
      await page.waitForFunction(()=>window.__pvScratch.some(x=>
        x.kind==="scrub"&&x.speed<0),{timeout:4000});
      await sleep(100);
      const beforeHold=await page.evaluate(()=>window.__pvScratch.length);
      const forward=await page.$eval("#seek-forward",el=>{
        const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
      });
      await page.mouse.move(forward.x,forward.y);
      await page.mouse.down();
      await sleep(300);
      const heldSpeeds=await page.evaluate(start=>window.__pvScratch
        .slice(start).filter(x=>x.kind==="command"&&Number.isFinite(x.speed))
        .map(x=>x.speed),beforeHold);
      assert.ok(heldSpeeds.length>=1&&heldSpeeds.every(speed=>speed===4),
        "a held 4× shuttle must not be overwritten by pending scrub inertia");
      await page.mouse.up();
      await page.waitForFunction(()=>window.__pvScratch.some(x=>
        x.kind==="command"&&Math.abs(x.speed-1)<.01),{timeout:4000});
    }
    assert.ok(await measure()>1e-5,
      "selected DSP must still produce samples after releasing the drag");
    assert.deepEqual(errors,[]);
    console.log(profile.model.toUpperCase()+"_REALTIME_CHROME_OUTPUT "+JSON.stringify({
      positive,frozen,reverse,dragCommands:thrown.length,
      inertiaSpeeds:inertia.map(x=>x.speed),nodeStarts:start
    }));
  }finally{await cleanupTestProcesses(browser,[server],"audio gesture HTTP server");}
});
}
