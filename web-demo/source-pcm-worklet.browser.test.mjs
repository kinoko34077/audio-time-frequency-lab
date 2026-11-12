import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

test("native Chrome experimental source-PCM AudioWorklet renders and loops without recreating its node",async()=>{
  const port=18743;
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
      await player.setLoopBounds(97,99);
      await player.setLoopEnabled(true);
      await player.seek(97);
      await player.setSpeed(-8);
      await player.play();
      await new Promise(resolve=>setTimeout(resolve,180));
      const loop=player.latest;
      await player.pause();
      const stable=node===player.node;
      player.dispose();
      const afterDispose=[];
      node.port.onmessage=e=>afterDispose.push(e.data?.type);
      node.port.postMessage({type:"command",op:"play",requestId:999999});
      await new Promise(resolve=>setTimeout(resolve,120));
      await ctx.close();
      return {
        first,loop,rms,stable,afterDispose,errors:events.filter(x=>x.type==="error"),
        windowAccepts:events.filter(x=>x.type==="window-accepted").length,
        gapReports:events.filter(x=>x.type==="underrun").length
      };
    });
    assert.deepEqual(pageErrors,[]);
    assert.deepEqual(evidence.errors,[]);
    assert.ok(evidence.first?.renderedFrames>=1024,evidence);
    assert.ok(evidence.loop?.renderedFrames>evidence.first.renderedFrames,evidence);
    assert.equal(evidence.loop.missingFrames,0,evidence);
    assert.ok(evidence.rms>.01,`expected audible PCM: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.stable,true);
    assert.deepEqual(evidence.afterDispose,[],
      "disposed worklet must no longer accept commands");
    assert.ok(evidence.windowAccepts>=1);
  }finally{
    await browser?.close();
    server.kill();
  }
});
