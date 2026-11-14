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
    // Real user function (R4), not another R2 quality benchmark: a single
    // primary button pauses and resumes without destroying the player or
    // losing pitch/tempo, A/B bounds or the canonical source position.
    await page.evaluate(()=>{
      const speed=document.getElementById("granular-speed-value");
      speed.value="1";speed.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:15000});
    // U2: audit the actual visible canvas during 28 browser animation frames.
    // Resizing either backing dimension on each moving frame discards pixels
    // and creates a paint hitch even when the audio Worklet is continuous.
    const waveDraw=await page.evaluate(async()=>{
      const canvas=document.getElementById("wave-detail");
      const proto=HTMLCanvasElement.prototype;
      const width=Object.getOwnPropertyDescriptor(proto,"width");
      const height=Object.getOwnPropertyDescriptor(proto,"height");
      let resets=0;const samples=[];
      Object.defineProperty(proto,"width",{...width,set(value){
        if(this===canvas)resets++;
        return width.set.call(this,value);
      }});
      Object.defineProperty(proto,"height",{...height,set(value){
        if(this===canvas)resets++;
        return height.set.call(this,value);
      }});
      try{
        await new Promise(resolve=>{
          let count=0;
          const frame=()=>{
            samples.push(Number(canvas.getAttribute("aria-valuenow")));
            if(++count>=28)resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        return {resets,distinctFrames:new Set(samples).size};
      }finally{
        Object.defineProperty(proto,"width",width);
        Object.defineProperty(proto,"height",height);
      }
    });
    assert.equal(waveDraw.resets,0,
      "moving fixed-head waveform must not reset same-sized canvas backing on every paint");
    assert.ok(waveDraw.distinctFrames>=8,
      "browser must visibly update the source-frame head during actual audio: "+
      JSON.stringify(waveDraw));
    console.log("U2_REAL_CANVAS_PAINT "+JSON.stringify(waveDraw));
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#play-main")
      ?.textContent.includes("再開")&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="false",
      {timeout:15000});
    const paused=await page.evaluate(()=>({
      frame:Number(document.querySelector("#wave-detail")?.getAttribute("aria-valuenow")),
      speed:document.querySelector("#granular-speed-value")?.value,
      pitch:document.querySelector("#granular-pitch-value")?.value,
      a:document.querySelector("#player-loop-a")?.value,
      b:document.querySelector("#player-loop-b")?.value,
      worklets:Number(document.querySelector("#rt-telemetry")?.dataset.pcmNodeStarts),
      media:navigator.mediaSession?.playbackState
    }));
    await new Promise(resolve=>setTimeout(resolve,100));
    const still=Number(await page.$eval("#wave-detail",
      e=>e.getAttribute("aria-valuenow")));
    assert.ok(Math.abs(still-paused.frame)<=2,{paused,still});
    assert.equal(paused.worklets,starts);
    assert.equal(paused.speed,"1");
    assert.equal(paused.pitch,"7.1234");
    assert.equal(paused.a,"1000");
    assert.equal(paused.b,"3000");
    if(paused.media)assert.equal(paused.media,"paused");
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#play-main")
      ?.textContent.includes("一時停止")&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:15000});
    assert.equal(await page.$eval("#rt-telemetry",
      el=>Number(el.dataset.pcmNodeStarts)),starts,
      "main pause/resume must reuse the identical audio worklet");
    assert.equal(await page.$eval("#granular-pitch-value",e=>e.value),"7.1234");
    await page.evaluate(()=>{
      const speed=document.getElementById("granular-speed-value");
      speed.value="0";speed.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:10000});
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
    // #63 U9/U10: observe REAL commands reaching the Worklet port during a
    // held waveform gesture and after the finger is thrown and released.
    await page.evaluate(()=>{
      window.__scratchSpeeds=[];
      const original=MessagePort.prototype.postMessage;
      if(!MessagePort.prototype.__scratchObserved){
        MessagePort.prototype.postMessage=function(data,...args){
          if((data?.type==="command"&&data.op==="speed")||
             data?.type==="scrub")
            window.__scratchSpeeds?.push(data.speed);
          return original.call(this,data,...args);
        };
        MessagePort.prototype.__scratchObserved=true;
      }
      const control=document.querySelector("#granular-speed-value");
      control.value="1";control.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.mouse.move(editingWave.x+editingWave.width*.20,editingWave.y+editingWave.height*.65);
    await page.mouse.down();
    await page.waitForFunction(()=>window.__scratchSpeeds?.includes(0),{timeout:8000});
    await page.mouse.move(editingWave.x+editingWave.width*.10,editingWave.y+editingWave.height*.65,{steps:8});
    console.log("U9_SCRUB_TRACE "+JSON.stringify(await page.evaluate(()=>({
      speeds:window.__scratchSpeeds,gesture:document.querySelector(".wave-detail-wrap")?.dataset.interaction,
      center:document.querySelector("#wave-detail")?.getAttribute("aria-valuenow"),
      span:document.querySelector("#wave-zoom-label")?.textContent,
      appliedSpeed:document.querySelector("#granular-optin-status")?.textContent
    }))));
    // The detailed viewport is zoomed to 0.75s; gesture velocity depends on
    // pointer event timing, so assert a positive signed command, not 1.5x.
    await page.waitForFunction(()=>window.__scratchSpeeds?.some(v=>v>0.05),{timeout:8000});
    const forwardDragHead=Number(await page.$eval("#wave-detail",
      el=>el.getAttribute("aria-valuenow")));
    // Reverse the record by moving the waveform in the opposite direction
    // before release; the Worklet must receive an actual negative speed.
    await page.mouse.move(editingWave.x+editingWave.width*.17,
      editingWave.y+editingWave.height*.65,{steps:8});
    await page.waitForFunction(()=>window.__scratchSpeeds?.some(v=>v<-.05),{timeout:8000});
    const reverseDragHead=Number(await page.$eval("#wave-detail",
      el=>el.getAttribute("aria-valuenow")));
    assert.ok(Number.isSafeInteger(forwardDragHead)&&Number.isSafeInteger(reverseDragHead),
      "real source-frame playhead must be reported during both gesture directions");
    assert.ok(reverseDragHead<forwardDragHead,
      "reversing the waveform must reverse the UI source-frame position: "+
      JSON.stringify({beforePan,forwardDragHead,reverseDragHead}));
    await page.mouse.up();
    await page.waitForFunction(()=>window.__scratchSpeeds?.length>=4&&
      window.__scratchSpeeds.at(-1)===1,{timeout:10000});
    const scratchSpeeds=await page.evaluate(()=>window.__scratchSpeeds);
    assert.ok(scratchSpeeds.some(v=>v>0.05),scratchSpeeds);
    assert.equal(scratchSpeeds.at(-1),1,
      "kinetic throw must restore canonical playback speed");
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"1",
      "scrub override must not rewrite the user's saved speed");
    // Restore the existing R4 test's 0x baseline for later positional checks.
    await page.evaluate(()=>{
      const speed=document.querySelector("#granular-speed-value");
      speed.value="0";speed.dispatchEvent(new Event("change",{bubbles:true}));
    });
    // With a short A/B loop and a reverse flick, the *post-release*
    // playhead may wrap and need not exceed the pre-drag position.
    // Direction is verified at each live mouse move above; here check
    // bounded final transport state and persistent worklet, not chronology.
    const finalScrubState=await page.$eval("#wave-detail",el=>({
      frame:Number(el.getAttribute("aria-valuenow")),
      maxFrame:Number(el.getAttribute("aria-valuemax"))
    }));
    const afterScrub=finalScrubState.frame;
    assert.ok(Number.isSafeInteger(afterScrub)&&afterScrub>=0&&
      afterScrub<=finalScrubState.maxFrame,
      "final sample position must remain within the actual source: "+
      JSON.stringify({beforePan,forwardDragHead,reverseDragHead,afterScrub}));
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
    // Snapshot emitted audible-seek commands after the intended pinch move.
    // A stale UI repaint can differ by subpixel sample rounding without
    // causing an audible seek, so verify the actual Worklet protocol.
    const beforePinchReleaseSeeks=await page.evaluate(()=>{
      window.__pinchReleaseSeeks=0;
      window.__pinchOriginalPost=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(msg,...args){
        if(msg?.type==="seek-window")window.__pinchReleaseSeeks++;
        return window.__pinchOriginalPost.call(this,msg,...args);
      };
      return window.__pinchReleaseSeeks;
    });
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await touch.send("Emulation.setTouchEmulationEnabled",{enabled:false});
    const pinchReleaseSeeks=await page.evaluate(()=>{
      MessagePort.prototype.postMessage=window.__pinchOriginalPost;
      return window.__pinchReleaseSeeks;
    });
    assert.equal(pinchReleaseSeeks,beforePinchReleaseSeeks,
      "pinch finger release must not command an additional audible seek");
    const afterPinchSpan=asSeconds(await page.$eval("#wave-zoom-label",
      el=>el.textContent));
    assert.ok(afterPinchSpan<beforePinchSpan,{beforePinchSpan,afterPinchSpan});
    const afterPinchFrame=Number(await page.$eval("#wave-detail",
      el=>el.getAttribute("aria-valuenow")));
    // The canvas reports a center frame rounded to an integer. A repaint
    // may shift under one displayed pixel while the Worklet seek count stays
    // identical. Do not confuse display quantization with an audio jump.
    const onePixelFrames=Math.ceil(afterPinchSpan*sourceRate/editingWave.width);
    assert.ok(Math.abs(afterPinchFrame-frameAfterZoomMove)<=Math.max(2,onePixelFrames),
      "pinch release must not jump by a visible pixel: "+
      JSON.stringify({frameAfterZoomMove,afterPinchFrame,beforePinchSpan,afterPinchSpan,onePixelFrames}));
    assert.equal(await page.$eval("#player-loop-b",el=>el.value),String(draggedB));
    assert.equal(await page.$eval("#rt-telemetry",el=>Number(el.dataset.pcmNodeStarts)),starts,
      "pinch may not restart the audio engine");
    await page.click("#main-tab-model");
    assert.equal(await page.$eval("body",el=>el.dataset.mainTab),"model");
    assert.notEqual(await page.$eval("#audio-lab",el=>getComputedStyle(el).display),"none");
    assert.equal(await page.$eval("#lab-model",el=>el.value),"granular");
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
    try{
      await page.waitForFunction(()=>document.querySelector("#player-loop-hint")
        ?.textContent.includes("反映が完了"),{timeout:20000});
    }catch(error){
      const state=await page.evaluate(()=>({
        hint:document.querySelector("#player-loop-hint")?.textContent,
        loopSectionHidden:document.querySelector("#player-loop-controls")?.hidden,
        loopChecked:document.querySelector("#player-loop-enabled")?.checked,
        selectedTab:document.body.dataset.mainTab,
        speed:document.querySelector("#granular-speed-value")?.value,
        playerStatus:document.querySelector("#granular-optin-status")?.textContent,
        telemetry:{...document.querySelector("#rt-telemetry")?.dataset}
      }));
      console.log("R4_LOOP_SYNC_FAILURE "+JSON.stringify(state));
      throw error;
    }
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
    // #63 U4: the user moves beyond old B and chooses "current position
    // as A". This must USE the tapped source sample, not reject it with a
    // browser validity bubble or require manually editing the old B first.
    await page.click(".player-loop-precision summary");
    await page.click("#player-loop-a-now");
    assert.equal(Number(await page.$eval("#player-loop-a",e=>e.value)),finalSample,
      "new A must be exactly the selected source frame even when A passes old B");
    assert.equal(Number(await page.$eval("#player-loop-b",e=>e.value)),3*sourceRate,
      "old B automatically follows new A to the sample-accurate source end");
    assert.equal(await page.$eval("#player-loop-a",e=>e.validationMessage),"");
    // Symmetric case: set B before the current A, while retaining an
    // end-exclusive nonempty sample interval and no blocking alert.
    await page.$eval("#player-loop-b",e=>{
      e.value="512";e.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(Number(await page.$eval("#player-loop-b",e=>e.value)),512);
    assert.equal(Number(await page.$eval("#player-loop-a",e=>e.value)),511);
    assert.equal(await page.$eval("#player-loop-b",e=>e.validationMessage),"");
    await page.waitForFunction(()=>document.querySelector("#player-loop-hint")
      ?.textContent.includes("反映が完了"),{timeout:15000});
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
test("U1/U5 primary Play routes to REAL selected live/PV/Granular engines and one speed/pitch state",async()=>{
  const port=18772;
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
    await page.evaluateOnNewDocument(()=>{
      const Worklet=window.AudioWorkletNode,NativeWorker=window.Worker;
      window.__engineCreations=[];
      window.AudioWorkletNode=class extends Worklet{
        constructor(ctx,name,opts){
          super(ctx,name,opts);
          window.__engineCreations.push({kind:"worklet",name});
        }
      };
      window.Worker=class extends NativeWorker{
        constructor(url,options){
          super(url,options);
          window.__engineCreations.push({kind:"worker",name:String(url)});
        }
      };
    });
    await page.goto("http://127.0.0.1:"+port+"/",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    assert.equal(await page.$eval("#lab-model",el=>el.value),"granular");
    await (await page.$("#audio-file")).uploadFile(recording);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:10000});
    const set=(id,value)=>page.evaluate(({id,value})=>{
      const el=document.getElementById(id);
      el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
    },{id,value});
    await set("granular-speed-value","1.237");
    await set("granular-pitch-value","0.125");
    await set("player-loop-a","5000");
    await set("player-loop-b","16000");
    await page.click("#main-tab-model");
    assert.equal(await page.$eval("#lab-model",el=>el.value),"granular");
    assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"0.125");
    assert.equal(await page.$eval("#model-transport-host #play-main",el=>el.getClientRects().length>0),true);
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"1.237");
    await set("lab-model","live");
    await page.waitForFunction(()=>document.querySelector("#lab-status")?.textContent
      .includes("Rust/WASM"),{timeout:10000});
    await page.click("#main-tab-player");
    await page.click("#play-main");
    await page.waitForFunction(()=>window.__engineCreations?.some(e=>
      e.kind==="worklet"&&e.name==="frequency-warp-rust"),{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#play-main")
      ?.textContent.includes("モデル停止"),{timeout:20000});
    assert.match(await page.$eval("#lab-model-compatibility",el=>el.textContent),/非対応|未対応/);
    await page.click("#main-tab-model");
    await set("lab-model","pv");
    await page.waitForFunction(()=>window.__engineCreations?.some(e=>
      e.kind==="worker"&&e.name.includes("lab-processor.worker.mjs")),{timeout:20000});
    // The Worker overwrites transient "モデル音声を再生中" status as
    // soon as it prefetches the next chunk. The stable indicator is emitted
    // only by the onStarted callback after real PCM has been scheduled.
    await page.waitForFunction(()=>document.querySelector("#rt-indicator")
      ?.textContent.includes("モデル再生中"),{timeout:20000});
    await set("lab-model","granular");
    await page.waitForFunction(()=>window.__engineCreations?.some(e=>
      e.kind==="worklet"&&e.name==="audio-lab-source-pcm"),{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",e=>e.value),"1.237");
    assert.equal(await page.$eval("#granular-pitch-value",e=>e.value),"0.125");
    assert.equal(await page.$eval("#player-loop-a",e=>e.value),"5000");
    assert.equal(await page.$eval("#player-loop-b",e=>e.value),"16000");
    // One shared edit surface replaces the duplicate model-tab sliders.
    await page.click("#main-tab-player");
    await set("granular-speed-value","1.5");
    await set("granular-pitch-value","0.7");
    await page.click("#main-tab-model");
    assert.equal(await page.$eval("#granular-speed-value",e=>e.value),"1.5");
    assert.equal(await page.$eval("#granular-pitch-value",e=>e.value),"0.7");
    // An unsupported pending model selection retains both canonical input
    // and the existing real audio stream; no silent model substitution.
    await page.click("#main-tab-player");
    await set("granular-speed-value","0");
    await page.click("#main-tab-model");
    const workletsBefore=await page.evaluate(()=>window.__engineCreations.length);
    await set("lab-model","live");
    await page.waitForFunction(()=>document.querySelector("#lab-status")
      ?.textContent.includes("適用待ち"),{timeout:10000});
    assert.equal(await page.$eval("#play-main",e=>e.textContent.includes("モデル停止")),true,
      "the previously playing Granular engine should not be destroyed");
    assert.equal(await page.$eval("#granular-speed-value",e=>e.value),"0");
    assert.equal(await page.evaluate(()=>window.__engineCreations.length),workletsBefore,
      "unsupported live 0x must not instantiate a substituted DSP");
    // When the user restores a compatible speed, the already selected
    // pending Rust model becomes the real processing path automatically.
    await page.click("#main-tab-player");
    await set("granular-speed-value","1.5");
    await page.waitForFunction(()=>document.querySelector("#rt-indicator")
      ?.textContent.includes("Rust/WASM AudioWorklet"),{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",e=>e.value),"1.5");
    assert.deepEqual(errors,[]);
    console.log("U1_U5_REAL_MODEL_ROUTE "+JSON.stringify({
      engines:await page.evaluate(()=>window.__engineCreations),
      speedPitch:"one canonical editable pair",ab:"preserved",
      unsupportedZero:"pending without stopping last-good DSP"
    }));
  }finally{await browser?.close();server.kill("SIGTERM");}
});
