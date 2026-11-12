# Real-recording test fixture — Audio Lab #36

This directory contains one **actual recorded upright-piano note**, not a synthesized waveform: `meta-piano-a0-cc0-3s-48khz.wav`.

- **Authoritative previous owner:** [frequency-warp-vst original fixture provenance](https://github.com/kinoko34077/frequency-warp-vst/blob/main/web-demo/test-fixtures/TEST_AUDIO_SOURCE.md); existing CC0 file and license were verified **before** copying, and the Git blob hash is identical.
- **Upstream recording:** [Meta Open Sound / Meta Piano](https://github.com/facebookincubator/Meta-open-sound/tree/main/systems/instruments/meta-piano), original `ogg/INSPiano_Vel01_A0_01.ogg`, professionally recorded felt-damped upright piano A0, original file SHA-256 `83194f023294242361ad1b49287ff971de1fa4f762414b23743170084227d7e0`.
- **License:** CC0 1.0 Universal; full legal text and original reuse rationale in the Frequency Warp owner's `META-OPEN-SOUND-CC0-LICENSE.txt` and [Meta Piano license](https://github.com/facebookincubator/Meta-open-sound). No attribution required by CC0; retained here for traceability.
- **Exact conversion used previously:** `ffmpeg -i INSPiano_Vel01_A0_01.ogg -t 3 -ac 1 -ar 48000 -c:a pcm_s16le meta-piano-a0-cc0-3s-48khz.wav`.
- **Copied recording:** 3.000 s; PCM16; mono; 48,000 samples/s. SHA-256 `69bbdab7ee718e174a23850f5525ff87761ca904a4445e6ae9138ca42b7dd261`.
- **Tests:** `web-demo/source-recorded-quality.test.mjs` renders this input through actual raw and experimental granular engines, and `web-demo/source-recorded-player.browser.test.mjs` uses native Chrome's actual file input→AudioWorklet route. Standard previous synthetic/stereo tests are kept as structural oracle, **not** recorded-material evidence.

This test-only recording is **never copied to the public Pages artifact**: the existing `stage-pages.mjs` publishes only the actual browser dependency graph. The fixture covers natural instrument attack/decay/harmonics, **not** voice, multi-instrument stereo, every pitch/velocity, natural gaplessness, DAC latency, real-time CPU/GC, nor physical iPhone Safari. Record failures as findings rather than falsely completing R2/R3.
