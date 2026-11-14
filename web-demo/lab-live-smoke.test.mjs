import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
function wav(){
 const rate=16000,n=rate*3,bytes=Buffer.alloc(44+2*n);
 bytes.write('RIFF',0);bytes.writeUInt32LE(36+2*n,4);bytes.write('WAVE',8);bytes.write('fmt ',12);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
 bytes.write('data',36);bytes.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)bytes.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*440*i/rate)),44+2*i);
 return bytes;
}
test('full Chrome: inherited Rust AudioWorklet live independent speed/pitch UI',async()=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'lab-live-'));
 const server=spawn('python3',['-m','http.server','8769','--bind','127.0.0.1'],{cwd:path.resolve(process.env.WARP_WEB_ROOT||'_site'),stdio:'ignore'});
 let browser;
 try{
  const audioFile=path.join(temp,'tone.wav');await writeFile(audioFile,wav());
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:8769/',{waitUntil:'domcontentloaded'});
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
  await page.$eval('#lab-speed',e=>{e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('#lab-pitch',e=>{e.value='5';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('#play-wet',el=>el.scrollIntoView({block:'center',inline:'nearest'}));
  const beforeWet=await page.evaluate(()=>{
    const wet=document.querySelector('#play-wet'),main=document.querySelector('#play-main');
    window.__wetNativeClicks=0;wet.addEventListener('click',()=>window.__wetNativeClicks++);
    const rect=wet.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
    const hit=document.elementFromPoint(cx,cy);
    return {wetCenter:{x:Math.round(cx),y:Math.round(cy)},hit:{id:hit?.id,
      tag:hit?.tagName,cls:String(hit?.className||'').slice(0,110)},
      wetDisabled:wet.disabled,mainDisabled:main.disabled,
      wetDisplay:getComputedStyle(wet).display,tab:document.body.dataset.mainTab,
      file:document.querySelector('#file-meta')?.textContent,
      labModel:document.querySelector('#lab-model')?.value,
      individual:document.querySelector('#lab-individual-periods')?.checked,
      status:document.querySelector('#status')?.textContent};
  });
  assert.equal(beforeWet.wetDisabled,false,'Rust wet play must remain enabled: '+JSON.stringify(beforeWet));
  await (await page.$('#play-wet')).click();
  try{
    await page.waitForFunction(()=>document.querySelector('#rt-indicator')?.textContent.includes('稼働中 · Rust/WASM AudioWorklet'),{timeout:20000});
  }catch(error){
    const info=await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,indicator:document.querySelector('#rt-indicator')?.textContent,lab:document.querySelector('#lab-status')?.textContent}));
    throw Error('Rust Worklet failed: '+JSON.stringify({beforeWet,clicks:await page.evaluate(()=>window.__wetNativeClicks),...info})+' / '+error.message);
  }
  assert.equal(await page.$eval('#lab-speed',e=>e.value),'1.5');
  assert.equal(await page.$eval('#lab-pitch',e=>e.value),'5');
  assert.deepEqual(errors,[]);
  await (await page.$('#stop')).click();
 }finally{await browser?.close();server.kill();await rm(temp,{recursive:true,force:true});}
});
