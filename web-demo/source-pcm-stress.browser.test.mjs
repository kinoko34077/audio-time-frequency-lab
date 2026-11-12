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
      const errors=[];
      const onEvent=e=>{
        if(e.type==="fatal-error"||e.type==="error")
          errors.push({type:e.type,message:e.message});
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
      const ack=await long.seek(600000);
      const ackMs=performance.now()-t0;
      await long.setSpeed(1);
      const recovery=await observe(600000,1,null,80);
      const recoveredMiss=long.latest?.missingFrames||0;
      await long.pause();long.dispose();probe.disconnect();await ctx.close();

      return {sourceRate,outputRate:48000,fixture:{
        frames,channels:2,silence:[145000,146500],
        type:"deterministic chord/voice-like FM, transients, noise and silence"
      },loopChecks,cachedStall:{
        match:cachedStallMatch,
        frames:cachedStall.frames,channels:cachedStall.channels.map(c=>({
          zeroFrames:c.zeroFrames,maxZeroRun:c.maxZeroRun,
          rms:c.rms,maxStep:c.maxStep
        }))
      },normal,intendedSilence,
      starved:{frames:starved.frames,channels:starved.channels.map(c=>({
        zeroFrames:c.zeroFrames,maxZeroRun:c.maxZeroRun,
        rms:c.rms,maxStep:c.maxStep
      })),sourceMissingDelta:after-before,mainThreadBlockedMs:1050},
      recovery:{...recovery,ackFrame:ack.sourceFrame,ackMs,
        cumulativeMissing:recoveredMiss},errors};
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
    // Host starvation beyond a finite cache is a documented limit;
    // measure, do not demand impossible arbitrary-duration gaplessness.
    console.log("R2_CONTENT_AUDIO_EVIDENCE "+JSON.stringify(evidence));
  }finally{
    await browser?.close();
    server.kill();
  }
});
