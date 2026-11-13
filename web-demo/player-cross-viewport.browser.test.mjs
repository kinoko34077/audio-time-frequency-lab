import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync} from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const WAV=path.resolve("web-demo/test-fixtures/meta-piano-a0-cc0-3s-48khz.wav");
const imageDir=path.resolve("ui-review-screenshots");
const profiles=[
  {name:"compact-320",width:320,height:568,touch:true},
  {name:"android-360",width:360,height:800,touch:true},
  {name:"mobile-390",width:390,height:844,touch:true},
  {name:"android-412",width:412,height:915,touch:true},
  {name:"tablet-768",width:768,height:1024,touch:true},
  {name:"desktop-1280",width:1280,height:900,touch:false}
];

// This is a reproducible viewport/gesture assessment of the same Web app.
// It does not claim hardware, codec, Safari or Android browser-engine parity.
test("real recorded waveform UX across mobile, Android-size, tablet and desktop windows",async()=>{
  mkdirSync(imageDir,{recursive:true});
  const port=18792;
  const server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{
    cwd:path.resolve("_site"),stdio:"ignore"
  });
  let browser;
  try{
    browser=await puppeteer.launch({
      executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",
      headless:true,args:["--no-sandbox","--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required"]
    });
    for(const profile of profiles){
      const page=await browser.newPage(),errors=[];
      page.on("pageerror",error=>errors.push(error.message));
      await page.setViewport({width:profile.width,height:profile.height,
        deviceScaleFactor:profile.touch?2:1,isMobile:profile.touch,
        hasTouch:profile.touch});
      try{
        await page.goto("http://127.0.0.1:"+port+"/",{
          waitUntil:"domcontentloaded",timeout:20000
        });
        await page.waitForFunction(()=>document.documentElement.dataset.fwBoot==="ready",
          {timeout:20000});
        await (await page.$("#audio-file")).uploadFile(WAV);
        await page.waitForFunction(()=>document.querySelector("#file-meta")?.textContent
          .includes("meta-piano-a0-cc0-3s-48khz.wav"),{timeout:20000});
        await page.waitForSelector("#play-main:not([disabled])",{timeout:12000});
        const geometry=await page.evaluate(()=>{
          const box=q=>{
            const element=document.querySelector(q);
            const r=element.getBoundingClientRect();
            return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
              width:r.width,height:r.height};
          };
          return {width:innerWidth,height:innerHeight,
            scrollWidth:document.documentElement.scrollWidth,
            wave:box(".wave-detail-wrap"),head:box(".wave-center-head"),
            play:box("#play-main"),speed:box("#granular-speed-value"),
            pitch:box("#granular-pitch-value"),tabs:box(".main-workspace-tabs")};
        });
        console.log("VIEWPORT_GEOMETRY "+profile.name+" "+JSON.stringify(geometry));
        assert.ok(geometry.scrollWidth<=geometry.width+2,
          "no full-page sideways scroll on "+profile.name);
        assert.ok(geometry.wave.width>=260&&geometry.wave.height>=150,
          "waveform must be operable on "+profile.name);
        assert.ok(geometry.play.height>=40,
          "main play target must be touch accessible on "+profile.name);
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
        await tab("#main-tab-model");
        await page.waitForFunction(()=>document.body.dataset.mainTab==="model");
        assert.equal(await page.$eval(".model-extra-controls",el=>el.open),false,
          "research is opt-in even on narrow Android-size windows");
        assert.equal(await page.$eval(".model-legacy-fold",el=>el.open),false);
        const modelWidth=await page.evaluate(()=>({
          client:innerWidth,scroll:document.documentElement.scrollWidth
        }));
        assert.ok(modelWidth.scroll<=modelWidth.client+2,
          "model tab cannot overflow on "+profile.name);
        await page.screenshot({path:path.join(imageDir,
          "responsive-"+profile.name+"-model.png"),fullPage:true});
        await tab("#main-tab-player");
        await page.waitForFunction(()=>document.body.dataset.mainTab==="player");
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
          ...profile,hitTargets,tabPersistence:true,
          screenshots:["player","model"],browserEngine:"Chromium",
          hardwareVerified:false
        }));
      }finally{await page.close();}
    }
  }finally{await browser?.close();server.kill("SIGTERM");}
});
