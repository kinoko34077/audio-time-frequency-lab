import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

// #36 visual acceptance: real staged site + real recorded WAV, at desktop
// and narrow touch viewport. Captures are review evidence, NOT a substitute
// for physical iPhone Safari or subjective audio-quality checks.
const recording=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const captureDir=path.resolve(process.env.AUDIO_LAB_REVIEW_DIR||"ui-review-screenshots");
const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||"_site");

async function waitForFile(page){
  await (await page.$("#audio-file")).uploadFile(recording);
  await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
    .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
  await page.waitForSelector("#play-main:not([disabled])",{timeout:15000});
  await page.waitForFunction(()=>{
    const canvas=document.querySelector("#wave");
    if(!canvas?.width||!canvas.height)return false;
    const pixels=canvas.getContext("2d").getImageData(
      0,0,canvas.width,canvas.height).data;
    let renderedColumns=0;
    for(let x=0;x<canvas.width;x++){
      let rendered=false;
      for(let y=0;y<canvas.height;y++){
        const offset=(y*canvas.width+x)*4;
        if(pixels[offset+1]>140&&pixels[offset+1]>pixels[offset]*1.45){
          rendered=true;break;
        }
      }
      if(rendered)renderedColumns++;
    }
    return renderedColumns>=canvas.width*.97;
  },{timeout:20000});
}
async function waitForServer(url,server){
  const deadline=Date.now()+10000;
  let lastError;
  while(Date.now()<deadline){
    if(server.exitCode!==null)throw Error("visual test server exited with "+server.exitCode);
    try{
      const response=await fetch(url,{cache:"no-store"});
      await response.arrayBuffer();
      if(response.ok)return;
    }catch(error){lastError=error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("visual test server did not become ready: "+(lastError?.message||"timeout"));
}
async function layoutEvidence(page,tag){
  const value=await page.evaluate(()=>{
    const box=selector=>{
      const el=document.querySelector(selector),r=el.getBoundingClientRect();
      return {top:Math.round(r.top+window.scrollY),bottom:Math.round(r.bottom+window.scrollY),
        width:Math.round(r.width),height:Math.round(r.height),visible:getComputedStyle(el).display!=="none"};
    };
    const studioStyle=getComputedStyle(document.querySelector(".studio"));
    const abToolbar=document.querySelector(".player-loop-toolbar").getBoundingClientRect();
    const abControls=[...document.querySelectorAll(
      ".player-loop-toolbar > button,.player-loop-toolbar > label")]
      .map(element=>element.getBoundingClientRect());
    return {viewport:innerWidth,viewportHeight:innerHeight,
      safeAreaPadding:{top:studioStyle.paddingTop,bottom:studioStyle.paddingBottom},
      viewportFitCover:/viewport-fit=cover/.test(
        document.querySelector('meta[name="viewport"]')?.content||""),
      scrollWidth:document.documentElement.scrollWidth,studio:box(".studio"),
      workspace:box(".workspace-grid"),workspaceLeft:box(".workspace-left"),
      workspaceItems:[...document.querySelector(".workspace-grid").children].map(element=>({
        className:element.className,display:getComputedStyle(element).display,
        top:Math.round(element.getBoundingClientRect().top),
        bottom:Math.round(element.getBoundingClientRect().bottom)})),
      playerPanel:box("#main-player-panel"),waveEditor:box(".wave-editor"),
      waveOverview:box(".wave-editor .wave-wrap"),
      below:box(".below-workspace"),footer:box("footer"),
      waveform:box(".wave-detail-wrap"),transport:box(".actions"),
      statusRow:box(".audio-status-row"),
      speedPitch:box("#granular-optin-controls"),ab:box("#player-loop-controls"),
      abControlsAfterTuning:document.querySelector("#player-loop-controls")
        .getBoundingClientRect().top>=document.querySelector("#granular-optin-controls")
          .getBoundingClientRect().bottom-1,
      abToolbarSpan:{left:abControls[0]?.left,right:abControls.at(-1)?.right,
        toolbarLeft:abToolbar.left,toolbarRight:abToolbar.right},
      railRangeVisible:document.querySelector("#granular-range").getClientRects().length>0&&
        document.querySelector("#granular-range").closest("details")===null,
      rulerAtTop:(()=>{
        const waveform=document.querySelector(".wave-detail-wrap").getBoundingClientRect();
        const ruler=document.querySelector(".wave-detail-ruler").getBoundingClientRect();
        return [...document.querySelectorAll(".wave-detail-ruler [data-ruler-tick]")]
          .filter(element=>element.textContent.trim())
          .every(element=>{
            const bounds=element.getBoundingClientRect();
            return bounds.top>=ruler.top-1&&bounds.top<=ruler.top+3&&
              bounds.bottom<=ruler.bottom+1&&
              Math.abs(ruler.top-waveform.top)<=1.5;
          });
      })(),
      playheadTopOffset:(()=>{
        const waveform=document.querySelector(".wave-detail-wrap").getBoundingClientRect();
        const playhead=document.querySelector(".wave-center-head").getBoundingClientRect();
        return Math.round((playhead.top-waveform.top)*100)/100;
      })(),
      rulerBandHeight:Math.round(document.querySelector(".wave-detail-ruler").getBoundingClientRect().height),
      rulerLabelsAtTop:(()=>{
        const ruler=document.querySelector(".wave-detail-ruler").getBoundingClientRect();
        return [...document.querySelectorAll(".wave-detail-ruler [data-ruler-tick]")]
          .filter(element=>element.textContent.trim())
          .every(element=>{
            const bounds=element.getBoundingClientRect();
            return Math.abs(bounds.top-ruler.top)<=2;
          });
      })(),
      rulerCoordinateErrors:(()=>{
        const canvas=document.querySelector("#wave-detail").getBoundingClientRect();
        return [...document.querySelectorAll(".wave-detail-ruler [data-ruler-tick]")]
          .map((element,index)=>{
            const bounds=element.getBoundingClientRect();
            const expected=canvas.left+canvas.width*index/4;
            const actual=index===4?bounds.right:index===0?bounds.left:
              bounds.left+bounds.width/2;
            return Math.round(Math.abs(actual-expected)*100)/100;
          });
      })(),
      markerBelowRuler:(()=>{
        const ruler=document.querySelector(".wave-detail-ruler").getBoundingClientRect();
        const marker=[...document.querySelectorAll(".wave-marker")]
          .find(element=>!element.hidden&&element.getClientRects().length);
        const bounds=marker?.getBoundingClientRect();
        return {fits:!bounds||bounds.top>=ruler.bottom,markerTop:bounds?.top??null,
          rulerBottom:ruler.bottom,markerHidden:!marker};
      })(),
      clockAtBottom:(()=>{
        const waveform=document.querySelector(".wave-detail-wrap").getBoundingClientRect();
        const clock=document.querySelector(".wave-detail-wrap .transport").getBoundingClientRect();
        return ["#elapsed","#duration"].every(selector=>
          document.querySelector(selector).parentElement.classList.contains("transport")&&
          document.querySelector(selector).parentElement.parentElement.classList.contains("wave-detail-wrap"))&&
          clock.top>=waveform.top+waveform.height*.72&&clock.bottom<=waveform.bottom;
      })(),
      sliderAlignment:(()=>{
        const speed=document.querySelector("#granular-speed").getBoundingClientRect();
        const pitch=document.querySelector("#granular-pitch").getBoundingClientRect();
        return Math.abs(speed.left-pitch.left)<=1&&Math.abs(speed.right-pitch.right)<=1;
      })(),
      tuningValueAlignment:(()=>{
        const speedInput=document.querySelector("#granular-speed-value").getBoundingClientRect();
        const pitchInput=document.querySelector("#granular-pitch-value").getBoundingClientRect();
        const speedUnit=document.querySelector("#granular-speed").closest(".player-tune-control")
          .querySelector(".player-tune-unit");
        const pitchUnit=document.querySelector("#granular-pitch").closest(".player-tune-control")
          .querySelector(".player-tune-unit");
        if(!speedUnit||!pitchUnit)return {aligned:false,missingUnits:true};
        const speedUnitRect=speedUnit.getBoundingClientRect();
        const pitchUnitRect=pitchUnit.getBoundingClientRect();
        return {aligned:Math.abs(speedInput.left-pitchInput.left)<=1&&
            Math.abs(speedInput.right-pitchInput.right)<=1&&
            Math.abs(speedUnitRect.right-pitchUnitRect.right)<=1,
          speedInputLeft:Math.round(speedInput.left),
          pitchInputLeft:Math.round(pitchInput.left),
          speedUnitRight:Math.round(speedUnitRect.right),
          pitchUnitRight:Math.round(pitchUnitRect.right)};
      })(),
      compactControlSizing:(()=>{
        const width=selector=>Math.round(document.querySelector(selector)
          .getBoundingClientRect().width*100)/100;
        const height=selector=>Math.round(document.querySelector(selector)
          .getBoundingClientRect().height*100)/100;
        const requiredInputWidth=(selector,text)=>{
          const element=document.querySelector(selector),style=getComputedStyle(element);
          const context=document.createElement("canvas").getContext("2d");
          context.font=style.font;
          return context.measureText(text).width+
            ["paddingLeft","paddingRight","borderLeftWidth","borderRightWidth"]
              .reduce((sum,key)=>sum+parseFloat(style[key]||"0"),0);
        };
        const measureRepresentativeValue=(selector,text)=>{
          const element=document.querySelector(selector),original=element.value;
          element.value=text;
          element.dispatchEvent(new Event("input",{bubbles:true}));
          const width=element.getBoundingClientRect().width;
          const fits=element.scrollWidth<=element.clientWidth;
          element.value=original;
          element.dispatchEvent(new Event("input",{bubbles:true}));
          return {width,fits};
        };
        const shortSpeed=measureRepresentativeValue("#granular-speed-value","1");
        const representativeSpeed=measureRepresentativeValue("#granular-speed-value","-1.237");
        const shortPitch=measureRepresentativeValue("#granular-pitch-value","0");
        const representativePitch=measureRepresentativeValue("#granular-pitch-value","-12.0");
        const actions=[...document.querySelectorAll("#main-player-panel #shared-transport>.actions button")]
          .filter(element=>getComputedStyle(element).display!=="none")
          .map(element=>({id:element.id,width:Math.round(element.getBoundingClientRect().width*100)/100,
            height:Math.round(element.getBoundingClientRect().height*100)/100}));
        const loop=[...document.querySelectorAll(
          ".player-loop-toolbar>button,.player-loop-toolbar>label")]
          .map(element=>Math.round(element.getBoundingClientRect().width*100)/100);
        return {speedValue:width("#granular-speed-value"),pitchValue:width("#granular-pitch-value"),
          speedValueHeight:height("#granular-speed-value"),pitchValueHeight:height("#granular-pitch-value"),
          speedTextFits:representativeSpeed.width>=requiredInputWidth("#granular-speed-value","-1.237"),
          pitchTextFits:representativePitch.width>=requiredInputWidth("#granular-pitch-value","-12.0"),
          speedInputTracksTextWidth:representativeSpeed.width<=
              requiredInputWidth("#granular-speed-value","-1.237")+3&&
            representativeSpeed.width>shortSpeed.width+10,
          pitchInputTracksTextWidth:representativePitch.width<=
              requiredInputWidth("#granular-pitch-value","-12.0")+3&&
            representativePitch.width>shortPitch.width+10,
          speedNativeValueFits:representativeSpeed.fits,
          pitchNativeValueFits:representativePitch.fits,
          dryButton:width("#play-dry"),actions,loop,
          loopHeights:[...document.querySelectorAll(
            ".player-loop-toolbar>button,.player-loop-toolbar>label")]
            .map(element=>Math.round(element.getBoundingClientRect().height*100)/100),
          loopCenterOffset:(()=>{
            const controls=document.querySelector(".player-loop-toolbar").getBoundingClientRect();
            const first=document.querySelector(".player-loop-toolbar>*:first-child").getBoundingClientRect();
            const last=document.querySelector(".player-loop-toolbar>*:last-child").getBoundingClientRect();
            return Math.round(((first.left+last.right)/2-(controls.left+controls.right)/2)*100)/100;
          })()};
      })(),
      redundantPlayerLabelsAbsent:(()=>{
        const visible=selector=>[...document.querySelectorAll(selector)]
          .some(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=="hidden");
        const footer=document.querySelector("footer").innerText;
        return !visible(".wave-editor-caption,.wave-overview-header")&&
          !footer.includes("音声は端末内で処理");
      })(),
      abControlsVisible:["#player-marker-toggle","#player-loop-a-now","#player-loop-b-now",
        "#player-loop-toggle"].every(selector=>
        document.querySelector(selector).getClientRects().length>0),
      pickerLabel:document.querySelector("#audio-picker-label")?.textContent,
      pickerLeftOfSettings:document.querySelector(".source-picker").getBoundingClientRect().left<
        document.querySelector("#settings-open").getBoundingClientRect().left,
      mainTabsVisible:document.querySelector(".main-workspace-tabs").getClientRects().length>0,
      durationRepeated:/\d+(?:\.\d+)?秒/.test(document.querySelector("#file-meta").textContent),
      successStatusVisible:(()=>{
        const rect=document.querySelector("#audio-state-summary").getBoundingClientRect();
        return rect.width>1&&rect.height>1;
      })(),
      diagnosticsButtonVisible:document.querySelector("#audio-diagnostics-toggle").getClientRects().length>0,
      numericLoopEditorVisible:document.querySelector("#player-loop-fields").getClientRects().length>0,
      processingDetailHidden:document.querySelector("#granular-optin-status").getClientRects().length===0,
      extraCopyAbsent:!/(音響品質検証中|実機可聴遅延|研究試作|区間の端点を数値で編集|左右に動かす)/
        .test(document.body.innerText),
      precisionOpen:document.querySelector("#player-loop-fields").hidden===false,
      legacyVisible:getComputedStyle(document.querySelector(".model-legacy-fold")).display!=="none"};
  });
  console.log("UI_VISUAL_AUDIT "+tag+" "+JSON.stringify(value));
  assert.ok(value.scrollWidth<=value.viewport+3,
    "no horizontal overflow in player view "+tag+": "+JSON.stringify(value));
  assert.ok(value.waveform.height>=150&&value.waveform.width>=260,
    "main waveform must be immediately usable "+tag);
  assert.ok(value.waveform.top<value.transport.top&&
    value.transport.top<value.speedPitch.top,
    "expected waveform > transport > speed/pitch hierarchy "+tag);
  assert.equal(value.railRangeVisible,true,"speed rail width is directly available");
  assert.equal(value.rulerAtTop,true,"waveform ruler labels stay inside its top edge");
  assert.ok(value.playheadTopOffset<=1,
    "center playback position starts on the waveform edge: "+value.playheadTopOffset);
  assert.ok(value.rulerBandHeight>=12&&value.rulerBandHeight<=18,
    "top ruler stays compact against the waveform edge: "+value.rulerBandHeight);
  assert.equal(value.rulerLabelsAtTop,true,"ruler labels sit at the waveform top edge");
  assert.ok(value.rulerCoordinateErrors.every(error=>error<=1),
    "ruler labels keep the waveform's full source-time coordinate system: "+
      JSON.stringify(value.rulerCoordinateErrors));
  assert.equal(value.markerBelowRuler.fits,true,
    "A/B markers begin just below the compact ruler: "+JSON.stringify(value.markerBelowRuler));
  assert.equal(value.clockAtBottom,true,"elapsed and total time sit inside the waveform bottom edge");
  assert.equal(value.sliderAlignment,true,"speed and pitch sliders share the same left and right edges");
  assert.ok(value.compactControlSizing.speedValue<=54&&value.compactControlSizing.pitchValue<=54,
    "numeric values use widths sized for their visible precision: "+JSON.stringify(value.compactControlSizing));
  assert.ok(value.compactControlSizing.speedValueHeight<=38&&
    value.compactControlSizing.pitchValueHeight<=38&&
    value.compactControlSizing.speedTextFits&&value.compactControlSizing.pitchTextFits&&
    value.compactControlSizing.speedInputTracksTextWidth&&
    value.compactControlSizing.pitchInputTracksTextWidth&&
    value.compactControlSizing.speedNativeValueFits&&value.compactControlSizing.pitchNativeValueFits,
    "compact numeric fields still show representative signed speed and pitch values: "+
      JSON.stringify(value.compactControlSizing));
  assert.ok(value.compactControlSizing.dryButton<=112,
    "original-audio action is sized to its label instead of a full row: "+
      JSON.stringify(value.compactControlSizing));
  assert.ok(value.compactControlSizing.loop.every(width=>width<=82),
    "Mark/A/B/Loop controls do not stretch beyond their labels: "+
      JSON.stringify(value.compactControlSizing));
  assert.ok(value.compactControlSizing.actions.every(action=>action.height<=40)&&
    value.compactControlSizing.loopHeights.every(height=>height<=40),
    "transport and loop buttons use compact, consistent heights: "+
      JSON.stringify(value.compactControlSizing));
  assert.ok(Math.abs(value.compactControlSizing.loopCenterOffset)<=2,
    "the compact loop controls are centered in the available row: "+
      JSON.stringify(value.compactControlSizing));
  assert.equal(value.redundantPlayerLabelsAbsent,true,
    "visible waveform headings and device-processing footer copy are removed");
  assert.equal(value.tuningValueAlignment.aligned,true,
    "speed and pitch values and units share fixed columns at desktop and mobile widths: "+
      JSON.stringify(value.tuningValueAlignment));
  assert.equal(value.abControlsAfterTuning,true,
    "Mark/A/B/Loop follow the speed and pitch controls");
  assert.equal(value.abControlsVisible,true,"AudioStretch-style Mark/A/B/Loop controls are visible");
  assert.equal(value.pickerLabel,"meta-piano-a0-cc0-3s-48khz.wav",
    "loaded source name remains visible beside the plus picker");
  assert.equal(value.pickerLeftOfSettings,true,"source picker and settings gear anchor the header");
  assert.equal(value.mainTabsVisible,false,"model navigation is a settings gear, not a tab row");
  assert.equal(value.durationRepeated,false,"duration is not repeated below the waveform ruler");
  assert.equal(value.successStatusVisible,false,"successful load status does not occupy player space");
  assert.equal(value.diagnosticsButtonVisible,false,"diagnostic controls stay out of the normal player");
  assert.ok(value.statusRow.height<=2,"empty status row does not reserve vertical space");
  assert.equal(value.numericLoopEditorVisible,false,"A/B editing stays on the waveform and AudioStretch controls");
  assert.equal(value.processingDetailHidden,true,"engineering playback status stays out of the player");
  assert.equal(value.extraCopyAbsent,true,"developer-only and redundant copy is removed");
  assert.equal(value.precisionOpen,false, "sample-precision fields are secondary by default");
  assert.equal(value.legacyVisible,false);
  return value;
}
test("R4 usability visual captures: desktop and mobile player and folded research",{
  timeout:120000
},async()=>{
  mkdirSync(captureDir,{recursive:true});
  const port=Number(process.env.AUDIO_LAB_VISUAL_PORT||18787);
  const browserProfile=mkdtempSync(path.join(tmpdir(),"audio-lab-puppeteer-"));
  const python=process.env.PYTHON_EXECUTABLE||
    (process.platform==="win32"?"python":"python3");
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore",windowsHide:true
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",userDataDir:browserProfile,
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    console.log("VISUAL_TEST_PROCESS_IDS "+JSON.stringify({browser:browser.process()?.pid,server:server.pid}));
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    const localUrl="http://127.0.0.1:"+port+"/";
    await waitForServer(localUrl,server);
    await page.goto(localUrl,{waitUntil:"domcontentloaded",timeout:20000});
    await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    assert.equal(await page.$eval("#audio-state-summary",e=>{
      const r=e.getBoundingClientRect();return r.width<=1&&r.height<=1;
    }),true,"idle status does not occupy player space");
    assert.equal(await page.$eval("#audio-diagnostics-toggle",e=>e.hidden),true,
      "details appear when a source or a recoverable error exists");
    await waitForFile(page);
    await layoutEvidence(page,"desktop-loaded");
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "user-facing player must not show a second telemetry card");
    await page.screenshot({path:path.join(captureDir,"01-player-desktop.png"),fullPage:true});
    await page.setViewport({width:813,height:900,deviceScaleFactor:1});
    await layoutEvidence(page,"compact-desktop-loaded");
    await page.screenshot({path:path.join(captureDir,"01b-player-813.png"),fullPage:true});
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    await page.evaluate(()=>{
      const set=(id,value)=>{
        const input=document.querySelector(id);
        input.value=String(value);
        input.dispatchEvent(new Event("change",{bubbles:true}));
      };
      set("#player-loop-a",1000);set("#player-loop-b",3000);
    });
    await page.evaluate(async()=>{
      const button=document.querySelector("#player-loop-a-now");
      button.dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,detail:1}));
      await new Promise(resolve=>setTimeout(resolve,260));
      button.dispatchEvent(new MouseEvent("click",{bubbles:true,button:0,detail:2}));
      button.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,button:0,detail:2}));
    });
    assert.deepEqual(await page.evaluate(()=>({
      a:document.querySelector("#player-loop-a").value,
      b:document.querySelector("#player-loop-b").value
    })),{a:"0",b:"3000"},"two taps act as single taps and do not shift the interval");
    await page.evaluate(()=>{
      document.querySelector("#player-loop-a").value="1000";
      document.querySelector("#player-loop-a").dispatchEvent(new Event("change",{bubbles:true}));
      document.querySelector("#player-loop-b").value="3000";
      document.querySelector("#player-loop-b").dispatchEvent(new Event("change",{bubbles:true}));
    });
    const loopBButton=await page.$eval("#player-loop-b-now",el=>{
      const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
    });
    await page.mouse.move(loopBButton.x,loopBButton.y);
    await page.mouse.down();
    await page.mouse.move(4,4,{steps:6});
    await page.mouse.up();
    await new Promise(resolve=>setTimeout(resolve,580));
    const cancelledLongPress=await page.evaluate(()=>({
      a:document.querySelector("#player-loop-a").value,
      b:document.querySelector("#player-loop-b").value
    }));
    assert.deepEqual(cancelledLongPress,{a:"1000",b:"3000"},
      "releasing a captured A/B pointer outside the control cancels long-press behavior");
    const loopAButton=await page.$eval("#player-loop-a-now",el=>{
      const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
    });
    await page.mouse.click(loopAButton.x,loopAButton.y);
    await page.waitForFunction(()=>document.querySelector("#player-loop-a")?.value==="0"&&
      document.querySelector("#player-loop-b")?.value==="3000",{timeout:1200});
    const loopBefore=await page.$eval("#player-loop-enabled",el=>el.checked);
    await page.$eval("#player-loop-enabled",el=>el.click());
    const loopAfterClick=await page.$eval("#player-loop-enabled",el=>el.checked);
    assert.equal(loopAfterClick,!loopBefore,
      "native checkbox activation toggles Loop immediately");
    await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(await page.$eval("#player-loop-enabled",el=>el.checked),loopAfterClick,
      "a native checkbox click does not schedule a duplicate Loop action");
    assert.equal(await page.$eval(".model-extra-controls",el=>el.open),false,
      "advanced model controls start folded");
    await page.click("#settings-open");
    await page.waitForFunction(()=>document.querySelector("#settings-dialog")?.open);
    assert.equal(await page.$eval(".model-legacy-fold",el=>el.getClientRects().length),0,
      "Frequency Warp workbench must not appear in the Audio Time model UI");
    assert.equal(await page.$eval("#main-player-panel",el=>el.getClientRects().length>0),true,
      "opening model settings preserves the full waveform/player panel");
    assert.equal(await page.$eval("#settings-dialog #audio-lab",el=>el.getClientRects().length>0),true,
      "model settings open from the header gear");
    assert.equal(await page.evaluate(()=>document.querySelectorAll("#play-main").length),1,
      "settings do not create a duplicate transport");
    assert.equal(await page.evaluate(()=>document.querySelectorAll("#lab-speed,#lab-pitch").length),0,
      "speed and pitch must have one canonical editable UI pair");
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0,
      "model settings do not append a second permanent status panel");
    await page.$eval(".model-extra-controls>summary",el=>el.click());
    await page.waitForFunction(()=>document.querySelector(".model-extra-controls")?.open);
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
    await page.click("#settings-close");
    await page.waitForFunction(()=>!document.querySelector("#settings-dialog")?.open);
    await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    // Error states must remain visible even if the full diagnostics are closed,
    // including startup failures from the separately loaded entry controller.
    const errorState=await page.evaluate(()=>new Promise(resolve=>{
      const node=document.querySelector("#status"),detail=document.querySelector("#audio-diagnostics-toggle");
      window.__u6StatusBefore={text:node.textContent,kind:node.dataset.kind};
      const visibleError=new MutationObserver(()=>{
        if(detail.hidden)return;
        visibleError.disconnect();
        resolve({text:document.querySelector("#audio-state-summary").textContent,
          visible:document.querySelector("#audio-state-summary").getClientRects().length>0});
        detail.click();
      });
      visibleError.observe(detail,{attributes:true,attributeFilter:["hidden"]});
      node.dataset.kind="error";node.textContent="検証用：音声処理起動失敗";
    }));
    assert.ok(errorState.text.includes("音声処理起動失敗"));
    assert.equal(errorState.visible,true,
      "actionable failures remain visible");
    assert.ok(await page.$eval(".audio-status-row",e=>e.getBoundingClientRect().height>0),
      "the status row returns when an actionable failure needs it");
    await page.waitForFunction(()=>document.querySelector("#runtime-hud")
      ?.classList.contains("is-expanded"),{timeout:3500});
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length>0),true,
      "actual DSP telemetry remains readable from an error state");
    await page.evaluate(()=>{
      const node=document.querySelector("#status");
      node.dataset.kind="info";node.textContent="検証用：状態復帰";
    });
    await page.waitForFunction(()=>document.querySelector("#audio-state-summary")
      ?.dataset.kind==="info",{timeout:3500});
    const recoveredDiagnostics=await page.evaluate(()=>({
      detailHidden:document.querySelector("#audio-diagnostics-toggle").hidden,
      playDisabled:document.querySelector("#play-main").disabled,
      hudExpanded:document.querySelector("#runtime-hud").classList.contains("is-expanded"),
      summaryHidden:document.querySelector("#audio-state-summary").hidden,
      summaryKind:document.querySelector("#audio-state-summary").dataset.kind,
      statusKind:document.querySelector("#status").dataset.kind,
      fileMeta:document.querySelector("#file-meta").textContent
    }));
    assert.equal(recoveredDiagnostics.detailHidden,false,
      "an expanded diagnostics panel keeps its close control when an error clears: "+
      JSON.stringify(recoveredDiagnostics));
    await page.evaluate(()=>document.querySelector("#audio-diagnostics-toggle").click());
    assert.equal(await page.$eval("#runtime-hud",e=>e.getClientRects().length),0);
    await page.evaluate(()=>{
      const node=document.querySelector("#status");
      node.dataset.kind=window.__u6StatusBefore.kind;
      node.textContent=window.__u6StatusBefore.text;
    });
    await page.waitForFunction(()=>!document.querySelector("#audio-state-summary")
      ?.textContent.includes("検証用"),{timeout:3500});
    await page.screenshot({path:path.join(captureDir,"02-model-desktop.png")});
    // Puppeteer's setViewport({isMobile:true,hasTouch:true}) can reload a
    // desktop page. Open a fresh mobile page instead; load the WAV there.
    const mobile=await browser.newPage();
    mobile.on("pageerror",e=>errors.push(e.message));
    // Match the supplied screenshot's 0.5 aspect ratio and modeled safe area
    // while keeping CSS viewport dimensions explicit. This is browser
    // emulation, not a claim of physical iOS metrics or hardware acceptance.
    await mobile.setViewport({width:393,height:853,deviceScaleFactor:1.5,isMobile:true,hasTouch:true});
    const mobileMetrics=await mobile.createCDPSession();
    await mobileMetrics.send("Emulation.setSafeAreaInsetsOverride",{insets:{
      top:44,bottom:24,left:0,right:0,topMax:44,bottomMax:24,leftMax:0,rightMax:0
    }});
    await mobile.goto(localUrl,{waitUntil:"domcontentloaded",timeout:20000});
    await mobile.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",{timeout:20000});
    await waitForFile(mobile);
    const mobileLayout=await layoutEvidence(mobile,"mobile-touch-loaded");
    assert.equal(Math.round(mobileLayout.viewport/mobileLayout.viewportHeight*1000)/1000,.461,
      "mobile browser viewport matches the supplied 591:1280 screenshot ratio");
    assert.deepEqual(mobileLayout.safeAreaPadding,{top:"50px",bottom:"32px"},
      "the page honors the modeled PWA status and home-indicator safe areas");
    assert.equal(mobileLayout.viewportFitCover,true,
      "mobile viewport leaves safe-area handling available to the PWA shell");
    assert.ok(mobileLayout.footer.bottom>=mobileLayout.viewportHeight-40,
      "mobile footer reaches the bottom of the usable viewport: "+
        JSON.stringify({footer:mobileLayout.footer,height:mobileLayout.viewportHeight}));
    assert.ok(mobileLayout.footer.bottom<=mobileLayout.viewportHeight-8,
      "mobile footer remains visible above the bottom safe-area padding: "+
        JSON.stringify({footer:mobileLayout.footer,height:mobileLayout.viewportHeight}));
    assert.ok(mobileLayout.waveform.height>=150,
      "the main waveform keeps a usable height on the screenshot-ratio viewport: "+
        JSON.stringify(mobileLayout.waveform));
    assert.ok(mobileLayout.waveEditor.bottom-mobileLayout.waveOverview.bottom<=5,
      "the detailed waveform fills the editor instead of leaving a blank mobile band: "+
        JSON.stringify({waveEditor:mobileLayout.waveEditor,waveOverview:mobileLayout.waveOverview}));
    assert.ok(Math.abs((mobileLayout.abToolbarSpan.left+mobileLayout.abToolbarSpan.right)/2-
      (mobileLayout.abToolbarSpan.toolbarLeft+mobileLayout.abToolbarSpan.toolbarRight)/2)<=2&&
      mobileLayout.abToolbarSpan.right-mobileLayout.abToolbarSpan.left<
        (mobileLayout.abToolbarSpan.toolbarRight-mobileLayout.abToolbarSpan.toolbarLeft)*.8,
      "compact A/B actions are centered without stretching across the phone: "+
        JSON.stringify(mobileLayout.abToolbarSpan));
    const firstViewportPitch=await mobile.evaluate(()=>{
      const pitch=document.querySelector("#granular-pitch-value").getBoundingClientRect();
      return {pitchBottom:pitch.bottom,viewportHeight:innerHeight};
    });
    console.log("UI_FIRST_VIEWPORT_PITCH "+JSON.stringify(firstViewportPitch));
    assert.ok(firstViewportPitch.pitchBottom<=firstViewportPitch.viewportHeight,
      "pitch editing must be reachable before first vertical scroll at the screenshot-ratio viewport");
    await mobile.screenshot({path:path.join(captureDir,"03-player-aspect-ratio-0.5.png")});
    await mobile.evaluate(()=>{
      const status=document.querySelector("#status");
      window.__mobileStatusBefore={text:status.textContent,kind:status.dataset.kind};
      status.dataset.kind="error";
      status.textContent="検証用：モバイル診断表示";
    });
    await mobile.waitForFunction(()=>!document.querySelector("#audio-diagnostics-toggle")?.hidden,
      {timeout:3500});
    await mobile.evaluate(()=>document.querySelector("#audio-diagnostics-toggle").click());
    const mobileDiagnostics=await mobile.evaluate(()=>{
      const box=selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {top:r.top,bottom:r.bottom};
      };
      const studio=document.querySelector(".studio");
      return {wave:box(".wave-detail-wrap"),actions:box("#main-player-panel .actions"),
        status:box(".audio-status-row"),tuning:box("#granular-optin-controls"),
        ab:box("#player-loop-controls"),footer:box("footer"),
        diagnosticsVisible:document.querySelector("#runtime-hud").getClientRects().length>0,
        scrollHeight:studio.scrollHeight,clientHeight:studio.clientHeight};
    });
    console.log("MOBILE_DIAGNOSTICS_LAYOUT "+JSON.stringify(mobileDiagnostics));
    assert.equal(mobileDiagnostics.diagnosticsVisible,true,
      "an actionable mobile error can open DSP details");
    assert.ok(mobileDiagnostics.wave.bottom<=mobileDiagnostics.actions.top&&
      mobileDiagnostics.actions.bottom<=mobileDiagnostics.status.top&&
      mobileDiagnostics.status.bottom<=mobileDiagnostics.tuning.top&&
      mobileDiagnostics.ab.bottom<=mobileDiagnostics.footer.top,
      "expanded mobile diagnostics do not overlap the waveform, controls or footer: "+
        JSON.stringify(mobileDiagnostics));
    // Opening optional diagnostics may extend the page; the main player stays
    // viewport-fitted and the expanded details remain ordered and scrollable.
    await mobile.click("#audio-diagnostics-toggle");
    await mobile.evaluate(()=>{
      const status=document.querySelector("#status");
      status.dataset.kind=window.__mobileStatusBefore.kind;
      status.textContent=window.__mobileStatusBefore.text;
    });
    await mobile.waitForFunction(()=>document.querySelector("#audio-diagnostics-toggle")?.hidden,
      {timeout:3500});
    await mobile.setViewport({width:390,height:980,deviceScaleFactor:2,isMobile:true,hasTouch:true});
    await mobile.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>
      requestAnimationFrame(resolve))));
    const tallMobileLayout=await layoutEvidence(mobile,"mobile-tall-touch-loaded");
    assert.ok(tallMobileLayout.waveform.height>=mobileLayout.waveform.height+60,
      "a taller phone viewport gives its extra height to the main waveform: "+
        JSON.stringify({normal:mobileLayout.waveform,tall:tallMobileLayout.waveform}));
    await mobile.click("#settings-open");
    await mobile.waitForFunction(()=>document.querySelector("#settings-dialog")?.open);
    assert.equal(await mobile.$eval("#runtime-hud",e=>e.getClientRects().length),0);
    assert.equal(await mobile.$eval(".model-legacy-fold",el=>el.getClientRects().length),0);
    assert.equal(await mobile.$eval("#main-player-panel",el=>el.getClientRects().length>0),true);
    assert.equal(await mobile.$eval("#settings-dialog #audio-lab",el=>el.getClientRects().length>0),true);
    assert.equal(await mobile.evaluate(()=>document.querySelectorAll("#lab-speed,#lab-pitch").length),0);
    await mobile.screenshot({path:path.join(captureDir,"04-model-mobile.png")});
    await mobile.click("#settings-close");
    assert.deepEqual(errors,[],"no console page exceptions");
  }finally{
    try{
      await cleanupTestProcesses(browser,[server],"visual audit HTTP server");
    }finally{
      rmSync(browserProfile,{recursive:true,force:true});
    }
  }
});
