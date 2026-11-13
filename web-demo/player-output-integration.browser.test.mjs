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
      window.__outputProbes=[];
      AudioNode.prototype.connect=function(destination,...rest){
        if(destination===this.context.destination){
          const probe=this.context.createAnalyser();
          probe.fftSize=2048;
          nativeConnect.call(this,probe,...rest);
          nativeConnect.call(probe,destination);
          window.__outputProbes.push(probe);
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
    await page.evaluate(()=>{
      const set=(id,value)=>{
        const e=document.getElementById(id);
        e.value=String(value);
        e.dispatchEvent(new Event("change",{bubbles:true}));
      };
      set("player-loop-b",20000);
      set("player-loop-a",8000);
      set("player-loop-b",16000);
      set("granular-speed-value",1);
      set("granular-pitch-value",0);
    });
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:20000});
    await page.waitForFunction(()=>window.__outputProbes?.length>0,{timeout:20000});
    const nodeStarts=await page.$eval("#rt-telemetry",
      el=>Number(el.dataset.pcmNodeStarts));
    assert.equal(nodeStarts,1);

    const readings=[];
    async function observe(tag,expectedSpeed,expectedPitch){
      await page.waitForFunction(({speed,pitch})=>{
        const node=document.querySelector("#granular-optin-status");
        return node?.dataset.renderRunning==="true"&&
          Number(node?.dataset.renderSpeed)===speed&&
          Number(node?.dataset.renderPitch)===pitch;
      },{timeout:20000},{speed:expectedSpeed,pitch:expectedPitch});
      const samples=[];
      for(let n=0;n<10;n++){
        await sleep(45);
        const value=await page.evaluate(()=>{
          const p=window.__outputProbes.at(-1);
          if(!p)return null;
          const data=new Float32Array(p.fftSize);
          p.getFloatTimeDomainData(data);
          let power=0,peak=0,zeros=0;
          for(const v of data){power+=v*v;peak=Math.max(peak,Math.abs(v));if(v===0)zeros++;}
          return {rms:Math.sqrt(power/data.length),peak,zeros};
        });
        assert.ok(value,"the real Web Audio output node must be observable");
        samples.push(value);
      }
      const active=samples.filter(x=>x.rms>1e-5);
      const result={tag,expectedSpeed,expectedPitch,active:active.length,
        maxRms:Math.max(...samples.map(x=>x.rms)),
        maxPeak:Math.max(...samples.map(x=>x.peak)),
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
    await page.mouse.move(box.x+box.width*.68,box.y+box.height*.73);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.42,box.y+box.height*.73,{steps:10});
    await page.mouse.up();
    const afterFrame=await page.$eval("#wave-detail",
      el=>Number(el.getAttribute("aria-valuenow")));
    assert.notEqual(afterFrame,beforeFrame,
      "actual waveform scrub must move the canonical source-time viewport");
    assert.equal(await page.$eval("#rt-telemetry",
      el=>Number(el.dataset.pcmNodeStarts)),nodeStarts);
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
