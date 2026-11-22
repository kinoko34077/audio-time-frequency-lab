import test from "node:test";
import assert from "node:assert/strict";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {createServer} from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {closeBrowserTree} from "./test-process-cleanup.mjs";
import {installTestAudioSilenceGuardForPage} from "./test-audio-silence-guard.mjs";

const WEB_ROOT=path.resolve("web-demo");
const FIXTURE="/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav";
test("recorded piano output stays continuous through live PV speed and pitch commands",{
  timeout:45000
},async()=>{
  const server=createServer(async(req,res)=>{
    let name;
    try{name=decodeURIComponent(new URL(req.url,"http://localhost").pathname);}
    catch{res.writeHead(400).end();return;}
    if(name==="/")name="/source-pcm-smoke.html";
    const file=path.resolve(WEB_ROOT,"."+name);
    if(file!==WEB_ROOT&&!file.startsWith(WEB_ROOT+path.sep)){
      res.writeHead(403).end();return;
    }
    try{
      const info=await stat(file);
      if(!info.isFile()){res.writeHead(404).end();return;}
      const ext=path.extname(file);
      const types={".html":"text/html",".css":"text/css",".js":"text/javascript",
        ".mjs":"text/javascript",".wasm":"application/wasm",".wav":"audio/wav"};
      res.writeHead(200,{"content-type":types[ext]||"application/octet-stream",
        "content-length":info.size});
      createReadStream(file).pipe(res);
    }catch{res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required","--mute-audio"]
    });
    const page=await browser.newPage();
    await installTestAudioSilenceGuardForPage(page);
    await page.goto("http://127.0.0.1:"+server.address().port+"/",{
      waitUntil:"domcontentloaded",timeout:15000
    });
    const result=await page.evaluate(async fixture=>{
      const {createSourcePCMBridge}=await import("./source-pcm-bridge.mjs");
      const maxStep=samples=>{
        let maximum=0;
        for(let i=1;i<samples.length;i++)
          maximum=Math.max(maximum,Math.abs(samples[i]-samples[i-1]));
        return maximum;
      };
      const ctx=new AudioContext({sampleRate:48000});
      const decoded=await ctx.decodeAudioData(await (await fetch(fixture)).arrayBuffer());
      const captureBlocks=[],events=[];
      await ctx.audioWorklet.addModule("./test-pcm-capture.worklet.js");
      const capture=new AudioWorkletNode(ctx,"audio-lab-test-pcm-capture",{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]
      });
      capture.port.onmessage=event=>captureBlocks.push(event.data);
      const analyser=ctx.createAnalyser();analyser.fftSize=128;
      const player=await createSourcePCMBridge({ctx,
        sourceChannels:[decoded.getChannelData(0)],
        sourceSampleRate:decoded.sampleRate,startFrame:48000,speed:1,
        processingMode:"pv",pitchSemitones:.25,onEvent:event=>events.push(event)});
      player.connect(capture);capture.connect(analyser);analyser.connect(ctx.destination);
      await player.play();
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const waitForApplied=async requestId=>{
        const deadline=performance.now()+1000;
        while(performance.now()<deadline){
          const event=events.find(item=>item.type==="render-applied"&&
            item.requestId===requestId);
          if(event)return event;
          await wait(1);
        }
        throw Error("Worklet did not confirm output for command "+requestId);
      };
      const waitForCapturedBlock=async startFrame=>{
        const deadline=performance.now()+250;
        while(performance.now()<deadline){
          const block=captureBlocks.find(item=>item.startFrame===startFrame);
          if(block)return block;
          await wait(1);
        }
        const frames=captureBlocks.map(item=>item.startFrame);
        throw Error("PCM capture missed output frame "+startFrame+
          "; captured range "+(frames.length?frames[0]+".."+
            frames.at(-1):"empty"));
      };
      await wait(120);
      const edits=[
        ["pitch",.5],["speed",.9],["pitch",.75],
        ["speed",.63],["pitch",.25],["speed",.9]
      ];
      const measurements=[];
      for(const [kind,value] of edits){
        await wait(4);
        const before=captureBlocks.at(-1);
        const receipt=kind==="pitch"?await player.setPitch(value):
          await player.setSpeed(value);
        const applied=await waitForApplied(receipt.requestId);
        const output=await waitForCapturedBlock(applied.outputFrame);
        const previous=captureBlocks.find(block=>
          block.startFrame===applied.outputFrame-128)||before;
        if(!previous)
          throw Error("capture missed preceding output quantum for "+applied.outputFrame);
        const previousSamples=previous.channels[0],outputSamples=output.channels[0];
        const boundary=Math.abs(outputSamples[0]-previousSamples.at(-1));
        const previousStep=maxStep(previousSamples),outputStep=maxStep(outputSamples);
        measurements.push({kind,value,requestId:receipt.requestId,
          outputFrame:applied.outputFrame,speed:applied.speed,
          pitch:applied.pitchSemitones,boundary,previousStep,outputStep,
          missingFrames:applied.missingFramesInBlock});
      }
      const audit=window.__audioSilenceAudit;
      await player.pause();player.dispose();capture.disconnect();analyser.disconnect();
      await ctx.close();
      return {sampleRate:decoded.sampleRate,frames:decoded.length,
        measurements,audit,final:player.latest};
    },FIXTURE);
    assert.equal(result.sampleRate,48000);
    assert.equal(result.frames,144000);
    assert.ok(result.audit.mutedOutputRoutes>=1&&
      result.audit.audioOutputMuteGain===0,
      "test Web Audio output was muted: "+JSON.stringify(result.audit));
    assert.ok(result.measurements.every(row=>Number.isFinite(row.boundary)),
      "live AudioWorklet emitted real recorded PCM after each edit: "+
        JSON.stringify(result.measurements));
    assert.ok(result.measurements.every(row=>row.kind==="speed"?
      row.speed===row.value:row.pitch===row.value),
      "PV applied each requested slider value in the captured Worklet output: "+
        JSON.stringify(result.measurements));
    assert.ok(result.measurements.every(row=>row.missingFrames===0),
      "speed/pitch edits did not depend on silent source-cache misses: "+
        JSON.stringify(result.measurements));
    assert.ok(result.measurements.every(row=>row.boundary<=row.previousStep*1.5+.001&&
      row.outputStep<=row.previousStep*2+.001),
      "live PV updates stay within the adjacent recorded-piano PCM steps: "+
        JSON.stringify(result.measurements));
    console.log("RECORDED_LIVE_PV_EDIT_BLOCKS "+JSON.stringify(result.measurements));
  }finally{
    await closeBrowserTree(browser);
    await new Promise(resolve=>server.close(resolve));
  }
});
