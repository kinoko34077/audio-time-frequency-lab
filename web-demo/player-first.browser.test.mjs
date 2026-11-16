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
    await page.goto("http://127.0.0.1:"+port+"/?model=granular",{waitUntil:"domcontentloaded",timeout:20000});
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
    // A previously emitted "playing" warning can outlive actual transport.
    // Exercise real Worklet pause/resume with the stale warning retained.
    await page.evaluate(()=>{
      const status=document.querySelector("#status");
      status.dataset.kind="warning";
      status.textContent="再生中。警告の詳細は保持されています。";
    });
    await page.waitForFunction(()=>{
      const summary=document.querySelector("#audio-state-summary");
      return summary?.dataset.kind==="warning"&&
        summary.textContent.includes("警告の詳細は保持されています。");
    },{timeout:4000});
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#play-main")
      ?.textContent.includes("再開")&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="false",
      {timeout:15000});
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.textContent.startsWith("一時停止中"),{timeout:4000});
    assert.ok(!await page.$eval("#audio-state-summary",
      el=>el.textContent.includes("一時停止中 · 再生中")),
      "stale playing warning cannot mask an actual Worklet pause");
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
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.textContent.startsWith("再生中"),{timeout:4000});
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
    await page.evaluate(()=>{
      const status=document.querySelector("#status");
      status.dataset.kind="warning";
      status.textContent="再生中。停止前の注意を保持します。";
    });
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.textContent.startsWith("停止中"),{timeout:4000});
    assert.ok(!await page.$eval("#audio-state-summary",
      el=>el.textContent.includes("停止中 · 再生中")),
      "the visible status must not claim playback after Stop");
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
    await page.goto("http://127.0.0.1:"+port+"/?model=granular",{
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
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="pv-phase-locked"&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000});
    // Normal PV is now a real peak-phase-locked AudioWorklet, not the
    // historical 1.5s Worker buffer disguised as realtime scratch.
    assert.match(await page.$eval("#rt-indicator",el=>el.textContent),
      /PVピーク位相ロック/);
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
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.textContent.includes("適用待ち"),{timeout:4000});
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "pending model must be shown in the one-line status, not a separate HUD");
    // Granular's primary button means "Pause", not legacy "モデル停止".
    // Verify actual render and the still-owned source PCM session instead of
    // asserting a label belonging to a different engine.
    const retained=await page.evaluate(()=>({
      mode:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      running:document.querySelector("#granular-optin-status").dataset.renderRunning,
      primary:document.querySelector("#play-main").textContent,
      stopDisabled:document.querySelector("#stop").disabled
    }));
    assert.equal(retained.mode,"granular-experimental",
      "pending model must retain the actual playing Granular engine: "+JSON.stringify(retained));
    assert.equal(retained.running,"true",
      "pending model must not stop the source PCM audio render: "+JSON.stringify(retained));
    assert.equal(retained.stopDisabled,false);
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

    // Independent review #71 P2 regression: a requested 0x is pending for
    // Rust, but ArrowRight seek must use its ACTUALLY APPLIED 1.5x source.
    await page.evaluate(()=>{
      window.__pendingRustSeekStarts=[];
      const proto=AudioBufferSourceNode.prototype,original=proto.start;
      proto.start=function(...args){
        window.__pendingRustSeekStarts.push({
          speed:this.playbackRate.value,offset:args[1]??0
        });
        return original.apply(this,args);
      };
    });
    await set("granular-speed-value","0");
    await page.waitForFunction(()=>document.querySelector("#lab-status")
      ?.textContent.includes("適用待ち"),{timeout:10000});
    await page.focus("#wave");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(()=>window.__pendingRustSeekStarts.length>0,{timeout:8000});
    const rustSeek=await page.evaluate(()=>window.__pendingRustSeekStarts.at(-1));
    assert.equal(rustSeek.speed,1.5,
      "pending 0x must not change the actual Rust source playback rate");
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"0");
    assert.match(await page.$eval("#lab-status",el=>el.textContent),/適用待ち/);

    // Preserve the old Worker-specific pending seek regression: it now
    // applies to PV+period-joint, which deliberately retains that backend.
    // The ordinary PV path above is a real signed-speed Worklet.
    await set("granular-speed-value","1.5");
    await page.click("#main-tab-model");
    await set("lab-model","pv");
    await page.$eval("#lab-individual-periods",el=>{
      el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>window.__engineCreations?.some(e=>
      e.kind==="worker"&&e.name.includes("lab-processor.worker.mjs")),{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#rt-indicator")
      ?.textContent.includes("モデル再生中"),{timeout:20000});
    await page.click("#main-tab-player");
    await set("granular-speed-value","0");
    await page.waitForFunction(()=>document.querySelector("#lab-status")
      ?.textContent.includes("適用待ち"),{timeout:10000});
    const beforeSeekWorker=await page.evaluate(()=>window.__engineCreations
      .filter(x=>x.kind==="worker"&&x.name.includes("lab-processor.worker.mjs")).length);
    await page.focus("#wave");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(before=>window.__engineCreations
      .filter(x=>x.kind==="worker"&&x.name.includes("lab-processor.worker.mjs")).length>before,
      {timeout:20000},beforeSeekWorker);
    await page.waitForFunction(()=>{
      const text=document.querySelector("#rt-indicator")?.textContent||"";
      return text.includes("モデル再生中")&&text.includes("PV");
    },{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"0");
    assert.match(await page.$eval("#lab-status",el=>el.textContent),/適用待ち/);
    assert.equal(await page.$eval("#stop",el=>el.disabled),false);
    assert.deepEqual(errors,[]);
    console.log("U1_U5_REAL_MODEL_ROUTE "+JSON.stringify({
      engines:await page.evaluate(()=>window.__engineCreations),
      speedPitch:"one canonical editable pair",ab:"preserved",
      unsupportedZero:"pending without stopping last-good DSP"
    }));
  }finally{await browser?.close();server.kill("SIGTERM");}
});

