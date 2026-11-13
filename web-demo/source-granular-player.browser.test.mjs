import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

test("R3 opt-in real page applies precise signed speed/pitch without replacing the AudioWorklet",async()=>{
  const port=18746;
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
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?pcmTransport=granular`,{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    assert.equal(await page.$eval("#granular-optin-controls",x=>x.hidden),false);

    // Content-bearing two-channel music-like WAV, through the normal native
    // file input; no test-only bridge creation or constant-first fixture.
    await page.evaluate(()=>{
      const sr=48000,count=sr*2,ch=2,dataBytes=count*ch*2;
      const buffer=new ArrayBuffer(44+dataBytes),v=new DataView(buffer);
      const ascii=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};
      ascii(0,"RIFF");v.setUint32(4,36+dataBytes,true);ascii(8,"WAVE");
      ascii(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);
      v.setUint16(22,ch,true);v.setUint32(24,sr,true);
      v.setUint32(28,sr*ch*2,true);v.setUint16(32,ch*2,true);
      v.setUint16(34,16,true);ascii(36,"data");v.setUint32(40,dataBytes,true);
      for(let i=0;i<count;i++){
        const t=i/sr;
        const pulse=(i%14000<1500)?0.1:0;
        for(let c=0;c<ch;c++){
          const wave=.29*Math.sin(2*Math.PI*174.61*t)+
            .17*Math.sin(2*Math.PI*(c?261.63:220)*t)+
            pulse*Math.sin(2*Math.PI*640*t);
          v.setInt16(44+(i*ch+c)*2,Math.max(-32768,
            Math.min(32767,Math.round(wave*32767))),true);
        }
      }
      const input=document.querySelector("#audio-file"),dt=new DataTransfer();
      dt.items.add(new File([buffer],"granular-controls.wav",{type:"audio/wav"}));
      input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("granular-controls.wav"),{timeout:20000});
    await page.waitForSelector("#play-dry:not([disabled])",{timeout:10000});
    await page.evaluate(()=>{
      const set=(id,value,kind="change")=>{
        const el=document.getElementById(id);
        el.value=value;el.dispatchEvent(new Event(kind,{bubbles:true}));
      };
      set("granular-speed-value","-7.125");
      set("granular-pitch-value","7.1234");
      set("granular-range","2");
    });
    const before=await page.evaluate(()=>({
      speed:document.querySelector("#granular-speed-value").value,
      pitch:document.querySelector("#granular-pitch-value").value,
      rail:document.querySelector("#granular-speed").value,
      railMax:document.querySelector("#granular-speed").max,
      output:document.querySelector("#granular-pitch-output").textContent,
      note:document.querySelector("#granular-rail-note").textContent
    }));
    assert.equal(before.speed,"-7.125","rail must not erase precise canonical speed");
    assert.equal(before.pitch,"7.1234","display must not round editable pitch");
    assert.equal(before.rail,"-2");
    assert.equal(before.railMax,"2");
    assert.match(before.output,/7\.1/);
    assert.match(before.note,/保持/);
    // Delay first registration after bridge options were captured. User edits
    // made before state.player assignment must still reach the actual Worklet.
    await page.evaluate(()=>{
      const NativeContext=window.AudioContext;
      window.__granularInitPending=false;
      window.AudioContext=class extends NativeContext{
        constructor(...args){
          super(...args);
          const worklet=this.audioWorklet;
          const original=worklet.addModule.bind(worklet);
          worklet.addModule=async (...args)=>{
            if(String(args[0]).includes("source-pcm.worklet.js")){
              window.__granularInitPending=true;
              await new Promise(resolve=>setTimeout(resolve,350));
            }
            return original(...args);
          };
        }
      };
    });
    // Start by touching the waveform while stopped, then drag to a new
    // location DURING delayed Worklet initialization. The first audible
    // render must use the FINAL scrub coordinate, never the stale down point.
    const sourceRate=await page.$eval("#file-meta",e=>
      Number(e.textContent.match(/(\d+)Hz/)?.[1]));
    assert.ok(sourceRate>0,"decoded PCM sample rate must be known");
    await page.$eval("#wave",e=>e.scrollIntoView({block:"center"}));
    const initialBox=await page.$eval("#wave",e=>{
      const r=e.getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height};
    });
    await page.evaluate(()=>{
      const status=document.getElementById("granular-optin-status");
      window.__firstGranularPlayFrame=null;
      const observer=new MutationObserver(()=>{
        if(status.dataset.renderRunning==="true"&&
           window.__firstGranularPlayFrame===null){
          window.__firstGranularPlayFrame=Number(status.dataset.renderFrame);
          observer.disconnect();
        }
      });
      observer.observe(status,{attributes:true,
        attributeFilter:["data-render-running"]});
    });
    const initialY=initialBox.top+initialBox.height/2;
    await page.mouse.move(initialBox.left+initialBox.width*.18,initialY);
    await page.mouse.down();
    await page.waitForFunction(()=>window.__granularInitPending,{timeout:10000});
    await page.evaluate(()=>{
      const set=(id,value)=>{
        const el=document.getElementById(id);
        el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
      };
      set("granular-speed-value","1.237");
      set("granular-pitch-value","-3.456");
    });
    await page.mouse.move(initialBox.left+initialBox.width*.72,initialY);
    await page.mouse.up();
    const firstExpected=Math.round(sourceRate*2*.72);
    await page.waitForFunction(()=>window.__firstGranularPlayFrame!==null,
      {timeout:20000});
    const firstFrame=await page.evaluate(()=>window.__firstGranularPlayFrame);
    assert.ok(Math.abs(firstFrame-firstExpected)<=2,
      `first audible render must start at final scrub frame ${firstExpected}; got ${firstFrame}`);
    await page.waitForFunction(()=>document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport==="granular-experimental",{timeout:20000});
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderPitch==="-3.456",{timeout:20000});
    assert.equal(await page.$eval("#granular-speed-value",e=>e.value),"1.237");
    assert.equal(await page.$eval("#granular-pitch-value",e=>e.value),"-3.456");
    const starts=await page.$eval("#rt-telemetry",
      e=>Number(e.dataset.pcmNodeStarts));
    assert.equal(starts,1);

    await page.evaluate(()=>{
      const input=document.querySelector("#granular-speed-value");
      input.value="0";input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#granular-speed-output")
      .textContent==="0.00×",{timeout:20000});
    await page.evaluate(()=>{
      const input=document.querySelector("#granular-pitch-value");
      input.value="7.1234";
      input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderPitch==="7.1234",{timeout:20000});
    await page.evaluate(()=>{
      const wave=document.querySelector("#wave"),r=wave.getBoundingClientRect();
      wave.dispatchEvent(new PointerEvent("pointerdown",{
        bubbles:true,clientX:r.left+r.width*.6,clientY:r.top+r.height/2
      }));
    });
    await new Promise(resolve=>setTimeout(resolve,150));
    const after=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      transport:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      pitch:document.querySelector("#granular-pitch-value").value,
      speed:document.querySelector("#granular-speed-value").value,
      renderRevision:document.querySelector("#granular-optin-status")
        .dataset.renderRevision,
      note:document.querySelector("#granular-optin-status").textContent
    }));
    assert.equal(after.starts,starts,"changing speed, pitch or seek restarted the node");
    assert.equal(after.transport,"granular-experimental");
    assert.equal(after.pitch,"7.1234");
    assert.equal(after.speed,"0");
    assert.ok(Number.isFinite(Number(after.renderRevision)));
    assert.match(after.note,/音声処理済み|音声反映前に上書き/);

    // Actual browser pointer movement, not a synthetic pointerdown fixture:
    // scrub a still-audible 0× granular stream across the waveform. It must
    // keep the original Worklet and reach the LAST dragged source coordinate.
    const box=await page.$eval("#wave",element=>{
      const r=element.getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height};
    });
    const y=box.top+box.height/2;
    await page.mouse.move(box.left+box.width*.2,y);
    await page.mouse.down();
    for(let n=1;n<=24;n++)
      await page.mouse.move(box.left+box.width*(.2+.6*n/24),y);
    const duringDrag=await page.evaluate(()=>({
      head:parseFloat(document.querySelector("#playhead").style.left),
      elapsed:document.querySelector("#elapsed").textContent
    }));
    assert.ok(duringDrag.head>75&&duringDrag.head<85,
      "live playhead should follow the finger, not a stale render ACK");
    // This assertion checks the held 0× sample, not a DJ-style flick.
    // Releasing immediately after movement intentionally continues inertia;
    // hold before lifting to distinguish the two user actions.
    await new Promise(resolve=>setTimeout(resolve,160));
    await page.mouse.up();
    const finalExpected=Math.round(sourceRate*2*.8);
    await page.waitForFunction(expected=>Math.abs(Number(document.querySelector(
      "#granular-optin-status")?.dataset.renderFrame)-expected)<=2,
      {timeout:20000},finalExpected);
    const dragResult=await page.evaluate(()=>({
      starts:Number(document.querySelector("#rt-telemetry").dataset.pcmNodeStarts),
      mode:document.querySelector("#rt-telemetry").dataset.pcmTransport,
      speed:document.querySelector("#granular-speed-value").value,
      pitch:document.querySelector("#granular-pitch-value").value,
      renderFrame:Number(document.querySelector(
        "#granular-optin-status").dataset.renderFrame)
    }));
    assert.equal(dragResult.starts,starts,
      "scrub may not recreate the AudioWorklet");
    assert.equal(dragResult.mode,"granular-experimental");
    assert.equal(dragResult.speed,"0");
    assert.equal(dragResult.pitch,"7.1234");
    assert.ok(Math.abs(dragResult.renderFrame-finalExpected)<=2,
      `final source frame must be ${finalExpected}, got ${dragResult.renderFrame}`);

    await page.click("#stop");
    await page.waitForFunction(()=>!document.querySelector("#rt-telemetry")
      ?.dataset.pcmTransport,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{
    await browser?.close();server.kill();
  }
});
