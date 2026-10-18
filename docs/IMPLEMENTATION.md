# Offline audio model audition — implementation notes

## Run
Serve over HTTP for ES modules and Module Worker:
```sh
python3 -m http.server 8000
# open http://localhost:8000
node --test tests/*.test.mjs
```

Import any browser-supported WAV/MP3/etc. File size <=75 MiB and duration <=600 seconds. The file is decoded with WebAudio and never uploaded. Processing is performed offline in a local Module Worker; results preview and export as PCM 16-bit WAV. No external dependencies or paid APIs. GitHub Pages is NOT deployed as part of this branch.

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
