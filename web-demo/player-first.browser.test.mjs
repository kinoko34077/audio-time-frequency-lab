import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

const recording=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||"_site");
const python=process.env.PYTHON_BIN||
  (process.platform==="win32"?"python":"python3");

test("R4 default page: play recorded song, set precise A/B and speed/pitch, switch tabs without reset",async()=>{
  const port=18771;
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
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
    await page.evaluate(()=>{
      window.__r4PointerTrace=[];
      const wave=document.querySelector("#wave-detail");
      for(const type of ["pointerdown","pointermove","pointerup"])
        wave.addEventListener(type,event=>window.__r4PointerTrace.push({
          type,target:event.target?.id,x:event.clientX,y:event.clientY,
          buttons:event.buttons,pointerId:event.pointerId,
          captured:wave.hasPointerCapture(event.pointerId)
        }),true);
    });
    await page.mouse.move(bHandle.x,editingWave.y+editingWave.height*.5);
    await page.mouse.down();
    await page.mouse.move(bHandle.x+55,editingWave.y+editingWave.height*.5,{steps:6});
    await page.mouse.up();
    try{
      await page.waitForFunction(()=>Number(document.querySelector("#player-loop-b").value)>12000,
        {timeout:15000});
    }catch(error){
      const diagnostic=await page.evaluate(({x,y})=>{
        const handle=document.querySelector("#wave-b-marker"),rect=handle.getBoundingClientRect();
        const target=document.elementFromPoint(x,y);
        return {loopA:document.querySelector("#player-loop-a").value,
          loopB:document.querySelector("#player-loop-b").value,
          handle:{hidden:handle.hidden,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
          releaseTarget:{id:target?.id,tag:target?.tagName,className:target?.className},
          pointerTrace:window.__r4PointerTrace};
      },{x:bHandle.x+55,y:editingWave.y+editingWave.height*.5});
      console.log("R4_AB_DRAG_DIAGNOSTIC",JSON.stringify(diagnostic));
      throw Error("B handle drag did not update the endpoint: "+JSON.stringify(diagnostic)+
        " / "+error.message);
    }
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
    // CDP can return before Chrome dispatches the resulting pointer events.
    // Observe the actual zoom update before recording the no-jump baseline.
    await page.waitForFunction(before=>{
      const label=document.querySelector("#wave-zoom-label")?.textContent||"";
      const span=label.startsWith("ms ")?Number(label.slice(3))/1000:
        Number(label.replace("秒",""));
      return span<before;
    },{timeout:5000},beforePinchSpan);
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
    assert.equal(await page.$eval(".player-loop-precision",el=>el.open),true);
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
    // The original button remains a separate audition path; it never aliases
    // the selected Phase Vocoder output.
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
    await cleanupTestProcesses(browser,[server],"player-first R4 HTTP server");
  }
});
test("U1/U5 primary Play routes to REAL selected live/PV/Granular engines and one speed/pitch state",async()=>{
  const port=18772;
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",err=>errors.push(err.message));
    await page.evaluateOnNewDocument(()=>{
      const Worklet=window.AudioWorkletNode,NativeWorker=window.Worker;
      window.__engineCreations=[];
      window.__workerMessages=[];
      window.__workerResponses=[];
      window.__workletFrames=[];
      window.__workletCommands=[];
      window.__lastPcmWorkletId=0;
      const nativePortPostMessage=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(data,...args){
        if(data?.type==="worker-seek-stage")
          window.__workletCommands.push({type:data.type,frame:data.frame,
            generation:data.generation,requestId:data.requestId,
            requiredChunks:data.requiredChunks});
        if((data?.type==="command"&&data.op==="speed")||
           data?.type==="scrub")
          window.__scratchSpeeds?.push(data.speed);
        return nativePortPostMessage.call(this,data,...args);
      };
      MessagePort.prototype.__scratchObserved=true;
      window.AudioWorkletNode=class extends Worklet{
        constructor(ctx,name,opts){
          super(ctx,name,opts);
          const id=window.__engineCreations.length+1;
          window.__engineCreations.push({kind:"worklet",name,id});
          if(name==="audio-lab-source-pcm")window.__lastPcmWorkletId=id;
          this.port.addEventListener("message",event=>{
            if(Number.isSafeInteger(event.data?.sourceFrame))
              window.__workletFrames.push({id,type:event.data.type,
                sourceFrame:event.data.sourceFrame,
                generation:event.data.generation,
                requestId:event.data.requestId,
                missingFrames:event.data.missingFrames,
                reusedChunks:event.data.reusedChunks});
          });
        }
      };
      window.Worker=class extends NativeWorker{
        constructor(url,options){
          super(url,options);
          this.__labName=String(url);
          this.__labCreation={kind:"worker",name:String(url),terminated:false};
          window.__engineCreations.push(this.__labCreation);
          this.addEventListener("message",event=>{
            if(!String(this.__labName).includes("lab-processor.worker.mjs"))return;
            const data=event.data||{};
            window.__workerResponses.push({job:data.job,
              generation:data.generation,ok:data.ok});
          });
        }
        terminate(){
          if(this.__labCreation)this.__labCreation.terminated=true;
          return super.terminate();
        }
        postMessage(message,transfer){
          if(String(this.__labName||"").includes("lab-processor.worker.mjs")){
            window.__workerMessages.push({job:message?.job,
              generation:message?.generation,startFrame:message?.plan?.start,
              endFrame:message?.plan?.start+message?.plan?.core});
          }
          return super.postMessage(message,transfer);
        }
      };
      document.addEventListener("keydown",event=>{
        if(event.target?.id!=="wave"||event.key!=="ArrowRight")return;
        const id=window.__lastPcmWorkletId;
        const current=[...window.__workletFrames].reverse().find(x=>
          x.id===id&&Number.isSafeInteger(x.sourceFrame));
        const canvas=document.getElementById("wave-detail");
        const fileMeta=document.getElementById("file-meta")?.textContent||"";
        const rate=Number(fileMeta.match(/(\d+)Hz/)?.[1]);
        const totalFrames=Number(canvas?.getAttribute("aria-valuemax"))+1;
        if(!current||!(rate>0&&totalFrames>1))return;
        window.__expectedSeekFrame=Math.round(Math.min(
          totalFrames/rate-.01,current.sourceFrame/rate+2)*rate);
      },true);
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
    try{
      await page.waitForFunction(()=>document.querySelector("#lab-status")?.textContent
        .includes("Rust/WASM"),{timeout:10000});
    }catch(error){
      const observed=await page.evaluate(()=>({
        model:document.querySelector("#lab-model").value,
        individual:document.querySelector("#lab-individual-periods").checked,
        speed:document.querySelector("#granular-speed-value").value,
        pitch:document.querySelector("#granular-pitch-value").value,
        status:document.querySelector("#lab-status").textContent,
        description:document.querySelector("#lab-model-description").textContent,
        compatibility:document.querySelector("#lab-model-compatibility").textContent
      }));
      throw Error("Rust model selection status did not settle: "+
        JSON.stringify({observed,errors})+" / "+error.message);
    }
    assert.equal(await page.$eval("#lab-long",el=>el.disabled),false,
      "Rust long-window slider must remain available for its supported setting");
    assert.equal(await page.$eval("#lab-long-value",el=>el.disabled),false,
      "Rust long-window numeric input must remain available");
    await page.click("#main-tab-player");
    await page.click("#play-main");
    await page.waitForFunction(()=>window.__engineCreations?.some(e=>
      e.kind==="worklet"&&e.name==="audio-lab-source-pcm"),{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="rust-engine3-source-time"&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000});
    assert.match(await page.$eval("#rt-indicator",el=>el.textContent),/Rust engine 3部分音＋残差/);
    assert.match(await page.$eval("#lab-model-compatibility",el=>el.textContent),/0\/逆再生・サンプル単位A\/B/);
    const rustNodeStarts=await page.$eval("#rt-telemetry",el=>el.dataset.pcmNodeStarts);
    assert.equal(await page.evaluate(()=>window.__engineCreations.filter(e=>
      e.kind==="worklet"&&e.name==="audio-lab-source-pcm").length),1,
      "Rust must render inside the shared PCM Worklet");
    assert.equal(await page.evaluate(()=>window.__engineCreations.some(e=>
      e.kind==="worklet"&&e.name==="frequency-warp-rust")),false,
      "Rust primary playback must not launch its separate legacy Worklet");
    // The Rust FFT size is fixed when its WASM renderer is constructed. A
    // live long-window edit must rebuild the same shared PCM route so the new
    // setting reaches the DSP instead of changing only the visible control.
    await page.click("#main-tab-model");
    const nodeStartsBeforeLongChange=Number(await page.$eval("#rt-telemetry",
      el=>el.dataset.pcmNodeStarts));
    const currentLong=await page.$eval("#lab-long",el=>el.value);
    const nextLong=currentLong==="12"?"11":"12";
    await set("lab-long",nextLong);
    await page.waitForFunction(before=>{
      const telemetry=document.querySelector("#rt-telemetry");
      return Number(telemetry?.dataset.pcmNodeStarts)>before&&
        telemetry?.dataset.pcmTransport==="rust-engine3-source-time"&&
        document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true";
    },{timeout:20000},nodeStartsBeforeLongChange);
    const afterLongChange=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      route:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      speed:document.querySelector("#granular-speed-value").value,
      pitch:document.querySelector("#granular-optin-status").dataset.renderPitch,
      long:document.querySelector("#lab-long").value
    }));
    assert.equal(afterLongChange.starts,nodeStartsBeforeLongChange+1,
      "changing the Rust long window recreates one shared renderer");
    assert.equal(afterLongChange.route,"rust-engine3-source-time");
    assert.equal(afterLongChange.speed,"1.237");
    assert.equal(afterLongChange.pitch,"0.125");
    assert.equal(afterLongChange.long,nextLong);
    await page.click("#main-tab-player");
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
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="granular-experimental",{timeout:20000});
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
    // Rust supports audible 0x on the shared source clock. Switching from
    // Granular must activate Rust's partial+residual DSP in the same node.
    await page.click("#main-tab-player");
    await set("granular-speed-value","0");
    await page.click("#main-tab-model");
    const pcmRoutesBeforeRustZero=await page.$eval("#rt-telemetry",el=>el.dataset.pcmNodeStarts);
    await set("lab-model","live");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="rust-engine3-source-time"&&
      document.querySelector("#granular-optin-status")?.dataset.renderRunning==="true",
      {timeout:20000});
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "transport status stays inline without a duplicate HUD");
    assert.doesNotMatch(await page.$eval("#lab-status",el=>el.textContent),/適用待ち/);
    const rustAtZero=await page.evaluate(()=>({
      mode:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      running:document.querySelector("#granular-optin-status").dataset.renderRunning,
      speed:document.querySelector("#granular-speed-value").value,
      stopDisabled:document.querySelector("#stop").disabled,
      nodeStarts:document.querySelector("#rt-telemetry").dataset.pcmNodeStarts
    }));
    assert.equal(rustAtZero.mode,"rust-engine3-source-time",JSON.stringify(rustAtZero));
    assert.equal(rustAtZero.running,"true",JSON.stringify(rustAtZero));
    assert.equal(rustAtZero.speed,"0",JSON.stringify(rustAtZero));
    assert.equal(rustAtZero.stopDisabled,false);
    assert.equal(Number(rustAtZero.nodeStarts),Number(pcmRoutesBeforeRustZero)+1,
      "selecting Rust creates one instance of the shared PCM Worklet");
    const rustRouteNodeCount=await page.evaluate(()=>window.__engineCreations.filter(e=>
      e.kind==="worklet"&&e.name==="audio-lab-source-pcm").length);
    const frozenAt=await page.$eval("#granular-optin-status",el=>el.dataset.renderFrame);
    await page.click("#main-tab-player");
    await page.focus("#wave");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(before=>document.querySelector("#granular-optin-status")
      ?.dataset.renderFrame!==before,{timeout:8000},frozenAt);
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"0",
      "seek at audible 0x must preserve the selected speed");
    assert.equal(await page.$eval("#rt-telemetry",el=>el.dataset.pcmTransport),"rust-engine3-source-time");
    assert.equal(await page.evaluate(()=>window.__engineCreations.filter(e=>
      e.kind==="worklet"&&e.name==="audio-lab-source-pcm").length),rustRouteNodeCount,
      "zero-speed seek must not create another render path");
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
    const beforeSeekWorkers=await page.evaluate(()=>{
      const workers=window.__engineCreations.filter(x=>x.kind==="worker"&&
        x.name.includes("lab-processor.worker.mjs"));
      return {created:workers.length,active:workers.filter(x=>!x.terminated).length};
    });
    const beforeSeekPcmNodes=await page.evaluate(()=>window.__engineCreations.filter(x=>
      x.kind==="worklet"&&x.name==="audio-lab-source-pcm").length);
    assert.equal(beforeSeekWorkers.active,1,
      "exactly one primary Worker is active before seek");
    const beforeSeekGeneration=await page.evaluate(()=>Math.max(-1,...window.__workletFrames
      .filter(x=>x.type==="worker-state-activated"&&
        Number.isSafeInteger(x.generation)).map(x=>x.generation)));
    const missingBeforeSeek=await page.evaluate(()=>
      [...window.__workletFrames].reverse().find(x=>
        x.type==="worker-state-activated")?.missingFrames||0);
    await page.focus("#wave");
    await page.keyboard.press("ArrowRight");
    const expectedSeekFrame=await page.evaluate(()=>window.__expectedSeekFrame);
    assert.ok(Number.isSafeInteger(expectedSeekFrame),
      "keyboard event must observe the shared source-frame cursor before seeking");
    const loopTarget=await page.evaluate(()=>({
      start:Number(document.querySelector("#player-loop-a")?.value),
      end:Number(document.querySelector("#player-loop-b")?.value),
      enabled:document.querySelector("#player-loop-enabled")?.checked
    }));
    const loopLength=loopTarget.end-loopTarget.start;
    const normalizedSeekFrame=loopTarget.enabled&&
      (expectedSeekFrame<loopTarget.start||expectedSeekFrame>=loopTarget.end)?
      loopTarget.start+((expectedSeekFrame-loopTarget.start)%loopLength+
        loopLength)%loopLength:expectedSeekFrame;
    try{
      await page.waitForFunction(({generation,frame})=>
        window.__workletCommands.some(x=>x.type==="worker-seek-stage"&&
          x.generation>generation&&x.frame===frame),
        {timeout:20000},{generation:beforeSeekGeneration,frame:normalizedSeekFrame});
    }catch(error){
      const diagnostic=await page.evaluate(({generation,frame})=>({
        expectedFrame:frame,
        commands:window.__workletCommands.filter(x=>
          x.type==="worker-seek-stage"&&x.generation>generation),
        activations:window.__workletFrames.filter(x=>
          x.type==="worker-state-activated"&&x.generation>generation),
        latestEvents:window.__workletFrames.slice(-12)
      }),{generation:beforeSeekGeneration,frame:normalizedSeekFrame});
      throw Error("A/B-normalized source-frame command did not reach the Worklet: "+
        JSON.stringify(diagnostic)+" / "+error.message);
    }
    const seekCommand=await page.evaluate(({generation,frame})=>
      window.__workletCommands.findLast(x=>x.type==="worker-seek-stage"&&
        x.generation>generation&&x.frame===frame),
      {generation:beforeSeekGeneration,frame:normalizedSeekFrame});
    try{
      await page.waitForFunction(generation=>{
        const workers=window.__engineCreations.filter(x=>x.kind==="worker"&&
          x.name.includes("lab-processor.worker.mjs"));
        return window.__workletFrames.some(x=>
            x.type==="worker-state-activated"&&x.generation===generation)&&
          workers.filter(x=>!x.terminated).length===1;
      },{timeout:20000},seekCommand.generation);
    }catch(error){
      const diagnostic=await page.evaluate(generation=>{
        const workers=window.__engineCreations.filter(x=>x.kind==="worker"&&
          x.name.includes("lab-processor.worker.mjs"));
        return {workers:workers.map(x=>({terminated:x.terminated,name:x.name})),
          commands:window.__workletCommands.filter(x=>x.generation>generation),
          messages:window.__workerMessages.filter(x=>x.generation===generation),
          responses:window.__workerResponses.filter(x=>x.generation===generation),
          workletEvents:window.__workletFrames.slice(-20),
          workletEventTypes:[...new Set(window.__workletFrames.map(x=>x.type))]};
      },seekCommand.generation);
      throw Error("seek handoff lifecycle did not settle: "+JSON.stringify(diagnostic)+
        " / "+error.message);
    }
    const seekRender=await page.evaluate(generation=>({
      workers:window.__engineCreations.filter(x=>x.kind==="worker"&&
        x.name.includes("lab-processor.worker.mjs")),
      messages:window.__workerMessages.filter(x=>x.generation===generation),
      responses:window.__workerResponses.filter(x=>x.generation===generation),
      activations:window.__workletFrames.filter(x=>
        x.type==="worker-state-activated"&&x.generation===generation),
      pcmNodeCount:window.__engineCreations.filter(x=>
        x.kind==="worklet"&&x.name==="audio-lab-source-pcm").length
    }),seekCommand.generation);
    const addedSeekWorkers=seekRender.workers.length-beforeSeekWorkers.created;
    assert.ok(addedSeekWorkers===0||addedSeekWorkers===1,
      "seek reuses the active Worker or creates at most one temporary handoff Worker");
    assert.equal(seekRender.workers.filter(x=>!x.terminated).length,
      beforeSeekWorkers.active,
      "seek leaves the same number of Workers active after PCM activation");
    assert.equal(seekRender.pcmNodeCount,beforeSeekPcmNodes,
      "seek keeps the existing shared PCM Worklet");
    assert.equal(seekCommand.frame,normalizedSeekFrame,
      "the Worklet must receive the A/B-normalized seek source frame: "+
      JSON.stringify({seekCommand,expectedSeekFrame,normalizedSeekFrame,loopTarget}));
    assert.ok(seekRender.activations.length>0,
      "seek PCM must activate in the existing shared Worklet");
    assert.ok(seekRender.activations.some(x=>
      x.sourceFrame===normalizedSeekFrame&&x.missingFrames===missingBeforeSeek),
      "the shared clock must activate at the exact A/B-normalized frame without new PCM loss: "+
      JSON.stringify({normalizedSeekFrame,loopTarget,
        missingBeforeSeek,activations:seekRender.activations}));
    assert.ok(seekRender.messages.every(x=>
      x.startFrame<=normalizedSeekFrame&&x.endFrame>normalizedSeekFrame),
      "any newly rendered seek PCM must cover the requested source frame: "+
      JSON.stringify({normalizedSeekFrame,messages:seekRender.messages}));
    assert.ok(seekRender.responses.every(x=>x.ok===true),
      "any newly rendered seek Worker job must complete successfully");
    await page.waitForFunction(()=>{
      const text=document.querySelector("#rt-indicator")?.textContent||"";
      return text.includes("モデル再生中")&&text.includes("PV");
    },{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"0");
    assert.match(await page.$eval("#lab-status",el=>el.textContent),/適用待ち/);
    assert.match(await page.$eval("#rt-telemetry",el=>el.textContent),/Worker/,
      "active Worker status remains visible beside the unapplied speed request");
    assert.equal(await page.$eval("#stop",el=>el.disabled),false);
    assert.deepEqual(errors,[]);
    console.log("U1_U5_REAL_MODEL_ROUTE "+JSON.stringify({
      engines:await page.evaluate(()=>window.__engineCreations),
      speedPitch:"one canonical editable pair",ab:"preserved",
      rustZero:"audible frozen source cursor and shared-clock seek",
      individualPeriodWorkerZero:"pending without stopping last-good DSP"
    }));
  }finally{await cleanupTestProcesses(browser,[server],
    "player-first selected-model HTTP server");}
});

