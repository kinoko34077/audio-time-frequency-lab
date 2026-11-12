import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

test("native Chrome content-audio stereo output matches independent source-time reference",async()=>{
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
      const measure=(op,captureFrames=0)=>new Promise((resolve,reject)=>{
        const n=++id;
        const timer=setTimeout(()=>{
          probe.port.removeEventListener("message",on);
          reject(Error("probe "+op+" timeout"));
        },3000);
        const on=e=>{
          if(e.data?.id!==n)return;
          clearTimeout(timer);
          probe.port.removeEventListener("message",on);
          resolve(e.data.stats);
        };
        probe.port.addEventListener("message",on);
        probe.port.start();
        probe.port.postMessage({id:n,op,captureFrames});
      });
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const sourceRate=44100,frames=1_000_000,source=[
        new Float32Array(frames),new Float32Array(frames)
      ];
      const tau=2*Math.PI,beatFrames=Math.floor(sourceRate*.37);
      // One reproducible content-bearing fixture for transport, loop,
      // transient, natural-silence, stereo and load checks. This is generated
      // musical-like audio, NOT a substitute for rights-cleared recordings.
      for(let i=0;i<frames;i++){
        const t=i/sourceRate,age=i%beatFrames;
        const transient=age<1700?.23*Math.exp(-age/280)*
          Math.sin(tau*(740+age/25)*t):0;
        const shimmer=.025*((Math.imul(i+17,1103515245)>>>16)/32768-1);
        const chord=.19*Math.sin(tau*174.61*t)+
          .105*Math.sin(tau*261.63*t+.2)+
          .08*Math.sin(tau*329.63*t+.75);
        const vocal=.085*Math.sin(tau*(134*t+2.3*Math.sin(tau*.9*t)))*
          (.65+.35*Math.sin(tau*2.8*t)**2);
        const phase=(i>=145000&&i<146500)?0:1;
        source[0][i]=phase*(chord+vocal+transient+shimmer);
        source[1][i]=phase*(-.65*chord+
          .15*Math.sin(tau*440*t+.9)+
          .075*Math.sin(tau*(196*t+1.1*Math.sin(tau*1.3*t)))+
          .7*transient-.55*shimmer);
      }
      function referenceAt(ch,seek,speed,offset,loop){
        const step=speed*sourceRate/ctx.sampleRate;
        let frame=seek+offset*step;
        if(loop){
          const [a,b]=loop,length=b-a;
          frame=a+(((frame-a)%length)+length)%length;
        }
        if(frame<0||frame>=frames)return 0;
        const index=Math.floor(frame),fraction=frame-index;
        const next=fraction>0&&loop&&index+1>=loop[1]?
          loop[0]:Math.min(frames-1,index+1);
        return source[ch][index]+
          (source[ch][next]-source[ch][index])*fraction;
      }
      // The probe arm is asynchronous relative to the producer's seek ACK.
      // Find the one unknown whole output-frame offset, using a tiny prefix,
      // then score ALL captured source samples against that same offset.
      function score(stats,seek,speed,loop){
        if(stats.inputChannels!==2||
           stats.channels.some(c=>c.captured.length<512))
          throw Error("output capture missing stereo data");
        const captured=stats.channels.map(c=>c.captured);
        let bestK=0,best=Infinity;
        const prefix=48;
        for(let k=0;k<=4096;k++){
          let error=0;
          for(let ch=0;ch<2;ch++){
            for(let i=0;i<prefix;i++){
              const delta=captured[ch][i]-
                referenceAt(ch,seek,speed,k+i,loop);
              error+=delta*delta;
            }
          }
          if(error<best){best=error;bestK=k;}
        }
        let sum=0,max=0;
        const count=Math.min(captured[0].length,captured[1].length);
        for(let ch=0;ch<2;ch++){
          for(let i=0;i<count;i++){
            const delta=Math.abs(captured[ch][i]-
              referenceAt(ch,seek,speed,bestK+i,loop));
            sum+=delta*delta;max=Math.max(max,delta);
          }
        }
        const lead=Math.min(128,count);
        const leadRms=captured.map(samples=>Math.sqrt(
          samples.slice(0,lead).reduce((sum,v)=>sum+v*v,0)/lead
        ));
        const trailingZeroRun=captured.map(samples=>{
          let zeros=0;
          for(let i=count-1;i>=0&&Math.abs(samples[i])<1e-7;i--)
            zeros++;
          return zeros;
        });
        return {offsetFrames:bestK,comparedFrames:count,
          rmsError:Math.sqrt(sum/(count*2)),maxError:max,
          leadingRms:leadRms,trailingZeroRun,
          frames:stats.frames,zeroFrames:stats.channels.map(c=>c.zeroFrames),
          maxZeroRun:stats.channels.map(c=>c.maxZeroRun),
          maxStep:stats.channels.map(c=>c.maxStep),
          missingChannels:2-stats.inputChannels};
      }
      const observe=async(seek,speed,loop,holdMs=45)=>{
        await measure("arm",1024);
        await sleep(holdMs);
        const stat=await measure("snapshot");
        return {score:score(stat,seek,speed,loop),statistics:{
          frames:stat.frames,channels:stat.channels.map(c=>({
            rms:c.rms,zeroFrames:c.zeroFrames,maxZeroRun:c.maxZeroRun,
            maxStep:c.maxStep
          }))
        }};
      };
      const errors=[],renderEvents=[];
      const onEvent=e=>{
        if(e.type==="fatal-error"||e.type==="error")
          errors.push({type:e.type,message:e.message});
        if(e.type==="render-applied"||e.type==="render-superseded")
          renderEvents.push({...e,observedAt:performance.now()});
      };
      const short=await createSourcePCMBridge({
        ctx,sourceChannels:source,sourceSampleRate:sourceRate,
        speed:8,startFrame:300,loopEnabled:true,
        loopStartFrame:300,loopEndFrame:301,onEvent
      });
      short.connect(probe);
      await short.play();
      const loopChecks=[];
      for(const span of [1,2,16,127,128,129,256]){
        for(const speed of [-8,8]){
          const a=span>=127?12000:300,b=a+span;
          await short.setLoopBounds(a,b);
          await short.setSpeed(speed);
          const seek=speed<0?b-1:a;
          await short.seek(seek);
          const result=await observe(seek,speed,[a,b],44);
          loopChecks.push({span,speed,a,b,...result});
        }
      }
      // Keep the normal-speed direction too: ±8 alone can alias tiny loops.
      for(const speed of [-1,1]){
        const a=44100,b=a+129;
        await short.setLoopBounds(a,b);await short.setSpeed(speed);
        const seek=speed<0?b-1:a;
        await short.seek(seek);
        loopChecks.push({span:129,speed,a,b,
          ...await observe(seek,speed,[a,b],44)});
      }
      // Capture fully cached transport while the host main thread is busy.
      await short.setLoopBounds(12000,12256);
      await short.setSpeed(1);
      await short.seek(12000);
      await measure("arm",1024);
      const start=performance.now();
      while(performance.now()-start<260){
        Math.sqrt((performance.now()-start)*127);
      }
      const cachedStall=await measure("snapshot");
      // A frozen but nonzero value cannot pass as correct loop playback.
      const cachedStallMatch=score(cachedStall,12000,1,[12000,12256]);
      await short.pause();short.dispose();

      const long=await createSourcePCMBridge({
        ctx,sourceChannels:source,sourceSampleRate:sourceRate,
        speed:8,startFrame:250000,loopEnabled:false,onEvent
      });
      long.connect(probe);await long.play();
      await long.seek(250000);
      const normal=await observe(250000,8,null,45);

      // Unlike the earlier 45ms smoke, exercise a normally scheduled long
      // source for 850ms at +8: the playhead crosses several 65536-frame
      // cache boundaries while the producer and PCM probe run independently.
      await long.seek(270000);
      const sustainedMissingBefore=long.latest?.missingFrames||0;
      await measure("arm",1024);
      await sleep(850);
      const sustainedStat=await measure("snapshot");
      await sleep(28); // allow latest progress message to reach the host
      const sustainedMissingAfter=long.latest?.missingFrames||0;
      const sustained={
        score:score(sustainedStat,270000,8,null),
        channels:sustainedStat.channels.map(c=>({
          frames:c.frames,zeroFrames:c.zeroFrames,
          maxZeroRun:c.maxZeroRun,rms:c.rms,maxStep:c.maxStep
        })),
        missingDelta:sustainedMissingAfter-sustainedMissingBefore
      };

      // Same content source, same output probe: rapid normal-load changes
      // far across the track. A/B endpoints, direction and seek must change
      // without old source-window data leaking through the render callback.
      // Only the final settled state has a single unambiguous source oracle;
      // intermediate switches are checked for whole-quantum inserted silence.
      const changes=[
        {a:340000,b:390001,seek:381234,speed:8},
        {a:420000,b:450129,seek:450127,speed:-8},
        {a:500000,b:502000,seek:501999,speed:-1},
        {a:610000,b:620256,seek:610002,speed:8},
        {a:720000,b:720129,seek:720128,speed:-8},
        {a:820000,b:840129,seek:822222,speed:1}
      ];
      const burstMissingBefore=long.latest?.missingFrames||0;
      await measure("arm");
      const acknowledged=[];
      for(const change of changes){
        const bounds=await long.setLoopBounds(change.a,change.b);
        if(acknowledged.length===0)await long.setLoopEnabled(true);
        const direction=await long.setSpeed(change.speed);
        const destination=await long.seek(change.seek);
        acknowledged.push({
          expected:change,
          bounds:[bounds.loopStartFrame,bounds.loopEndFrame],
          appliedFrame:destination.sourceFrame,
          speedApplied:direction.op==="speed"
        });
        // A rapid sequence can legitimately complete entirely between two
        // output quanta. Observe a short real output interval per destination
        // rather than asserting a render happened during zero elapsed frames.
        await sleep(12);
      }
      const burstStat=await measure("snapshot");
      const last=changes[changes.length-1];
      const settled=await observe(last.seek,last.speed,[last.a,last.b],55);
      const burstMissingAfter=long.latest?.missingFrames||0;
      const burst={
        acknowledged,measuredFrames:burstStat.frames,
        channels:burstStat.channels.map(c=>({
          frames:c.frames,zeroFrames:c.zeroFrames,
          maxZeroRun:c.maxZeroRun,maxStep:c.maxStep
        })),
        missingDelta:burstMissingAfter-burstMissingBefore,
        settled: settled.score
      };
      await long.setLoopEnabled(false);

      // The same fixture contains an intentionally silent section:
      // output zero samples there are correct, not a cache underrun.
      await long.setSpeed(1);
      await long.seek(144250);
      const intendedSilence=await observe(144250,1,null,50);
      await long.setSpeed(8);
      await long.seek(250000);
      await sleep(70);
      const before=long.latest?.missingFrames||0;
      await measure("arm",1024);
      const stallStart=performance.now();
      while(performance.now()-stallStart<1050){
        Math.sqrt((performance.now()-stallStart)*197);
      }
      const starved=await measure("snapshot");
      await sleep(120);
      const after=long.latest?.missingFrames||0;

      const t0=performance.now();
      // Request IDs are local to each bridge instance. Older receipts from
      // the already disposed short source may reuse the same numeric ID.
      const receiptStart=renderEvents.length;
      const ack=await long.seek(600000);
      const ackMs=performance.now()-t0;
      // A command-accepted ACK is not sufficient proof of audible render.
      // Wait for the separate Worklet process() output-quantum receipt.
      let applied=renderEvents.slice(receiptStart).find(e=>
        e.type==="render-applied"&&e.requestId===ack.requestId);
      const deadline=performance.now()+1000;
      while(!applied&&performance.now()<deadline){
        await sleep(4);
        applied=renderEvents.slice(receiptStart).find(e=>
          e.type==="render-applied"&&e.requestId===ack.requestId);
      }
      if(!applied)throw Error("seek ACK never reached an output quantum");
      const renderReceiptMs=applied.observedAt-t0;
      await long.setSpeed(1);
      // The source keeps advancing at +8 while render feedback crosses the
      // port/main-thread boundary. After observing that receipt, establish a
      // NEW source coordinate for the +1 reference capture; don't let a
      // finite alignment search hide elapsed playback as a PCM failure.
      await long.seek(600000);
      const recovery=await observe(600000,1,null,80);
      const recoveredMiss=long.latest?.missingFrames||0;
      await long.pause();long.dispose();

      // R3: do not create another fixture or a constant-PCM preflight.
      // Use the SAME content-rich stereo source and post-render probe to
      // verify experimental signed-time, independent pitch and zero-speed
      // audible synthesis in the REAL Chrome AudioWorklet.
      const grainEvents=[];
      const grain=await createSourcePCMBridge({
        ctx,sourceChannels:source,sourceSampleRate:sourceRate,
        processingMode:"granular",pitchSemitones:0,
        speed:0,startFrame:280000,loopEnabled:false,
        onEvent:e=>grainEvents.push(e)
      });
      grain.connect(probe);
      await grain.play();
      const spectralEnergy=(samples,hz)=>{
        let re=0,im=0;
        for(let i=0;i<samples.length;i++){
          const theta=2*Math.PI*hz*i/ctx.sampleRate;
          re+=samples[i]*Math.cos(theta);
          im+=samples[i]*Math.sin(theta);
        }
        return Math.hypot(re,im);
      };
      const granularCases=[];
      for(const speed of [-8,0,8]){
        for(const pitch of [0,7]){
          const speedAck=await grain.setSpeed(speed);
          const pitchAck=await grain.setPitch(pitch);
          const seekAck=await grain.seek(280000);
          await measure("arm",2048);
          await sleep(105);
          const observed=await measure("snapshot");
          const first=observed.channels[0].captured;
          const fundamental=spectralEnergy(first,174.61);
          const shifted=spectralEnergy(first,174.61*2**(7/12));
          granularCases.push({speed,pitch,processingMode:grain.processingMode,
            seekFrame:seekAck.sourceFrame,
            sourceFrameAfter:grain.latest?.sourceFrame,
            pitchAck:pitchAck.pitchSemitones,
            pitchRevision:pitchAck.pitchRevision,
            sourceMisses:grain.latest?.missingFrames,
            channels:observed.channels.map(ch=>({
              frames:ch.frames,rms:ch.rms,maxStep:ch.maxStep,
              maxZeroRun:ch.maxZeroRun,
              captured:ch.captured.length
            })),
            spectral:{fundamental,shifted},
            recentRender:grainEvents.filter(x=>x.type==="render-applied")
              .slice(-1).map(x=>({processingMode:x.processingMode,
                pitchRevision:x.pitchRevision,
                missingFramesInBlock:x.missingFramesInBlock}))
          });
        }
      }
      const precisionAck=await grain.setPitch(7.1234);
      const precisionApplied=precisionAck.pitchSemitones;
      await grain.pause();grain.dispose();
      probe.disconnect();await ctx.close();

      return {sourceRate,outputRate:48000,fixture:{
        frames,channels:2,silence:[145000,146500],
        type:"deterministic chord/voice-like FM, transients, noise and silence"
      },loopChecks,cachedStall:{
        match:cachedStallMatch,
        frames:cachedStall.frames,channels:cachedStall.channels.map(c=>({
          zeroFrames:c.zeroFrames,maxZeroRun:c.maxZeroRun,
          rms:c.rms,maxStep:c.maxStep
        }))
      },normal,sustained,burst,intendedSilence,
      starved:{frames:starved.frames,channels:starved.channels.map(c=>({
        zeroFrames:c.zeroFrames,maxZeroRun:c.maxZeroRun,
        rms:c.rms,maxStep:c.maxStep
      })),sourceMissingDelta:after-before,mainThreadBlockedMs:1050},
      recovery:{...recovery,ackFrame:ack.sourceFrame,ackMs,
        commandToRenderReceiptMs:renderReceiptMs,
        firstOutputFrame:applied.outputFrame,
        firstOutputTime:applied.outputTime,
        firstOutputSourceFrame:applied.sourceFrame,
        firstRenderMissing:applied.missingFramesInBlock,
        firstRenderRevision:applied.revision,
        ackRevision:ack.revision,
        cumulativeMissing:recoveredMiss},
        granular:{cases:granularCases,precisionApplied,
          events:grainEvents.filter(e=>e.type==="fatal-error"||
            e.type==="error").map(e=>({type:e.type,message:e.message}))},
        errors};
    });
    assert.deepEqual(errors,[]);
    assert.deepEqual(evidence.errors,[]);
    assert.equal(evidence.loopChecks.length,16);
    for(const {span,speed,score} of evidence.loopChecks){
      assert.ok(score.comparedFrames>=512,{span,speed,score});
      assert.ok(score.rmsError<.00012,{span,speed,score});
      assert.ok(score.maxError<.0005,{span,speed,score});
    }
    for(const name of ["normal","intendedSilence","recovery"]){
      const score=evidence[name].score;
      assert.ok(score.comparedFrames>=512,{name,score});
      assert.ok(score.rmsError<.00012,{name,score});
      assert.ok(score.maxError<.0005,{name,score});
    }
    assert.ok(evidence.sustained.score.comparedFrames>=512);
    assert.ok(evidence.sustained.score.rmsError<.00012,evidence.sustained);
    assert.ok(evidence.sustained.score.maxError<.0005,evidence.sustained);
    assert.ok(evidence.sustained.channels.every(c=>
      c.frames>30000&&c.maxZeroRun<128),evidence.sustained);
    assert.equal(evidence.sustained.missingDelta,0,
      "normally scheduled long +8 source must not exhaust its cache");
    assert.equal(evidence.burst.acknowledged.length,6);
    for(const {expected,bounds,appliedFrame,speedApplied} of
      evidence.burst.acknowledged){
      assert.deepEqual(bounds,[expected.a,expected.b]);
      assert.equal(appliedFrame,expected.seek);
      assert.equal(speedApplied,true);
    }
    assert.ok(evidence.burst.measuredFrames>0,evidence.burst);
    assert.ok(evidence.burst.channels.every(c=>c.maxZeroRun<128),
      "rapid source-window changes must not create whole-quanta silence");
    assert.equal(evidence.burst.missingDelta,0,
      "rapid A/B and seek commands must prime their destination PCM");
    assert.ok(evidence.burst.settled.rmsError<.00012,evidence.burst);
    assert.ok(evidence.burst.settled.maxError<.0005,evidence.burst);
    const transition=evidence.intendedSilence.score;
    assert.ok(transition.leadingRms.every(x=>x>.02),
      "silence test requires genuine stereo audio before the quiet section");
    assert.ok(transition.trailingZeroRun.every(n=>n>=128),
      "captured output must cross from non-silent into actual source silence");
    assert.ok(evidence.intendedSilence.statistics.channels
      .every(c=>c.maxZeroRun>128),
      "intentional source silence must not be mistaken for inserted silence");
    assert.ok(evidence.cachedStall.frames>=128);
    assert.ok(evidence.cachedStall.match.comparedFrames>=512);
    assert.ok(evidence.cachedStall.match.rmsError<.00012,
      evidence.cachedStall.match);
    assert.ok(evidence.cachedStall.match.maxError<.0005,
      evidence.cachedStall.match);
    assert.ok(evidence.cachedStall.channels.every(c=>c.maxZeroRun<128),
      "fully cached real-content loop must not drop whole render quanta");
    assert.ok(evidence.starved.frames>=128);
    assert.ok(evidence.starved.sourceMissingDelta>=0);
    assert.equal(evidence.recovery.ackFrame,600000);
    assert.ok(Number.isFinite(evidence.recovery.ackMs));
    assert.equal(evidence.recovery.firstOutputSourceFrame,600000,
      "ACK is not proof until the exact source frame is rendered");
    assert.equal(evidence.recovery.firstRenderRevision,
      evidence.recovery.ackRevision);
    assert.equal(evidence.recovery.firstRenderMissing,0);
    assert.ok(Number.isSafeInteger(evidence.recovery.firstOutputFrame));
    assert.ok(evidence.recovery.firstOutputFrame>=0);
    assert.ok(Number.isFinite(evidence.recovery.firstOutputTime));
    assert.ok(evidence.recovery.commandToRenderReceiptMs>=
      evidence.recovery.ackMs,
      "render observation must not precede command acceptance");
    assert.ok(evidence.recovery.commandToRenderReceiptMs<1000,
      "render-thread application must not stall for an entire second");
    console.log("R3_GRANULAR_EVIDENCE "+JSON.stringify(evidence.granular));
    assert.deepEqual(evidence.granular.events,[]);
    assert.equal(evidence.granular.precisionApplied,7.1234,
      "canonical pitch input must not be rounded to display precision");
    assert.equal(evidence.granular.cases.length,6);
    for(const c of evidence.granular.cases){
      assert.equal(c.processingMode,"granular");
      assert.equal(c.seekFrame,280000);
      assert.equal(c.pitchAck,c.pitch);
      assert.equal(c.channels.length,2);
      assert.ok(c.channels.every(ch=>
        ch.frames>=2048&&ch.rms>.012&&ch.maxStep>.00005&&
        ch.maxZeroRun<128&&ch.captured===2048),c);
      assert.ok(c.recentRender.some(e=>
        e.processingMode==="granular"&&
        e.pitchRevision===c.pitchRevision),c);
      // A content-bearing chord's fundamental must follow pitch, not
      // signed source speed. Source speed=0 must emit evolving audio.
      if(c.pitch===0)
        assert.ok(c.spectral.fundamental>1.1*c.spectral.shifted,c);
      else assert.ok(c.spectral.shifted>1.25*c.spectral.fundamental,c);
      if(c.speed===0)assert.equal(c.sourceFrameAfter,280000,
        "0x source time must remain frozen while audio remains non-DC");
    }
    // Host starvation beyond a finite cache is a documented limit;
    // measure, do not demand impossible arbitrary-duration gaplessness.
    console.log("R2_CONTENT_AUDIO_EVIDENCE "+JSON.stringify(evidence));
  }finally{
    await browser?.close();
    server.kill();
  }
});
