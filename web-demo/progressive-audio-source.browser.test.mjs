import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {installTestAudioSilenceGuardForPage} from './test-audio-silence-guard.mjs';
import {cleanupTestProcesses} from './test-process-cleanup.mjs';

test('native browser decodes exact requested WAV PCM, loads the app without eager AudioContext and preserves the last good file',async()=>{
  const port=18761;
  const python=process.env.PYTHON_BIN||
    (process.platform==='win32'?'python':'python3');
  const server=spawn(python,['-m','http.server',String(port),'--bind','127.0.0.1'],{
    cwd:'_site',stdio:'ignore'
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
    await page.goto(`http://127.0.0.1:${port}/?pcmTransport=1`,{
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
          return {sampleRate:source.sampleRate,channels:source.channelCount,
            sourceFrames:source.sourceFrames,frames:samples.length,rms,
            residentFrames:source.stats().residentFrames};
        }finally{source.dispose();}
      },{...fixture,encoded});}
      catch(error){throw Error(`${fixture.name}: ${error.message}`,{cause:error});}
      assert.equal(probe.sampleRate,48000,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.channels,2,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.sourceFrames>=48000,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.equal(probe.frames,4096,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.rms>.02,`${fixture.name}: ${JSON.stringify(probe)}`);
      assert.ok(probe.residentFrames<=65_536,`${fixture.name}: ${JSON.stringify(probe)}`);
    }

    await page.evaluate(()=>{
      const input=document.querySelector('#audio-file'),transfer=new DataTransfer();
      transfer.items.add(window.__progressiveTestFile);input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector('#file-meta')?.textContent
      .includes('progressive-tone.wav · 8.0秒'),{timeout:20000});
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
    assert.equal(loading.duration,'0:08.0');

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
    await page.click('#stop');
    const output=await page.evaluate(()=>({
      muted:window.__audioSilenceAudit?.audioOutputMuteGain,
      mutedRoutes:window.__audioSilenceAudit?.mutedOutputRoutes,
      contexts:window.__audioContextCreations
    }));
    assert.equal(output.muted,0,'browser playback test output must be muted');
    assert.ok(output.mutedRoutes>0);
    assert.equal(output.contexts,1,'AudioContext is created only after an explicit Play action');
    assert.deepEqual(errors,[]);
  }finally{
    await cleanupTestProcesses(browser,[server],'progressive source test server');
  }
});
