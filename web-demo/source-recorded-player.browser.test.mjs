import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
test("recorded CC0 upright piano goes through the real granular file picker and live Worklet",async()=>{
  const port=18767;
  const server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
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
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();server.kill();
  }
});