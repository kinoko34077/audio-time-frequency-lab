# 周波数ごとの個別波長 — Issue #20 isolated opt-in experiment

Status: RESEARCH PROTOTYPE. Not production quality, source separation, joint AM/onset/residual inference, or published acceptance.

## Checkbox contract
- Exact Japanese label: 周波数ごとの個別波長. Default OFF. OFF leaves the selected existing DSP unchanged.
- ON routes exclusively to a separate period-joint model, not PV/WSOLA/dual output mixing. Existing model selection resumes on OFF.
- UI must say 試験版：単一定常純音のみ; unsupported inputs explicitly error and leave original audio playable. No silent DSP fallback that pretends the checkbox worked.
- Scope: buffered 0.2–3 seconds, mono/stereo, single stationary sinusoid 80–1600Hz or silence. Model treats amplitude and phase as constant within one chunk. Chunk phase stitching, polyphony, AM/FM, onsets, residual/noise and nonstationary trajectories remain UNIMPLEMENTED.

## Mathematics
- The user's 個別波長 means individual frequency-dependent OBSERVATION DURATION, not the physical propagation wavelength (which depends on sound speed).
- T(f,K)=K/f seconds; integer anchor n=floor(f+0.5) denotes n-0.5 <= f < n+0.5, without quantizing f.
- For integer anchors a,b with common origin, first positive common end boundary = K/gcd(a,b). Never force coprime channels globally synchronized and never equate shared end boundaries to oscillator phase agreement.
- Convert theoretical real-valued boundaries to ceil(Fs*t) indices only for sampling; use continuous-time Hann weights.
- For candidate f and seven different window centers, all windows constrain ONE shared frequency f and per-channel real sinusoidal coefficients (a,b) in x(t)=a cos(2pi f t)+b sin(2pi f t). Fit a,b through weighted 2x2 normal equations minimizing the sum of windowed squared errors. Search f coarse-to-fine. Candidate DISCOVERY may use one short window, but seven-window joint fit determines the final f,a,b. Never mix independent inverse transforms.
- Different windows reuse the same PCM; the observations are correlated and do not create independent physical information. Current explained-energy threshold 0.90 is a guard, NOT a verified polyphony classifier.
- For the stationary case only: output pitch p=2^(semitones/12), f_out=p*f, duration frames = round(source frames/speed). This is the f_in(s*t) law only because f_in is constant. Within-chunk oscillator phase is continuous, global cross-chunk phase is NOT proven.

## Verification and promotion
- P0: gcd / octave / 3x / 5x / coprime / ±0.5Hz and fractional sample boundaries; tests in period-joint.test.mjs.
- P1: 16kHz 1s pure 440.4Hz absolute error under 0.1Hz, explained energy above 97%, duration/speed and pitch/p, finite silence, stereo amplitude/phase. These tests accept only this limited synthetic model.
- P2: multi-component shared latent trajectories f_k(t), a_k(t), phase and onsets with harmonic/AM groups; explicitly compare AM sidebands versus independent tones, score ambiguity and noise.
- P3: transient/nonpitch residual, perceptual safeguards, onset timing, phase across chunks, adaptive K, stereo stability, bounded memory/CPU.
- P4: matched STFT/PV, WSOLA, dual, CQT/NSGT, joint-grid baselines; evaluate reconstruction, frequency/phase error, timing, robustness under noise, CPU/memory, and listening on real devices.
- Do not merge or publish merely because the checkbox exists. Require P2–P4 and review plus target-device proof and user publication authorization. The existing Rust/WASM and production Pages remain untouched.