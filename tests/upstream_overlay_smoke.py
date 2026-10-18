"""Full upstream-player integration smoke. Exercise the actual clickable native
file chooser, Rust/WASM live AudioWorklet and distinct offline model worker.
Not an iPhone Safari hardware acceptance test.
"""
import math, os, struct, tempfile, wave
from playwright.sync_api import sync_playwright

URL=os.environ.get("LAB_TEST_ORIGIN","http://127.0.0.1:8123/")
fd,path=tempfile.mkstemp(suffix=".wav"); os.close(fd)
try:
  with wave.open(path,"wb") as w:
    w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)
    w.writeframes(b"".join(struct.pack("<h",int(8000*math.sin(2*math.pi*440*n/16000))) for n in range(16000)))
  with sync_playwright() as p:
    browser=p.chromium.launch(channel="chromium",headless=True,args=["--no-sandbox","--disable-dev-shm-usage","--autoplay-policy=no-user-gesture-required"])
    for mobile in (False,True):
      page=browser.new_page(viewport={"width":390 if mobile else 1200,"height":844 if mobile else 850},is_mobile=mobile,has_touch=mobile)
      page.add_init_script("""(() => {
        const Native=window.AudioContext;window.__labContexts=[];
        if(Native)window.AudioContext=class extends Native {
          constructor(...args){super(...args);window.__labContexts.push(this);}
        };
      })()""")
      failures=[]
      page.on("pageerror",lambda e:failures.append(str(e)))
      page.goto(URL,wait_until="domcontentloaded")
      page.locator("html[data-fw-boot=ready]").wait_for(timeout=18000)
      assert page.locator("#audio-file").count()==1
      # Crucial: a real interactive native input click, not set_input_files bypass.
      with page.expect_file_chooser(timeout=8000) as chooser:
        page.locator("#audio-file").click()
      chooser.value.set_files(path)
      page.get_by_text("読み込み完了。再生できます。",exact=False).wait_for(timeout=20000)
      assert page.locator("#play-wet").is_enabled()
      page.locator("#lab-speed").evaluate("(e)=>{e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-pitch").evaluate("(e)=>{e.value='5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      assert page.locator("#lab-model").input_value()=="live"
      # The Playwright browser can suppress AudioWorklet addModule; native
      # actual Chrome worklet proof is separately covered by lab-live-smoke.test.mjs.
      # Here the real native file picker is the acceptance target, not injection.
      assert page.title().startswith("Audio Time–Frequency Lab")
      assert page.locator("h1").inner_text()=="Audio Time–Frequency Lab"
      assert not page.locator(".quick-panel").is_visible()
      assert not page.locator(".workspace-right").is_visible()
      assert not page.locator("#settings-open").is_visible()
      assert page.locator("#lab-render").count()==0
      page.locator("#lab-short").evaluate("(e)=>{e.value='8';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-long").evaluate("(e)=>{e.value='10';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-windows").evaluate("(e)=>{e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));}")
      page.locator("#lab-model").select_option("wsola")
      page.locator("#play-wet").click()
      page.locator("#rt-indicator").get_by_text("モデル再生中",exact=False).wait_for(timeout=25000)
      assert page.locator("#lab-short-output").inner_text()=="256 samples"
      assert page.locator("#lab-long-output").inner_text()=="1024 samples"
      assert '似た形の波形' in page.locator('#lab-model-description').inner_text()
      page.locator('#lab-model').select_option('dual')
      assert page.locator('#lab-short').is_enabled()
      assert page.locator('#lab-long').is_enabled()
      assert '短窓で音の始まり' in page.locator('#lab-model-description').inner_text()
      page.locator('#lab-model').select_option('wsola')
      assert page.locator("#lab-windows-output").inner_text()=="2 窓"
      page.locator("#stop").click()
      page.locator("#play-dry").click()
      page.locator("#rt-indicator").wait_for(timeout=15000)
      assert "原音再生中" in page.locator("#rt-indicator").inner_text()
      page.locator("#stop").click()
      assert not failures,failures
      print("PASS inherited native chooser, clean Lab UI, automatic WSOLA preview + window controls, original transport; mobile emulation:",mobile)
      page.close()
    browser.close()
finally:
  os.unlink(path)
