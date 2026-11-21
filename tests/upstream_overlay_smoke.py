"""Full upstream-player integration smoke. Exercise the actual clickable native
file chooser, Rust/WASM live AudioWorklet and distinct offline model worker.
Not an iPhone Safari hardware acceptance test.
"""
import atexit, json, math, os, struct, tempfile, wave
from playwright.sync_api import sync_playwright

URL=os.environ.get("LAB_TEST_ORIGIN","http://127.0.0.1:8123/")
fd,path=tempfile.mkstemp(suffix=".wav"); os.close(fd)
expected_name=os.path.basename(path)
try:
  with wave.open(path,"wb") as w:
    w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h",int(8000*math.sin(2*math.pi*440*n/16000))) for n in range(16000)))
  with sync_playwright() as p:
    browser=p.chromium.launch(channel="chromium",headless=True,args=["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required", "--mute-audio"])
    def close_browser():
      try: browser.close()
      except Exception: pass
    atexit.register(close_browser)
    for mobile in (False,True):
      page=browser.new_page(viewport={"width":390 if mobile else 1200,"height":844 if mobile else 850},is_mobile=mobile,has_touch=mobile)
      page.add_init_script("""(() => {
        const Native=window.AudioContext;window.__labContexts=[];
        if(Native)window.AudioContext=class extends Native {
          constructor(...args){super(...args);window.__labContexts.push(this);}
        };
      })()""")
      failures=[]
      console_errors=[]
      failed_requests=[]
      page.on("pageerror",lambda e:failures.append(str(e)))
      page.on("console",lambda msg:console_errors.append(msg.text) if msg.type=="error" else None)
      page.on("requestfailed",lambda request:failed_requests.append({
        "url":request.url,"failure":request.failure
      }))
      legacy_url=URL+("&" if "?" in URL else "?")+"legacyUi=1"
      page.goto(legacy_url,wait_until="domcontentloaded")
      page.locator("html[data-fw-boot=ready]").wait_for(timeout=18000)
      assert page.locator("#audio-file").count()==1
      # Crucial: a real interactive native input click, not set_input_files bypass.
      with page.expect_file_chooser(timeout=8000) as chooser:
        page.locator("#audio-file").click()
      chooser.value.set_files(path)
      # The compatibility route keeps its inherited engine telemetry visible.
      # The public route's compact status and hidden default HUD are verified
      # separately by player-visual.browser.test.mjs.
      try:
        page.wait_for_function("""() => {
          const name=__EXPECTED_FILE_NAME__;
          return Boolean(name&&document.querySelector('#file-meta')?.textContent.includes(name)&&
            !document.querySelector('#play-main')?.disabled);
        }""".replace("__EXPECTED_FILE_NAME__",json.dumps(expected_name)),timeout=20000)
      except Exception as error:
        try:
          state=page.evaluate("""() => {
            const text=selector=>document.querySelector(selector)?.textContent||null;
            const file=document.querySelector('#audio-file')?.files?.[0];
            return {boot:document.documentElement.dataset.fwBoot,
              summary:text('#audio-state-summary'),status:text('#status'),
              statusKind:document.querySelector('#status')?.dataset.kind||null,
              fileMeta:text('#file-meta'),indicator:text('#rt-indicator'),
              file:file?{name:file.name,type:file.type,size:file.size}:null};
          }""")
        except Exception as diagnostic_error:
          state={"diagnostic_error":str(diagnostic_error)}
        print("AUDIO_FILE_READY_DIAGNOSTICS",json.dumps({
          "mobile":mobile,"state":state,"pageErrors":failures,
          "consoleErrors":console_errors,"failedRequests":failed_requests,
          "waitError":str(error)
        },ensure_ascii=False),flush=True)
        close_browser();atexit.unregister(close_browser)
        raise
      # legacyUi=1 deliberately retains the inherited detailed HUD for this
      # compatibility route. The public player route separately verifies
      # that the HUD is hidden after a source loads.
      assert page.locator("#runtime-hud").is_visible()
      assert page.locator("#play-wet").is_enabled()
      # The Audio Time player owns the only editable speed/pitch pair.
      assert page.locator("#lab-speed,#lab-pitch").count()==0
      page.locator("#granular-speed-value").evaluate("(e)=>{e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#granular-pitch-value").evaluate("(e)=>{e.value='5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      assert page.locator("#granular-speed-value").input_value()=="1.5"
      assert page.locator("#granular-pitch-value").input_value()=="5"
      # The actual user-facing default is the selected Phase Vocoder route.
      assert page.locator("#lab-model").input_value()=="pv"
      assert page.locator("#granular-speed").get_attribute("min")=="-2"
      assert page.locator("#granular-speed").get_attribute("max")=="2"
      assert page.locator("#granular-speed-value").get_attribute("min")=="-8"
      assert page.locator("#granular-speed-value").get_attribute("max")=="8"
      assert page.locator("#granular-range").input_value()=="2"
      assert page.locator("#granular-range option[value='8']").count()==1
      # The Playwright browser can suppress AudioWorklet addModule; native
      # actual Chrome worklet proof is separately covered by lab-live-smoke.test.mjs.
      # Here the real native file picker is the acceptance target, not injection.
      assert page.title().startswith("Audio Time–Frequency Lab")
      assert page.locator("h1").inner_text()=="Audio Time–Frequency Lab"
      assert not page.locator(".quick-panel").is_visible()
      assert not page.locator(".workspace-right").is_visible()
      assert page.locator("#settings-open").is_visible()
      assert page.locator("#lab-render").count()==0
      # The model tab is dedicated to model selection. Neither a second
      # waveform/player nor inherited Frequency Warp UI may appear there.
      page.locator("#main-tab-model").click()
      assert page.locator("#audio-lab").is_visible()
      assert not page.locator("#main-player-panel").is_visible()
      assert page.locator(".quick-panel").is_visible()
      assert page.locator(".model-legacy-fold").is_visible()
      assert page.locator("#settings-open").is_visible()
      assert page.locator("#model-transport-host #play-main").is_visible()
      assert page.locator("#granular-speed-value").input_value()=="1.5"
      assert page.locator("#granular-pitch-value").input_value()=="5"
      # Model details are open by default, so clicking the summary would close them.
      assert page.locator(".model-extra-controls").get_attribute("open") is not None
      assert page.locator("#lab-short").is_visible()

      page.locator("#lab-short").evaluate("(e)=>{e.value='8';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-long").evaluate("(e)=>{e.value='10';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-windows").evaluate("(e)=>{e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-model").select_option("wsola")
      # Legacy file-picker regression deliberately uses the period-joint
      # Worker; actual WSOLA AudioWorklet PCM is checked in Chrome separately.
      page.locator('#lab-individual-periods').evaluate(
        "(e)=>{e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));}")
      # Long window is disabled in WSOLA and must not silently constrain short.
      assert page.locator("#lab-long").is_disabled()
      page.locator("#lab-short").evaluate("(e)=>{e.value='11';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      assert page.locator("#lab-short-value").input_value()=="2048"
      assert page.locator("#lab-long-value").input_value()=="1024"
      page.locator("#play-main").click()
      page.wait_for_function("""() => document.querySelector('#rt-indicator')
        ?.textContent.includes('モデル再生中')""",timeout=25000)
      assert page.locator("#audio-state-summary").is_visible()
      assert page.locator("#lab-short-value").input_value()=="2048"
      assert page.locator("#lab-long-value").input_value()=="1024"
      # Model information remains expanded, without a redundant toggle click.
      assert page.locator(".model-info-controls").get_attribute("open") is not None
      assert page.locator("#lab-model-description").is_visible()
      assert '個別波長' in page.locator('#lab-model-description').inner_text()
      page.locator('#lab-model').select_option('dual')
      page.locator('#lab-individual-periods').evaluate(
        "(e)=>{e.checked=false;e.dispatchEvent(new Event('change',{bubbles:true}));}")
      assert page.locator('#lab-short').is_enabled()
      assert page.locator('#lab-long').is_enabled()
      assert '短窓WSOLA' in page.locator('#lab-model-description').inner_text()
      page.locator('#lab-model').select_option('wsola')
      assert page.locator("#lab-windows-output").inner_text()=="2 窓"
      page.locator("#stop").click()
      page.locator("#play-dry").click()
      page.wait_for_function("""() => document.querySelector('#rt-indicator')
        ?.textContent.includes('原音再生中')""",timeout=15000)
      assert "原音再生中" in page.locator("#audio-state-summary").inner_text()
      page.locator("#stop").click()
      assert not failures,failures
      print("PASS native chooser, dedicated Audio Time model/player UI, WSOLA preview + windows, original transport; mobile emulation:",mobile)
      page.close()
    browser.close()
    atexit.unregister(close_browser)
finally:
  os.unlink(path)
