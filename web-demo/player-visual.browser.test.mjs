import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync} from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

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
      railRangeVisible:document.querySelector("#granular-range").getClientRects().length>0&&
        document.querySelector("#granular-range").closest("details")===null,
      waveTimeBoundsInside:(()=>{
        const waveform=document.querySelector(".wave-detail-wrap").getBoundingClientRect();
        return ["#wave-visible-start","#wave-visible-end"].every(selector=>{
          const element=document.querySelector(selector);
          const bounds=element.getBoundingClientRect();
          return element.parentElement===document.querySelector(".wave-detail-time-bounds")&&
            bounds.top>=waveform.top&&bounds.bottom<=waveform.bottom;
        });
      })(),
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
  assert.equal(value.railRangeVisible,true,"speed rail width is directly available");
  assert.equal(value.waveTimeBoundsInside,true,"visible waveform bounds stay inside the detailed waveform");
  assert.equal(value.precisionOpen,true, "A/B detail must remain expanded by default");
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
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    await page.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await waitForFile(page);
    await layoutEvidence(page,"desktop-loaded");
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "user-facing player must not show a second telemetry card");
    assert.equal(await page.$eval("#audio-state-summary",e=>e.getClientRects().length>0),true);
    await page.click("#audio-diagnostics-toggle");
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length>0),true,
      "actual DSP telemetry remains readable on deliberate request");
    assert.equal(await page.$eval("#audio-diagnostics-toggle",e=>e.getAttribute("aria-expanded")),"true");
    await page.click("#audio-diagnostics-toggle");
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0);
    await page.screenshot({path:path.join(captureDir,"01-player-desktop.png"),fullPage:true});
    // Compact viewport preview is logged so reviewers without artifact ZIP
    // extraction can inspect the actual browser pixels at the exact test HEAD.
    console.log("UI_REVIEW_JPEG_DESKTOP:"+Buffer.from(await page.screenshot({type:"jpeg",quality:30})).toString("base64"));
    await page.click("#main-tab-model");
    assert.equal(await page.$eval(".model-extra-controls",el=>el.open),true);
    assert.equal(await page.$eval(".model-legacy-fold",el=>el.getClientRects().length),0,
      "Frequency Warp workbench must not appear in the Audio Time model UI");
    assert.equal(await page.$eval("#main-player-panel",el=>el.getClientRects().length),0,
      "the model tab must not duplicate the full waveform/player panel");
    assert.equal(await page.$eval("#model-transport-host #play-main",el=>el.getClientRects().length>0),true,
      "the same primary Play must be reachable on the model tab");
    assert.equal(await page.evaluate(()=>document.querySelectorAll("#lab-speed,#lab-pitch").length),0,
      "speed and pitch must have one canonical editable UI pair");
    assert.equal(await page.$eval("#settings-open",el=>el.getClientRects().length),0,
      "old Frequency Warp settings must not be a public Audio Time entry");
    assert.equal(await page.$eval("#audio-lab",el=>el.getClientRects().length>0),true);
    assert.equal(await page.$eval("#model-transport-host #audio-state-summary",e=>e.getClientRects().length>0),true);
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "the model view must not append a second permanent status panel after the footer");
    await page.setViewport({width:610,height:900,deviceScaleFactor:1});
    const tabletModel=await page.evaluate(()=>{
      const grid=document.querySelector(".model-extra-grid");
      const controls=[...grid.querySelectorAll(".lab-inline-control")]
        .filter(control=>control.getClientRects().length>0);
      return {columns:getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
        controls:controls.map(control=>{
          const label=control.querySelector(":scope > label").getBoundingClientRect();
          const slider=control.querySelector(":scope > input[type=range]").getBoundingClientRect();
          const value=control.querySelector(":scope > .inline-number").getBoundingClientRect();
          return {sliderWidth:slider.width,labelBeforeSlider:label.right<=slider.left,
            sliderBeforeValue:slider.right<=value.left};
        })};
    });
    assert.equal(tabletModel.columns,1,"model controls need a full-width row at 610 px");
    assert.ok(tabletModel.controls.length>=3&&tabletModel.controls.every(control=>
      control.sliderWidth>0&&control.labelBeforeSlider&&control.sliderBeforeValue),
      "model sliders must remain visible between their labels and editable values: "+JSON.stringify(tabletModel));
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    // Error states must remain visible even if the full diagnostics are closed,
    // including startup failures from the separately loaded entry controller.
    await page.evaluate(()=>{
      const node=document.querySelector("#status");
      window.__u6StatusBefore={text:node.textContent,kind:node.dataset.kind};
      node.dataset.kind="error";node.textContent="検証用：音声処理起動失敗";
    });
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.textContent.includes("音声処理起動失敗"),{timeout:3500});
    assert.equal(await page.$eval("#audio-state-summary",e=>e.dataset.kind),"error");
    await page.evaluate(()=>{
      const node=document.querySelector("#status");
      node.dataset.kind=window.__u6StatusBefore.kind;
      node.textContent=window.__u6StatusBefore.text;
    });
    await page.waitForFunction(()=>!document.querySelector("#audio-state-summary")
      ?.textContent.includes("検証用"),{timeout:3500});
    await page.screenshot({path:path.join(captureDir,"02-model-desktop.png")});
    console.log("UI_REVIEW_JPEG_MODEL_DESKTOP:"+Buffer.from(await page.screenshot({type:"jpeg",quality:28})).toString("base64"));
    // Puppeteer's setViewport({isMobile:true,hasTouch:true}) can reload a
    // desktop page. Open a fresh mobile page instead; load the WAV there.
    const mobile=await browser.newPage();
    mobile.on("pageerror",e=>errors.push(e.message));
    await mobile.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await mobile.goto("http://127.0.0.1:"+port+"/",{waitUntil:"domcontentloaded",timeout:20000});
    await mobile.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await waitForFile(mobile);
    await layoutEvidence(mobile,"mobile-loaded");
    const firstViewportPitch=await mobile.evaluate(()=>{
      const pitch=document.querySelector("#granular-pitch-value").getBoundingClientRect();
      return {pitchBottom:pitch.bottom,viewportHeight:innerHeight};
    });
    console.log("UI_FIRST_VIEWPORT_PITCH "+JSON.stringify(firstViewportPitch));
    assert.ok(firstViewportPitch.pitchBottom<=firstViewportPitch.viewportHeight,
      "pitch editing must be reachable before first vertical scroll at 390x844");
    await mobile.screenshot({path:path.join(captureDir,"03-player-mobile.png"),fullPage:true});
    console.log("UI_REVIEW_JPEG_MOBILE:"+Buffer.from(await mobile.screenshot({type:"jpeg",quality:32})).toString("base64"));
    await mobile.click("#main-tab-model");
    assert.equal(await mobile.$eval("#runtime-hud",e=>e.getClientRects().length),0);
    assert.equal(await mobile.$eval("#model-transport-host #audio-state-summary",e=>e.getClientRects().length>0),true);
    assert.equal(await mobile.$eval(".model-legacy-fold",el=>el.getClientRects().length),0);
    assert.equal(await mobile.$eval("#main-player-panel",el=>el.getClientRects().length),0);
    assert.equal(await mobile.$eval("#model-transport-host #play-main",el=>el.getClientRects().length>0),true);
    assert.equal(await mobile.evaluate(()=>document.querySelectorAll("#lab-speed,#lab-pitch").length),0);
    await mobile.screenshot({path:path.join(captureDir,"04-model-mobile.png")});
    console.log("UI_REVIEW_JPEG_MODEL_MOBILE:"+Buffer.from(await mobile.screenshot({type:"jpeg",quality:30})).toString("base64"));
    assert.deepEqual(errors,[],"no console page exceptions");
  }finally{
    await cleanupTestProcesses(browser,[server],"visual audit HTTP server");
  }
});
