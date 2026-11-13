import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// End-to-end R2/R3 observation: use the published player, not a laboratory
// function call. A unity AnalyserNode is inserted immediately BEFORE the
// AudioContext destination, so these are actual rendered output samples
// rather than a command-accepted or render-applied UI receipt.
// This does not measure a phone DAC or certify perceptual fidelity.
test("recorded piano main player: gesture/parameter receipts AND actual output PCM",async()=>{
  const port=18791;
  const server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.evaluateOnNewDocument(()=>{
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
    });
    await page.goto("http://127.0.0.1:"+port+"/",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await (await page.$("#audio-file")).uploadFile(WAV);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
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
        if(m?.type==="scrub"||m?.type==="seek-window")
          window.__scratchProtocol.push({type:m.type,frame:m.frame,
            speed:m.speed,bytes:m.channels?.reduce((n,c)=>n+c.byteLength,0)||0});
        return native.call(this,m,...args);
      };
    });
    await page.mouse.move(box.x+box.width*.68,box.y+box.height*.73);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.42,box.y+box.height*.73,{steps:10});
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
    assert.ok(actualScratch.log.some(x=>x.type==="scrub"&&x.bytes>0),
      "initial scratch must prime its PCM cache");
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
    assert.ok(overviewCommands.some(x=>x.type==="scrub"&&x.bytes>0),
      "overview touch must prime the actual audio scratch window");
    assert.equal(overviewCommands.filter(x=>x.type==="seek-window").length,0,
      "overview must not reset sound grain epoch on each pointer movement");
    console.log("ATOMIC_OVERVIEW_SCRATCH "+JSON.stringify({
      commands:overviewCommands.length,
      transfers:overviewCommands.filter(x=>x.bytes>0).length,
      positive:overviewCommands.some(x=>x.speed>0),
      negative:overviewCommands.some(x=>x.speed<0)
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
  }finally{await browser?.close();server.kill("SIGTERM");}
});
