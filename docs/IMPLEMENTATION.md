# Offline audio model audition — implementation notes

## Run
Serve over HTTP for ES modules and Module Worker:
```sh
python3 -m http.server 8000
# open http://localhost:8000
node --test tests/*.test.mjs
```

The published Audio Lab player reads local files progressively. It has no 75 MiB file-size or 600-second duration cap; files above 75 MB show one continue/cancel prompt. Mediabunny is bundled locally under MPL-2.0 to demux supported formats, and the browser's `AudioDecoder` support is checked before the current source is replaced. Playback, seek, scrub and A/B reads request bounded PCM ranges and preempt background waveform reads; the compressed file stays on the device and is not uploaded. Format support depends on the browser's available decoder. The full-file WAV export remains on hold. The existing GitHub Pages deployment serves this player.

## Models actually present
- Phase Vocoder: STFT analysis and bin-phase accumulation with overlap-add. Frequency smearing/metallic artifacts can occur at transients.
- WSOLA: wave similarity grain selection, shared grain positions for stereo. Time-domain clicks or wavering can occur at extreme changes.
- Dual-window onset blend: short (512) / long (2048) STFT phase vocoder outputs, switching weight from short-term RMS onset detection; experimental, not per-partial uniquely identified short/long inversion.\n- AM Envelope × Phase Vocoder: experimental RMS-envelope separation, PV on normalized carrier, reapplication of stretched envelope. This is NOT general partial tracking, perfect AM inference or unique physical source identification. A full jointly optimized, per-partial short/long-window identification model remains unimplemented in this slice.
- A bypass: always original file, independent of speed/pitch settings.

Independent settings: pitch ratio p=2^(semitones/12); first resample to length approximately original/p, then stretch by p/s where s is requested playback speed. Target length approximately original/s. DSP model selector changes real implemented algorithm, not merely a label.

## Limitations / sources
This initial build focuses on the accepted low-cost benchmark and does not establish high-fidelity production quality. Linear interpolation resampling is not bandlimited and can alias; multicomponent polyphonic signals may blur. No verified per-model loudness matching; do not interpret timbre changes as objective superiority. Numeric tests cover steady tones, impulsive stereo and WAV container, not full acoustic quality/real iPhone Safari.
Transport/input/accessibility were newly implemented, following the workflow and user-facing design lessons from kinoko34077/frequency-warp-vst/web-demo, rather than copying unrelated nonlinear frequency-warp Rust/WASM DSP. The original repo is unchanged.

## Research roadmap
See Issue #1 (owner), #2 (DSP), #3 (WEB). Future work: model-independent signal corpus, onset and glissando metrics, multiresolution short/long-window fusion, per-partial common modulation grouping with identifiable model criteria, stronger anti-alias resampling, aligned loudness A/B, browser E2E and user-approved Pages publication.
