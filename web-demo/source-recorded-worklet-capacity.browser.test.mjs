import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

// #36 R2: same checksum-verified, rights-cleared recorded piano as the
// offline source-reference suite. Exercise the ACTUAL AudioWorklet render
// thread, post-render PCM probe and Chrome's independent WebAudio runtime
// metrics. This is NOT per-quantum CPU timing or a physical DAC capture.
const SHA="69bbdab7ee718e174a23850f5525ff87761ca904a4445e6ae9138ca42b7dd261";
const spans=[1,2,16,127,128,129,256],speeds=[-1,0,1];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=n=>Number(n.toFixed(6));

test("recorded ultrashort loops: real Chrome Worklet PCM, source oracle and WebAudio render capacity",async()=>{
  const server=spawn("python3",["-m","http.server","18821","--bind","127.0.0.1"],{
    cwd:path.resolve("web-demo"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage(),errors=[],contexts=[];
    page.on("pageerror",error=>errors.push(error.message));
    const cdp=await page.createCDPSession();
    cdp.on("WebAudio.contextCreated",({context})=>contexts.push(context));
    await cdp.send("WebAudio.enable");
    await page.goto("http://127.0.0.1:18821/source-pcm-smoke.html",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await page.evaluate(async expectedSha=>{
      const response=await fetch("./test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
      if(!response.ok)throw Error("recorded CC0 source fetch failed");
      const data=await response.arrayBuffer();
      const hex=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)))
        .map(b=>b.toString(16).padStart(2,"0")).join("");
      if(hex!==expectedSha)throw Error("recorded source checksum mismatch");
      const dv=new DataView(data);
      if(dv.getUint32(0,false)!==0x52494646||dv.getUint32(8,false)!==0x57415645)
        throw Error("not the original RIFF/WAVE recording");
      let rate=0,channels=0,bits=0,encoding=0,start=-1,count=0;
      for(let at=12;at+8<=dv.byteLength;){
        const four=String.fromCharCode(...new Uint8Array(data,at,4));
        const size=dv.getUint32(at+4,true),p=at+8;
        if(p+size>dv.byteLength)throw Error("invalid WAV chunk");
        if(four==="fmt "){
          encoding=dv.getUint16(p,true);channels=dv.getUint16(p+2,true);
          rate=dv.getUint32(p+4,true);bits=dv.getUint16(p+14,true);
        }
        if(four==="data"){start=p;count=size;}
        at=p+size+(size%2);
      }
      if(rate!==48000||channels!==1||bits!==16||encoding!==1||
         start<0||count!==144000*2)throw Error("unexpected piano recording format");
      const source=new Float32Array(count/2);
      for(let i=0;i<source.length;i++)
        source[i]=dv.getInt16(start+i*2,true)/32768;
      const ctx=new AudioContext({sampleRate:rate,latencyHint:"interactive"});
      if(ctx.sampleRate!==rate)throw Error("actual output rate differs; source oracle uncalibrated");
      await ctx.audioWorklet.addModule("./source-pcm-probe.worklet.js");
      const probe=new AudioWorkletNode(ctx,"audio-lab-pcm-probe",{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]
      });
      probe.connect(ctx.destination);
      let seq=0;
      const measure=(op,captureFrames=0)=>new Promise((resolve,reject)=>{
        const id=++seq;
        const timeout=setTimeout(()=>{
          probe.port.removeEventListener("message",listener);
          reject(Error("audio probe "+op+" timeout"));
        },3000);
        const listener=e=>{
          if(e.data?.id!==id)return;
          clearTimeout(timeout);
          probe.port.removeEventListener("message",listener);
          resolve(e.data.stats);
        };
        probe.port.addEventListener("message",listener);
        probe.port.start();
        probe.port.postMessage({op,id,captureFrames});
      });
      const {createSourcePCMBridge}=await import("./source-pcm-bridge.mjs");
      window.__r2={
        source,ctx,probe,measure,createSourcePCMBridge,
        anchor:100417,bridge:null,mode:null,
        events:[],sourceSha:hex
      };
      await ctx.resume();
    },SHA);
    await page.waitForFunction(()=>!!window.__r2?.ctx,{timeout:10000});
    await sleep(50);
    const context=contexts.find(x=>x.contextType==="realtime"&&x.sampleRate===48000);
    assert.ok(context,"CDP must observe the actual Chrome AudioContext");
    const measured=[];
    for(const mode of ["raw","granular"]){
      const initialized=await page.evaluate(async mode=>{
        const s=window.__r2;
        s.bridge?.dispose();
        s.mode=mode;
        s.events=[];
        s.bridge=await s.createSourcePCMBridge({
          ctx:s.ctx,sourceChannels:[s.source],sourceSampleRate:48000,
          startFrame:s.anchor,loopStartFrame:s.anchor,
          loopEndFrame:s.anchor+256,loopEnabled:true,
          processingMode:mode,pitchSemitones:mode==="granular"?7.1234:0,
          onEvent:e=>{
            if(e.type==="render-applied"||e.type==="underrun"||
               e.type==="error"||e.type==="fatal-error")
              s.events.push(e);
          }
        });
        s.bridge.connect(s.probe);
        await s.bridge.play();
        return {rate:s.ctx.sampleRate,mode};
      },mode);
      assert.equal(initialized.rate,48000);
      // Reuse the SAME Worklet for all 21 cases of one processing mode.
      for(const span of spans){
        for(const speed of speeds){
          const output=await page.evaluate(async ({span,speed})=>{
            const s=window.__r2,bridge=s.bridge;
            const a=s.anchor,b=a+span;
            await bridge.setLoopBounds(a,b);
            await bridge.setSpeed(speed);
            const seek=await bridge.seek(speed<0?b-1:a);
            const startMissing=bridge.latest?.missingFrames??0;
            const eventStart=s.events.length;
            // Settle command-accepted and output-quantum receipts before
            // arming independent post-render capture. This is not a
            // consumer/UI ACK masquerading as audio samples.
            await new Promise(resolve=>setTimeout(resolve,55));
            await s.measure("arm",2048);
            await new Promise(resolve=>setTimeout(resolve,68));
            const stats=await s.measure("snapshot");
            const endMissing=bridge.latest?.missingFrames??0;
            const received=s.events.slice(eventStart);
            const captured=stats.channels[0]?.captured||[];
            if(captured.length!==2048)throw Error("incomplete actual Worklet output capture");
            const maxAbs=Math.max(...captured.map(Math.abs));
            const finite=captured.every(Number.isFinite);
            const rendered=received.filter(e=>e.type==="render-applied"&&e.running);
            let oracleError=null,phase=null;
            if(s.mode==="raw"){
              // The first observed output position has an unknown delay
              // since the last seek; allow only the source-period offset,
              // never a changing phase, silent block or scale adjustment.
              let least=Infinity;
              for(let p=0;p<span;p++){
                let worst=0;
                for(let i=0;i<captured.length;i++){
                  const j=((p+i*speed)%span+span)%span;
                  const err=Math.abs(captured[i]-s.source[a+j]);
                  if(err>worst)worst=err;
                  if(worst>=least)break;
                }
                if(worst<least){least=worst;phase=p;}
              }
              oracleError=least;
            }
            return {span,speed,mode:s.mode,
              sourceFrameAck:seek.sourceFrame,
              oracleError,phase,maxAbs,finite,
              inputBoundaryDifference:Math.abs(s.source[b-1]-s.source[a]),
              missingDelta:endMissing-startMissing,
              probeFrames:stats.channels[0]?.frames||0,
              probeMaxZeroRun:stats.channels[0]?.maxZeroRun,
              probeRms:stats.channels[0]?.rms,
              renderReceipts:rendered.length,
              renderReceiptMissing:rendered.map(e=>e.missingFramesInBlock),
              errorEvents:received.filter(e=>
                ["error","fatal-error","underrun"].includes(e.type)).map(e=>e.type)
            };
          },{span,speed});
          let capacity=null;
          try{
            const data=await cdp.send("WebAudio.getRealtimeData",
              {contextId:context.contextId});
            capacity=data.realtimeData;
          }catch(error){
            throw Error("Chrome actual WebAudio runtime metrics unavailable: "+error.message);
          }
          assert.ok(capacity&&Number.isFinite(capacity.renderCapacity)&&
            Number.isFinite(capacity.callbackIntervalMean)&&
            Number.isFinite(capacity.callbackIntervalVariance),
            "real Chrome AudioContext metrics are required");
          assert.ok(output.finite&&output.probeFrames>=2048&&
            output.maxAbs>.001,{output,capacity});
          assert.equal(output.missingDelta,0,{output,capacity});
          assert.deepEqual(output.errorEvents,[],{output,capacity});
          assert.ok(output.renderReceipts>=1,{output,capacity});
          assert.ok(output.renderReceiptMissing.every(n=>n===0),{output,capacity});
          if(mode==="raw")
            assert.ok(output.oracleError<1e-5,
              "actual post-Worklet output must equal periodic recorded-source samples: "+
              JSON.stringify(output));
          measured.push({...output,capacity:round(capacity.renderCapacity),
            callbackIntervalMean:round(capacity.callbackIntervalMean),
            callbackIntervalVariance:round(capacity.callbackIntervalVariance)});
        }
      }
    }
    await page.evaluate(async()=>{
      const s=window.__r2;
      await s.bridge.pause();
      s.bridge.dispose();
      s.probe.disconnect();
      await s.ctx.close();
    });
    assert.deepEqual(errors,[]);
    const summarized=mode=>{
      const list=measured.filter(e=>e.mode===mode);
      return {count:list.length,missing:list.reduce((a,x)=>a+x.missingDelta,0),
        maxSourceError:mode==="raw"?Math.max(...list.map(x=>x.oracleError)):null,
        maxCapacityPercent:Math.max(...list.map(x=>x.capacity)),
        meanCapacityPercent:round(list.reduce((a,x)=>a+x.capacity,0)/list.length),
        maxCallbackIntervalVariance:Math.max(...list.map(x=>x.callbackIntervalVariance)),
        minProbeRms:Math.min(...list.map(x=>x.probeRms))};
    };
    console.log("RECORDED_REAL_CHROME_WORKLET_QUANTUM "+JSON.stringify({
      source:"CC0 Meta Piano A0",sha:SHA,rate:48000,anchor:100417,
      spans,speeds,raw:summarized("raw"),granular:summarized("granular"),
      observed:measured,
      interpretation:"Chrome graph-wide renderCapacity and callback interval; NOT per-quantum execution-time or device DAC/glitch guarantee",
      shortLoopContract:"raw source-step oracle permits original A/B edge jumps; granular nonzero finite and missing/receipt only"
    }));
  }finally{await browser?.close();server.kill("SIGTERM");}
});
