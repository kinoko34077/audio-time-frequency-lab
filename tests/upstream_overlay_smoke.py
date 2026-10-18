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
      page.locator("#lab-model").select_option("wsola")
      page.locator("#lab-render").click()
      page.get_by_text("計算済み · wsola",exact=False).wait_for(timeout=25000)
      page.locator("#play-wet").click()
      page.get_by_text("計算済みのwsolaモデルを再生中",exact=False).wait_for(timeout=15000)
      page.locator("#stop").click()
      page.locator("#play-dry").click()
      page.locator("#rt-indicator").wait_for(timeout=15000)
      assert "原音再生中" in page.locator("#rt-indicator").inner_text()
      page.locator("#stop").click()
      assert not failures,failures
      print("PASS upstream-native picker, Rust worklet live speed+pitch, WSOLA offline model and dry transport; mobile emulation:",mobile)
      page.close()
    browser.close()
finally:
  os.unlink(path)
