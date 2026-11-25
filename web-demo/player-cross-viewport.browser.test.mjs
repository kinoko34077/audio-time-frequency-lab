import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync} from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "./test-process-cleanup.mjs";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const imageDir=path.resolve(process.env.AUDIO_LAB_REVIEW_DIR||"ui-review-screenshots");
const siteRoot=path.resolve(process.env.AUDIO_LAB_TEST_SITE||"_site");
const profiles=[
  {name:"compact-320",width:320,height:568,touch:true},
  {name:"iphone-pwa-393x853",width:393,height:853,touch:true,dpr:1.5},
  {name:"android-360",width:360,height:800,touch:true},
  {name:"mobile-390",width:390,height:844,touch:true},
  {name:"android-412",width:412,height:915,touch:true},
  {name:"tablet-768",width:768,height:1024,touch:true},
  {name:"desktop-1280",width:1280,height:900,touch:false}
];

async function waveformEdgePixels(page,edge){
  return page.$eval("#wave-detail",(canvas,edge)=>{
    const {data}=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    const half=Math.floor(canvas.width/2),height=canvas.height;
    const count=(start,end)=>{
      let total=0;
      for(let x=Math.max(0,start);x<Math.min(canvas.width,end);x++)
        for(let y=0;y<height;y++){
          const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
          if(g>150&&g>r*1.25&&b>r*1.1)total++;
        }
      return total;
    };
    return edge==="start"?{
      outside:count(0,half-2),source:count(half+2,half+82)
    }:{outside:count(half+2,canvas.width),source:count(half-82,half-2)};
  },edge);
}

async function waitForWaveformSourcePixels(page,edge){
  await page.waitForFunction(edge=>{
    const canvas=document.querySelector("#wave-detail");
    if(!canvas?.width||!canvas.height)return false;
    const {data}=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
    const half=Math.floor(canvas.width/2),height=canvas.height;
    const from=edge==="start"?half+2:half-82;
    const to=edge==="start"?half+82:half-2;
    for(let x=Math.max(0,from);x<Math.min(canvas.width,to);x++)
      for(let y=0;y<height;y++){
        const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
        if(g>150&&g>r*1.25&&b>r*1.1)return true;
      }
    return false;
  },{timeout:15000},edge);
}

