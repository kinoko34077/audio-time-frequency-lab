"""Optional real browser E2E. Requires Playwright Python and Chromium (no remote services).
Usage: python3 -m http.server 8123  # from repository root
       python3 tests/browser_smoke.py
This exercises a real localhost module-worker path; do not label PASS without running.
"""
import math
import os
import pathlib
import struct
import tempfile
import wave
from playwright.sync_api import sync_playwright

ORIGIN = os.environ.get('LAB_TEST_ORIGIN', 'http://127.0.0.1:8123/')
here = pathlib.Path(__file__).resolve().parents[1]
fd, path = tempfile.mkstemp(suffix='.wav')
os.close(fd)
try:
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        samples = (struct.pack('<h', int(8000 * math.sin(2*math.pi*440*n/16000))) for n in range(16000))
        w.writeframes(b''.join(samples))
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page(accept_downloads=True)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(ORIGIN, wait_until='domcontentloaded')
        page.locator('#file').set_input_files(path)
        page.get_by_text('原音を再生できます。', exact=False).wait_for(timeout=12000)
        page.locator('#speedNumber').fill('1.50')
        page.locator('#speedNumber').dispatch_event('change')
        assert float(page.locator('#speed').input_value()) == 1.5
        page.locator('#pitchNumber').fill('12')
        page.locator('#pitchNumber').dispatch_event('change')
        assert float(page.locator('#pitch').input_value()) == 12
        page.locator('#render').click()
        page.get_by_text('加工音が完成しました。', exact=False).wait_for(timeout=30000)
        assert page.locator('#processed').is_enabled()
        page.locator('#play').click()
        page.wait_for_timeout(220)
        page.locator('#original').click()
        page.locator('#processed').click()
        page.locator('#stop').click()
        with page.expect_download(timeout=12000) as download:
            page.locator('#download').click()
        assert download.value.suggested_filename.endswith('.wav')
        assert not errors, errors
        print('PASS: browser decode → module Worker DSP → independent controls → A/B → WAV export')
        browser.close()
finally:
    os.unlink(path)