test("U7 touch tap seeks without autoplay; deliberate drag auditions PCM, paused remains paused",async()=>{
  const port=18775,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
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
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?model=granular`,{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await (await page.$("#audio-file")).uploadFile(recording);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
    await page.waitForSelector("#play-main:not([disabled])",{timeout:10000});
    const touch=await page.createCDPSession();
    await touch.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:2});
    const point=async(selector,fraction,id)=>{
      const b=await page.$eval(selector,el=>{
        el.scrollIntoView({block:"center"});
        const r=el.getBoundingClientRect();
        return {x:r.x,y:r.y,w:r.width,h:r.height};
      });
      return {x:Math.round(b.x+b.w*fraction),y:Math.round(b.y+b.h*.67),id};
    };
    const tap=async(selector,id,fraction=.54)=>{
      const p=await point(selector,fraction,id);
      await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[p]});
      await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    };
    const audio=()=>page.evaluate(()=>({
      transport:document.querySelector("#rt-telemetry")?.dataset.pcmTransport||"",
      starts:Number(document.querySelector("#rt-telemetry")?.dataset.pcmNodeStarts||0),
      running:document.querySelector("#granular-optin-status")?.dataset.renderRunning||"",
      button:document.querySelector("#play-main")?.textContent
    }));
    const initial=await audio();
    assert.equal(initial.transport,"");
    await tap("#wave",31,.35);
    await new Promise(resolve=>setTimeout(resolve,350));
    const overviewTap=await audio();
    assert.equal(overviewTap.transport,"","overview tap must only seek: "+JSON.stringify(overviewTap));
    assert.equal(overviewTap.starts,initial.starts);
    await tap("#wave-detail",32);
    await new Promise(resolve=>setTimeout(resolve,350));
    const detailTap=await audio();
    assert.equal(detailTap.transport,"","detail tap must not autoplay: "+JSON.stringify(detailTap));
    assert.equal(detailTap.starts,initial.starts);
    // A real dragged touch, as opposed to a stationary tap, must still
    // initiate the actual granular PCM output path. This does not change
    // the saved speed/pitch and allows normal DJ-style release kinetics.
    const p=await point("#wave-detail",.56,33);
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[p]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[
      {...p,x:p.x-75}
    ]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="granular-experimental"&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000});
    const started=await audio();
    assert.ok(started.starts>=1,"drag must start an actual PCM Worklet");
    await page.click("#play-main");
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="false",{timeout:10000});
    await tap("#wave",34);
    await tap("#wave-detail",35);
    await new Promise(resolve=>setTimeout(resolve,200));
    const paused=await audio();
    assert.equal(paused.running,"false",
      "tap while explicitly paused must not silently unpause the Worklet");
    assert.equal(paused.starts,started.starts);
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    // Full-track overview must also start deliberate scratch *motion* from
    // stopped state, while a tap on the exact same surface did not.
    const overviewDrag=await point("#wave",.43,36);
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[overviewDrag]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[
      {...overviewDrag,x:overviewDrag.x+75}
    ]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="granular-experimental"&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000});
    const overviewStarted=await audio();
    assert.ok(overviewStarted.starts>started.starts,
      "overview drag must start a new audible Worklet, not an inert seek");
    await touch.send("Emulation.setTouchEmulationEnabled",{enabled:false});
    assert.deepEqual(errors,[]);
    console.log("U7_REAL_TOUCH_INTENT "+JSON.stringify({
      overviewTap,detailTap,detailDrag:started,pausedTap:paused,
      overviewDrag:overviewStarted
    }));
  }finally{await browser?.close();server.kill("SIGTERM");}
});


test("shared A/B updates every realtime model and compact numeric controls stay expanded",async()=>{
  const port=18809;
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
    const page=await browser.newPage();
    await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    const ui=await page.evaluate(()=>({
      modelInfo:document.querySelector(".model-info-controls").open,
      modelDetails:document.querySelector(".model-extra-controls").open,
      loopDetails:document.querySelector(".player-loop-precision").open,
      inlinePitch:document.querySelector("#granular-pitch-value").closest(".player-tune-heading")!==null,
      inlineSpeed:document.querySelector("#granular-speed-value").closest(".player-tune-heading")!==null,
      inlineAB:document.querySelector("#player-loop-a").closest(".loop-point")!==null,
      modelNumbers:["lab-short","lab-long","lab-windows","lab-period-cycles"]
        .every(id=>document.querySelector("#"+id+"-value")?.type==="number"),
      hiddenOutputs:["granular-pitch-output","granular-speed-output","lab-short-output"]
        .every(id=>document.getElementById(id).hidden)
    }));
    assert.ok(Object.values(ui).every(Boolean),JSON.stringify(ui));
    await (await page.$("#audio-file")).uploadFile(recording);
    await page.waitForSelector("#play-main:not([disabled])",{timeout:20000});
    await page.click("#play-main");
    const routes={spectral:"spectral-realtime",pv:"pv-phase-locked",
      wsola:"wsola-source-time",dual:"dual-transient-source-time",
      granular:"granular-experimental"};
    for(const [index,[mode,route]] of Object.entries(routes).entries()){
      if(mode!=="spectral")await page.evaluate(selected=>{
        const input=document.getElementById("lab-model");
        input.value=selected;input.dispatchEvent(new Event("change",{bubbles:true}));
      },mode);
      await page.waitForFunction(expected=>
        document.querySelector("#rt-telemetry")?.dataset.pcmTransport===expected,
        {timeout:20000},route);
      const starts=Number(await page.$eval("#rt-telemetry",el=>el.dataset.pcmNodeStarts));
      const a=1000+index*150,b=4000+index*150;
      await page.evaluate(({a,b})=>{
        for(const [id,value] of [["player-loop-a",a],["player-loop-b",b]]){
          const input=document.getElementById(id);
          input.value=String(value);
          input.dispatchEvent(new Event("change",{bubbles:true}));
        }
      },{a,b});
      await page.waitForFunction(({a,b})=>{
        const hint=document.querySelector("#player-loop-hint")?.textContent||"";
        const frame=Number(document.querySelector("#granular-optin-status")?.dataset.renderFrame);
        return hint.includes("反映が完了")&&Number.isFinite(frame)&&frame>=a&&frame<b;
      },{timeout:12000},{a,b});
      const after=Number(await page.$eval("#rt-telemetry",el=>el.dataset.pcmNodeStarts));
      assert.equal(after,starts,mode+" must not recreate the Worklet on A/B edits");
    }
    // The number itself is editable; it is not an inert duplicate readout.
    await page.evaluate(()=>{
      const selected=document.querySelector("#lab-model");
      selected.value="dual";
      selected.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#lab-short-value")?.disabled===false,
      {timeout:10000});
    await page.evaluate(()=>{
      const input=document.querySelector("#lab-short-value");
      input.value="256";
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#lab-short").value==="8"&&
      document.querySelector("#lab-short-value").value==="256"&&
      document.querySelector("#lab-short-output").textContent==="256 samples",
      {timeout:10000});
    await page.evaluate(()=>{
      const input=document.querySelector("#lab-short-value");
      input.value="300";
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    assert.equal(await page.$eval("#lab-short",el=>el.value),"8",
      "invalid freeform FFT size must not silently change the model");
    assert.equal(await page.$eval("#lab-short-value",el=>el.validity.customError),true);
  }finally{
    await browser?.close();
    server.kill("SIGTERM");
  }
});
