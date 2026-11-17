import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import puppeteer from 'puppeteer-core';
function wav(){
 const rate=16000,n=rate*3,bytes=Buffer.alloc(44+2*n);
 bytes.write('RIFF',0);bytes.writeUInt32LE(36+2*n,4);bytes.write('WAVE',8);bytes.write('fmt ',12);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
 bytes.write('data',36);bytes.writeUInt32LE(n*2,40);
 let phase=0;
 for(let i=0;i<n;i++){
  const hz=[220,440,659][Math.floor(i/rate)];
  phase+=2*Math.PI*hz/rate;
  const transient=i%rate===0 ? .08 : 0;
  const sample=.68*Math.sin(phase)+.24*Math.sin(phase*2)+transient;
  bytes.writeInt16LE(Math.round(8000*sample),44+2*i);
 }
 return bytes;
}
const pythonCommand=process.env.PYTHON||
 (process.platform==='win32'?'python':'python3');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
 const probe=createServer();
 await new Promise((resolve,reject)=>{
  probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);
 });
 const port=probe.address().port;
 await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
 return port;
}
test('full Chrome: inherited Rust AudioWorklet live independent speed/pitch UI',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'lab-live-'));
 const port=await freePort();
 const server=spawn(pythonCommand,['-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:path.resolve(process.env.WARP_WEB_ROOT||'_site'),stdio:'ignore'});
 let browser;
 try{
  const audioFile=path.join(temp,'tone.wav');await writeFile(audioFile,wav());
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(()=>{
   const connect=AudioNode.prototype.connect;
   window.__rustOutputAnalysers=[];
   window.__rustStartupSnapshots=[];
   window.__rustCaptureStartedAt=0;
   window.__rustCaptureTimer=setInterval(()=>{
    if(!window.__rustCaptureStartedAt)return;
    let peak=0,rms=0;
    for(const analyser of window.__rustOutputAnalysers){
     const pcm=new Float32Array(analyser.fftSize);
     analyser.getFloatTimeDomainData(pcm);
     let power=0,pathPeak=0;
     for(const sample of pcm){pathPeak=Math.max(pathPeak,Math.abs(sample));power+=sample*sample;}
     peak=Math.max(peak,pathPeak);
     rms=Math.max(rms,Math.sqrt(power/pcm.length));
    }
    if(window.__rustStartupSnapshots.length<512)
     window.__rustStartupSnapshots.push({
      elapsedMs:performance.now()-window.__rustCaptureStartedAt,peak,rms
     });
   },2);
   AudioNode.prototype.connect=function(target,...args){
    const media=typeof MediaStreamAudioDestinationNode!=="undefined"&&
      target instanceof MediaStreamAudioDestinationNode;
    if(target===this.context.destination||media){
     const analyser=this.context.createAnalyser();analyser.fftSize=2048;
     connect.call(this,analyser,...args);connect.call(analyser,target);
     window.__rustOutputAnalysers.push(analyser);return target;
    }
    return connect.call(this,target,...args);
   };
  });
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('html[data-fw-boot="ready"]');
  // The research/model controls now live on their explicit top-level tab.
  await page.click('#main-tab-model');
  assert.equal(await page.$eval('body',e=>e.dataset.mainTab),'model');
  await (await page.$('#audio-file')).uploadFile(audioFile);
  await page.waitForFunction(()=>!document.querySelector('#play-wet').disabled,{timeout:20000});
  // Granular is now the explicit main default. Enter an FFT model before
  // exercising the research-only individual-wave controls.
  await page.$eval('#lab-model',el=>{
    el.value='pv';el.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.waitForFunction(()=>document.querySelector('#lab-model').value==='pv'&&
    !document.querySelector('#lab-individual-periods').disabled,{timeout:10000});
  // Native Chrome UI contract: opt-in controls a real slider; log2 positions
  // select half through 32 cycles and switching OFF restores legacy mode.
  assert.equal(await page.$eval('#lab-period-cycles-field',e=>e.hidden),true);
  await page.$eval('#lab-individual-periods',e=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>!document.querySelector('#lab-period-cycles-field').hidden);
  await page.$eval('#lab-period-cycles',e=>{
    e.value='-1';
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.waitForFunction(()=>document.querySelector('#lab-period-cycles-output').textContent==='0.5周期');
  assert.equal(await page.$eval('#lab-period-cycles',e=>e.disabled),false);
  assert.equal(await page.$eval('#lab-model',e=>e.disabled),false);
  await page.$eval('#lab-model',e=>{e.value='wsola';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('#lab-model').value==='wsola' && document.querySelector('#lab-model-description').textContent.includes('WSOLA'));
  assert.equal(await page.$eval('#lab-short',e=>e.disabled),false);
  await page.$eval('#lab-individual-periods',e=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('#lab-period-cycles-field').hidden);
  assert.equal(await page.$eval('#lab-model',e=>e.disabled),false);
  await page.$eval('#lab-model',e=>{e.value='live';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('#lab-model').value==='live');
  // Audio Time exposes one canonical speed/pitch edit pair. Make the edits
  // in the player tab, then verify the same real Rust engine from model tab.
  await page.click('#main-tab-player');
  await page.$eval('#granular-speed-value',e=>{
    e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.$eval('#granular-pitch-value',e=>{
    e.value='12';e.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.click('#main-tab-model');
  // Model sections are deliberately expanded; scroll the shared Play button
  // into view before verifying it is actually hit-testable.
  await page.$eval("#play-main",el=>el.scrollIntoView({block:"center"}));
  const stateBefore=await page.evaluate(()=>{
    const main=document.querySelector('#play-main');
    const r=main.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return {visible:main.getClientRects().length>0,hit:hit===main||main.contains(hit),
      model:document.querySelector('#lab-model').value,
      speed:document.querySelector('#granular-speed-value').value,
      pitch:document.querySelector('#granular-pitch-value').value};
  });
  assert.equal(stateBefore.visible&&stateBefore.hit,true,
    'shared main Play must be hit-testable on the model tab: '+JSON.stringify(stateBefore));
  assert.equal(stateBefore.model,'live');
  await page.evaluate(()=>{
   const set=(id,value)=>{
    const el=document.getElementById(id);el.value=String(value);
    el.dispatchEvent(new Event('change',{bubbles:true}));
   };
   set('player-loop-a',0);set('player-loop-b',48000);
   const loop=document.querySelector('#player-loop-enabled');
   if(!loop.checked)loop.click();
  });
  await page.click('#play-main');
  try{
    await page.waitForFunction(()=>document.querySelector('#rt-indicator')
      ?.textContent.includes('Rust engine 3部分音＋残差合成中 · 共通サンプル時計'),{timeout:20000});
  }catch(error){
    const info=await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,
      indicator:document.querySelector('#rt-indicator')?.textContent,
      lab:document.querySelector('#lab-status')?.textContent}));
    throw Error('Rust Worklet failed from shared model transport: '+JSON.stringify({stateBefore,...info})+' / '+error.message);
  }
  assert.equal(await page.$eval('#granular-speed-value',e=>e.value),'1.5');
  assert.equal(await page.$eval('#granular-pitch-value',e=>e.value),'12');
  await page.waitForFunction(()=>window.__rustOutputAnalysers?.length>0,
   {timeout:10000});
  const setSpeed=async speed=>{
   const previous=Number(await page.$eval('#granular-optin-status',
    e=>e.dataset.renderRevision||0));
   await page.$eval('#granular-speed-value',(el,value)=>{
    el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));
   },speed);
   await page.waitForFunction(({speed,previous})=>{
    const status=document.querySelector('#granular-optin-status');
    return Number(document.querySelector('#granular-speed-value')?.value)===speed&&
      status?.dataset.renderRunning==='true'&&
      Number(status?.dataset.renderRevision)>previous;
   },{timeout:10000},{speed,previous});
   await sleep(100);
   const readings=[];
   for(let i=0;i<7;i++){
    await sleep(40);
    readings.push(await page.evaluate(()=>{
     const paths=(window.__rustOutputAnalysers||[]).map(analyser=>{
      const pcm=new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(pcm);
      let power=0,peak=0;
      for(const sample of pcm){power+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
      return {rms:Math.sqrt(power/pcm.length),peak};
     });
     return {rms:Math.max(0,...paths.map(x=>x.rms)),
      peak:Math.max(0,...paths.map(x=>x.peak))};
    }));
   }
   return {speed,maxRms:Math.max(...readings.map(x=>x.rms)),
    maxPeak:Math.max(...readings.map(x=>x.peak)),
    active:readings.filter(x=>x.rms>1e-4).length,
    renderFrame:Number(await page.$eval('#granular-optin-status',e=>e.dataset.renderFrame)),
    route:await page.$eval('#rt-telemetry',e=>e.dataset.pcmTransport)};
  };
  for(const speed of [8,-8]){
   const output=await setSpeed(speed);
   console.log('RUST_SIGNED_EXTREME_ACTUAL_OUTPUT '+JSON.stringify(output));
   assert.equal(output.route,'rust-engine3-source-time');
   assert.ok(output.active>=5&&output.maxRms>1e-4,
    'Rust AudioWorklet must output measured nonzero PCM at '+speed+'x: '+JSON.stringify(output));
   assert.ok(output.maxPeak>1e-3&&Number.isFinite(output.renderFrame));
  }
  const nodeStartsBeforeRestart=Number(await page.$eval('#rt-telemetry',
   e=>e.dataset.pcmNodeStarts));
  await page.click('#stop');
  await page.waitForFunction(()=>document.querySelector('#stop')?.disabled);
  await page.$eval('#granular-speed-value',e=>{
   e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.$eval('#granular-pitch-value',e=>{
   e.value='12';e.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.evaluate(()=>{
   window.__rustOutputAnalysers=[];
   window.__rustStartupSnapshots=[];
   window.__rustCaptureStartedAt=performance.now();
  });
  await page.click('#play-main');
  await page.waitForFunction(({nodeStartsBeforeRestart})=>{
   const telemetry=document.querySelector('#rt-telemetry');
   return Number(telemetry?.dataset.pcmNodeStarts)>nodeStartsBeforeRestart&&
    telemetry?.dataset.pcmTransport==='rust-engine3-source-time'&&
    document.querySelector('#granular-optin-status')?.dataset.renderRunning==='true';
  },{timeout:20000},{nodeStartsBeforeRestart});
  await sleep(250);
  const restartedStartup=await page.evaluate(()=>{
   const snapshots=window.__rustStartupSnapshots||[];
   const audible=snapshots.find(x=>x.rms>1e-4);
   const steady=snapshots.filter(x=>audible&&x.elapsedMs>=audible.elapsedMs+80)
    .map(x=>x.peak).sort((a,b)=>a-b);
   const startup=snapshots.filter(x=>audible&&x.elapsedMs>=audible.elapsedMs&&
    x.elapsedMs<=audible.elapsedMs+45);
   return {snapshotCount:snapshots.length,
    firstAudibleMs:audible?.elapsedMs??null,
    startupPeak:Math.max(0,...startup.map(x=>x.peak)),
    steadyPeak:steady[Math.floor(steady.length/2)]||0};
  });
  console.log('RUST_CHROME_RESTART_STARTUP_PCM '+JSON.stringify(restartedStartup));
  assert.ok(restartedStartup.steadyPeak>1e-3,
   'restarted Rust AudioWorklet must produce browser-measured PCM: '+
    JSON.stringify(restartedStartup));
  assert.ok(restartedStartup.startupPeak<=restartedStartup.steadyPeak*2,
   'restarted Rust startup must stay within 2x steady peak: '+
    JSON.stringify(restartedStartup));
  assert.deepEqual(errors,[]);
  await (await page.$('#stop')).click();
 }finally{await browser?.close();server.kill();await rm(temp,{recursive:true,force:true});}
});
