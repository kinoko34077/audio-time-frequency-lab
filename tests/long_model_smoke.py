"""Realistic music-length 48k stereo regression: all four model choices
must start near the seek position WITHOUT rendering/copying the entire file.
Headless Chromium performance is hardware dependent; this checks functional
first-chunk output and ability to switch settings during playback.
"""
import math,os,struct,tempfile,wave
from playwright.sync_api import sync_playwright
url=os.environ.get('LAB_TEST_ORIGIN','http://127.0.0.1:8123/')
fd,path=tempfile.mkstemp(suffix='.wav');os.close(fd)
expected_name=os.path.basename(path)
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
        browser=p.chromium.launch(channel='chromium',headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage', "--mute-audio"])
        page=browser.new_page()
        page.add_init_script("""(() => {
          window.__labWorkerResults=[];
          window.__labWorkerCounter=0;
          window.__labLatestWorkerId=0;
          const NativeWorker=window.Worker;
          window.Worker=class extends NativeWorker{
            constructor(url,options){
              super(url,options);
              if(!String(url).includes('lab-processor.worker.mjs'))return;
              const id=++window.__labWorkerCounter;
              window.__labLatestWorkerId=id;
              this.addEventListener('message',({data})=>{
                if(!Number.isSafeInteger(data?.job))return;
                window.__labWorkerResults.push({id,job:data.job,
                  generation:data.generation,ok:data.ok===true,
                  startFrame:data.plan?.start,
                  outputFrames:data.channels?.[0]?.length||0,
                  channelCount:data.channels?.length||0});
              });
            }
          };
          window.__labWorkletProgress=[];
          window.__labWorkletCounter=0;
          window.__labLatestSourceWorkletId=0;
          const NativeWorklet=window.AudioWorkletNode;
          window.AudioWorkletNode=class extends NativeWorklet{
            constructor(ctx,name,options){
              super(ctx,name,options);
              const id=++window.__labWorkletCounter;
              if(name!=='audio-lab-source-pcm')return;
              window.__labLatestSourceWorkletId=id;
              this.port.addEventListener('message',({data})=>{
                if(data?.type==='progress'&&data.processingMode==='worker')
                  window.__labWorkletProgress.push({id,
                    sourceFrame:data.sourceFrame,
                    renderedFrames:data.renderedFrames,
                    missingFrames:data.missingFrames,
                    workerGeneration:data.workerGeneration});
              });
            }
          };
        })()""")
        failures=[]
        page.on('pageerror',lambda err: failures.append(str(err)))
        legacy_url=url+('&' if '?' in url else '?')+'legacyUi=1'
        page.goto(legacy_url,wait_until='domcontentloaded')
        page.locator('html[data-fw-boot=ready]').wait_for(timeout=15000)
        page.locator('#audio-file').set_input_files(path)
        page.wait_for_function("""() => {
          const name=__EXPECTED_FILE_NAME__;
          return Boolean(name&&document.querySelector('#file-meta')?.textContent.includes(name)&&
            !document.querySelector('#play-main')?.disabled);
        }""".replace('__EXPECTED_FILE_NAME__',json.dumps(expected_name)),timeout=25000)
        # The player owns the only editable speed/pitch controls. Select
        # models in their dedicated tab, without duplicate field proxies.
        assert page.locator("#lab-speed,#lab-pitch").count()==0
        page.locator('#granular-speed-value').evaluate("(e)=>{e.value='0.5';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#granular-pitch-value').evaluate("(e)=>{e.value='3';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#main-tab-model').click()
        assert page.locator('#audio-lab').is_visible()
        page.locator('#lab-short').evaluate("(e)=>{e.value='8';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#lab-long').evaluate("(e)=>{e.value='10';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        page.locator('#lab-windows').evaluate("(e)=>{e.value='2';e.dispatchEvent(new Event('change',{bubbles:true}));}")
        # The ordinary PV setting now genuinely renders through a
        # source-time AudioWorklet. Keep the older 1.5s PV/period-joint Worker
        # as a separate, explicit regression route.
        page.locator('#lab-model').select_option('pv')
        page.locator('#play-main').click()
        page.wait_for_function("""() => document.querySelector('#rt-telemetry')
          ?.dataset.pcmTransport==='pv-phase-locked'""",timeout=25000)
        page.locator('#stop').click()
        # Ordinary WSOLA is now a real PCM Worklet; its long-reference stereo
        # waveform correlation follows the requested original source clock.
        page.locator('#lab-model').select_option('wsola')
        page.locator('#play-main').click()
        page.wait_for_function("""() => document.querySelector('#rt-telemetry')
          ?.dataset.pcmTransport==='wsola-source-time'""",timeout=25000)
        page.locator('#stop').click()
        # Dual native simultaneously renders short WSOLA transients and
        # long peak-locked PV sustains on the persistent original-source clock.
        page.locator('#lab-model').select_option('dual')
        page.locator('#play-main').click()
        page.wait_for_function("""() => document.querySelector('#rt-telemetry')
          ?.dataset.pcmTransport==='dual-transient-source-time'""",timeout=25000)
        page.locator('#stop').click()
        # Native AM now applies its own RMS envelope correction over PV
        # within the same continuously rendered PCM and source-time transport.
        page.locator('#lab-model').select_option('am')
        page.locator('#play-main').click()
        page.wait_for_function("""() => document.querySelector('#rt-telemetry')
          ?.dataset.pcmTransport==='am-envelope-source-time'""",timeout=25000)
        page.locator('#stop').click()
        # Previous period-joint Worker remains distinct and explicitly limited.
        for model in ('pv','wsola','dual'):
            page.locator('#lab-model').select_option(model)
            page.locator('#lab-individual-periods').evaluate(
                "(e)=>{e.checked="+("true" if model in ("pv","wsola","dual") else "false")+
                ";e.dispatchEvent(new Event('change',{bubbles:true}));}")
            page.locator('#play-main').click()
            try:
                page.wait_for_function("""() => document.querySelector('#rt-indicator')
                  ?.textContent.includes('モデル再生中')""",timeout=25000)
            except Exception as err:
                raise AssertionError(f'{model} could not start: '+page.locator('#lab-status').inner_text()) from err
            assert 'メモリ上限' not in page.locator('#lab-status').inner_text()
            if model=='pv':
                # The shared PCM Worklet owns playback. Verify that multiple
                # actual Worker PCM results reach it and its source-frame
                # clock advances; counting AudioBufferSource.start() would
                # only observe the retired per-segment playback route.
                worker_id,worklet_id=page.evaluate("""() => [
                  window.__labLatestWorkerId,window.__labLatestSourceWorkletId]""")
                page.wait_for_timeout(7600)
                evidence=page.evaluate("""({workerId,workletId})=>{
                  const results=window.__labWorkerResults.filter(x=>
                    x.id===workerId&&x.ok&&x.channelCount===2&&x.outputFrames>0);
                  const progress=window.__labWorkletProgress.filter(x=>
                    x.id===workletId&&x.workerGeneration===results.at(-1)?.generation);
                  return {workerId,workletId,completedChunks:results.length,
                    distinctChunkStarts:new Set(results.map(x=>x.startFrame)).size,
                    outputFrames:results.reduce((sum,x)=>sum+x.outputFrames,0),
                    progressSamples:progress.length,
                    renderedFrames:progress.at(-1)?.renderedFrames||0,
                    missingFrames:progress.at(-1)?.missingFrames||0,
                    sourceStart:progress[0]?.sourceFrame,
                    sourceEnd:progress.at(-1)?.sourceFrame};
                }""",{"workerId":worker_id,"workletId":worklet_id})
                print('LONG_WORKER_PCM_PREVIEW',evidence,flush=True)
                assert evidence['completedChunks']>=3, evidence
                assert evidence['distinctChunkStarts']>=3, evidence
                assert evidence['outputFrames']>0, evidence
                assert evidence['renderedFrames']>0, evidence
                assert evidence['sourceStart'] is not None and evidence['sourceEnd']>evidence['sourceStart'], evidence
                assert 'モデル再生中' in page.locator('#rt-indicator').inner_text()
            # Seek directly to mid-song; replacement preview must start at
            # the requested source timeline without waiting for full render.
            if model=='wsola':
                # A single waveform remains on the player tab; model playback
                # continues across tab navigation, and seek uses that one view.
                page.locator('#main-tab-player').click()
                page.locator('#wave').evaluate("(el)=>{const r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width*.67,clientY:r.top+20}));}")
                page.locator('#main-tab-model').click()
                page.wait_for_function("""() => document.querySelector('#rt-indicator')
                  ?.textContent.includes('モデル再生中')""",timeout=25000)
            page.locator('#stop').click()
            print('PASS long-track automatic bounded model:',model,flush=True)
        assert not failures, failures
        browser.close()
finally:
    os.unlink(path)