test("U7 touch tap seeks without autoplay; deliberate drag auditions PCM, paused remains paused",async()=>{
  const port=18775,server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
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
  }finally{await cleanupTestProcesses(browser,[server],
    "player-first touch HTTP server");}
});


test("shared A/B updates every realtime model and compact numeric controls stay expanded",async()=>{
  const port=18809;
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage();
    await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    const ui=await page.evaluate(()=>({
      modelInfo:document.querySelector(".model-info-controls").open,
      modelDetails:document.querySelector(".model-extra-controls").open,
      loopDetails:document.querySelector(".player-loop-precision").open,
      inlinePitch:document.querySelector("#granular-pitch-value").closest(".player-tune-control")===
        document.querySelector("#granular-pitch").closest(".player-tune-control"),
      inlineSpeed:document.querySelector("#granular-speed-value").closest(".player-tune-control")===
        document.querySelector("#granular-speed").closest(".player-tune-control"),
      railRangeAlwaysVisible:document.querySelector("#granular-range").closest("details")===null,
      noDevelopmentQualityNote:document.querySelector(".player-quality-note")===null,
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
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="pv-phase-locked",{timeout:20000});
    const routes={spectral:"spectral-realtime",pv:"pv-phase-locked",
      wsola:"wsola-source-time",dual:"dual-transient-source-time",
      am:"am-envelope-source-time",granular:"granular-experimental"};
    for(const [index,[mode,route]] of Object.entries(routes).entries()){
      // Keep this route matrix independent of the user's current default model.
      await page.evaluate(selected=>{
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
    await cleanupTestProcesses(browser,[server],
      "player-first settings HTTP server");
  }
});
