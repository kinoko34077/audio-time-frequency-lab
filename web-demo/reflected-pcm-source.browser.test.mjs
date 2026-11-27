import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

test("reflected reader supplies real raw/PV Worklets through existing repeat bridge",async()=>{
  const port=18792,server=spawn(process.env.PYTHON_BIN||(process.platform==="win32"?"python":"python3"),["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    let ready=false;for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/web-demo/source-pcm-smoke.html"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    const report=await page.evaluate(async()=>{
      const {createReflectedPCMSource}=await import("/web-demo/reflected-pcm-source.mjs");
      const {createSourcePCMBridge}=await import("/web-demo/source-pcm-bridge.mjs");
      const ctx=new AudioContext({sampleRate:48000});await ctx.resume();
      const sr=ctx.sampleRate,A=2400,B=7201,channel=Float32Array.from({length:12000},(_,i)=>.2*Math.sin(2*Math.PI*440*i/sr));
      const source=createReflectedPCMSource({channels:[channel,channel.map(x=>-x)],startFrame:A,endFrame:B});
      const result=[];
      try{
        for(const processingMode of ["raw","pv"]){
          const events=[],tap=ctx.createAnalyser();tap.fftSize=2048;
          const splitter=ctx.createChannelSplitter(2),left=ctx.createAnalyser(),right=ctx.createAnalyser();
          left.fftSize=right.fftSize=2048;splitter.connect(left,0);splitter.connect(right,1);
          const bridge=await createSourcePCMBridge({ctx,source,sourceSampleRate:sr,processingMode,
            startFrame:0,loopEnabled:true,loopEndFrame:source.sourceFrames,onEvent:e=>{if(e.type==="progress")events.push(e);}});
          bridge.connect(splitter);left.connect(tap);tap.connect(ctx.destination);
          try{
            await bridge.play();
            await new Promise(r=>setTimeout(r,400));
            const l=new Float32Array(left.fftSize),r=new Float32Array(right.fftSize);
            left.getFloatTimeDomainData(l);right.getFloatTimeDomainData(r);
            await bridge.setSpeed(-1);await new Promise(r=>setTimeout(r,300));
            const positions=events.map(e=>source.toSourceFrame(e.sourceFrame));
            result.push({processingMode,events:events.length,positions,
              reverse:events.some(e=>e.speed===-1),missing:Math.max(0,...events.map(e=>e.missingFrames)),
              finite:l.every(Number.isFinite)&&r.every(Number.isFinite),
              peak:Math.max(...l.map(Math.abs)),
              stereoError:Math.max(...l.map((v,i)=>Math.abs(v+r[i])))});
          }finally{bridge.dispose();splitter.disconnect();left.disconnect();right.disconnect();tap.disconnect();}
        }
      }finally{await ctx.close();}
      return result;
    });
    for(const r of report){
      assert.ok(r.events>5,JSON.stringify(r));assert.ok(r.reverse);
      assert.ok(r.positions.every(p=>p>=2400&&p<=7200));
      assert.ok(r.positions.some((p,i,a)=>i>0&&p>a[i-1])&&r.positions.some((p,i,a)=>i>0&&p<a[i-1]));
      assert.equal(r.missing,0);assert.ok(r.finite&&r.peak>.01);
      assert.ok(r.stereoError<.01,JSON.stringify(r));
    }
    assert.deepEqual(errors,[]);
    console.log("reflected source Worklet",report.map(({positions,...r})=>r));
  }finally{await cleanupTestProcesses(browser,[server]);}
});
