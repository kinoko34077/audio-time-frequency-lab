import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

test("live Audio Lab opt-in original playback uses a persistent PCM node across waveform seek",async()=>{
  // Verify the actual production entry point with a user-shaped native WAV file.
  // This is opt-in/raw original audio only; it is NOT pitch-independent playback.
  const port=18745;
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
      .includes("pcm-optin.wav · 2.0秒"),{timeout:20000});
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
    assert.match(initial.indicator,/PCM実験経路/);
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

    // The old app defaulted the research model to Rust; now it defaults
    // explicitly to Granular. Select Rust before injecting the invalid
    // preflight quality, since model selection legitimately updates #quality.
    await page.click("#main-tab-model");
    await page.evaluate(()=>{
      const model=document.querySelector("#lab-model");
      model.value="live";model.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#lab-model").value==="live",{
      timeout:10000
    });
    // Rejected wet parameters must not stop/recreate currently audible raw.
    await page.evaluate(()=>{
      const quality=document.querySelector("#quality");
      window.__originalQuality=quality.value;
      quality.add(new Option("Invalid test only","invalid-for-test"));
      quality.value="invalid-for-test";
    });
    await page.click("#play-wet");
    await page.waitForFunction(()=>document.querySelector("#status")
      ?.textContent.includes("変換設定は未反映"),{timeout:10000});
    const unchanged=await page.evaluate(()=>({
      raw:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      nodes:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts)
    }));
    assert.equal(unchanged.raw,"raw-experimental");
    assert.equal(unchanged.nodes,initial.starts);
    await page.evaluate(()=>{
      const quality=document.querySelector("#quality");
      quality.value=window.__originalQuality;
      quality.querySelector('[value="invalid-for-test"]').remove();
    });

    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});

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
    // Exercise the real app callback, not only a standalone bridge fixture.
    await page.evaluate(()=>{
      window.__faultTargetPCMNode.dispatchEvent(new Event("processorerror"));
    });
    await page.waitForFunction(()=>document.querySelector("#status")
      ?.textContent.includes("音源は保持されています"),{timeout:10000});
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
    assert.equal(afterFatal.raw,undefined);
    assert.match(afterFatal.indicator,/異常終了/);

    // A different failure boundary: crash *during* the initial play ACK
    // while both buttons are disabled. The same loaded file must recover.
    await page.evaluate(()=>{
      window.__startupFaultFired=false;
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
    await page.waitForFunction(()=>{
      const d=document;
      return window.__startupFaultFired&&
        !d.querySelector("#play-dry").disabled&&
        !d.querySelector("#play-wet").disabled&&
        d.querySelector("#status").textContent.includes("音源は保持されています")&&
        d.querySelector("#rt-indicator").textContent.includes("異常終了")&&
        d.querySelector("#rt-telemetry").dataset.pcmTransport===undefined;
    },{timeout:10000});
    assert.match(await page.$eval("#file-meta",el=>el.textContent),/pcm-optin.wav/);

    await page.evaluate(()=>{window.AudioWorkletNode=window.__nativeAudioWorkletNode;});
    await page.click("#play-dry");
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="raw-experimental",{timeout:12000});
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();
    server.kill();
  }
});
