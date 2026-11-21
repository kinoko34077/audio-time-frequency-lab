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
            speedLabel:box(".player-tune-control:first-child .player-tune-labels > label:first-child"),
            pitchLabel:box(".player-tune-control:nth-child(2) > label"),
            play:box("#play-main"),speed:box("#granular-speed-value"),
            pitch:box("#granular-pitch-value"),
            tune:box("#granular-optin-controls"),
            loop:box("#player-loop-controls"),
            loopOrder:[...document.querySelectorAll(".player-loop-toolbar>*")]
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
        await page.evaluate(()=>{
          const e=document.querySelector("#granular-speed-value");
          e.value="-1.237";e.dispatchEvent(new Event("change",{bubbles:true}));
          const p=document.querySelector("#granular-pitch-value");
          p.value="7.1234";p.dispatchEvent(new Event("change",{bubbles:true}));
        });
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
