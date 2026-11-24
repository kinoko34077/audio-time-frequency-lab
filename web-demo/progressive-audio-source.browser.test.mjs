import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {installTestAudioSilenceGuardForPage} from './test-audio-silence-guard.mjs';
import {cleanupTestProcesses} from './test-process-cleanup.mjs';

test('native browser decodes exact requested WAV PCM, loads the app without eager AudioContext and preserves the last good file',async()=>{
  const port=18761;
  const python=process.env.PYTHON_BIN||
    (process.platform==='win32'?'python':'python3');
  const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||'_site');
  const server=spawn(python,['-m','http.server',String(port),'--bind','127.0.0.1'],{
    cwd:siteRoot,stdio:'ignore'
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',
      headless:true,args:['--no-sandbox','--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required','--mute-audio']
    });
    const page=await browser.newPage();
    await installTestAudioSilenceGuardForPage(page);
    await page.evaluateOnNewDocument(()=>{
      const Native=window.AudioContext;
      window.__audioContextCreations=0;
      if(Native)window.AudioContext=new Proxy(Native,{
        construct(target,args,newTarget){
          window.__audioContextCreations++;
          return Reflect.construct(target,args,newTarget);
        }
      });
    });
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?pcmTransport=1&legacyUi=1`,{
      waitUntil:'domcontentloaded',timeout:20000
    });
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==='ready',
      {timeout:20000});
    const decoded=await page.evaluate(async()=>{
      const rate=48000,frames=rate*8,bytes=new ArrayBuffer(44+frames*4),view=new DataView(bytes);
      const put=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
      put(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);put(8,'WAVE');
      put(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);
      view.setUint16(22,2,true);view.setUint32(24,rate,true);
      view.setUint32(28,rate*4,true);view.setUint16(32,4,true);
      view.setUint16(34,16,true);put(36,'data');view.setUint32(40,frames*4,true);
      for(let i=0;i<frames;i++){
        view.setInt16(44+i*4,Math.round(.4*Math.sin(2*Math.PI*440*i/rate)*32767),true);
        view.setInt16(46+i*4,Math.round(.2*Math.sin(2*Math.PI*660*i/rate)*32767),true);
      }
      const file=new File([bytes],'progressive-tone.wav',{type:'audio/wav'});
      window.__progressiveTestFile=file;
      const {createProgressiveAudioSource}=await import('./progressive-audio-source.mjs');
      const source=await createProgressiveAudioSource(file);
      const start=frames-2999,count=2048;
      const result=await source.read(start,count,{priority:'playback'});
      const stats=source.stats();
      const observed=result.channels[0][0];
      const observedRight=result.channels[1][0];
      const expected=Math.round(.4*Math.sin(2*Math.PI*440*start/rate)*32767)/32768;
      const expectedRight=Math.round(.2*Math.sin(2*Math.PI*660*start/rate)*32767)/32768;
      source.dispose();
      return {rate:source.sampleRate,channels:source.channelCount,frames:source.sourceFrames,
        observed,expected,observedRight,expectedRight,residentFrames:stats.residentFrames,
        residentWindows:stats.residentWindows};
    });
    assert.equal(decoded.rate,48000);
    assert.equal(decoded.channels,2);
    assert.equal(decoded.frames,48000*8);
    assert.ok(Math.abs(decoded.observed-decoded.expected)<2/32768,
      `real decoder PCM mismatch ${decoded.observed} vs ${decoded.expected}`);
    assert.ok(Math.abs(decoded.observedRight-decoded.expectedRight)<2/32768,
      `real decoder right-channel mismatch ${decoded.observedRight} vs ${decoded.expectedRight}`);
    assert.ok(decoded.residentFrames<=65_536);
    assert.ok(decoded.residentWindows<=1);

    // These self-generated short clips exercise WebCodecs-backed demux and
    // range reads for the compressed formats the old browser decoder accepted.
    for(const fixture of [
      {name:'progressive-probe.mp3',path:'./test-fixtures/progressive-probe.mp3',mime:'audio/mpeg'},
      {name:'progressive-probe.m4a',path:'./test-fixtures/progressive-probe.m4a',mime:'audio/mp4'},
      {name:'progressive-probe.ogg',path:'./test-fixtures/progressive-probe.ogg',mime:'audio/ogg'},
      {name:'progressive-probe.flac',path:'./test-fixtures/progressive-probe.flac',mime:'audio/flac'}
    ]){
      const encoded=(await readFile(new URL(fixture.path,import.meta.url))).toString('base64');
      let probe;
      try{probe=await page.evaluate(async input=>{
        const binary=atob(input.encoded),bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        const file=new File([bytes],input.name,{type:input.mime});
        const {createProgressiveAudioSource}=await import('./progressive-audio-source.mjs');
        const source=await createProgressiveAudioSource(file);
        try{
          const count=4096,start=Math.floor(source.sourceFrames/2-count/2);
          const block=await source.read(start,count,{priority:'playback'});
          const samples=block.channels[0];
          const rms=Math.sqrt(samples.reduce((sum,sample)=>sum+sample*sample,0)/samples.length);
          const reference=await source.read(start+8192,128,{priority:'playback'});
          const beforeLoopRead=source.stats().residentFrames;
          const loopBlock=await source.read(start+8192,128,{
            priority:'playback',windowFrames:8192
          });
          const afterLoopRead=source.stats().residentFrames;
          const loopRms=Math.sqrt(loopBlock.channels[0].reduce(
            (sum,sample)=>sum+sample*sample,0)/loopBlock.channels[0].length);
          return {sampleRate:source.sampleRate,channels:source.channelCount,
            sourceFrames:source.sourceFrames,frames:samples.length,rms,
            residentFrames:source.stats().residentFrames,
            loopWindowResidentDelta:afterLoopRead-beforeLoopRead,loopRms,
            loopMatches:loopBlock.channels.every((channel,c)=>
              channel.every((sample,i)=>sample===reference.channels[c][i]))};
        }finally{source.dispose();}
      },{...fixture,encoded});}
      catch(error){throw Error(`${fixture.name}: ${error.message}`,{cause:error});}
      assert.equal(probe.sampleRate,48000,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.channels,2,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.sourceFrames>=48000,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.frames,4096,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.rms>.02,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.residentFrames<=65_536+8_192,
        `${fixture.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.loopWindowResidentDelta,0,
        `${fixture.name} should reuse the cached playback window: ${JSON.stringify(probe)}`);
      assert.equal(probe.loopMatches,true,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.loopRms>.02,`${fixture.name}: ${JSON.stringify(probe)}`);
    }

    await page.evaluate(()=>{
      const input=document.querySelector('#audio-file'),transfer=new DataTransfer();
      transfer.items.add(window.__progressiveTestFile);input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await page.waitForFunction(()=>{
      const meta=document.querySelector('#file-meta')?.textContent||'';
      return meta.includes('progressive-tone.wav')&&meta.includes('48000Hz')&&meta.includes('2ch');
    },{timeout:20000});
    await page.waitForSelector('#play-dry:not([disabled])',{timeout:10000});
    const loading=await page.evaluate(()=>({
      contexts:window.__audioContextCreations,
      audioOutputRoutes:window.__audioSilenceAudit?.mutedOutputRoutes||0,
      meta:document.querySelector('#file-meta').textContent,
      duration:document.querySelector('#duration').textContent
    }));
    assert.equal(loading.contexts,0,'source selection must not create an audio output context');
    assert.equal(loading.audioOutputRoutes,0,'loading must not connect an audio route');
    assert.match(loading.meta,/progressive-tone\.wav/);
    assert.doesNotMatch(loading.meta,/8\.0秒/,
      'source duration is shown once in the waveform instead of repeated in file metadata');
    assert.equal(loading.duration,'0:08.0');

    // The whole-track overview has source-coordinate bins independent of
    // canvas pixels. Rotate while the first scan is still in progress.
    await page.waitForFunction(()=>{
      const d=document.querySelector('#wave')?.dataset;
      return Number(d?.overviewReadyBins)>0&&Number(d?.overviewReadyBins)<Number(d?.overviewBins);
    },{timeout:10000});
    const overviewSnapshot=()=>page.$eval('#wave',canvas=>{
      const {overviewGeneration,overviewBins,overviewReads,overviewReadyBins}=canvas.dataset;
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let signal=0;
      for(let i=0;i<pixels.length;i+=4)
        if(pixels[i+1]>130&&pixels[i+1]>pixels[i]+35&&pixels[i+3]>0)signal++;
      return {generation:Number(overviewGeneration),bins:Number(overviewBins),
        reads:Number(overviewReads),ready:Number(overviewReadyBins),width:canvas.width,signal};
    });
    const building=await overviewSnapshot();
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await page.setViewport({width:844,height:390,deviceScaleFactor:1});
    await page.waitForFunction(()=>{
      const d=document.querySelector('#wave')?.dataset;
      return Number(d?.overviewBins)>0&&d.overviewReadyBins===d.overviewBins;
    },{timeout:10000});
    const completed=await overviewSnapshot();
    assert.equal(completed.generation,building.generation,
      'rotation must not restart the source-coordinate scan');
    assert.equal(completed.bins,2048);
    assert.equal(completed.reads,64,'8-second source scanned once in 32-bin batches');
    assert.ok(completed.signal>0);
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await new Promise(resolve=>setTimeout(resolve,250));
    const rotated=await overviewSnapshot();
    assert.notEqual(rotated.width,completed.width);
    assert.equal(rotated.generation,completed.generation);
    assert.equal(rotated.reads,completed.reads);
    assert.equal(rotated.ready,completed.ready);
    assert.ok(rotated.signal>0,'redrawn overview must retain waveform pixels');
    await page.setViewport({width:800,height:600,deviceScaleFactor:1});
    console.log('U02_OVERVIEW_RESIZE '+JSON.stringify({building,completed,rotated}));

    await page.evaluate(()=>{
      const input=document.querySelector('#audio-file'),transfer=new DataTransfer();
      transfer.items.add(new File(['not audio'],'broken.wav',{type:'audio/wav'}));
      input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent
      .includes('音声を開けませんでした'),{timeout:20000});
    assert.match(await page.$eval('#file-meta',el=>el.textContent),/progressive-tone\.wav/,
      'failed replacement must preserve the last playable source');

    await page.click('#play-dry');
    await page.waitForFunction(()=>document.querySelector('#rt-telemetry')
      ?.dataset.pcmTransport==='raw-experimental',{timeout:20000});
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await new Promise(resolve=>setTimeout(resolve,250));
    const playingResize=await overviewSnapshot();
    assert.equal(playingResize.generation,completed.generation);
    assert.equal(playingResize.reads,completed.reads);
    assert.equal(playingResize.ready,completed.ready);
    assert.equal(await page.$eval('#rt-telemetry',el=>el.dataset.pcmTransport),'raw-experimental');
    await page.setViewport({width:800,height:600,deviceScaleFactor:1});
    await page.click('#stop');
    await page.evaluate(()=>window.dispatchEvent(
      new PageTransitionEvent('pagehide',{persisted:true})));
    await page.click('#play-dry');
    await page.waitForFunction(()=>document.querySelector('#rt-telemetry')
      ?.dataset.pcmTransport==='raw-experimental',{timeout:3000});
    await page.click('#stop');
    const output=await page.evaluate(()=>({
      muted:window.__audioSilenceAudit?.audioOutputMuteGain,
      mutedRoutes:window.__audioSilenceAudit?.mutedOutputRoutes,
      contexts:window.__audioContextCreations
    }));
    assert.equal(output.muted,0,'browser playback test output must be muted');
    assert.ok(output.mutedRoutes>0);
    assert.equal(output.contexts,1,'AudioContext is created only after an explicit Play action');

    // Actual compressed local PCM and a real Worklet. Hold an endpoint
    // read deliberately so ordering is deterministic, not a timing guess
    // about the speed of the test runner's decoder.
    const mp3=(await readFile(new URL('./test-fixtures/progressive-probe.mp3',
      import.meta.url))).toString('base64');
    const superseded=await page.evaluate(async encoded=>{
      const bytes=Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
      const {createProgressiveAudioSource}=await import('./progressive-audio-source.mjs');
      const {createSourcePCMBridge}=await import('./source-pcm-bridge.mjs');
      const source=await createProgressiveAudioSource(new File([bytes],
        'progressive-probe.mp3',{type:'audio/mpeg'}));
      const ctx=new AudioContext({sampleRate:source.sampleRate});
      const events=[];
      let release,entered,bridge,old;
      const held=new Promise(resolve=>{release=resolve;});
      const started=new Promise(resolve=>{entered=resolve;});
      let holdEndpoints=false;
      const reader={sourceFrames:source.sourceFrames,channelCount:source.channelCount,
        async read(start,count,options){
          if(holdEndpoints&&options?.windowFrames===8192&&start>0){
            entered();
            await held;
          }
          return source.read(start,count,options);
        }};
      const waitFor=async predicate=>{
        const until=performance.now()+3000;
        while(!predicate()){
          if(performance.now()>until)throw Error('loop render receipt timed out');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
      };
      try{
        bridge=await createSourcePCMBridge({ctx,source:reader,
          sourceSampleRate:source.sampleRate,startFrame:8192,speed:0,
          processingMode:'pv',onEvent:event=>events.push(event)});
        const analyser=ctx.createAnalyser();
        analyser.fftSize=1024;
        bridge.connect(analyser);analyser.connect(ctx.destination);
        await bridge.play();
        await waitFor(()=>bridge.latest?.renderedFrames>=4096&&
          events.some(e=>e.type==='render-applied'&&e.running));
        const a=0,b=source.sourceFrames;
        holdEndpoints=true;
        const began=performance.now();
        old=bridge.setLoopConfiguration(a,b,true);
        await Promise.race([started,new Promise((_,reject)=>setTimeout(
          ()=>reject(Error('endpoint read did not start')),3000))]);
        const offAt=performance.now();
        const off=await bridge.setLoopConfiguration(a,b,false);
        await waitFor(()=>events.some(e=>e.type==='render-applied'&&
          e.requestId===off.requestId));
        const offRender=events.find(e=>e.type==='render-applied'&&
          e.requestId===off.requestId);
        const offRenderMs=performance.now()-offAt;
        const pcm=new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(pcm);
        const rms=Math.sqrt(pcm.reduce((sum,x)=>sum+x*x,0)/pcm.length);
        release();
        const oldResult=await old;
        return {a,b,oldResult,offRender,offRenderMs,heldMs:performance.now()-began,
          rms,enabledReceipts:events.filter(e=>e.type==='command-accepted'&&
            e.loopEnabled===true).length};
      }finally{
        release();
        if(old)await old.catch(()=>{});
        bridge?.dispose();source.dispose();await ctx.close();
      }
    },mp3);
    console.log('COMPRESSED_LOOP_SUPERSESSION '+JSON.stringify(superseded));
    assert.deepEqual(superseded.oldResult,{stale:true});
    assert.equal(superseded.offRender.loopStartFrame,superseded.a);
    assert.equal(superseded.offRender.loopEndFrame,superseded.b);
    assert.equal(superseded.offRender.loopEnabled,false);
    assert.equal(superseded.offRender.running,true);
    assert.equal(superseded.offRender.missingFramesInBlock,0);
    assert.equal(superseded.enabledReceipts,0);
    assert.ok(superseded.rms>.001,'held obsolete endpoint must not silence current PCM');

    // Measure the actual decoder+bridge path without artificial delays.
    const reuse=await page.evaluate(async encoded=>{
      const bytes=Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
      const {createProgressiveAudioSource}=await import('./progressive-audio-source.mjs');
      const {createSourcePCMBridge}=await import('./source-pcm-bridge.mjs');
      const source=await createProgressiveAudioSource(new File([bytes],
        'progressive-probe.mp3',{type:'audio/mpeg'}));
      const ctx=new AudioContext({sampleRate:source.sampleRate});
      let bridge;
      const reads=[],receipts=new Map();
      const reader={sourceFrames:source.sourceFrames,channelCount:source.channelCount,
        async read(start,count,options){
          if(options?.windowFrames===8192)reads.push({start,count});
          return source.read(start,count,options);
        }};
      try{
        bridge=await createSourcePCMBridge({ctx,source:reader,
          sourceSampleRate:source.sampleRate,startFrame:30000,speed:0,
          processingMode:'pv',onEvent:e=>{
            if(e.type==='render-applied')receipts.set(e.requestId,e);
          }});
        const analyser=ctx.createAnalyser();
        analyser.fftSize=1024;
        bridge.connect(analyser);analyser.connect(ctx.destination);
        await bridge.play();
        const measure=async(a,b,enabled=true)=>{
          const count=reads.length,t=performance.now();
          const ack=await bridge.setLoopConfiguration(a,b,enabled);
          const acceptedMs=performance.now()-t;
          const deadline=performance.now()+3000;
          while(!receipts.has(ack.requestId)){
            if(performance.now()>deadline)throw Error('loop render receipt timed out');
            await new Promise(resolve=>setTimeout(resolve,1));
          }
          const render=receipts.get(ack.requestId);
          return {reads:reads.slice(count),acceptedMs,renderMs:performance.now()-t,
            missing:render.missingFramesInBlock,a:render.loopStartFrame,
            b:render.loopEndFrame,enabled:render.loopEnabled,running:render.running};
        };
        const b=source.sourceFrames;
        const initial=await measure(0,b);
        const changed=await measure(18000,b);
        const nearby=await measure(18001,b);
        await measure(18001,b,false);
        const reenabled=await measure(18001,b);
        return {initial,changed,nearby,reenabled,b};
      }finally{bridge?.dispose();source.dispose();await ctx.close();}
    },mp3);
    console.log('COMPRESSED_ENDPOINT_REUSE '+JSON.stringify(reuse));
    assert.equal(reuse.initial.reads.length,2);
    assert.equal(reuse.changed.reads.length,1);
    assert.equal(reuse.nearby.reads.length,0);
    assert.equal(reuse.reenabled.reads.length,0);
    for(const result of [reuse.initial,reuse.changed,reuse.nearby,reuse.reenabled]){
      assert.equal(result.b,reuse.b);
      assert.equal(result.enabled,true);
      assert.equal(result.running,true);
      assert.equal(result.missing,0);
    }
    assert.equal(reuse.reenabled.a,18001);

    // Real browser canvas: force the decoder to wait while zooming, then
    // inspect actual edge pixels during forward and reverse high-zoom pans.
    const edgeAudit=await page.evaluate(async()=>{
      const {createPlayerWaveEditor}=await import('./player-wave-editor.mjs');
      const root=document.createElement('div');
      root.style.cssText='position:fixed;left:-10000px;top:0;width:320px';
      document.body.append(root);
      const node=tag=>{const el=document.createElement(tag);root.append(el);return el;};
      const canvas=node('canvas');
      canvas.style.cssText='display:block;width:320px;height:120px';
      const zoomIn=node('button'),zoomOut=node('button');
      let position=30,release,readCount=0;
      const held=new Promise(resolve=>{release=resolve;});
      const source={sourceFrames:48000*120,maxReadFrames:32768,
        overviewPeaks:Array.from({length:96},()=>[-.95,.95]),
        async read(startFrame,frameCount){
          readCount++;
          await held;
          return {startFrame,channels:[new Float32Array(frameCount).fill(.2)]};
        }};
      const editor=createPlayerWaveEditor({canvas,wrap:root,
        overviewSelection:node('div'),markerA:node('button'),markerB:node('button'),
        zoomIn,zoomOut,zoomLabel:node('span'),
        getPosition:()=>position,onPosition:value=>{position=value;},
        onStart:()=>{},onAB:()=>({a:0,b:source.sourceFrames,enabled:false}),
        onScrubState:()=>{}});
      const edgePixels=()=>{
        const ctx=canvas.getContext('2d'),width=canvas.width,height=canvas.height;
        return [2,width-3].map(x=>{
          const data=ctx.getImageData(x,0,1,height).data;
          let count=0;
          for(let i=0;i<data.length;i+=4)
            if(data[i+1]>130&&data[i+2]>120&&data[i+1]>data[i]+35)count++;
          return count;
        });
      };
      try{
        editor.setSource(source,48000);
        for(let i=0;i<10;i++)zoomIn.click();
        const pending={busy:canvas.getAttribute('aria-busy'),pixels:edgePixels()};
        release();
        const until=performance.now()+5000;
        while(canvas.getAttribute('aria-busy')!=='false'){
          if(performance.now()>until)throw Error('fine edge read timeout');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        // Allow the bounded guard read to settle before moving.
        await new Promise(resolve=>setTimeout(resolve,100));
        const span=editor.spanFrames,ready=edgePixels();
        const scrub=[];
        for(const direction of [1,-1]){
          position=30+direction*span/4/48000;
          editor.refresh(true);
          scrub.push({direction,pixels:edgePixels(),busy:canvas.getAttribute('aria-busy')});
        }
        return {pending,ready,scrub,span,readCount};
      }finally{
        release();editor.setSource(null,48000);root.remove();
      }
    });
    console.log('U01_REAL_CANVAS_EDGE '+JSON.stringify(edgeAudit));
    assert.equal(edgeAudit.pending.busy,'true');
    assert.deepEqual(edgeAudit.pending.pixels,[0,0],
      'unread high-zoom edges must not draw coarse overview blocks');
    for(const pixels of [edgeAudit.ready,...edgeAudit.scrub.map(s=>s.pixels)])
      assert.ok(pixels.every(count=>count>0&&count<10),
        'fine edge pixels must remain narrow and visible: '+JSON.stringify(pixels));
    assert.ok(edgeAudit.scrub.every(s=>s.busy==='false'),
      'short forward/reverse moves must be covered by fine guard data');


    assert.deepEqual(errors,[]);
  }finally{
    await cleanupTestProcesses(browser,[server],'progressive source test server');
  }
});
