import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";
import {installTestAudioSilenceGuardForPage} from "./test-audio-silence-guard.mjs";

const pythonCommand=process.env.PYTHON||
  (process.platform==="win32"?"python":"python3");

test("native Chrome experimental source-PCM AudioWorklet renders and loops without recreating its node",async()=>{
  const port=18743;
  const server=spawn(pythonCommand,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("web-demo"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage();
    await installTestAudioSilenceGuardForPage(page);
    const pageErrors=[];
    page.on("pageerror",e=>pageErrors.push(e.message));
    await page.goto("http://127.0.0.1:"+port+"/source-pcm-smoke.html",{
      waitUntil:"domcontentloaded",timeout:15000
    });
    const evidence=await page.evaluate(async()=>{
      const {createSourcePCMBridge}=await import("./source-pcm-bridge.mjs");
      const ctx=new AudioContext({sampleRate:48000});
      const data=Float32Array.from({length:48000},(_,i)=>.35*Math.sin(i*2*Math.PI*440/48000));
      const events=[];
      const player=await createSourcePCMBridge({
        ctx,sourceChannels:[data],sourceSampleRate:48000,startFrame:0,speed:1,
        onEvent:e=>events.push(e.type==="error"?{type:"error",message:e.message}:{type:e.type})
      });
      const node=player.node;
      const analyser=ctx.createAnalyser();analyser.fftSize=512;
      player.connect(analyser);analyser.connect(ctx.destination);
      await player.play();
      await new Promise(resolve=>setTimeout(resolve,280));
      const first=player.latest;
      const pcm=new Float32Array(512);
      analyser.getFloatTimeDomainData(pcm);
      const rms=Math.sqrt(pcm.reduce((a,v)=>a+v*v,0)/pcm.length);
      await player.pause();
      const wasmBytes=await (await fetch("./dsp_core.wasm")).arrayBuffer();
      const {fullBandPartialOptions}=await import("./lab-contract.mjs");
      const rustSettings={
        low:1,high:Math.min(20000,ctx.sampleRate*.49),
        curvature:1,invert:0,mode:"blend",outside:"pass",
        qualityIndex:1,hopDiv:8,engine:3,pitchRatio:2,shiftHz:0,
        carrierHz:350,zeroMode:0,axisShift:0,axisReference:350,
        ringEnabled:false,rationalEnabled:true,axisPivot:350,axisSlope:1,
        zeroReflectGain:1,zeroReflectDecay:0,crusherBits:0,crusherHold:1,
        ...fullBandPartialOptions(ctx.sampleRate)
      };
      const rustEvents=[];
      const rust=await createSourcePCMBridge({
        ctx,sourceChannels:[data],sourceSampleRate:48000,startFrame:24000,
        speed:0,processingMode:"live",pitchSemitones:12,
        wasmBytes,rustSettings,onEvent:event=>{
          if(event.type==="error"||event.type==="rust-error")
            rustEvents.push(event.message||event.type);
        }
      });
      rust.connect(analyser);
      analyser.fftSize=4096;
      const measureRustPCM=()=>{
        const pcm=new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(pcm);
        let power=0,peak=0,frequency=0;
        for(const sample of pcm)power+=sample*sample;
        for(let hz=850;hz<=910;hz++){
          let re=0,im=0;
          for(let i=0;i<pcm.length;i++){
            const phase=2*Math.PI*hz*i/ctx.sampleRate;
            re+=pcm[i]*Math.cos(phase);im-=pcm[i]*Math.sin(phase);
          }
          const magnitude=Math.hypot(re,im);
          if(magnitude>peak){peak=magnitude;frequency=hz;}
        }
        return {rms:Math.sqrt(power/pcm.length),frequency};
      };
      await rust.play();
      await new Promise(resolve=>setTimeout(resolve,280));
      const rustFreeze=rust.latest;
      const rustFreezePCM=measureRustPCM();
      await rust.setSpeed(8);
      await rust.setLoopBounds(12000,36000);
      await rust.setLoopEnabled(true);
      await new Promise(resolve=>setTimeout(resolve,140));
      const rustLoop=rust.latest;
      const rustForwardPCM=measureRustPCM();
      await rust.setLoopEnabled(false);
      await rust.setSpeed(0);
      await rust.seek(42000);
      await rust.setSpeed(-8);
      await new Promise(resolve=>setTimeout(resolve,100));
      const rustReverse=rust.latest;
      const rustReversePCM=measureRustPCM();
      await rust.scrub(22000,0);
      await new Promise(resolve=>setTimeout(resolve,60));
      const rustScrub=rust.latest;
      await rust.pause();
      rust.dispose();
      await player.setLoopBounds(97,99);
      await player.setLoopEnabled(true);
      await player.seek(97);
      await player.setSpeed(-8);
      await player.play();
      await new Promise(resolve=>setTimeout(resolve,180));
      const loop=player.latest;
      const loopMissing=loop?.missingFrames??0;
      // Update both PCM loop endpoints while the real AudioWorklet renders.
      // The boundaries and their caches must be applied in a single message.
      const transitions=[];
      for(const [a,b] of [[1800,1816],[4200,4201],[9400,9529],[97,99]]){
        const receipt=await player.setLoopBounds(a,b);
        await new Promise(resolve=>setTimeout(resolve,45));
        const current=player.latest;
        transitions.push({a,b,receipt,current});
      }

      // The standard PV player uses a progressive PCM reader. An A/B edit
      // should decode only small endpoint windows, not two full playback
      // windows (65,536 frames each).
      const loopReads=[],loopRenderReceipts=[];
      const progressive={sourceFrames:48000*20,channelCount:1,
        async read(startFrame,frameCount,options={}){
          loopReads.push({startFrame,frameCount,windowFrames:options.windowFrames});
          return {startFrame,channels:[Float32Array.from(
            {length:frameCount},(_,i)=>.25*Math.sin(
              2*Math.PI*440*(startFrame+i)/48000))]};
        }};
      const pvLoop=await createSourcePCMBridge({ctx,source:progressive,
        sourceSampleRate:48000,startFrame:200000,speed:1,
        processingMode:"pv",onEvent:event=>{
          if(event.type==="render-applied")loopRenderReceipts.push(event);
        }});
      pvLoop.connect(analyser);
      await pvLoop.play();
      await new Promise(resolve=>setTimeout(resolve,35));
      const loopReadStart=loopReads.length;
      const loopEditStarted=performance.now();
      const loopEdit=await pvLoop.setLoopConfiguration(48000,96000,true);
      const loopEditLatencyMs=performance.now()-loopEditStarted;
      const endpointReads=loopReads.slice(loopReadStart,loopReadStart+2);
      await new Promise(resolve=>setTimeout(resolve,80));
      const pvLoopState=pvLoop.latest;
      const pvLoopRender=loopRenderReceipts.find(event=>
        event.requestId===loopEdit.requestId);
      await pvLoop.pause();
      pvLoop.dispose();
      await player.pause();
      const stable=node===player.node;
      player.dispose();
      const afterDispose=[],oldInFlightReceipts=[];
      // A render-applied message sent BEFORE disposal can be delivered
      // after replacing the host port listener. That queued notification
      // does NOT prove the disposed processor accepted a NEW command.
      node.port.onmessage=e=>{
        const data=e.data||{};
        if(data.requestId===999999)afterDispose.push(data.type);
        else if(data.type==="render-applied")
          oldInFlightReceipts.push(data.requestId);
      };
      node.port.postMessage({type:"command",op:"play",requestId:999999});
      await new Promise(resolve=>setTimeout(resolve,120));

      // Real Worklet integration for the independent review's long-loop bug:
      // A/B pins + two moving windows are full before a far seek to frame 700k.
      // Installation and seek must reach the processor in one atomic message.
      const longEvents=[];
      const long=await createSourcePCMBridge({
        ctx,sourceChannels:[new Float32Array(1_000_000).fill(.35)],
        sourceSampleRate:48000,startFrame:340000,speed:8,
        loopEnabled:true,loopStartFrame:0,loopEndFrame:999999,
        onEvent:e=>{if(e.type==="window-accepted"||e.type==="error")
          longEvents.push({type:e.type,message:e.message});}
      });
      long.connect(analyser);
      await long.play();
      await new Promise(resolve=>setTimeout(resolve,260));
      const beforeSeekMissing=long.latest?.missingFrames||0;
      const appliedSeek=await long.seek(700000);
      await new Promise(resolve=>setTimeout(resolve,75));
      const afterSeek=long.latest;
      await long.pause();
      long.dispose();

      // Fault injection at the actual AudioWorkletNode boundary. A fatal
      // processor error must reject commands without hanging and emit exactly
      // one explicit fatal state, rather than reporting stale "playing".
      const injected=[];
      const crashed=await createSourcePCMBridge({
        ctx,sourceChannels:[data],sourceSampleRate:48000,
        commandTimeoutMs:150,onEvent:e=>injected.push(e)
      });
      crashed.connect(analyser);
      await crashed.play();
      const pendingSeek=crashed.seek(1234);
      crashed.node.dispatchEvent(new Event("processorerror"));
      let crashRejected=false;
      try{await pendingSeek;}catch(err){
        crashRejected=/processor unexpectedly terminated/.test(err.message);
      }
      const fatalCount=injected.filter(x=>x.type==="fatal-error").length;
      let afterCrashRejected=false;
      try{await crashed.setSpeed(2);}catch(err){
        afterCrashRejected=/disposed/.test(err.message);
      }
      crashed.dispose();

      const silent=[];
      const unresponsive=await createSourcePCMBridge({
        ctx,sourceChannels:[data],sourceSampleRate:48000,
        commandTimeoutMs:65,onEvent:e=>silent.push(e)
      });
      unresponsive.connect(analyser);
      // Simulate a lost ACK or silent processor shutdown, without firing
      // onprocessorerror. Every command must settle within the bounded timer.
      unresponsive.node.port.onmessage=null;
      let timedOut=false;
      try{await unresponsive.setSpeed(2);}catch(err){
        timedOut=/command response timed out/.test(err.message);
      }
      const timeoutFatalCount=silent.filter(x=>x.type==="fatal-error").length;
      const afterTimeout=[];
      unresponsive.node.port.onmessage=e=>{
        if(e.data?.type==="command-accepted"&&e.data.requestId===987654)
          afterTimeout.push(e.data);
      };
      unresponsive.node.port.postMessage({
        type:"command",op:"play",requestId:987654
      });
      await new Promise(resolve=>setTimeout(resolve,100));
      unresponsive.dispose();
      await ctx.close();
      return {
        first,loop,rms,stable,loopMissing,transitions,afterDispose,
        progressiveLoop:{endpointReads,latencyMs:loopEditLatencyMs,
          command:loopEdit,state:pvLoopState,render:pvLoopRender},
        rust:{freeze:rustFreeze,freezePCM:rustFreezePCM,rms:rustFreezePCM.rms,loop:rustLoop,
          frequency:rustFreezePCM.frequency,freezeRms:rustFreezePCM.rms,
          forwardPCM:rustForwardPCM,reverse:rustReverse,
          reversePCM:rustReversePCM,scrub:rustScrub,
          errors:rustEvents},
        oldInFlightReceipts,
        failureRecovery:{crashRejected,fatalCount,afterCrashRejected,
          timedOut,timeoutFatalCount,postTimeoutAck:afterTimeout.length},
        errors:events.filter(x=>x.type==="error"),
        windowAccepts:events.filter(x=>x.type==="window-accepted").length,
        gapReports:events.filter(x=>x.type==="underrun").length,
        farSeek:{
          ack:appliedSeek.sourceFrame, beforeMissing:beforeSeekMissing,
          afterMissing:afterSeek?.missingFrames,
          afterFrame:afterSeek?.sourceFrame,
          windows:longEvents.filter(e=>e.type==="window-accepted").length,
          errors:longEvents.filter(e=>e.type==="error")
        }
      };
    });
    const outputIsolation=await page.evaluate(()=>window.__audioSilenceAudit);
    console.log("TEST_AUDIO_ISOLATION "+JSON.stringify(outputIsolation));
    console.log("RUST_SIGNED_SPEED_PCM "+JSON.stringify({sampleRate:48000,
      pitchSemitones:12,freeze:evidence.rust.freezePCM,
      positive8x:evidence.rust.forwardPCM,negative8x:evidence.rust.reversePCM}));
    assert.ok(outputIsolation.mutedOutputRoutes>0,outputIsolation);
    assert.ok(outputIsolation.audioOutputMuteGains.length>0,outputIsolation);
    assert.ok(outputIsolation.audioOutputMuteGains.every(gain=>gain===0),outputIsolation);
    assert.deepEqual(pageErrors,[]);
    assert.deepEqual(evidence.errors,[]);
    assert.deepEqual(evidence.rust.errors,[]);
    assert.equal(evidence.rust.freeze?.sourceFrame,24000,evidence.rust);
    assert.equal(evidence.rust.freeze?.pitchSemitones,12,evidence.rust);
    assert.equal(evidence.rust.freeze?.running,true,evidence.rust);
    assert.ok(evidence.rust.freezeRms>.02,evidence.rust);
    assert.ok(Math.abs(evidence.rust.frequency-880)<=4,evidence.rust);
    assert.ok(evidence.rust.forwardPCM.rms>.01,evidence.rust,
      "Rust +8x must emit measured non-silent PCM");
    assert.ok(Math.abs(evidence.rust.forwardPCM.frequency-880)<=4,evidence.rust,
      "Rust +8x must keep the independently selected octave pitch");
    assert.ok(evidence.rust.loop?.sourceFrame>=12000&&
      evidence.rust.loop?.sourceFrame<36000,evidence.rust);
    assert.equal(evidence.rust.loop?.loopEnabled,true,evidence.rust);
    assert.ok(evidence.rust.reverse?.sourceFrame<42000,evidence.rust);
    assert.ok(evidence.rust.reverse?.sourceFrame>0,evidence.rust);
    assert.ok(evidence.rust.reversePCM.rms>.01,evidence.rust,
      "Rust -8x must emit measured non-silent PCM");
    assert.ok(Math.abs(evidence.rust.reversePCM.frequency-880)<=4,evidence.rust,
      "Rust -8x must keep the independently selected octave pitch");
    assert.equal(evidence.rust.scrub?.sourceFrame,22000,evidence.rust);
    assert.equal(evidence.rust.scrub?.speed,0,evidence.rust);
    assert.ok(evidence.first?.renderedFrames>=1024,evidence);
    assert.ok(evidence.loop?.renderedFrames>evidence.first.renderedFrames,evidence);
    assert.equal(evidence.loop.missingFrames,0,evidence);
    assert.ok(evidence.rms>.01,`expected audible PCM: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.stable,true);
    assert.equal(evidence.transitions.length,4);
    assert.equal(evidence.progressiveLoop.endpointReads.length,2,
      evidence.progressiveLoop);
    assert.ok(evidence.progressiveLoop.endpointReads.every(read=>
      read.windowFrames===8192&&read.frameCount===8192),
      evidence.progressiveLoop);
    assert.ok(evidence.progressiveLoop.latencyMs<100,
      `progressive PV loop edit took ${evidence.progressiveLoop.latencyMs.toFixed(1)}ms`);
    assert.equal(evidence.progressiveLoop.command.loopStartFrame,48000,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.command.loopEndFrame,96000,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.render?.loopStartFrame,48000,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.render?.loopEndFrame,96000,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.render?.loopEnabled,true,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.render?.running,true,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.state?.loopEnabled,true,
      evidence.progressiveLoop);
    assert.equal(evidence.progressiveLoop.state?.missingFrames,0,
      evidence.progressiveLoop);
    for(const {a,b,receipt,current} of evidence.transitions){
      assert.equal(receipt.loopStartFrame,a);
      assert.equal(receipt.loopEndFrame,b);
      assert.equal(receipt.loopEnabled,true);
      assert.ok(current.sourceFrame>=a&&current.sourceFrame<b,
        `loop read outside updated interval [${a},${b}): ${JSON.stringify(current)}`);
      assert.equal(current.missingFrames,evidence.loopMissing,
        "changing A/B must not create an intermediate cache-miss block");
    }
    assert.deepEqual(evidence.afterDispose,[],
      "disposed Worklet must not accept/render requestId=999999 submitted AFTER disposal");
    // Events queued BEFORE dispose are telemetry, not post-dispose commands.
    // Keep this count as evidence of possible host/Worklet delivery ordering.
    assert.ok(Array.isArray(evidence.oldInFlightReceipts));
    assert.ok(evidence.windowAccepts>=1);
    assert.deepEqual(evidence.failureRecovery,{
      crashRejected:true,fatalCount:1,afterCrashRejected:true,
      timedOut:true,timeoutFatalCount:1,postTimeoutAck:0
    });
    assert.equal(evidence.farSeek.ack,700000);
    assert.deepEqual(evidence.farSeek.errors,[]);
    assert.ok(evidence.farSeek.windows>=4,evidence.farSeek);
    assert.ok(evidence.farSeek.afterFrame>700000,evidence.farSeek);
    assert.equal(evidence.farSeek.afterMissing,evidence.farSeek.beforeMissing,
      "far seek source cache should be ready without missing output frames");
  }finally{
    await cleanupTestProcesses(browser,[server],"PCM Worklet HTTP server");
  }
});
