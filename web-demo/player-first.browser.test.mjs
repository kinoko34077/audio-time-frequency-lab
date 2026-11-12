import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const recording=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");

test("R4 default page: play recorded song, set precise A/B and speed/pitch, switch tabs without reset",async()=>{
  const port=18771;
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
    page.on("pageerror",err=>errors.push(err.message));
    await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    assert.equal(await page.$eval("body",el=>el.dataset.mainTab),"player");
    assert.equal(await page.$eval("#main-tab-player",el=>el.getAttribute("aria-selected")),"true");
    assert.equal(await page.$eval("#granular-optin-controls",el=>el.hidden),false);
    assert.equal(await page.$eval("#audio-lab",el=>getComputedStyle(el).display),"none");
    await (await page.$("#audio-file")).uploadFile(recording);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav · 3.0秒"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:10000});
    assert.equal(await page.$eval("#player-loop-controls",el=>el.hidden),false);
    const sourceRate=Number((await page.$eval("#file-meta",el=>el.textContent)).match(/(\d+)Hz/)?.[1]);
    assert.ok(sourceRate>=8000);
    await page.evaluate(()=>{
      const set=(id,value)=>{
        const el=document.getElementById(id);
        el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
      };
      set("granular-speed-value","0");
      set("granular-pitch-value","7.1234");
      set("player-loop-a","1000");
      set("player-loop-b","3000");
    });
    assert.equal(await page.$eval("#player-loop-a",el=>el.value),"1000");
    assert.equal(await page.$eval("#player-loop-b",el=>el.value),"3000");
    assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")?.dataset.pcmTransport
      ==="granular-experimental",{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderPitch==="7.1234"&&document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:20000});
    const starts=await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts));
    assert.equal(starts,1);
    await page.evaluate(()=>{
      const a=document.getElementById("player-loop-a");
      // Grow the interval's end first; a transient A>=B is invalid by contract.
      const b=document.getElementById("player-loop-b");
      b.value="12000";b.dispatchEvent(new Event("change",{bubbles:true}));
      a.value="8000";a.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#player-loop-hint")
      ?.textContent.includes("反映が完了"),{timeout:20000});
    assert.equal(await page.$eval("#player-loop-a",el=>el.value),"8000");
    assert.equal(await page.$eval("#player-loop-b",el=>el.value),"12000");
    // Voice Memos / AudioStretch interaction: a stationary central head,
    // a separately navigable overview, and zoomed sound under the finger.
    const centerAlignment=await page.$eval(".wave-center-head",el=>{
      const head=el.getBoundingClientRect(),wrap=el.parentElement.getBoundingClientRect();
      return Math.abs(head.left+head.width/2-(wrap.left+wrap.width/2));
    });
    assert.ok(centerAlignment<=2,"central playhead must remain stationary and centered");
    assert.equal(await page.$eval("#wave-detail",el=>getComputedStyle(el).touchAction),"none");
    const wave=await page.$eval("#wave-detail",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    assert.ok(wave.width>220&&wave.height>160,"large detailed waveform is visible");
    const initialSpan=await page.$eval("#wave-zoom-label",el=>el.textContent);
    await page.evaluate(()=>{
      window.__r4SeekCount=0;
      window.__r4NativePost=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(msg,...args){
        if(msg?.type==="seek-window")window.__r4SeekCount++;
        return window.__r4NativePost.call(this,msg,...args);
      };
    });
    await page.click("#wave-zoom-in");
    await page.click("#wave-zoom-in");
    const zoomSeekCount=await page.evaluate(()=>{
      MessagePort.prototype.postMessage=window.__r4NativePost;
      return window.__r4SeekCount;
    });
    assert.equal(zoomSeekCount,0,
      "centered visual zoom must not send an audible PCM seek/reset");
    assert.notEqual(await page.$eval("#wave-zoom-label",el=>el.textContent),initialSpan,
      "zoom controls must change the source-time viewport");
    await page.$eval("#wave-detail",el=>el.scrollIntoView({block:"center"}));
    const editingWave=await page.$eval("#wave-detail",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    });
    const bHandle=await page.$eval("#wave-b-marker",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,visible:!el.hidden};
    });
    assert.ok(bHandle.visible,"B handle should be in the zoomed viewport");
    const bTarget=await page.evaluate(({x,y})=>{
      const e=document.elementFromPoint(x,y);
      return {id:e?.id,tag:e?.tagName,cls:e?.className};
    },{x:bHandle.x,y:editingWave.y+editingWave.height*.5});
    assert.equal(bTarget.id,"wave-detail",
      "physical B drag must hit the editable waveform, not an overlapping panel: "+JSON.stringify(bTarget));
    await page.mouse.move(bHandle.x,editingWave.y+editingWave.height*.5);
    await page.mouse.down();
    await page.mouse.move(bHandle.x+55,editingWave.y+editingWave.height*.5,{steps:6});
    await page.mouse.up();
    await page.waitForFunction(()=>Number(document.querySelector("#player-loop-b").value)>12000,
      {timeout:15000});
    const draggedB=Number(await page.$eval("#player-loop-b",el=>el.value));
    assert.ok(draggedB>12000);
    // Move the waveform under the fixed head (as opposed to moving a head
    // over a static whole-song overview).
    const beforePan=Number(await page.$eval("#wave-detail",el=>el.getAttribute("aria-valuenow")));
    await page.mouse.move(editingWave.x+editingWave.width*.20,editingWave.y+editingWave.height*.65);
    await page.mouse.down();
    await page.mouse.move(editingWave.x+editingWave.width*.10,editingWave.y+editingWave.height*.65,{steps:8});
    await page.mouse.up();
    await page.waitForFunction(prev=>Number(document.querySelector("#wave-detail")
      ?.getAttribute("aria-valuenow"))>prev,{timeout:15000},beforePan);
    assert.equal(await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts)),starts,
      "zoom/handle scrub may not create extra worklet nodes");
    // Native Chrome touchscreen injection: two simultaneous active contacts
    // must zoom the waveform without changing canonical A/B or Worklet count.
    const asSeconds=label=>label.startsWith("ms ")?Number(label.slice(3))/1000:
      Number(label.replace("秒",""));
    const beforePinchSpan=asSeconds(await page.$eval("#wave-zoom-label",
      el=>el.textContent));
    assert.ok(Number.isFinite(beforePinchSpan)&&beforePinchSpan>0);
    const touch=await page.createCDPSession();
    await touch.send("Emulation.setTouchEmulationEnabled",
      {enabled:true,maxTouchPoints:2});
    const point=(fraction,id)=>({
      x:Math.round(editingWave.x+editingWave.width*fraction),
      y:Math.round(editingWave.y+editingWave.height*.40),id
    });
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",
      touchPoints:[point(.37,21),point(.63,22)]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchMove",
      touchPoints:[point(.22,21),point(.78,22)]});
    const frameAfterZoomMove=Number(await page.$eval("#wave-detail",
      el=>el.getAttribute("aria-valuenow")));
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await touch.send("Emulation.setTouchEmulationEnabled",{enabled:false});
    const afterPinchSpan=asSeconds(await page.$eval("#wave-zoom-label",
      el=>el.textContent));
    assert.ok(afterPinchSpan<beforePinchSpan,{beforePinchSpan,afterPinchSpan});
    const afterPinchFrame=Number(await page.$eval("#wave-detail",
      el=>el.getAttribute("aria-valuenow")));
    assert.ok(Math.abs(afterPinchFrame-frameAfterZoomMove)<=2,
      "lifting a remaining pinch contact must not issue a second tap seek: "+
      JSON.stringify({frameAfterZoomMove,afterPinchFrame,beforePinchSpan,afterPinchSpan}));
    assert.equal(await page.$eval("#player-loop-b",el=>el.value),String(draggedB));
    assert.equal(await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts)),starts,
      "pinch may not restart the audio engine");
    await page.click("#main-tab-model");
    assert.equal(await page.$eval("body",el=>el.dataset.mainTab),"model");
    assert.notEqual(await page.$eval("#audio-lab",el=>getComputedStyle(el).display),"none");
    assert.equal(await page.$eval("#lab-model",el=>el.value),"live");
    await page.click("#main-tab-player");
    assert.equal(await page.$eval("body",el=>el.dataset.mainTab),"player");
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"0");
    assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
    assert.equal(await page.$eval("#player-loop-a",el=>el.value),"8000");
    assert.equal(await page.$eval("#player-loop-b",el=>el.value),String(draggedB));
    assert.equal(await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts)),starts,
      "switching tabs may not recreate the Worklet");
    await page.evaluate(()=>{
      const speed=document.getElementById("granular-speed-value");
      speed.value="-1.125";
      speed.dispatchEvent(new Event("change",{bubbles:true}));
      document.getElementById("player-loop-enabled").click();
    });
    await page.waitForFunction(()=>document.querySelector("#player-loop-hint")
      ?.textContent.includes("反映が完了"),{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.125");
    assert.equal(await page.$eval("#player-loop-enabled",el=>el.checked),false);
    assert.equal(await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts)),starts);
    // R4 sample-accurate range: the detailed editor must reach the very
    // last decoded source frame, not the old 1ms legacy seek cutoff.
    await page.evaluate(()=>{
      const speed=document.querySelector("#granular-speed-value");
      speed.value="0";speed.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.focus("#wave-detail");
    await page.keyboard.press("End");
    const finalSample=3*sourceRate-1;
    await page.waitForFunction(frame=>Number(document.querySelector("#granular-optin-status")
      ?.dataset.renderFrame)===frame,{timeout:20000},finalSample);
    // The detailed canvas is intentionally repainted at ~30fps, so its
    // accessible frame label can update one animation frame AFTER the audio
    // Worklet's render-applied receipt. Require convergence, not same-tick.
    await page.waitForFunction(frame=>Number(document.querySelector("#wave-detail")
      ?.getAttribute("aria-valuenow"))===frame,{timeout:10000},finalSample);
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:20000});
    // The original button remains a separate audition path, not an alias
    // for granular pitch-shifted output on the new default home page.
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator")
      ?.textContent.includes("原音再生中"),{timeout:20000});
    assert.notEqual(await page.$eval("#rt-telemetry",
      el=>el.dataset.pcmTransport||""),"granular-experimental");
    await page.click("#stop");
    assert.deepEqual(errors,[]);
    console.log("R4_DEFAULT_PLAYER_REAL_RECORDING "+JSON.stringify({
      source:"Meta Open Sound recorded piano A0 CC0",decodedRate:sourceRate,
      mainTab:"player",controls:"±8/0 exact typed speed; independent ±12 pitch",
      loop:"source sample A/B 8000..12000 and OFF while playing",
      tabs:"model and player without reset or node reinit",
      rawRoute:"preserved as separate original playback",nodeStarts:starts,
      note:"browser functional route; no iPhone / subjective audio fidelity proof"
    }));
  }finally{
    await browser?.close();server.kill();
  }
});