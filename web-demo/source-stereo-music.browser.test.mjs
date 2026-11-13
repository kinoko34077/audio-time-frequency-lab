import test from "node:test";
import assert from "node:assert/strict";
import {readFile,stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

// #36 R2: a COMPLETE, CC0, originally released stereo orchestral music
// recording, not a mono isolated note or a generated music-like test tone.
// Author/CC0/file URL are recorded in test-fixtures/STEREO_MUSIC_SOURCE.md.
// Retrieved into test-only directory by the Actions workflow; stage-pages
// must never include the copyrighted/CC0 musical fixture in public Pages.
const FILE=path.resolve("web-demo/test-fixtures/determined-pursuit-cc0-full-stereo.wav");
const NAME="determined-pursuit-cc0-full-stereo.wav";
const PINNED_SHA="e4f3be098b50213b56a60aefe60fffae79cd9f7c9008088f93c187ef1bbc856b";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=x=>Number(x.toFixed(6));

test("full real CC0 stereo orchestral song: three musical sections, L/R output, raw reference and granular signed-pitch UI",{
  timeout:120000
},async()=>{
  const data=await readFile(FILE);
  assert.ok(data.length>4_000_000,"complete original music, not a short test excerpt");
  const sha=createHash("sha256").update(data).digest("hex");
  // SHA becomes hard-pinned after the first successful original-source
  // acquisition. Until then this is exploratory, not accepted provenance.
  assert.equal(sha,PINNED_SHA,
    "original complete CC0 orchestral music source has changed; do not substitute it");
  const fixtureSize=(await stat(FILE)).size;
  const sourceServer=spawn("python3",["-m","http.server","18827","--bind","127.0.0.1"],{
    cwd:path.resolve("web-demo"),stdio:"ignore"
  });
  const appServer=spawn("python3",["-m","http.server","18828","--bind","127.0.0.1"],{
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
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto("http://127.0.0.1:18827/source-pcm-smoke.html",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    const source=await page.evaluate(async sha=>{
      const r=await fetch("./test-fixtures/determined-pursuit-cc0-full-stereo.wav");
      if(!r.ok)throw Error("stereo musical source not reachable through actual page");
      const raw=await r.arrayBuffer();
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",raw)))
        .map(x=>x.toString(16).padStart(2,"0")).join("");
      if(digest!==sha)throw Error("browser and Node received different original song");
      const ctx=new AudioContext({sampleRate:48000,latencyHint:"interactive"});
      const decoded=await ctx.decodeAudioData(raw.slice(0));
      if(decoded.numberOfChannels!==2||
        decoded.duration<30||decoded.duration>360||
        decoded.sampleRate!==48000)
        throw Error("source must decode to a complete actual 2-channel musical song");
      const sourceChannels=[decoded.getChannelData(0),decoded.getChannelData(1)];
      const rms=x=>Math.sqrt(x.reduce((a,v)=>a+v*v,0)/x.length);
      const metrics=(l,r,at,len=4096)=>{
        let left=0,right=0,mid=0,side=0,cross=0;
        for(let i=0;i<len;i++){
          const a=l[at+i],b=r[at+i];
          left+=a*a;right+=b*b;mid+=(a+b)**2/4;
          side+=(a-b)**2/4;cross+=a*b;
        }
        return {rmsL:Math.sqrt(left/len),rmsR:Math.sqrt(right/len),
          rmsMid:Math.sqrt(mid/len),rmsSide:Math.sqrt(side/len),
          sideMid:Math.sqrt(side/Math.max(mid,1e-15)),
          correlation:cross/Math.sqrt(Math.max(left*right,1e-15))};
      };
      const frames=decoded.length,anchors=[];
      for(const fraction of [.19,.50,.81]){
        let best=null;
        // Score a non-silent, stereo musical passage near each different
        // region of the WHOLE song; no substitution with isolated notes.
        for(let n=-3;n<=3;n++){
          const at=Math.max(8192,Math.min(frames-14000,
            Math.round(frames*fraction+n*48000)));
          const m=metrics(sourceChannels[0],sourceChannels[1],at);
          const score=m.rmsMid+m.rmsSide*.4;
          if(!best||score>best.score)best={at,score,...m};
        }
        anchors.push(best);
      }
      if(anchors.some(x=>x.rmsL<.002||x.rmsR<.002))
        throw Error("the selected song passages must contain real audible music");
      if(anchors.filter(x=>x.sideMid>.02).length<2)
        throw Error("two sampled musical passages must have independent L/R material");
      await ctx.audioWorklet.addModule("./source-pcm-probe.worklet.js");
      const probe=new AudioWorkletNode(ctx,"audio-lab-pcm-probe",{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]
      });
      probe.connect(ctx.destination);
      let id=0;
      const measure=(op,captureFrames=0)=>new Promise((resolve,reject)=>{
        const requestId=++id;
        const timeout=setTimeout(()=>{
          probe.port.removeEventListener("message",listener);
          reject(Error("stereo music probe timed out: "+op));
        },6000);
        const listener=e=>{
          if(e.data?.id!==requestId)return;
          clearTimeout(timeout);probe.port.removeEventListener("message",listener);
          resolve(e.data.stats);
        };
        probe.port.addEventListener("message",listener);
        probe.port.start();
        probe.port.postMessage({id:requestId,op,captureFrames});
      });
      const {createSourcePCMBridge}=await import("./source-pcm-bridge.mjs");
      window.__music={
        ctx,sourceChannels,probe,anchors,measure,metrics,createSourcePCMBridge,
        bridge:null,events:[],activeMode:null
      };
      await ctx.resume();
      return {channels:decoded.numberOfChannels,duration:decoded.duration,
        sampleRate:decoded.sampleRate,frames,anchors:anchors.map(x=>({
          at:x.at,rmsL:x.rmsL,rmsR:x.rmsR,sideMid:x.sideMid,
          correlation:x.correlation
        })),sha:digest};
    },sha);
    assert.equal(source.channels,2);
    assert.ok(source.anchors.every(x=>x.rmsL>.002&&x.rmsR>.002));
    console.log("R2_FULL_STEREO_SOURCE_METADATA "+JSON.stringify({
      sha256:sha,bytes:fixtureSize,channels:source.channels,
      durationSeconds:round(source.duration),sampleRate:source.sampleRate,
      sourceRegions:source.anchors.map(x=>({
        frame:x.at,rmsL:round(x.rmsL),rmsR:round(x.rmsR),
        sideMid:round(x.sideMid),correlation:round(x.correlation)
      }))
    }));
    const observations=[];
    const variants=[
      {mode:"raw",speed:1,pitch:0},
      {mode:"raw",speed:-1,pitch:0},
      {mode:"granular",speed:1,pitch:0},
      {mode:"granular",speed:1,pitch:7.1234},
      {mode:"granular",speed:.5,pitch:7.1234},
      {mode:"granular",speed:-1,pitch:-5},
      {mode:"granular",speed:0,pitch:7.1234}
    ];
    let currentMode=null;
    for(const variant of variants){
      if(currentMode!==variant.mode){
        currentMode=variant.mode;
        await page.evaluate(async mode=>{
          const s=window.__music;
          s.bridge?.dispose();s.activeMode=mode;s.events=[];
          s.bridge=await s.createSourcePCMBridge({
            ctx:s.ctx,sourceChannels:s.sourceChannels,
            sourceSampleRate:48000,processingMode:mode,
            startFrame:s.anchors[0].at,
            loopStartFrame:0,loopEndFrame:s.sourceChannels[0].length,
            speed:1,pitchSemitones:0,loopEnabled:false,
            onEvent:e=>{
              if(["render-applied","error","fatal-error","underrun"].includes(e.type))
                s.events.push(e);
            }
          });
          s.bridge.connect(s.probe);
          await s.bridge.play();
        },variant.mode);
      }
      for(let region=0;region<3;region++){
        const result=await page.evaluate(async ({variant,region})=>{
          const s=window.__music,b=s.bridge;
          const anchor=s.anchors[region].at;
          const evtFrom=s.events.length;
          await b.setSpeed(variant.speed);
          if(variant.mode==="granular")await b.setPitch(variant.pitch);
          await b.seek(anchor);
          // Wait for bounded source-window refill and first render-applied
          // before observing the true post-render stereo graph.
          await new Promise(resolve=>setTimeout(resolve,95));
          const missing0=b.latest?.missingFrames??0;
          await s.measure("arm",2048);
          await new Promise(resolve=>setTimeout(resolve,85));
          const stats=await s.measure("snapshot");
          const missing1=b.latest?.missingFrames??0;
          const l=stats.channels[0]?.captured||[];
          const r=stats.channels[1]?.captured||[];
          if(l.length!==2048||r.length!==2048||stats.inputChannels!==2)
            throw Error("real stereo output probe did not capture both channels");
          const finite=l.every(Number.isFinite)&&r.every(Number.isFinite);
          const actual=s.metrics(l,r,0,l.length);
          let maxSourceDifference=null,phaseSourceFrame=null;
          if(variant.mode==="raw"){
            // Independent source-oracle: native browser's decoded stereo
            // recording, never a hand-built surrogate. Unknown capture-start
            // phase is measured via two-channel sparse correlation, then
            // EVERY captured sample is checked sample-exactly.
            const samples=s.sourceChannels,sign=variant.speed;
            let best=Infinity;
            for(let offset=0;offset<=18000;offset++){
              const frame=anchor+sign*offset;
              if(frame-sign*2047<0&&sign<0)continue;
              if(frame+sign*2047>=samples[0].length&&sign>0)continue;
              let score=0;
              for(let i=0;i<2048;i+=256){
                const at=frame+sign*i;
                const a=samples[0][at]-l[i],b=samples[1][at]-r[i];
                score+=a*a+b*b;
              }
              if(score<best){best=score;phaseSourceFrame=frame;}
            }
            let max=0;
            for(let i=0;i<2048;i++){
              const at=phaseSourceFrame+sign*i;
              max=Math.max(max,Math.abs(samples[0][at]-l[i]),
                Math.abs(samples[1][at]-r[i]));
            }
            maxSourceDifference=max;
          }
          const evt=s.events.slice(evtFrom);
          return {mode:variant.mode,region,sourceAnchor:anchor,
            speed:variant.speed,pitch:variant.pitch,
            inputRmsL:s.anchors[region].rmsL,
            inputRmsR:s.anchors[region].rmsR,
            inputSideMid:s.anchors[region].sideMid,
            outputRmsL:actual.rmsL,outputRmsR:actual.rmsR,
            outputSideMid:actual.sideMid,outputCorrelation:actual.correlation,
            finite,framesCaptured:2048,
            missingDelta:missing1-missing0,
            sourceFrameMatch:phaseSourceFrame,maxSourceDifference,
            renderReceipts:evt.filter(x=>x.type==="render-applied").length,
            renderReceiptMisses:evt.filter(x=>x.type==="render-applied")
              .map(x=>x.missingFramesInBlock),
            errors:evt.filter(x=>["error","fatal-error","underrun"].includes(x.type))
              .map(x=>x.type)
          };
        },{variant,region});
        assert.ok(result.finite&&result.outputRmsL>.0005&&
          result.outputRmsR>.0005,result);
        assert.ok(result.outputSideMid>.0002,
          "actual stereo musical mix must not collapse into identical L/R output: "+
          JSON.stringify(result));
        assert.equal(result.missingDelta,0,result);
        assert.deepEqual(result.errors,[],result);
        assert.ok(result.renderReceipts>0,result);
        assert.ok(result.renderReceiptMisses.every(n=>n===0),result);
        if(variant.mode==="raw")
          assert.ok(result.maxSourceDifference<1e-6,
            "raw music must match BOTH stereo original channels exactly: "+
            JSON.stringify(result));
        observations.push(result);
      }
    }
    // Follow-up #36 R2: apply the user's *actual complete stereo song* to
    // sample-precise A/B loops rather than using the mono note as a surrogate.
    // For RAW, verify BOTH channels against the original 48k decoded song
    // cyclic sample by sample, including legitimate original A/B edge steps.
    // Granular pitch on a 1-sample source interval cannot imply musical
    // fundamental or subjective clickless sound; check only 2ch transport
    // continuity, finite output, source misses and render receipts.
    const ultra=[],spans=[1,2,16,127,128,129,256];
    for(const mode of ["raw","granular"]){
      await page.evaluate(async mode=>{
        const s=window.__music;
        s.bridge.dispose();
        s.events=[];
        const a=s.anchors[1].at;
        s.bridge=await s.createSourcePCMBridge({
          ctx:s.ctx,sourceChannels:s.sourceChannels,sourceSampleRate:48000,
          startFrame:a,loopStartFrame:a,loopEndFrame:a+256,
          loopEnabled:true,speed:1,processingMode:mode,
          pitchSemitones:mode==="granular"?7.1234:0,
          onEvent:e=>{
            if(["render-applied","error","fatal-error","underrun"].includes(e.type))
              s.events.push(e);
          }
        });
        s.bridge.connect(s.probe);
        await s.bridge.play();
        s.activeMode=mode;
      },mode);
      const regions=mode==="raw"?[0,1,2]:[1];
      for(const region of regions){
        for(const span of spans){
          for(const speed of [-1,0,1]){
            const result=await page.evaluate(async ({region,span,speed,mode})=>{
              const s=window.__music,b=s.bridge;
              const a=s.anchors[region].at,end=a+span;
              const from=s.events.length;
              await b.setLoopBounds(a,end);
              await b.setSpeed(speed);
              await b.seek(speed<0?end-1:a);
              await new Promise(resolve=>setTimeout(resolve,55));
              const firstMissing=b.latest?.missingFrames??0;
              await s.measure("arm",2048);
              await new Promise(resolve=>setTimeout(resolve,68));
              const snap=await s.measure("snapshot");
              const lastMissing=b.latest?.missingFrames??0;
              const left=snap.channels[0]?.captured||[];
              const right=snap.channels[1]?.captured||[];
              if(snap.inputChannels!==2||left.length!==2048||
                 right.length!==2048)
                throw Error("A/B stereo Worklet probe must capture both L/R");
              const complete=s.events.slice(from);
              let maxOracleError=null,phase=null,sourceMaxStep=null,
                outputMaxStep=null;
              if(mode==="raw"){
                const source=s.sourceChannels;
                let best=Infinity;
                for(let candidate=0;candidate<span;candidate++){
                  let error=0;
                  for(let i=0;i<2048;i+=256){
                    const j=((candidate+i*speed)%span+span)%span;
                    const x=source[0][a+j]-left[i],
                      y=source[1][a+j]-right[i];
                    error+=x*x+y*y;
                  }
                  if(error<best){best=error;phase=candidate;}
                }
                maxOracleError=0;outputMaxStep=0;sourceMaxStep=0;
                for(let i=0;i<2048;i++){
                  const j=((phase+i*speed)%span+span)%span;
                  maxOracleError=Math.max(maxOracleError,
                    Math.abs(source[0][a+j]-left[i]),
                    Math.abs(source[1][a+j]-right[i]));
                  if(i){
                    outputMaxStep=Math.max(outputMaxStep,
                      Math.abs(left[i]-left[i-1]),
                      Math.abs(right[i]-right[i-1]));
                  }
                }
                for(let j=0;j<span;j++){
                  const k=((j+speed)%span+span)%span;
                  sourceMaxStep=Math.max(sourceMaxStep,
                    Math.abs(source[0][a+k]-source[0][a+j]),
                    Math.abs(source[1][a+k]-source[1][a+j]));
                }
              }
              const stats=s.metrics(left,right,0,2048);
              return {mode,region,span,speed,
                observedSourceFrame:a,firstPhase:phase,
                sourceBoundaryStepL:Math.abs(
                  s.sourceChannels[0][end-1]-s.sourceChannels[0][a]),
                sourceBoundaryStepR:Math.abs(
                  s.sourceChannels[1][end-1]-s.sourceChannels[1][a]),
                maxOracleError,sourceMaxStep,outputMaxStep,
                finite:left.every(Number.isFinite)&&right.every(Number.isFinite),
                sampleCount:2048,outputRmsL:stats.rmsL,
                outputRmsR:stats.rmsR,outputSideMid:stats.sideMid,
                missing: lastMissing-firstMissing,
                renderReceipts:complete.filter(e=>e.type==="render-applied").length,
                receiptMisses:complete.filter(e=>e.type==="render-applied")
                  .map(e=>e.missingFramesInBlock),
                errors:complete.filter(e=>
                  ["error","fatal-error","underrun"].includes(e.type))
                  .map(e=>e.type)
              };
            },{region,span,speed,mode});
            assert.ok(result.finite&&result.sampleCount===2048,result);
            assert.equal(result.missing,0,result);
            assert.deepEqual(result.errors,[],result);
            assert.ok(result.renderReceipts>0,result);
            assert.ok(result.receiptMisses.every(x=>x===0),result);
            if(mode==="raw"){
              assert.ok(result.maxOracleError<1e-6,
                "both song channels must equal original cyclic PCM, not generated gaps: "+
                JSON.stringify(result));
              assert.ok(Math.abs(result.outputMaxStep-result.sourceMaxStep)<1e-5,
                "any loop click must be original PCM A/B derivative, not an injected step: "+
                JSON.stringify(result));
            }
            ultra.push(result);
          }
        }
      }
    }
    const rawCases=ultra.filter(x=>x.mode==="raw"),
      granularCases=ultra.filter(x=>x.mode==="granular");
    assert.equal(rawCases.length,63);
    assert.equal(granularCases.length,21);
    console.log("R2_REAL_STEREO_MUSIC_ULTRASHORT "+JSON.stringify({
      sourceSha:sha,title:"Determined Pursuit complete 108s stereo orchestral recording",
      sourceSampleRate:44100,workletSampleRate:48000,
      lengthsSourceFrames:spans,speeds:[-1,0,1],musicalRegions:[0,1,2],
      raw:{count:rawCases.length,maxSourceSampleError:Math.max(...rawCases.map(x=>x.maxOracleError)),
        maxUnexpectedStep:Math.max(...rawCases.map(x=>Math.abs(x.outputMaxStep-x.sourceMaxStep))),
        missing:rawCases.reduce((n,x)=>n+x.missing,0)},
      granular:{count:granularCases.length,missing:granularCases.reduce((n,x)=>n+x.missing,0),
        minLrPower:Math.min(...granularCases.map(x=>Math.min(x.outputRmsL,x.outputRmsR)))},
      rawConditions:rawCases.map(x=>({region:x.region,span:x.span,
        speed:x.speed,maxSourceSampleError:x.maxOracleError,
        naturalABStepL:round(x.sourceBoundaryStepL),
        naturalABStepR:round(x.sourceBoundaryStepR)})),
      note:"Original musical A/B seam steps are permitted and MUST remain distinct from newly inserted silence/click. Granular 1-source-sample pitch is not perceptually meaningful; the test makes no subjective sound-quality claim."
    }));
    await page.evaluate(async()=>{
      const s=window.__music;
      await s.bridge.pause();s.bridge.dispose();s.probe.disconnect();
      await s.ctx.close();
    });
    // Validate the actual USER-FACING phone-width file-picker/player as well:
    // the original full song is uploaded via the HTML file input, not a URL
    // that would be published to end users.
    const app=await browser.newPage();
    app.on("pageerror",e=>errors.push(e.message));
    await app.setViewport({width:412,height:915,deviceScaleFactor:2,
      isMobile:true,hasTouch:true});
    await app.goto("http://127.0.0.1:18828/",{
      waitUntil:"domcontentloaded",timeout:20000
    });
    await app.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:25000});
    await (await app.$("#audio-file")).uploadFile(FILE);
    await app.waitForFunction(name=>{
      const v=document.querySelector("#file-meta")?.textContent||"";
      return v.includes(name)&&v.includes("2ch");
    },{timeout:30000},NAME);
    const meta=await app.$eval("#file-meta",el=>el.textContent);
    await app.waitForSelector("#play-main:not([disabled])",{timeout:20000});
    const playButton=await app.$eval("#play-main",e=>{
      const b=e.getBoundingClientRect();
      return {top:b.top,bottom:b.bottom,width:b.width};
    });
    assert.ok(playButton.width>0&&playButton.bottom<=915,
      "primary play must be in the initial 412x915 mobile viewport");
    await app.click("#play-main");
    await app.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderRunning==="true",{timeout:25000});
    const originalNodes=await app.$eval("#rt-telemetry",
      e=>Number(e.dataset.pcmNodeStarts));
    assert.equal(originalNodes,1);
    await app.evaluate(()=>{
      const v=document.getElementById("granular-speed-value");
      v.value="-1";v.dispatchEvent(new Event("change",{bubbles:true}));
      const p=document.getElementById("granular-pitch-value");
      p.value="7.1234";p.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await app.waitForFunction(()=>document.querySelector("#granular-optin-status")
      ?.dataset.renderPitch==="7.1234"&&
      document.querySelector("#granular-optin-status")
        ?.dataset.renderRunning==="true",{timeout:25000});
    assert.equal(await app.$eval("#rt-telemetry",
      e=>Number(e.dataset.pcmNodeStarts)),originalNodes,
      "song speed/pitch changes must reuse one Worklet, not restart it");
    await app.click("#stop");
    assert.deepEqual(errors,[]);
    console.log("R2_FULL_STEREO_MUSIC_REAL_BROWSER "+JSON.stringify({
      title:"Determined Pursuit",author:"Emma_MA",license:"CC0",
      originalURL:"https://opengameart.org/sites/default/files/determined_pursuit_loop.wav",
      sha256:sha,bytes:fixtureSize,source,
      runs:observations.length,rawSampleExactCases:observations.filter(x=>x.mode==="raw").length,
      granularCases:observations.filter(x=>x.mode==="granular").length,
      observations:observations.map(x=>({
        ...x,inputRmsL:round(x.inputRmsL),inputRmsR:round(x.inputRmsR),
        inputSideMid:round(x.inputSideMid),outputRmsL:round(x.outputRmsL),
        outputRmsR:round(x.outputRmsR),outputSideMid:round(x.outputSideMid),
        outputCorrelation:round(x.outputCorrelation)
      })),
      userFilePickerMeta:meta,mobileViewport:"412x915 Android-class touch",
      nodeStarts:originalNodes,scope:"REAL_COMPLETE_STEREO_ORCHESTRAL_SONG_CHROMIUM_WEB_AUDIO_NOT_DAC_OR_SUBJECTIVE_AUDIO"
    }));
  }finally{
    await browser?.close();
    sourceServer.kill("SIGTERM");appServer.kill("SIGTERM");
  }
});
