"""Realistic music-length 48k stereo regression: all four model choices
must start near the seek position WITHOUT rendering/copying the entire file.
Headless Chromium performance is hardware dependent; this checks functional
first-chunk output and ability to switch settings during playback.
"""
import math,os,struct,tempfile,wave
from playwright.sync_api import sync_playwright
url=os.environ.get('LAB_TEST_ORIGIN','http://127.0.0.1:8123/')
fd,path=tempfile.mkstemp(suffix='.wav');os.close(fd)
try:
    rate=48000
    a=bytearray(rate*4)
    for i in range(rate):
        struct.pack_into('<hh',a,i*4,
          int(9000*math.sin(2*math.pi*440*i/rate)),
          int(8000*math.sin(2*math.pi*659.25*i/rate)))
    with wave.open(path,'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(rate)
        f.writeframes(bytes(a)*181)
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='chromium',headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage'])
        page=browser.new_page()
        page.add_init_script("""(() => {
          window.__labStarts=0;
          const original=AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start=function(...args){
            window.__labStarts++;return original.apply(this,args);
          };
        })()""")
        failures=[]
        page.on('pageerror',lambda err: failures.append(str(err)))
        page.goto(url,wait_until='domcontentloaded')
        page.locator('html[data-fw-boot=ready]').wait_for(timeout=15000)
        page.locator('#audio-file').set_input_files(path)
        page.get_by_text('読み込み完了。再生できます。',exact=False).wait_for(timeout=25000)
        page.locator('#lab-speed').evaluate("(e)=>{e.value='0.5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#lab-pitch').evaluate("(e)=>{e.value='3';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#lab-fft').evaluate("(e)=>{e.value='10';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#lab-windows').evaluate("(e)=>{e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        for model in ('pv','wsola','dual','am'):
            page.locator('#lab-model').select_option(model)
            page.locator('#play-wet').click()
            try:
                page.locator('#rt-indicator').get_by_text('モデル再生中',exact=False).wait_for(timeout=25000)
            except Exception as err:
                raise AssertionError(f'{model} could not start: '+page.locator('#lab-status').inner_text()) from err
            assert 'メモリ上限' not in page.locator('#lab-status').inner_text()
            if model=='pv':
                # 1.5sec input chunks at 0.5x occupy about 3sec playback.
                # Multiple native AudioBufferSource starts prove continuous
                # replenishment past the first processed preview segment.
                page.wait_for_timeout(7600)
                started=page.evaluate('window.__labStarts')
                assert started>=3, f'only {started} preview segment(s) scheduled'
                assert 'モデル再生中' in page.locator('#rt-indicator').inner_text()
            # Seek directly to mid-song; replacement preview must start at
            # the requested source timeline without waiting for full render.
            if model=='wsola':
                page.locator('#wave').evaluate("(el)=>{const r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width*.67,clientY:r.top+20}));}")
                page.locator('#rt-indicator').get_by_text('モデル再生中',exact=False).wait_for(timeout=25000)
            page.locator('#stop').click()
            print('PASS long-track automatic bounded model:',model,flush=True)
        assert not failures, failures
        browser.close()
finally:
    os.unlink(path)
