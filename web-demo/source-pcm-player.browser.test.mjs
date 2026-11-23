import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

test("live Audio Lab routes the selected Rust model through the shared PCM node",async()=>{
  // Verify the production entry point with a user-shaped native WAV file,
  // including the selected Rust DSP route through the shared PCM Worklet.
  const port=18745;
  const python=process.env.PYTHON_BIN||
    (process.platform==="win32"?"python":"python3");
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("_site"),stdio:"ignore"
  });
  let browser;
  let testFailure=null;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage();
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?pcmTransport=1&legacyUi=1`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
    // The actual module and input listeners must be ready before file change.
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    // The same input path as the end user, no test-only audio engine hook.
    await page.evaluate(()=>{
      const sampleRate=48000,count=sampleRate*2;
      const bytes=new ArrayBuffer(44+count*2),v=new DataView(bytes);
      const ascii=(i,text)=>{for(let j=0;j<text.length;j++)v.setUint8(i+j,text.charCodeAt(j));};
      ascii(0,"RIFF");v.setUint32(4,36+count*2,true);ascii(8,"WAVE");
      ascii(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);
      v.setUint16(22,1,true);v.setUint32(24,sampleRate,true);
      v.setUint32(28,sampleRate*2,true);v.setUint16(32,2,true);
      v.setUint16(34,16,true);ascii(36,"data");v.setUint32(40,count*2,true);
      for(let i=0;i<count;i++)
        v.setInt16(44+2*i,Math.round(14000*Math.sin(2*Math.PI*440*i/sampleRate)),true);
      const input=document.querySelector("#audio-file"),data=new DataTransfer();
      data.items.add(new File([bytes],"pcm-optin.wav",{type:"audio/wav"}));
      input.files=data.files;
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("pcm-optin.wav · 48000Hz · 1ch"),{timeout:20000});
    await page.waitForSelector("#play-dry:not([disabled])",{timeout:10000});
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental",{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.textContent.includes("cache不足"),{timeout:20000});
    const initial=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      text:document.querySelector("#rt-telemetry").textContent,
      indicator:document.querySelector("#rt-indicator").textContent,
      stopEnabled:!document.querySelector("#stop").disabled,
      wetEnabled:!document.querySelector("#play-wet").disabled
    }));
    assert.equal(initial.starts,1);
    assert.equal(initial.stopEnabled,true);
    assert.equal(initial.wetEnabled,true);
    assert.equal(initial.indicator,"原音再生中");
    assert.match(initial.text,/cache不足 0/);
    // Seek the loaded audio while it is playing: old app used stop/startSource,
    // but the R2 opt-in must retain the same Worklet instance.
    await page.evaluate(()=>{
      const wave=document.querySelector("#wave");
      const r=wave.getBoundingClientRect();
      wave.dispatchEvent(new PointerEvent("pointerdown",{
        bubbles:true,clientX:r.left+r.width*.6,clientY:r.top+r.height/2
      }));
    });
    await new Promise(resolve=>setTimeout(resolve,300));
    const after=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      telemetry:document.querySelector("#rt-telemetry").textContent,
      elapsed:document.querySelector("#elapsed").textContent
    }));
    assert.equal(after.starts,initial.starts,"seek restarted source Worklet");
    assert.match(after.telemetry,/cache不足 0/);
    assert.match(after.elapsed,/0:01/);

    // Selecting Rust in the model tab now switches the active player to the
    // real source-time Rust engine on the shared PCM Worklet.
    await page.click("#main-tab-model");
    await page.evaluate(()=>{
      const model=document.querySelector("#lab-model");
      model.value="live";model.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#lab-model").value==="live",{
      timeout:10000
    });
    // A model selection preserves currently playing original audio until the
    // explicit transformed-play request applies that selected DSP.
    await page.click("#play-wet");
    try{
      await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
        ?.dataset.pcmTransport==="rust-engine3-source-time",{timeout:20000});
    }catch(error){
      const observed=await page.evaluate(()=>({
        selectedModel:document.querySelector("#lab-model").value,
        status:document.querySelector("#status").textContent,
        labStatus:document.querySelector("#lab-status").textContent,
        indicator:document.querySelector("#rt-indicator").textContent,
        transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
        starts:document.querySelector("#rt-telemetry").dataset.pcmNodeStarts,
        telemetry:document.querySelector("#rt-telemetry").textContent
      }));
      throw Error("Selected Rust model did not start: "+
        JSON.stringify({observed,errors})+" / "+error.message);
    }
    const rust=await page.evaluate(()=>({
      transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      indicator:document.querySelector("#rt-indicator").textContent
    }));
    assert.equal(rust.transport,"rust-engine3-source-time");
    assert.equal(rust.starts,initial.starts+1);
    assert.match(rust.indicator,/Rust · 再生中/);
    // The legacy wet button resolves to this same selected live model. A
    // duplicate request must keep the actual Rust renderer and node alive.
    await page.click("#play-wet");
    await new Promise(resolve=>setTimeout(resolve,300));
    const unchanged=await page.evaluate(()=>({
      transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      nodes:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts)
    }));
    assert.equal(unchanged.transport,"rust-engine3-source-time");
    assert.equal(unchanged.nodes,rust.starts);

    const beforeStop=await page.evaluate(()=>{
      const el=document.querySelector("#stop"),rect=el.getBoundingClientRect();
      const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return {disabled:el.disabled,rect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height},
        hit:hit?.id||hit?.tagName,indicator:document.querySelector("#rt-indicator").textContent,
        status:document.querySelector("#status").textContent,
        pcm:document.querySelector("#rt-telemetry").dataset.pcmTransport};
    });
    await page.click("#stop");
    try{
      await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
        ?.dataset.pcmTransport,{timeout:3500});
    }catch(error){
      const afterStop=await page.evaluate(()=>({
        disabled:document.querySelector("#stop").disabled,
        pcm:document.querySelector("#rt-telemetry").dataset.pcmTransport,
        indicator:document.querySelector("#rt-indicator").textContent,
        status:document.querySelector("#status").textContent}));
      throw Error("Legacy Stop failed to clear PCM session: "+
        JSON.stringify({beforeStop,afterStop})+" / "+error.message);
    }

    // A startup failure must never strand the original/wet playback controls.
    await page.evaluate(()=>{
      window.__nativeAudioWorkletNode=window.AudioWorkletNode;
      window.AudioWorkletNode=function(ctx,name,options){
        if(name==="audio-lab-source-pcm")throw Error("simulated raw backend failure");
        return new window.__nativeAudioWorkletNode(ctx,name,options);
      };
    });
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#status")
      ?.textContent.includes("PCM実験経路の起動失敗"),{timeout:10000});
    const recovered=await page.evaluate(()=>({
      dry:!document.querySelector("#play-dry").disabled,
      wet:!document.querySelector("#play-wet").disabled,
      pcm:document.querySelector("#rt-telemetry").dataset.pcmTransport
    }));
    assert.equal(recovered.dry,true,"failed raw start disabled dry retry");
    assert.equal(recovered.wet,true,"failed raw start disabled wet fallback option");
    assert.equal(recovered.pcm,undefined);
    await page.evaluate(()=>{
      window.AudioWorkletNode=function(ctx,name,options){
        const node=new window.__nativeAudioWorkletNode(ctx,name,options);
        if(name==="audio-lab-source-pcm")window.__faultTargetPCMNode=node;
        return node;
      };
    });
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental",{timeout:12000});
    // The real app should create a fresh PCM processor and resume the same
    // playing route after one runtime failure.
    const startsBeforeFault=await page.$eval("#rt-telemetry",el=>
      Number(el.dataset.pcmNodeStarts));
    await page.evaluate(()=>{
      window.__faultTargetPCMNode.dispatchEvent(new Event("processorerror"));
    });
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental"&&
      document.querySelector("#rt-indicator")?.textContent.includes("自動復旧"),
      {timeout:10000});
    const afterFatal=await page.evaluate(()=>({
      dry:!document.querySelector("#play-dry").disabled,
      wet:!document.querySelector("#play-wet").disabled,
      file:document.querySelector("#file-meta").textContent,
      raw:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      indicator:document.querySelector("#rt-indicator").textContent
    }));
    assert.equal(afterFatal.dry,true);
    assert.equal(afterFatal.wet,true);
    assert.match(afterFatal.file,/pcm-optin.wav/);
    assert.equal(afterFatal.raw,"raw-experimental");
    assert.match(afterFatal.indicator,/自動復旧/);
    assert.equal(Number(await page.$eval("#rt-telemetry",el=>
      el.dataset.pcmNodeStarts)),startsBeforeFault+1);
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});

    // A manual stop ends the prior recovery episode. A later runtime failure
    // must get its own one-time recovery instead of being mistaken for a loop.
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental",{timeout:12000});
    const startsBeforeSecondFault=await page.$eval("#rt-telemetry",el=>
      Number(el.dataset.pcmNodeStarts));
    await page.evaluate(()=>window.__faultTargetPCMNode.dispatchEvent(
      new Event("processorerror")));
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental"&&
      document.querySelector("#rt-indicator")?.textContent.includes("自動復旧"),
      {timeout:10000});
    assert.equal(Number(await page.$eval("#rt-telemetry",el=>
      el.dataset.pcmNodeStarts)),startsBeforeSecondFault+1);
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});

    // A different failure boundary: crash *during* the initial play ACK
    // while both buttons are disabled. The same loaded file must recover.
    await page.evaluate(()=>{
      window.__startupFaultFired=false;
      window.__startupStateHistory=[];
      const status=document.querySelector("#status");
      const indicator=document.querySelector("#rt-indicator");
      const controls=[...document.querySelectorAll("#play-main,#play-dry,#play-wet")];
      const observe=new MutationObserver(()=>window.__startupStateHistory.push({
        status:status.textContent,indicator:indicator.textContent,
        disabled:controls.map(control=>control.disabled)
      }));
      observe.observe(status,{childList:true,characterData:true,subtree:true});
      observe.observe(indicator,{childList:true,characterData:true,subtree:true});
      controls.forEach(control=>observe.observe(control,
        {attributes:true,attributeFilter:["disabled"]}));
      window.AudioWorkletNode=function(ctx,name,options){
        const node=new window.__nativeAudioWorkletNode(ctx,name,options);
        if(name==="audio-lab-source-pcm"){
          const nativePost=node.port.postMessage.bind(node.port);
          node.port.postMessage=(...args)=>{
            nativePost(...args);
            if(args[0]?.type==="command"&&args[0]?.op==="play"){
              window.__startupFaultFired=true;
              node.dispatchEvent(new Event("processorerror"));
            }
          };
        }
        return node;
      };
    });
    await page.click("#play-dry");
    try{
      await page.waitForFunction(()=>{
        const d=document;
        return window.__startupFaultFired&&
          !d.querySelector("#play-dry").disabled&&
          !d.querySelector("#play-wet").disabled&&
          d.querySelector("#status").textContent.includes("音源は保持されています")&&
          d.querySelector("#rt-indicator").textContent.includes("処理失敗")&&
          d.querySelector("#rt-telemetry").dataset.pcmTransport===undefined;
      },{timeout:10000});
    }catch(error){
      const state=await page.evaluate(()=>({
        fault:window.__startupFaultFired,
        dryDisabled:document.querySelector("#play-dry").disabled,
        wetDisabled:document.querySelector("#play-wet").disabled,
        status:document.querySelector("#status").textContent,
        indicator:document.querySelector("#rt-indicator").textContent,
        transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
        history:window.__startupStateHistory
      }));
      error.message+="; startup failure state="+JSON.stringify(state);
      throw error;
    }
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/pcm-optin.wav/);

    await page.evaluate(()=>{window.AudioWorkletNode=window.__nativeAudioWorkletNode;});
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental",{timeout:12000});
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    await page.click("#main-tab-model");
    assert.equal(await page.$eval("#scrub-inertia",el=>el.value),"150");
    await page.$eval("#scrub-inertia",el=>{
      el.value="220";el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    assert.equal(await page.$eval("#scrub-inertia-value",el=>el.textContent),"220%");
    assert.equal(await page.evaluate(()=>localStorage.getItem(
      "audio-lab-scrub-inertia")),"220");
    await page.click("#main-tab-player");
    await page.click("#play-main");
    try{
      await page.waitForFunction(()=>Boolean(document.querySelector("#rt-telemetry")
        ?.dataset.pcmTransport),{timeout:12000});
    }catch(error){
      const state=await page.evaluate(()=>({
        model:document.querySelector("#lab-model").value,
        status:document.querySelector("#status").textContent,
        indicator:document.querySelector("#rt-indicator").textContent,
        transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
        detail:document.querySelector("#rt-telemetry").textContent,
        playDisabled:document.querySelector("#play-main").disabled
      }));
      error.message+="; play transport state="+JSON.stringify(state);
      throw error;
    }
    assert.equal(await page.$eval("#rt-telemetry",el=>el.dataset.pcmTransport),
      "rust-engine3-source-time");
    const forwardBox=await page.$eval("#seek-forward",el=>{
      const r=el.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    });
    await page.mouse.move(forwardBox.x,forwardBox.y);
    await page.mouse.down();
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderSpeed==="4",{timeout:5000});
    await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderSpeed==="1",{timeout:5000});
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);

    const mobile=await browser.newPage();
    await mobile.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await mobile.goto(`http://127.0.0.1:${port}/`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await mobile.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    await mobile.click("#settings-open");
    await mobile.waitForFunction(()=>document.querySelector("#settings-dialog")?.open,
      {timeout:5000});
    await mobile.click(".model-info-controls > summary");
    await mobile.click(".model-extra-controls > summary");
    const settingsLayout=await mobile.evaluate(()=>{
      const dialog=document.querySelector("#settings-dialog");
      const host=document.querySelector("#model-settings-host");
      const d=dialog.getBoundingClientRect(),h=host.getBoundingClientRect();
      return {viewport:{width:innerWidth,height:innerHeight},
        dialog:{width:d.width,height:d.height,top:d.top,bottom:d.bottom},
        host:{height:h.height,scrollHeight:host.scrollHeight,
          clientHeight:host.clientHeight,maxHeight:getComputedStyle(host).maxHeight}};
    });
    await mobile.screenshot({path:path.resolve("settings-mobile-check.png")});
    assert.ok(settingsLayout.dialog.width<=settingsLayout.viewport.width);
    assert.ok(settingsLayout.dialog.height<=settingsLayout.viewport.height);
    assert.ok(settingsLayout.host.scrollHeight<=settingsLayout.host.clientHeight+1,
      JSON.stringify(settingsLayout));
  }catch(error){
    testFailure=error;
    throw error;
  }finally{
    try{
      if(browser){
        const pages=await browser.pages().catch(()=>[]);
        await Promise.allSettled(pages.map(page=>page.close()));
      }
      await cleanupTestProcesses(browser,[server],"PCM player HTTP server");
    }catch(cleanupFailure){
      if(testFailure)throw new AggregateError([testFailure,cleanupFailure],
        "PCM player test failed and cleanup also reported a problem");
      throw cleanupFailure;
    }
  }
});