// This is a reproducible viewport/gesture assessment of the same Web app.
// It does not claim hardware, codec, Safari or Android browser-engine parity.
test("real recorded waveform UX across mobile, Android-size, tablet and desktop windows",{
  timeout:120000
},async()=>{
  mkdirSync(imageDir,{recursive:true});
  const port=18792;
  const python=process.env.PYTHON_EXECUTABLE||"python3";
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:siteRoot,stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    });
    for(const profile of profiles){
      const page=await browser.newPage(),errors=[],consoleErrors=[],requestFailures=[];
      page.on("pageerror",error=>errors.push(error.message));
      page.on("console",message=>{
        if(message.type()==="error")consoleErrors.push(message.text());
      });
      page.on("requestfailed",request=>requestFailures.push({url:request.url(),
        error:request.failure()?.errorText}));
      await page.setViewport({width:profile.width,height:profile.height,
        deviceScaleFactor:profile.dpr??(profile.touch?2:1),isMobile:profile.touch,
        hasTouch:profile.touch});
      try{
        await page.goto("http://127.0.0.1:"+port+"/",{
          waitUntil:"domcontentloaded",timeout:20000
        });
        await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
          {timeout:20000}).catch(async error=>{
            const state=await page.evaluate(()=>({url:location.href,
              readyState:document.readyState,boot:document.documentElement.dataset.fwBoot,
              body:document.body.innerText.slice(0,240),
              scripts:[...document.scripts].map(script=>script.src)})).catch(()=>null);
            throw new Error(`${profile.name} player boot did not become ready: `+
              JSON.stringify({state,errors,consoleErrors,requestFailures,
                cause:error.message}));
          });
        await (await page.$("#audio-file")).uploadFile(WAV);
        await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
          .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
        await page.waitForSelector("#play-main:not([disabled])",{timeout:12000});
        if(profile.name==="iphone-pwa-393x853"){
          await page.waitForFunction(()=>{
            const canvas=document.querySelector("#wave-detail");
            if(!canvas?.width||!canvas.height)return false;
            const {data}=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
            const half=Math.floor(canvas.width/2);
            for(let y=0;y<canvas.height;y++)for(let x=half+2;x<half+82;x++){
              const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];
              if(g>150&&g>r*1.25&&b>r*1.1)return true;
            }
            return false;
          },{timeout:15000});
          const startEdge=await waveformEdgePixels(page,"start");
          assert.equal(startEdge.outside,0,
            "source-start blank time stays empty in the real canvas: "+JSON.stringify(startEdge));
          assert.ok(startEdge.source>0,"recorded PCM is drawn after source time zero");
          await page.focus("#wave-detail");
          await page.keyboard.press("End");
          await page.waitForFunction(()=>{
            const canvas=document.querySelector("#wave-detail");
            return Number(canvas?.getAttribute("aria-valuenow"))>=
              Number(canvas?.getAttribute("aria-valuemax"))-1;
          },{timeout:5000});
          await waitForWaveformSourcePixels(page,"end");
          const endEdge=await waveformEdgePixels(page,"end");
          assert.equal(endEdge.outside,0,
            "source-end blank time stays empty in the real canvas: "+JSON.stringify(endEdge));
          assert.ok(endEdge.source>0,"recorded PCM remains drawn before source end");
        }
        const geometry=await page.evaluate(()=>{
          const box=q=>{
            const element=document.querySelector(q);
            const r=element.getBoundingClientRect();
            return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
              width:r.width,height:r.height};
          };
          const studio=document.querySelector(".studio");
          return {width:innerWidth,height:innerHeight,
            scrollWidth:document.documentElement.scrollWidth,
            wave:box(".wave-detail-wrap"),waveEditor:box(".wave-editor"),
            waveOverview:box(".wave-editor .wave-wrap"),head:box(".wave-center-head"),
            zoom:box(".wave-zoom-actions"),sourcePicker:box(".source-picker"),
            rulerLabelsCoveredByZoom:(()=>{
              const zoom=document.querySelector(".wave-zoom-actions").getBoundingClientRect();
              return [...document.querySelectorAll(".wave-detail-ruler [data-ruler-tick]")]
                .filter(element=>element.textContent.trim())
                .filter(element=>{
                  const tick=element.getBoundingClientRect();
                  return tick.left<zoom.right&&tick.right>zoom.left&&
                    tick.top<zoom.bottom&&tick.bottom>zoom.top;
                }).map(element=>element.textContent.trim());
            })(),
            markerBadgesCoveredByZoom:(()=>{
              const zoom=document.querySelector(".wave-zoom-actions").getBoundingClientRect();
              return [...document.querySelectorAll(".wave-marker:not([hidden])")]
                .filter(element=>element.getClientRects().length)
                .filter(element=>{
                  const marker=element.getBoundingClientRect();
                  return marker.left<zoom.right&&marker.right>zoom.left&&
                    marker.top<zoom.bottom&&marker.bottom>zoom.top;
                }).map(element=>element.textContent.trim());
            })(),
            sourceButton:box(".source-picker-button"),
            sourcePickerBorderWidth:parseFloat(getComputedStyle(
              document.querySelector("#drop")).borderTopWidth),
            settings:box("#settings-open"),speedSlider:box("#granular-speed"),
            pitchSlider:box("#granular-pitch"),
            sliderEndsAligned:Math.abs(box("#granular-speed").right-
              box("#granular-pitch").right)<=1,
            sliderStartsAligned:Math.abs(box("#granular-speed").left-
              box("#granular-pitch").left)<=1,
            plusMark:(()=>{
              const icon=document.querySelector(".source-picker-button>svg");
              const stroke=icon?.querySelector("path");
              return Boolean(icon&&stroke&&icon.getBoundingClientRect().width>=18&&
                getComputedStyle(icon).visibility!=="hidden"&&
                getComputedStyle(stroke).stroke!=="none");
            })(),
            speedLabel:box("#granular-speed-label"),
            pitchLabel:box(".player-tune-control:nth-child(2) > label"),
            play:box("#play-main"),speed:box("#granular-speed-value"),
            pitch:box("#granular-pitch-value"),
            tune:box("#granular-optin-controls"),
            loop:box("#player-loop-controls"),
            loopOrder:[...document.querySelectorAll(".player-loop-toolbar>*")]
              .filter(element=>!element.hidden)
              .map(element=>element.id),
            footer:box(".below-workspace footer"),
            studio:{scrollHeight:studio.scrollHeight,clientHeight:studio.clientHeight},
            stopVisible:document.querySelector("#stop").getClientRects().length>0,
            dryVisible:document.querySelector("#play-dry").getClientRects().length>0};
        });
        console.log("VIEWPORT_GEOMETRY "+profile.name+" "+JSON.stringify(geometry));
        assert.ok(geometry.scrollWidth<=geometry.width+2,
          "no full-page sideways scroll on "+profile.name);
        assert.ok(geometry.wave.width>=260&&geometry.wave.height>=150,
          "waveform must be operable on "+profile.name);
        assert.ok(Math.abs(geometry.waveEditor.bottom-geometry.waveOverview.bottom)<=5,
          "wave editor must not leave an empty band after the overview on "+profile.name+": "+
            JSON.stringify({waveEditor:geometry.waveEditor,waveOverview:geometry.waveOverview}));
        assert.ok(geometry.zoom.left>=geometry.wave.left&&
          geometry.zoom.right<=geometry.wave.right&&
          geometry.zoom.top>=geometry.wave.top&&
          geometry.zoom.bottom<=geometry.wave.bottom,
          "zoom controls must stay inside the waveform frame: "+
            JSON.stringify({wave:geometry.wave,zoom:geometry.zoom}));
        assert.deepEqual(geometry.rulerLabelsCoveredByZoom,[],
          "time labels must stay readable beside the in-frame zoom controls: "+
            JSON.stringify({zoom:geometry.zoom,
              labels:geometry.rulerLabelsCoveredByZoom}));
        assert.deepEqual(geometry.markerBadgesCoveredByZoom,[],
          "A/B badges must stay readable beside the in-frame zoom controls: "+
            JSON.stringify({zoom:geometry.zoom,
              markers:geometry.markerBadgesCoveredByZoom}));
        assert.ok(geometry.sourcePicker.left<geometry.settings.left,
          "the plus file picker belongs at the left of the settings gear");
        assert.ok(geometry.sourcePickerBorderWidth<=0.5,
          "the compact source control has no oversized enclosing frame: "+
            geometry.sourcePickerBorderWidth);
        assert.equal(geometry.plusMark,true,"file selection has a visible plus affordance");
        assert.equal(geometry.sourceButton.width,profile.width<600?40:42,
          "the plus affordance stays compact at the header edge");
        assert.equal(geometry.stopVisible,false,"the separate Stop button is removed");
        assert.equal(geometry.dryVisible,false,"the original-audio button is removed");
        assert.deepEqual(geometry.loopOrder,["player-marker-toggle","player-loop-a-now",
          "player-loop-toggle","player-loop-b-now"],
          "A/B controls follow the reference order below speed and pitch");
        assert.equal(geometry.sliderEndsAligned,true,
          "speed and pitch rails share one right edge regardless of their units");
        assert.equal(geometry.sliderStartsAligned,true,
          "speed and pitch rails share one left edge below their labels");
        assert.ok(geometry.wave.bottom<=geometry.play.top,
          "waveform must not cover playback controls on "+profile.name+": "+
            JSON.stringify({wave:geometry.wave,play:geometry.play}));
        assert.ok(geometry.play.height>=40,
          "main play target must be touch accessible on "+profile.name);
        for(const [label,control,slider,heading] of [
          ["speed",geometry.speed,geometry.speedSlider,geometry.speedLabel],
          ["pitch",geometry.pitch,geometry.pitchSlider,geometry.pitchLabel]]){
          const centers=[control,slider,heading].map(box=>(box.top+box.bottom)/2);
          assert.ok(Math.max(...centers)-Math.min(...centers)<=4,
            label+" heading, rail and inline value must share one row: "+
              JSON.stringify({control,slider,heading}));
        }
        if(profile.name==="compact-320")
          assert.ok(geometry.play.bottom<=geometry.height-4,
            "compact phone must reveal the main Play button without scrolling: "+
            JSON.stringify(geometry.play));
        if(profile.name==="iphone-pwa-393x853"){
          assert.equal(geometry.width,393,"PWA viewport width matches the supplied phone ratio");
          assert.equal(geometry.height,853,"PWA viewport height matches the supplied phone ratio");
          assert.ok(geometry.loop.top>=geometry.tune.bottom,
            "A/B actions must remain below speed and pitch controls: "+
              JSON.stringify({loop:geometry.loop,tune:geometry.tune}));
          assert.ok(geometry.footer.bottom<=geometry.height-4,
            "the PWA footer must fit inside the short phone viewport: "+
              JSON.stringify({footer:geometry.footer,height:geometry.height,
                wave:geometry.wave}));
          assert.ok(geometry.studio.scrollHeight<=geometry.studio.clientHeight+1,
            "the short phone player must not hide its footer in internal vertical overflow: "+
              JSON.stringify(geometry.studio));
        }
        assert.ok(geometry.wave.top<geometry.play.top&&
          geometry.play.top<geometry.speed.top&&
          geometry.speed.top<geometry.pitch.bottom,
          "playback controls must follow waveform on "+profile.name);
        const hitTargets={};
        for(const [label,selector] of [
          ["play","#play-main"],["speed","#granular-speed-value"],
          ["pitch","#granular-pitch-value"]]){
          await page.$eval(selector,el=>el.scrollIntoView({block:"center"}));
          hitTargets[label]=await page.$eval(selector,el=>{
            const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
            const hit=document.elementFromPoint(x,y);
            return {targetId:hit?.id||null,canHit:hit===el||el.contains(hit)};
          });
          assert.ok(hitTargets[label].canHit,
            label+" is covered by another surface on "+profile.name+": "+
            JSON.stringify(hitTargets[label]));
        }
        // Check the actual full inline group and the native slider hit area,
        // not merely the centers of the input and aligned slider endpoints.
        const tuningGeometry=()=>page.evaluate(()=>["speed","pitch"].map(kind=>{
          const rail=document.querySelector("#granular-"+kind);
          const input=document.querySelector("#granular-"+kind+"-value");
          const group=input.closest(".inline-number");
          const r=rail.getBoundingClientRect(),i=input.getBoundingClientRect();
          const g=group.getBoundingClientRect(),u=group.querySelector(".player-tune-unit").getBoundingClientRect();
          const row=rail.closest(".player-tune-control").getBoundingClientRect();
          const x=r.right-2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
          return {kind,left:r.left,right:r.right,width:r.width,inputLeft:i.left,
            inputRight:i.right,groupLeft:g.left,groupRight:g.right,unitLeft:u.left,
            unitRight:u.right,rowRight:row.right,railHit:hit===rail};
        }));
        const baselineTuning=await tuningGeometry();
        const tuningSamples=[];
        for(const [speed,pitch] of [["8","12"],["-8","-12"],
          ["-0.001","-0.001"],["1.237","7.1234"],["-1.237","7.1234"]]){
          await page.evaluate(([speed,pitch])=>{
            const e=document.querySelector("#granular-speed-value");
            e.value=speed;e.dispatchEvent(new Event("change",{bubbles:true}));
            const p=document.querySelector("#granular-pitch-value");
            p.value=pitch;p.dispatchEvent(new Event("change",{bubbles:true}));
          },[speed,pitch]);
          tuningSamples.push(await tuningGeometry());
        }
        for(const pair of [baselineTuning,...tuningSamples])
          for(const [index,g] of pair.entries()){
            assert.ok(g.width>=24&&g.right+3<=g.groupLeft&&
              g.groupLeft<=g.inputLeft+.25&&g.inputRight<=g.unitLeft+.25&&
              g.unitRight<=g.groupRight+.25&&g.groupRight<=g.rowRight+.25,
              "rail, numeric input and unit must have disjoint in-row boxes on "+
                profile.name+": "+JSON.stringify(g));
            assert.ok(g.railHit,"rail right edge must not be covered by the inline group: "+
              profile.name+" "+JSON.stringify(g));
            assert.ok(Math.abs(g.left-baselineTuning[index].left)<.25&&
              Math.abs(g.right-baselineTuning[index].right)<.25,
              "digits must not move the rail: "+profile.name+" "+JSON.stringify(g));
          }
        console.log("U03_TUNING_CLEARANCE "+JSON.stringify({profile:profile.name,
          baseline:baselineTuning,precise:tuningSamples.at(-1)}));
        const typedWidths=await page.evaluate(()=>["#granular-speed-value",
          "#granular-pitch-value"].map(selector=>{
          const el=document.querySelector(selector),rect=el.getBoundingClientRect();
          return {value:el.value,width:rect.width};
        }));
        assert.ok(typedWidths.every(input=>input.width<70&&input.width>=input.value.length*6),
          "editable numeric fields grow to their text instead of reserving nine characters: "+
            JSON.stringify(typedWidths));
        assert.equal(await page.evaluate(()=>Math.abs(
          document.querySelector("#granular-speed").getBoundingClientRect().right-
          document.querySelector("#granular-pitch").getBoundingClientRect().right)<=1),true,
          "editing number widths does not push either slider to a different horizontal stop");
        // The normal inline value opens the exact same FW wheel component.
        // Real pointer interaction, signed 4th-place change, cancel and
        // no-op open must preserve the existing canonical value.
        await page.$eval("#granular-speed-value",el=>el.scrollIntoView({block:"center"}));
        await (profile.touch?page.tap("#granular-speed-value"):page.click("#granular-speed-value"));
        await page.waitForSelector("#vr-wheel-overlay:not([hidden])");
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>
          el.querySelectorAll(".vr-wheel-track").length),6);
        await page.click("[data-wheel-done]");
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        await (profile.touch?page.tap("#granular-pitch-value"):page.click("#granular-pitch-value"));
        await page.waitForSelector("#vr-wheel-overlay:not([hidden])");
        await new Promise(resolve=>setTimeout(resolve,80));
        await page.$eval('.vr-wheel-track[data-wheel-place="-4"]',el=>el.focus());
        await page.keyboard.press("ArrowDown");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1235");
        await page.click("button[data-wheel-cancel]");
        await page.waitForFunction(()=>document.querySelector("#vr-wheel-overlay").hidden);
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
        await (profile.touch?page.tap("#granular-pitch-value"):page.click("#granular-pitch-value"));
        await page.waitForSelector("#vr-wheel-overlay:not([hidden])");
        await new Promise(resolve=>setTimeout(resolve,80));
        await page.$eval('.vr-wheel-track[data-wheel-place="-4"]',el=>el.focus());
        await page.keyboard.press("ArrowDown");
        await page.click("[data-wheel-done]");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1235");
        // Direct keyboard editing remains available for exact values beyond
        // a particular wheel display precision; restore the existing fixture.
        await page.focus("#granular-pitch-value");
        await page.keyboard.down("Control");
        try{await page.keyboard.press("a");}finally{await page.keyboard.up("Control");}
        await page.keyboard.type("7.1234");
        await page.keyboard.press("Tab");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>el.hidden),true);
        // A precise pre-existing value must survive opening the wheel
        // even when its columns need horizontal scrolling on narrow screens.
        await page.evaluate(()=>{
          const p=document.querySelector("#granular-pitch-value");
          p.value="-7.123456789012";p.dispatchEvent(new Event("change",{bubbles:true}));
        });
        await (profile.touch?page.tap("#granular-pitch-value"):page.click("#granular-pitch-value"));
        await page.waitForSelector("#vr-wheel-overlay:not([hidden])");
        const precision=await page.$eval(".vr-wheel-columns",el=>{
          const tracks=[...el.querySelectorAll(".vr-wheel-track")];
          el.scrollLeft=0;const start=el.getBoundingClientRect();
          const first=tracks[0].getBoundingClientRect();
          el.scrollLeft=el.scrollWidth;
          const last=tracks.at(-1).getBoundingClientRect();
          return {columns:tracks.length,firstVisible:first.left>=start.left-.5,
            lastVisible:last.right<=start.right+.5};
        });
        assert.deepEqual(precision,{columns:15,firstVisible:true,lastVisible:true});
        await page.click("[data-wheel-done]");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"-7.123456789012");
        await page.evaluate(()=>{
          const p=document.querySelector("#granular-pitch-value");
          p.value="7.1234";p.dispatchEvent(new Event("change",{bubbles:true}));
        });
        console.log("U04_SHARED_WHEEL "+JSON.stringify({profile:profile.name,
          speed:"-1.237",pitch:"7.1234",cancel:true,commit:true,exactInput:true,precision}));
        // The old visible range select is gone; the speed label and exact
        // value use the same menu as inherited snap controls.
        assert.ok(geometry.speedLabel.width<=34,"range selector must not reserve label width");
        assert.equal(await page.evaluate(()=>document.querySelector("#granular-range")),null);
        await page.click("#granular-speed-label",{button:"right"});
        assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll("#fw-unit-snap-menu button")].map(e=>[e.textContent,e.getAttribute("aria-checked")])),
          [["±1倍","false"],["±2倍","true"],["±4倍","false"],["±8倍","false"]]);
        await page.click("#fw-unit-snap-menu button:nth-child(1)");
        assert.equal(await page.$eval("#granular-speed",el=>el.max),"1");
        assert.equal(await page.$eval("#granular-speed",el=>el.value),"-1");
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        if(profile.touch){
          await page.evaluate(()=>{
            window.__u07MenuTrace=[];
            for(const type of ["pointerdown","pointerup","pointercancel","contextmenu","click"])
              document.addEventListener(type,event=>{
                if(window.__u07MenuTrace.length<32)window.__u07MenuTrace.push({
                  type,target:event.target?.id||event.target?.textContent?.slice(0,30),
                  pointerType:event.pointerType,detail:event.detail,x:event.clientX,y:event.clientY
                });
              },{capture:true});
          });
          await page.$eval("#granular-speed-value",el=>el.scrollIntoView({block:"center"}));
          const point=await page.$eval("#granular-speed-value",el=>{
            const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
          });
          const touch=await page.createCDPSession();
          try{
            await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...point,id:1}]});
            await page.waitForSelector("#fw-unit-snap-menu:not([hidden])",{timeout:2500});
            await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
            await new Promise(resolve=>setTimeout(resolve,80));
          }finally{await touch.detach();}
        }else{
          await page.focus("#granular-speed-value");
          await page.keyboard.down("Shift");await page.keyboard.press("F10");await page.keyboard.up("Shift");
        }
        assert.equal(await page.$eval("#fw-unit-snap-menu",el=>el.hidden),false,
          "hold release must leave menu open: "+JSON.stringify(await page.evaluate(()=>({
            trace:window.__u07MenuTrace,range:document.querySelector("#granular-speed").max
          }))));
        assert.equal(await page.$eval("#vr-wheel-overlay",el=>el.hidden),true,"long hold must not open the tap wheel");
        assert.equal(await page.$eval('#fw-unit-snap-menu [aria-checked="true"]',el=>el.textContent),"±1倍");
        await page.click("#fw-unit-snap-menu button:nth-child(4)");
        assert.equal(await page.$eval("#granular-speed",el=>el.max),"8");
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        await page.click("#granular-speed-label",{button:"right"});
        await page.click("#fw-unit-snap-menu button:nth-child(2)");
        assert.equal(await page.$eval("#granular-speed",el=>el.max),"2");
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
        assert.equal(await page.evaluate(()=>document.querySelectorAll("#fw-unit-snap-menu").length),1);
        console.log("U05_SPEED_RANGE "+JSON.stringify({profile:profile.name,railWidth:geometry.speedSlider.width,
          labelWidth:geometry.speedLabel.width,canonicalSpeed:"-1.237",rangeRestored:2,
          hold:profile.touch,keyboard:!profile.touch,singleton:true}));
        // U06: full stepper fits the former rail cell. The visible buttons
        // have real hit targets and never overlap the native rail or editor.
        const steps=await page.evaluate(()=>["speed","pitch"].map(kind=>{
          const rail=document.querySelector("#granular-"+kind),root=rail.parentElement;
          const minus=root.querySelector('[data-range-step="minus"]');
          const plus=root.querySelector('[data-range-step="plus"]');
          const m=minus.getBoundingClientRect(),p=plus.getBoundingClientRect();
          const r=rail.getBoundingClientRect(),group=root.parentElement.querySelector(".inline-number").getBoundingClientRect();
          const hit=el=>{const b=el.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===el;};
          return {kind,rail:r.width,minus:m.width,plus:p.width,height:Math.min(m.height,p.height),
            disjoint:m.right<=r.left+.25&&r.right<=p.left+.25&&p.right<group.left,
            hit:hit(minus)&&hit(plus)};
        }));
        assert.ok(steps.every(g=>g.minus<=20&&g.plus<=20&&g.height>=28&&g.rail>=64&&g.disjoint&&g.hit),
          "compact endpoint buttons have their own hit targets: "+profile.name+" "+JSON.stringify(steps));
        const stepSelector=(id,side)=>'[data-range-stepper="'+id+'"] [data-range-step="'+side+'"]';
        const tapStep=async(id,side)=>{
          const selector=stepSelector(id,side);
          await (profile.touch?page.tap(selector):page.click(selector));
        };
        const readSpeed=()=>page.$eval("#granular-speed-value",el=>el.value);
        const readPitch=()=>page.$eval("#granular-pitch-value",el=>el.value);
        await tapStep("granular-speed","plus");assert.equal(await readSpeed(),"-1.227");
        await tapStep("granular-speed","minus");assert.equal(await readSpeed(),"-1.237");
        await tapStep("granular-pitch","plus");assert.equal(await readPitch(),"7.2234");
        await tapStep("granular-pitch","minus");assert.equal(await readPitch(),"7.1234");
        await page.focus(stepSelector("granular-speed","plus"));
        await page.keyboard.press("Enter");assert.equal(await readSpeed(),"-1.227");
        await tapStep("granular-speed","minus");assert.equal(await readSpeed(),"-1.237");
        const setSpeed=value=>page.$eval("#granular-speed-value",(el,value)=>{
          el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
        },value);
        await setSpeed("-7.125");
        await tapStep("granular-speed","plus");
        assert.equal(await readSpeed(),"-7.115");
        assert.equal(await page.$eval("#granular-speed",el=>el.value),"-2");
        await setSpeed("-1.237");
        if(profile.name==="iphone-pwa-393x853"||!profile.touch){
          const selector=stepSelector("granular-speed","plus");
          await page.$eval(selector,el=>el.scrollIntoView({block:"center"}));
          const point=await page.$eval(selector,el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
          for(const cancel of [false,true]){
            const touch=profile.touch?await page.createCDPSession():null;
            try{
              if(touch)await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...point,id:1}]});
              else{await page.mouse.move(point.x,point.y);await page.mouse.down();}
              await page.waitForFunction(()=>Number(document.querySelector("#granular-speed-value").value)>=-1.207,
                {timeout:2500});
              if(touch)await touch.send("Input.dispatchTouchEvent",{type:cancel?"touchCancel":"touchEnd",touchPoints:[]});
              else if(cancel){await page.evaluate(()=>window.dispatchEvent(new Event("blur")));await page.mouse.up();}
              else await page.mouse.up();
              const after=await readSpeed();
              await new Promise(resolve=>setTimeout(resolve,220));
              assert.equal(await readSpeed(),after,"release/cancel must stop repeat without an extra step");
              await setSpeed("-1.237");
            }finally{if(touch)await touch.detach();}
          }
        }
        console.log("U06_FINE_STEP "+JSON.stringify({profile:profile.name,geometry:steps,
          exactStep:true,outsideRail:true,keyboard:true,repeatChecked:profile.name==="iphone-pwa-393x853"||!profile.touch}));


        await page.evaluate(()=>{
          document.querySelector(".studio")?.scrollTo(0,0);
          window.scrollTo(0,0);
        });
        await page.screenshot({path:path.join(imageDir,
          "responsive-"+profile.name+"-player.png"),fullPage:true});
        const tab=async selector=>{
          await page.$eval(selector,el=>el.scrollIntoView({block:"center"}));
          const r=await page.$eval(selector,el=>{
            const b=el.getBoundingClientRect();
            return {x:b.x+b.width/2,y:b.y+b.height/2};
          });
          if(profile.touch)await page.touchscreen.tap(r.x,r.y);
          else await page.click(selector);
        };
        await tab("#settings-open");
        await page.waitForFunction(()=>document.querySelector("#settings-dialog")?.open);
        const settingsHeight=await page.$eval("#settings-dialog",el=>
          el.getBoundingClientRect().height);
        assert.ok(settingsHeight<geometry.height*.65,
          "model settings should wrap their contents instead of filling the phone: "+settingsHeight);
        assert.equal(await page.$eval(".model-extra-controls",el=>el.open),false,
          "advanced model controls stay out of the way until requested");
        assert.equal(await page.$eval(".model-legacy-fold",el=>el.getClientRects().length),0);
        assert.equal(await page.$eval("#main-player-panel",el=>el.getClientRects().length>0),true,
          "opening settings preserves the player and its playback position");
        assert.equal(await page.$eval("#settings-dialog #lab-model",el=>el.getClientRects().length>0),true);
        assert.equal(await page.evaluate(()=>document.querySelectorAll("#play-main").length),1,
          "model settings do not duplicate the main transport");
        const modelWidth=await page.evaluate(()=>({
          client:innerWidth,scroll:document.documentElement.scrollWidth
        }));
        assert.ok(modelWidth.scroll<=modelWidth.client+2,
          "model settings cannot overflow on "+profile.name);

        // U14: test the live input path at both digit boundaries, including
        // repeated transitions that previously moved the range under the finger.
        const inertiaGeometry=await page.evaluate(()=>{
          const rail=document.querySelector("#scrub-inertia"),root=rail.parentElement;
          const value=document.querySelector("#scrub-inertia-value");
          const box=el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
          const capture=()=>({value:value.textContent,rail:box(rail),
            minus:box(root.querySelector('[data-range-step="minus"]')),
            plus:box(root.querySelector('[data-range-step="plus"]')),valueBox:box(value),
            valueFits:value.scrollWidth<=value.clientWidth+1});
          const saved=rail.value,samples=[];
          for(const n of [0,10,90,100,90,100,90,100,300,0]){
            rail.value=String(n);rail.dispatchEvent(new Event("input",{bubbles:true}));
            samples.push(capture());
          }
          rail.value=saved;rail.dispatchEvent(new Event("input",{bubbles:true}));
          return samples;
        });
        const stableGeometry=(samples,keys)=>samples.every(sample=>keys.every(key=>
          sample[key].every((v,i)=>Math.abs(v-samples[0][key][i])<=.25)));
        assert.ok(stableGeometry(inertiaGeometry,["rail","minus","plus","valueBox"])&&
          inertiaGeometry.every(s=>s.valueFits&&s.rail[2]>0),
          "digit-count changes must never move either endpoint or either step button: "+
          profile.name+" "+JSON.stringify(inertiaGeometry));
        let dragEvidence=null;
        if(profile.name==="iphone-pwa-393x853"){
          const rail="#scrub-inertia";
          const original=await page.$eval(rail,el=>el.value);
          await page.$eval(rail,el=>{
            el.value="90";el.dispatchEvent(new Event("input",{bubbles:true}));
            el.scrollIntoView({block:"center"});
            window.__u14Drag=[];
            const record=()=>{
              const root=el.parentElement;
              const rect=node=>{const r=node.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
              window.__u14Drag.push({value:Number(el.value),rail:rect(el),
                minus:rect(root.firstElementChild),plus:rect(root.lastElementChild)});
            };
            window.__u14Record=record;record();el.addEventListener("input",record);
          });
          const rect=await page.$eval(rail,el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
          const touch=await page.createCDPSession();
          try{
            const point=fraction=>({x:Math.round(rect.x+rect.w*fraction),y:Math.round(rect.y+rect.h/2),id:1});
            await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point(.31)]});
            for(const fraction of [.26,.36,.29,.40,.25,.42,.30,.39]){
              await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[point(fraction)]});
              await new Promise(resolve=>setTimeout(resolve,45));
            }
            await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
            dragEvidence=await page.evaluate(()=>window.__u14Drag);
            assert.ok(dragEvidence.some(s=>s.value<100)&&dragEvidence.some(s=>s.value>=100)&&
              dragEvidence.length>=3&&stableGeometry(dragEvidence,["rail","minus","plus"]),
              "real touch drag crosses the digit boundary without rail feedback: "+JSON.stringify(dragEvidence));
          }finally{
            await touch.detach();
            await page.$eval(rail,(el,original)=>{
              el.removeEventListener("input",window.__u14Record);
              el.value=original;el.dispatchEvent(new Event("input",{bubbles:true}));
            },original);
          }
        }
        console.log("U14_STABLE_INERTIA "+JSON.stringify({profile:profile.name,
          first:inertiaGeometry[0],last:inertiaGeometry.at(-1),samples:inertiaGeometry.length,
          maxDrift:Math.max(...inertiaGeometry.flatMap(sample=>["rail","minus","plus","valueBox"].flatMap(key=>sample[key].map((v,i)=>Math.abs(v-inertiaGeometry[0][key][i]))))),
          dragValues:dragEvidence?.map(s=>s.value)??null}));
        if(profile.name==="iphone-pwa-393x853"){
          const prior=await page.evaluate(()=>({
            model:document.querySelector("#lab-model").value,
            individual:document.querySelector("#lab-individual-periods").checked,
            sliders:Object.fromEntries(["scrub-inertia","lab-short","lab-long","lab-windows","lab-period-cycles"].map(id=>[id,document.getElementById(id).value]))
          }));
          assert.equal(await page.evaluate(()=>document.querySelectorAll(".range-stepper").length),7);
          const inertiaBefore=Number(prior.sliders["scrub-inertia"]);
          const inertiaSide=inertiaBefore<300?"plus":"minus";
          await tapStep("scrub-inertia",inertiaSide);
          const inertiaAfter=inertiaBefore+(inertiaSide==="plus"?10:-10);
          assert.equal(await page.$eval("#scrub-inertia",el=>Number(el.value)),inertiaAfter);
          assert.equal(await page.$eval("#scrub-inertia-value",el=>el.textContent),inertiaAfter+"%");
          await tapStep("scrub-inertia",inertiaSide==="plus"?"minus":"plus");
          await page.click(".model-extra-controls>summary");
          await page.waitForFunction(()=>document.querySelector(".model-extra-controls").open);
          await page.waitForFunction(()=>document.querySelector('[data-range-stepper="lab-short"] button').disabled);
          await page.select("#lab-model","dual");
          await page.waitForFunction(()=>!document.querySelector('[data-range-stepper="lab-short"] button').disabled);
          // Start from a known adjacent pair so the second short-window step
          // must grow the long window, rather than losing the intended edit.
          await page.evaluate(()=>{
            for(const [id,value] of [["lab-short","9"],["lab-long","11"]])document.getElementById(id).value=value;
            document.getElementById("lab-short").dispatchEvent(new Event("change",{bubbles:true}));
          });
          const stableModelRails=async ids=>page.evaluate(ids=>ids.map(id=>{
            const rail=document.getElementById(id),root=rail.parentElement;
            const read=()=>[rail,root.firstElementChild,root.lastElementChild].map(el=>{
              const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
            }).flat();
            const saved=rail.value,values=[rail.min,rail.max,saved,rail.min,rail.max,saved];
            const samples=values.map(value=>{
              rail.value=value;rail.dispatchEvent(new Event("input",{bubbles:true}));return read();
            });
            return {id,drift:Math.max(...samples.flatMap(row=>row.map((v,i)=>Math.abs(v-samples[0][i]))))};
          }),ids);
          const modelGeometry=await stableModelRails(["lab-short","lab-long","lab-windows"]);
          assert.ok(modelGeometry.every(r=>r.drift<=.25),"advanced rail digit stability: "+JSON.stringify(modelGeometry));
          await tapStep("lab-short","plus");
          assert.equal(await page.$eval("#lab-short-value",el=>el.value),"1024");
          await tapStep("lab-short","plus");
          assert.equal(await page.$eval("#lab-short-value",el=>el.value),"2048");
          assert.equal(await page.$eval("#lab-long-value",el=>el.value),"4096");
          await tapStep("lab-long","plus");
          assert.equal(await page.$eval("#lab-long-value",el=>el.value),"8192");
          assert.equal(await page.$eval('[data-range-stepper="lab-windows"] button',el=>el.disabled),true);
          await page.select("#lab-model","pv");
          await page.$eval("#lab-individual-periods",el=>{el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));});
          await page.waitForFunction(()=>!document.querySelector('[data-range-stepper="lab-period-cycles"] button').disabled&&
            !document.querySelector("#lab-period-cycles-field").hidden);
          const periodGeometry=await stableModelRails(["lab-period-cycles"]);
          assert.ok(periodGeometry.every(r=>r.drift<=.25),"period rail digit stability: "+JSON.stringify(periodGeometry));
          console.log("U14_STABLE_MODEL "+JSON.stringify([...modelGeometry,...periodGeometry]));
          const previousPeriod=await page.$eval("#lab-period-cycles",el=>Number(el.value));
          await tapStep("lab-period-cycles",previousPeriod<5?"plus":"minus");
          assert.equal(await page.$eval("#lab-period-cycles-value",el=>Number(el.value)),2**(previousPeriod+(previousPeriod<5?1:-1)));
          await page.evaluate(prior=>{
            document.getElementById("lab-model").value=prior.model;
            document.getElementById("lab-individual-periods").checked=prior.individual;
            for(const [id,value] of Object.entries(prior.sliders))document.getElementById(id).value=value;
            document.getElementById("lab-model").dispatchEvent(new Event("change",{bubbles:true}));
            document.querySelector(".model-extra-controls").open=false;
          },prior);
          console.log("U06_MODEL_STEP inertia=true short=true long=true period=true disabledWindows=true");
        }
        await page.screenshot({path:path.join(imageDir,
          "responsive-"+profile.name+"-settings.png"),fullPage:true});
        await tab("#settings-close");
        await page.waitForFunction(()=>!document.querySelector("#settings-dialog")?.open);
        assert.equal(await page.$eval("#granular-speed-value",el=>el.value),"-1.237");
        assert.equal(await page.$eval("#granular-pitch-value",el=>el.value),"7.1234");
        // Exercise an actual two-contact gesture for an Android-like window,
        // not only the mobile-mode CSS. No hardware OS is implied.
        if(profile.name==="android-412"){
          await page.$eval("#wave-detail",el=>el.scrollIntoView({block:"center"}));
          const wave=await page.$eval("#wave-detail",el=>{
            const b=el.getBoundingClientRect();
            return {x:b.x,y:b.y,width:b.width,height:b.height};
          });
          const original=await page.$eval("#wave-zoom-label",el=>el.textContent);
          const touch=await page.createCDPSession();
          await touch.send("Emulation.setTouchEmulationEnabled",
            {enabled:true,maxTouchPoints:2});
          const point=(fraction,id)=>({
            id,x:Math.round(wave.x+wave.width*fraction),
            y:Math.round(wave.y+wave.height*.42)
          });
          await touch.send("Input.dispatchTouchEvent",{type:"touchStart",
            touchPoints:[point(.35,1),point(.65,2)]});
          await touch.send("Input.dispatchTouchEvent",{type:"touchMove",
            touchPoints:[point(.18,1),point(.82,2)]});
          await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
          const zoomed=await page.$eval("#wave-zoom-label",el=>el.textContent);
          assert.notEqual(zoomed,original,
            "real two-touch pinch must change waveform zoom on Android-size window");
          await touch.detach();
        }
        assert.deepEqual(errors,[],"no page exceptions on "+profile.name);
        console.log("RESPONSIVE_USER_FLOW "+JSON.stringify({
          ...profile,hitTargets,settingsDialog:true,inlineValueWidths:typedWidths,
          screenshots:["player","settings"],browserEngine:"Chromium",
          hardwareVerified:false
        }));
      }finally{
        await page.evaluate(()=>{
          const dialog=document.querySelector("#settings-dialog");
          if(dialog?.open)dialog.close();
        }).catch(()=>{});
        await page.close();
      }
    }
  }finally{await cleanupTestProcesses(browser,[server],"cross-viewport HTTP server");}
});
