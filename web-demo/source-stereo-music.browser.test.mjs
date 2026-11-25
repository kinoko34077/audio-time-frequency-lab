import test from "node:test";
import assert from "node:assert/strict";
import {readFile,stat,mkdtemp,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawn,execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";
import {installTestAudioSilenceGuard} from "./test-audio-silence-guard.mjs";

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
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
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
    await app.goto("http://127.0.0.1:18828/?model=granular&legacyUi=1",{
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
    await cleanupTestProcesses(browser,[sourceServer,appServer],
      "stereo music HTTP server");
  }
});

/* #113/#36: a finite normal-use audit, not a synthetic scheduler fault injection.
 * Reuse the complete verified CC0 song and real staged default player.
 * Keep the encoded derivative outside _site and do not publish it.
 * Report deficits rather than making an arbitrary performance threshold a gate.
 */
test("normal player PV: continuous controls, distant seek and A/B with a full compressed stereo song",{
  timeout:90000
},async()=>{
  assert.equal(createHash("sha256").update(await readFile(FILE)).digest("hex"),PINNED_SHA);
  const dir=await mkdtemp(path.join(tmpdir(),"audio-lab-normal-use-"));
  const mp3=path.join(dir,"determined-pursuit-normal-use.mp3");
  let server,browser,cdp;
  try{
    execFileSync("ffmpeg",["-nostdin","-v","error","-i",FILE,"-codec:a","libmp3lame",
      "-b:a","192k",mp3],{timeout:30000,stdio:"pipe"});
    const encoded=await readFile(mp3);
    server=spawn("python3",["-m","http.server","18829","--bind","127.0.0.1"],{
      cwd:path.resolve("_site"),stdio:"ignore"
    });
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required","--mute-audio"]
    });
    const page=await browser.newPage(),errors=[],contexts=[];
    await page.setViewport({width:412,height:915,deviceScaleFactor:2,
      isMobile:true,hasTouch:true});
    page.on("pageerror",e=>errors.push(e.message));
    cdp=await page.createCDPSession();
    cdp.on("WebAudio.contextCreated",({context})=>contexts.push(context));
    await cdp.send("WebAudio.enable");
    await page.evaluateOnNewDocument(guard=>{
      const audit={mutedOutputRoutes:0,audioOutputMuteGains:[]};
      (0,eval)(`(${guard})`)(window,audit);
      window.__useAudit={audit,events:[],paths:[],ui:[],audio:[],phase:"load",nodeCount:0};
      const a=window.__useAudit;
      const nativeConnect=AudioNode.prototype.connect;
      AudioNode.prototype.connect=function(dest,...args){
        const media=typeof MediaStreamAudioDestinationNode!=="undefined"&&
          dest instanceof MediaStreamAudioDestinationNode;
        if(dest===this.context.destination||media){
          const analyser=this.context.createAnalyser();analyser.fftSize=2048;
          nativeConnect.call(this,analyser,...args);nativeConnect.call(analyser,dest);
          a.paths.push({kind:media?"media":"direct",analyser});
          return dest;
        }
        return nativeConnect.call(this,dest,...args);
      };
      const Native=window.AudioWorkletNode;
      window.AudioWorkletNode=class extends Native{
        constructor(ctx,name,options){
          super(ctx,name,options);
          if(name!=="audio-lab-source-pcm")return;
          const node=++a.nodeCount,port=this.port,post=port.postMessage.bind(port);
          const append=(dir,m)=>{
            // Retain identifiers, clocks and counts, never source PCM buffers.
            const {channels,endpoints,...rest}=m;
            a.events.push({at:performance.now(),phase:a.phase,node,dir,...rest,
              bytes:channels?.reduce((n,c)=>n+c.byteLength,0)||0,
              endpointCount:endpoints?.length??0});
          };
          port.postMessage=(m,...args)=>{append("tx",m);return post(m,...args);};
          port.addEventListener("message",({data})=>append("rx",data));
          port.start();
          this.addEventListener("processorerror",()=>append("rx",{type:"processorerror"}));
        }
      };
      for(const kind of ["input","change","click","pointerdown","pointerup"]){
        document.addEventListener(kind,e=>{
          const id=e.target.closest?.("[id]")?.id;
          if(id&&/granular-(pitch|speed)|player-loop|wave|play-main/.test(id))
            a.ui.push({at:performance.now(),phase:a.phase,kind,id,
              value:e.target.value??null});
        },true);
      }
      // Independent sparse observation of actual output before the mute sink.
      // Not a sample-complete capture: missingFrames is measured by Worklet.
      a.timer=setInterval(()=>{
        if(!a.paths.length)return;
        const values=a.paths.map(({kind,analyser})=>{
          const pcm=new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(pcm);
          return {kind,rms:Math.sqrt(pcm.reduce((n,x)=>n+x*x,0)/pcm.length),
            finite:pcm.every(Number.isFinite)};
        });
        a.audio.push({at:performance.now(),phase:a.phase,values});
      },60);
    },installTestAudioSilenceGuard.toString());
    await page.goto("http://127.0.0.1:18829/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
      {timeout:20000});
    await (await page.$("#audio-file")).uploadFile(mp3);
    await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
      .includes("determined-pursuit-normal-use.mp3")&&
      !document.querySelector("#play-main")?.disabled,{timeout:25000});
    const meta=await page.$eval("#file-meta",e=>e.textContent);
    assert.match(meta,/2ch/);
    assert.equal(await page.$eval("#lab-model",e=>e.value),"pv");
    const phases=[];
    async function phase(name,action,settle=600){
      await page.evaluate(n=>{window.__useAudit.phase=n;},name);
      const begin=Date.now();
      let failure=null;
      try{await action();await sleep(settle);}
      catch(e){failure=e.message;}
      const summary=await page.evaluate(()=>{
        const a=window.__useAudit,p=a.phase;
        const latest=a.events.filter(e=>e.dir==="rx"&&e.type==="progress").at(-1);
        const status=document.querySelector("#granular-optin-status")?.dataset;
        return {phase:p,nodeCount:a.nodeCount,
          requested:{speed:Number(document.querySelector("#granular-speed-value").value),
            pitch:Number(document.querySelector("#granular-pitch-value").value),
            a:Number(document.querySelector("#player-loop-a").value),
            b:Number(document.querySelector("#player-loop-b").value),
            loop:document.querySelector("#player-loop-enabled").checked},
          rendered:latest?{node:latest.node,frame:latest.sourceFrame,speed:latest.speed,
            pitch:latest.pitchSemitones,loop:latest.loopEnabled,a:latest.loopStartFrame,
            b:latest.loopEndFrame,running:latest.running,missing:latest.missingFrames}:null,
          status:{...status}};
      });
      const capacities=[];
      for(const context of contexts.filter(c=>c.contextType==="realtime")){
        try{
          const {realtimeData}=await cdp.send("WebAudio.getRealtimeData",{contextId:context.contextId});
          capacities.push(realtimeData);
        }catch(e){capacities.push({unavailable:e.message});}
      }
      phases.push({...summary,elapsedMs:Date.now()-begin,failure,capacities});
    }
    const point=async(selector,fraction,id,y=.67)=>{
      const b=await page.$eval(selector,el=>{
        el.scrollIntoView({block:"center"});
        const r=el.getBoundingClientRect();
        return {x:r.x,y:r.y,w:r.width,h:r.height};
      });
      return {x:Math.round(b.x+b.w*fraction),y:Math.round(b.y+b.h*y),id};
    };
    const tap=async(selector,fraction=.5,id=1)=>{
      const p=await point(selector,fraction,id);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[p]});
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    };
    const drag=async(selector,from,to,id=2,y=.5)=>{
      const start=await point(selector,from,id,y),end=await point(selector,to,id,y);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[start]});
      try{
        for(let i=1;i<=18;i++){
          await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[
            {...start,x:Math.round(start.x+(end.x-start.x)*i/18)}
          ]});
          await sleep(18);
        }
      }finally{await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});}
    };
    await phase("start",async()=>{
      await tap("#wave",.19);
      if(await page.$eval("#player-loop-enabled",e=>e.checked))await page.click("#player-loop-toggle");
      await page.click("#play-main");
      await page.waitForFunction(()=>document.querySelector("#granular-optin-status")
        ?.dataset.renderRunning==="true",{timeout:15000});
    },1500);
    assert.equal(await page.$eval("#rt-telemetry",e=>e.dataset.pcmTransport),"pv-phase-locked");
    await phase("pitch-rail",()=>drag("#granular-pitch",.50,.64),1400);
    await phase("speed-rail",()=>drag("#granular-speed",.75,.64),1400);
    await phase("distant-scrub",()=>drag("#wave",.23,.64,3,.43),1400);
    await phase("mark-a",()=>page.click("#player-loop-a-now"),450);
    await phase("distant-seek",()=>tap("#wave",.79,4),1000);
    await phase("mark-b",()=>page.click("#player-loop-b-now"),450);
    await phase("loop-on",()=>page.click("#player-loop-toggle"),1500);
    await phase("loop-off",()=>page.click("#player-loop-toggle"),1200);
    const report=await page.evaluate(()=>{
      const a=window.__useAudit;clearInterval(a.timer);
      const byPhase={};
      const phaseFor=p=>byPhase[p]??={tx:0,rx:0,refills:0,discardedRefillResponses:0,
        missingDelta:0,errors:[],renderLatencies:[],maxProgressIntervalMs:0,
        observedPitches:[],observedSpeeds:[],audioSamples:0,nonzeroAudioSamples:0};
      const tx=new Map(),accepted=new Set(),last=new Map();
      for(const e of a.events){
        const p=phaseFor(e.phase),key=e.node+":"+e.requestId;
        if(e.dir==="tx"){
          p.tx++;if(e.requestId!=null)tx.set(key,e);
        }else{
          p.rx++;
          if(e.type==="need-window")p.refills++;
          if(e.type==="window-accepted")accepted.add(key);
          if(e.type==="render-applied"){
            const sent=tx.get(key);
            if(sent)p.renderLatencies.push({op:sent.op??sent.type,
              ms:e.at-sent.at,missing:e.missingFramesInBlock,
              pitch:e.pitchSemitones,speed:e.speed});
          }
          if(["error","fatal-error","processorerror","underrun"].includes(e.type))
            p.errors.push({type:e.type,message:e.message,requestId:e.requestId});
          if(e.type==="progress"){
            const prev=last.get(e.node);
            if(prev){
              p.missingDelta+=Math.max(0,e.missingFrames-prev.missingFrames);
              p.maxProgressIntervalMs=Math.max(p.maxProgressIntervalMs,e.at-prev.at);
            }else p.missingDelta+=e.missingFrames;
            last.set(e.node,e);
            if(!p.observedPitches.includes(e.pitchSemitones))p.observedPitches.push(e.pitchSemitones);
            if(!p.observedSpeeds.includes(e.speed))p.observedSpeeds.push(e.speed);
          }
        }
      }
      // A sent but unacknowledged refill may be stale OR still in flight at
      // the observation end. Do not claim this count proves decode waste.
      for(const [key,e] of tx)
        if(e.type==="window"&&e.refillId!=null&&!accepted.has(key))
          phaseFor(e.phase).discardedRefillResponses++;
      for(const sample of a.audio){
        const p=phaseFor(sample.phase);p.audioSamples++;
        if(sample.values.some(v=>v.rms>1e-4))p.nonzeroAudioSamples++;
      }
      return {byPhase,nodeCount:a.nodeCount,ui:a.ui,
        audioRoutes:a.paths.map(p=>p.kind),mute:a.audit,
        // Bounded detailed command/ACK and refill sequence, not audio data.
        protocol:a.events.filter(e=>e.type!=="progress").map(e=>({
          at:e.at,phase:e.phase,dir:e.dir,node:e.node,type:e.type,op:e.op,
          id:e.requestId,refillId:e.refillId,frame:e.frame??e.sourceFrame,
          pitch:e.semitones??e.pitchSemitones,speed:e.speed,bytes:e.bytes,
          a:e.a??e.loopStartFrame,b:e.b??e.loopEndFrame,enabled:e.enabled??e.loopEnabled,
          missing:e.missingFramesInBlock,message:e.message
        })),
        lastProgress:[...last.values()]};
    });
    console.log("NORMAL_USE_AUDIO_AUDIT "+JSON.stringify({meta,
      fixture:{sourceSHA:PINNED_SHA,encodedSHA:createHash("sha256").update(encoded).digest("hex"),
        bytes:encoded.length,codec:"MP3 192kbps"},
      phases,...report,pageErrors:errors,
      limits:"Host receipt time and sampled graph capacity are not DAC time; sparse analyser does not prove all PCM continuity."}));
    assert.ok(report.mute.mutedOutputRoutes>0&&
      report.mute.audioOutputMuteGains.every(v=>v===0),"audio must stay muted");
    // Only the validity of the audit is a gate here. Product failures
    // (missing frames, errors, late/mismatched settings) remain findings.
    assert.ok(report.byPhase.start?.rx>0&&report.lastProgress.length>0,
      "real normal-player PV progress must be observed");
    assert.ok(report.ui.some(e=>e.id==="granular-pitch")&&
      report.ui.some(e=>e.id==="granular-speed"),"actual controls must receive events");
  }finally{
    try{await cleanupTestProcesses(browser,server?[server]:[],"normal-use audio audit server");}
    finally{await rm(dir,{recursive:true,force:true});}
  }
});
