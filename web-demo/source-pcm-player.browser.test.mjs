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
    await page.goto(`http://127.0.0.1:${port}/?pcmTransport=1`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
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
    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();
    server.kill();
  }
});
