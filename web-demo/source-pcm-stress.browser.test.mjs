import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

test("native Chrome measures actual output PCM under tiny loops and long-source main-thread stalls",async()=>{
  const port=18746;
  const server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("web-demo"),stdio:"ignore"
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
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://127.0.0.1:"+port+"/source-pcm-smoke.html",{
      waitUntil:"domcontentloaded",timeout:15000
    });
    const evidence=await page.evaluate(async()=>{
      const {createSourcePCMBridge}=await import("./source-pcm-bridge.mjs");
      const ctx=new AudioContext({sampleRate:48000,latencyHint:"interactive"});
      await ctx.audioWorklet.addModule("./source-pcm-probe.worklet.js");
      const probe=new AudioWorkletNode(ctx,"audio-lab-pcm-probe",{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]
      });
      probe.connect(ctx.destination);
      let id=0;
      const measure=op=>new Promise((resolve,reject)=>{
        const n=++id;
        const timer=setTimeout(()=>{probe.port.removeEventListener("message",on);
          reject(Error("probe "+op+" timeout"));},3000);
        const on=e=>{
          if(e.data?.id!==n)return;
          clearTimeout(timer);
          probe.port.removeEventListener("message",on);
          resolve(e.data.stats);
        };
        probe.port.addEventListener("message",on);
        probe.port.start();
        probe.port.postMessage({id:n,op});
      });
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const shortSrc=[
        new Float32Array(8192).fill(.375),
        new Float32Array(8192).fill(.5)
      ];
      const short=await createSourcePCMBridge({
        ctx,sourceChannels:shortSrc,sourceSampleRate:44100,speed:8,
        startFrame:320,loopEnabled:true,loopStartFrame:320,loopEndFrame:321
      });
      short.connect(probe);
      await short.play();
      await sleep(85);
      const tiny=[];
      for(const span of [1,2,16,127,128,129,256]){
        for(const speed of [-8,8]){
          await short.setLoopBounds(300,300+span);
          await short.setSpeed(speed);
          await short.seek(speed<0?300+span-1:300);
          await measure("arm");
          await sleep(36);
          const samples=await measure("snapshot");
          tiny.push({span,speed,...samples,
            cacheMisses:short.latest?.missingFrames??null});
        }
      }
      // Stalled main-thread work cannot be repaired by an unbounded queue.
      // Read the post-render PCM directly, not merely the producer's counter.
      const stalledTinyBefore=await measure("arm");
      const shortStallAt=performance.now();
      while(performance.now()-shortStallAt<260){
        Math.sqrt((performance.now()-shortStallAt)*127);
      }
      const stalledTiny=await measure("snapshot");
      await short.pause();
      short.dispose();

      const totalFrames=2_000_000;
      const longSrc=[
        new Float32Array(totalFrames).fill(.375),
        new Float32Array(totalFrames).fill(.5)
      ];
      const events=[];
      const long=await createSourcePCMBridge({
        ctx,sourceChannels:longSrc,sourceSampleRate:48000,
        speed:8,startFrame:250000,loopEnabled:false,
        onEvent:e=>{if(e.type==="fatal-error"||e.type==="error")
          events.push({type:e.type,message:e.message});}
      });
      long.connect(probe);
      await long.play();
      await sleep(80);
      const missBefore=long.latest?.missingFrames??0;
      await measure("arm");
      const stallStart=performance.now();
      // Deliberately beyond a finite 4-window cache's supply horizon at 8x.
      while(performance.now()-stallStart<1050){
        Math.sqrt((performance.now()-stallStart)*197);
      }
      const stall=await measure("snapshot");
      await sleep(120);
      const missAfter=long.latest?.missingFrames??0;
      const t0=performance.now();
      const ack=await long.seek(1_200_000);
      const seekAckMs=performance.now()-t0;
      await long.setSpeed(1);
      await sleep(80);
      await measure("arm");
      await sleep(140);
      const recovered=await measure("snapshot");
      const recoveryMissing=long.latest?.missingFrames??0;
      await long.pause();
      long.dispose();
      probe.disconnect();
      await ctx.close();
      return {sampleRate:48000,sourceRateTiny:44100,tiny,stalledTiny,
        stalledTinyBefore,stalledLong:{...stall,missingBefore:missBefore,
          missingAfter:missAfter,missingDelta:missAfter-missBefore,
          sourceFrames:totalFrames,sourceSpeed:8,mainThreadBlockMs:1050},
        recovery:{...recovered,seekAckMs,seekFrame:ack.sourceFrame,
          missingCumulative:recoveryMissing},
        errors:events};
    });
    assert.deepEqual(errors,[]);
    assert.deepEqual(evidence.errors,[]);
    assert.equal(evidence.tiny.length,14);
    for(const value of evidence.tiny){
      assert.equal(value.inputChannels,2,"stereo input must stay stereo");
      for(const [ch,reference] of [.375,.5].entries()){
        const measured=value.channels[ch];
        assert.ok(measured?.frames>=128&&measured.nonzeroFrames>0,value);
        assert.equal(measured.zeroFrames,0,
          `stable loop inserted silence in stereo channel ${ch}`);
        assert.ok(measured.maxStep<.015,measured);
        assert.ok(Math.abs(measured.rms-reference)<.015,
          `stereo channel ${ch} changed amplitude: ${JSON.stringify(measured)}`);
      }
    }
    assert.ok(evidence.stalledTiny.frames>128,evidence.stalledTiny);
    assert.equal(evidence.stalledTiny.inputChannels,2);
    for(const [ch,reference] of [.375,.5].entries()){
      const measured=evidence.stalledTiny.channels[ch];
      assert.equal(measured.zeroFrames,0,
        `fully cached short loop dropped stereo channel ${ch} under host stall`);
      assert.ok(Math.abs(measured.rms-reference)<.015,measured);
    }
    assert.ok(evidence.stalledLong.frames>=128,evidence.stalledLong);
    assert.equal(evidence.stalledLong.inputChannels,2);
    assert.ok(evidence.stalledLong.channels.every(ch=>ch.nonzeroFrames>0),
      evidence.stalledLong);
    assert.equal(evidence.recovery.seekFrame,1_200_000);
    assert.equal(evidence.recovery.inputChannels,2);
    assert.ok(evidence.recovery.channels.every(ch=>ch.nonzeroFrames>0),
      evidence.recovery);
    assert.ok(Number.isFinite(evidence.recovery.seekAckMs));
    // A finite source cache cannot guarantee no gap under an arbitrarily
    // long blocked host. Report the observed limit, do NOT mark R2 accepted.
    console.log("R2_REAL_PCM_STRESS_EVIDENCE "+JSON.stringify(evidence));
  }finally{
    await browser?.close();
    server.kill();
  }
});
