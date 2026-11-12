import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync} from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

// #36 visual acceptance: real staged site + real recorded WAV, at desktop
// and iPhone-sized touch viewport. Captures are review evidence, NOT a
// substitute for physical iPhone Safari or subjective audio-quality checks.
const recording=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const captureDir=path.resolve("ui-review-screenshots");

async function waitForFile(page){
  await (await page.$("#audio-file")).uploadFile(recording);
  await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
    .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
  await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
}
async function layoutEvidence(page,tag){
  const value=await page.evaluate(()=>{
    const box=selector=>{
      const el=document.querySelector(selector),r=el.getBoundingClientRect();
      return {top:Math.round(r.top+window.scrollY),bottom:Math.round(r.bottom+window.scrollY),
        width:Math.round(r.width),height:Math.round(r.height),visible:getComputedStyle(el).display!=="none"};
    };
    return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      waveform:box(".wave-detail-wrap"),transport:box(".actions"),
      speedPitch:box("#granular-optin-controls"),ab:box("#player-loop-controls"),
      advancedOpen:document.querySelector(".player-tune-advanced").open,
      precisionOpen:document.querySelector(".player-loop-precision").open,
      legacyVisible:getComputedStyle(document.querySelector(".model-legacy-fold")).display!=="none"};
  });
  console.log("UI_VISUAL_AUDIT "+tag+" "+JSON.stringify(value));
  assert.ok(value.scrollWidth<=value.viewport+3,
    "no horizontal overflow in player view "+tag+": "+JSON.stringify(value));
  assert.ok(value.waveform.height>=150&&value.waveform.width>=260,
    "main waveform must be immediately usable "+tag);
  assert.ok(value.waveform.top<value.transport.top&&
    value.transport.top<value.speedPitch.top&&value.speedPitch.top<value.ab.top,
    "expected waveform > transport > speed/pitch > loop hierarchy "+tag);
  assert.equal(value.advancedOpen,false);
  assert.equal(value.precisionOpen,false);
  assert.equal(value.legacyVisible,false);
}
test("R4 usability visual captures: desktop and mobile player and folded research",async()=>{
  mkdirSync(captureDir,{recursive:true});
  const port=18787;
  const server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await waitForFile(page);
    await layoutEvidence(page,"desktop-loaded");
    await page.screenshot({path:path.join(captureDir,"01-player-desktop.png"),fullPage:true});
    // Compact viewport preview is logged so reviewers without artifact ZIP
    // extraction can inspect the actual browser pixels at the exact test HEAD.
    console.log("UI_REVIEW_JPEG_DESKTOP:"+Buffer.from(await page.screenshot({type:"jpeg",quality:30})).toString("base64"));
    await page.click("#main-tab-model");
    assert.equal(await page.$eval(".model-legacy-fold",el=>el.open),false);
    assert.equal(await page.$eval("#audio-lab",el=>getComputedStyle(el).display==="none"),false);
    await page.screenshot({path:path.join(captureDir,"02-model-desktop.png")});
    await page.click(".model-legacy-fold > summary");
    assert.equal(await page.$eval(".model-legacy-fold",el=>el.open),true);
    assert.equal(await page.$eval(".quick-panel",el=>getComputedStyle(el).display==="none"),false,
      "old transform features are explicitly available instead of deleted");
    // Puppeteer's setViewport({isMobile:true,hasTouch:true}) can reload a
    // desktop page. Open a fresh mobile page instead; load the WAV there.
    const mobile=await browser.newPage();
    mobile.on("pageerror",e=>errors.push(e.message));
    await mobile.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await mobile.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await mobile.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await waitForFile(mobile);
    await layoutEvidence(mobile,"mobile-loaded");
    await mobile.screenshot({path:path.join(captureDir,"03-player-mobile.png"),fullPage:true});
    console.log("UI_REVIEW_JPEG_MOBILE:"+Buffer.from(await mobile.screenshot({type:"jpeg",quality:32})).toString("base64"));
    await mobile.click("#main-tab-model");
    assert.equal(await mobile.$eval(".model-legacy-fold",el=>el.open),false);
    await mobile.screenshot({path:path.join(captureDir,"04-model-mobile.png")});
    assert.deepEqual(errors,[],"no console page exceptions");
  }finally{
    await browser?.close();
    server.kill("SIGTERM");
  }
});
