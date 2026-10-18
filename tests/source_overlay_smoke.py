"""Browser proof that the inherited Frequency Warp page and Time/Pitch Lab coexist.
Invoke with an HTTP server rooted at the STAGED _site directory.
Unlike the old test, opens the actual native chooser from a user click.
No user audio: a deterministic generated one-second WAV only.
"""
import os
import math
import struct
import tempfile
import wave
from playwright.sync_api import sync_playwright

ORIGIN=os.environ.get('LAB_TEST_ORIGIN','http://127.0.0.1:8123/')
fd,path=tempfile.mkstemp(suffix=".wav")
os.close(fd)
try:
    with wave.open(path,"wb") as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h",int(7000*math.sin(2*math.pi*440*i/16000))) for i in range(16000)))
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=["--no-sandbox","--autoplay-policy=no-user-gesture-required"])
        page=browser.new_page(accept_downloads=True,viewport={"width":390,"height":844},device_scale_factor=2,is_mobile=True,has_touch=True)
        errors=[]
        page.on("pageerror",lambda e:errors.append(str(e)))
        page.goto(ORIGIN,wait_until="domcontentloaded")
        page.locator("#drop").wait_for()
        page.locator("#lab-live").wait_for()
        # This truly goes through the user-click chooser path (not set_input_files).
        with page.expect_file_chooser(timeout=15000) as chooser:
            page.locator("#drop").click(position={"x":25,"y":25})
        chooser.value.set_files(path)
        page.get_by_text("読み込み完了。再生できます。",exact=False).wait_for(timeout=20000)
        assert page.locator("#play-dry").is_enabled(), "inherited original playback unavailable"
        assert page.locator("#lab-live").is_enabled(), "overlay did not observe inherited decode"
        # Shared upstream real-time Rust/WASM engine must remain operable.
        page.locator("#play-wet").click()
        page.get_by_text("リアルタイム音声処理中",exact=False).wait_for(timeout=35000)
        page.locator("#stop").click()
        # New realtime Time/Pitch Worklet, independent speed and pitch.
        page.locator("#lab-speed").fill("1.5")
        page.locator("#lab-pitch").fill("7")
        page.locator("#lab-live").click()
        page.get_by_text("LIVE: 全体レンダリングなし",exact=False).wait_for(timeout=20000)
        page.wait_for_timeout(350)
        assert page.evaluate("typeof window.__audioLabSourceTime === 'function'")
        # Same source, full-file offline model stage remains separate.
        page.locator("#lab-stop").click()
        page.locator("#lab-render").click()
        page.get_by_text("オフライン解析完了",exact=False).wait_for(timeout=30000)
        assert page.locator("#lab-processed").is_enabled()
        page.locator("#lab-processed").click()
        with page.expect_download(timeout=10000) as download:
            page.locator("#lab-export").click()
        assert download.value.suggested_filename.endswith(".wav")
        assert not errors, errors
        print("PASS: native chooser → inherited decoder → Rust/WASM stream → live time/pitch Worklet → offline PV model → WAV")
        browser.close()
finally:
    os.unlink(path)
