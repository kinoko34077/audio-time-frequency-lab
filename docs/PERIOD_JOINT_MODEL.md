# 「周波数ごとの個別波長」— public experimental multi-partial model

Current implementation scope: **publicly auditionable research mode**, independent of legacy Rust/PV/WSOLA/dual/AM engine. This is not a claim of exact physical source attribution or perceptual transparency.

## UX contract
- Checkbox exactly 「周波数ごとの個別波長」, OFF by default; no change to the original selected engine when OFF.
- ON: independent \`period-joint\` implementation, whose tone parameters are estimated from seven frequency-dependent K=8-period windows for each candidate, with common unknown frequencies, channel amplitude and phase. DO NOT mix independently reconstructed short and long windows.
- Process mono/stereo and multiple simultaneous notes, AM/FM, noise, attacks and voice/music inputs with a preserved **residual branch** rather than throwing an unsupported-source error. This means the input is processed, not that every modulation source is correctly identified.
- The user retains original playback as an independent reference if a genuine DSP execution failure occurs. Status does not falsely say the input was physically separated.

## Shared model and residual path
- For each candidate k: T(f_k,K)=K/f_k; seven Hann observations constrain the **same** global f_k and coefficients a_ck,b_ck across all windows. Integer reference n=floor(f+.5) remains a separate theoretical indexing rule. G_c(t)=sum_k a_ck cos(2πf_k t)+b_ck sin(2πf_k t)+r_c(t).
- FFT peaks at three points are **candidate initialization only**; iterative residual conditional block-refit resolves at most six shared stationary partials (bounded browser work). No individual window's inverse audio is mixed.
- The residual r_c(t) is the actual PCM minus the fitted shared partial sum, preserving unmatched sidebands, voice, noise and onset information. It undergoes existing anti-aliased resampling + PV stretch with independent speed and pitch, then combines with the pitch-mapped partials as **different physical model components**, not crossfading short/long window outputs.
- Different windows reuse samples; independent physical information is NOT manufactured. AM versus independent sidebands can have the same PCM: grouping remains explicitly ambiguous. Residual processing is an engineering fallback, not general AM inference.
- Exact neutral speed=1, pitch=0 preserves the input PCM sample-for-sample even though analysis runs. Transformed duration round(N/s), tonal f_out=p*f, p=2^(semitones/12). Source-absolute phase anchors each stationary oscillator during preview chunk crops. Residual PV may have audible seams/time smearing; time-variable trajectories are not yet optimally estimated.
- Candidate input frequencies initially target 45Hz–min(7500Hz,.44*Fs), six partials and seven observation windows per segment. Energy outside this tonal model remains in the residual rather than being discarded. The original fixed single-tone P1 estimator remains as \`renderPeriodJointTone\` for isolated deterministic research validation only; actual UI dispatch uses \`renderJointAudio\`.

## Test gates and limitations
- Verified by automated synthetic tests: integer/prime/coprime/fractional period math, single tone, additive polyphony, AM with equivalent sidebands, stereo antiphase, impulse/noise preservation, speed and pitch, neutral and chunk seam; Browser+Rust/WASM and native Pages staging.
- Follow-up scientific requirements not claimed complete: joint time-varying trajectories, true onset/offset unknowns, adaptive K, harmonic/AM grouping hypothesis selection with ambiguity confidence, accurate residual time/pitch treatment, multiple recording objective comparison with CQT/NSGT/STFT, noise stability and per-device CPU/acoustic acceptance.
- Public release is explicitly authorized by user on 2026-10-18, *provided native CI and accurate research-status disclosure pass*. Public experimental release does not waive scientific validity claims or alter the unchanged checkbox-OFF models. No user audio uploads, remote access, credentials or paid providers.

## Close-component and common-timeline phase experiment (Issue #20)

- New 0.25 Hz *search* candidate lattice, with continuous off-grid final frequency refinement and full-length least-squares joint two-tone fit for near 440/441 components. Candidate discovery is gated by improvement over continuously optimized single-tone fit, under CPU/resource limits. Do not label 0.25Hz as quantization.
- Compare 440×4.41=441×4.4 as equal **cycle counts at different source times**, not simultaneous media-clock synchronization. Map all observation phases to a shared time reference with exact f and timestamps; retain distinct tone identities and original sample timeline. For two equal-origin 440/441Hz oscillators, same-time relative phase repeats at 1 second, while original K=8 window terminal coincidence requires 8 seconds. No mandatory long wait.
- This is a bounded stationary close-pair hypothesis; moving frequency trajectories, attacks and residual PV chunk changes still need independent audible/CPU acceptance. Gate release on additional frequency/phase/chunk test and native Chromium/Pages CI.
