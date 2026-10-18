# Audio Time–Frequency Lab — Initial specification (2026-10-18)

Status: INITIAL ACCEPTED REQUIREMENTS; implementations / performance and publication not yet verified.

## Objective and accepted inputs
Dedicated research/audition website, not an addition to existing frequency-warp-vst. Upload/drag-drop existing audio (WAV and browser-supported MP3 etc.), preview and compare several *actual implemented* processing models. Speed and pitch controls must be independent. Recordings/offline first; buffering for future real-time is allowed and not a blocker.

## DSP models / hierarchy
B0: original decoded PCM bypass, reference at speed=1 and pitch=0.
M1: phase vocoder (STFT with phase accumulation), preserves approximate spectral pitch during time scale changes.
M2: waveform similarity overlap-add (WSOLA) or comparable granular/synchronous time stretch; no FFT phase estimate, different artifact signature.
M3: hybrid, with short-window onset/transient analysis and long-window pitch/phase trajectory; use explicit onset handling and crossovers; do not label generic M1 as hybrid.
M4: experimental constituent/AM group interpretation (optional late slice): partial trajectories, shared frequency glide, envelope and phase relation, modulation grouping, reconstruction and controlled residual. Modulation is a deterministic *model interpretation*, not claimed physical source identity.
Pitch shift separate from speed: factor p=2^(semitones/12). Resampling changes pitch and duration together; **compensate duration explicitly in stretch stage** so requested speed and pitch are independent. E.g. resample to roughly input_frames/p and stretch resulting signal by p/s (with s=speed output time denominator), yielding duration input_duration/s and pitch factor p. Correct formulas, sample-rate semantics, and channel alignment in code/tests.
Special cases: silence, impulses, harmonics, glissandi, simultaneous notes, AM sidebands, stereo, very short clips and boundaries. Compare reconstruction at neutral settings and non-neutral settings. Avoid inventing physical provenance.
## UI
Drag/drop and file dialog. Clear audio info and processing progress. Play/stop/seek and A/B rapid switch, model name and verified status, speed 0.5–2x + numeric (configurable later), pitch -12–+12 semitones + numeric (configurable later), separate reset, analysis display showing onset estimates and curves only when actually computed, export WAV. No external upload or log of user audio. Safe graceful fallback to original playback if DSP fails; no fake success. Stable layout, mobile controls accessible and keyboard support. No mandatory frequency warp controls in primary comparison interface.
## Metrics and validation
Ground truth synthetic corpus plus representative recordings. Same source/crop/gain/loudness and user parameter settings across models. Accurate output_duration = input_duration/speed within defined edge tolerance; pitch f_out≈f_in*2^(semi/12) for steady sine; no NaN/clipping, channels preserved and export integrity; onset smearing, transient clarity, AM ambiguity, phase continuity, spectral deviation and run time documented per algorithm. Distinguish mathematical reconstruction from unique physical source attribution. Compare vs known reference implementation before release. Manual perceived quality left as qualitative, never pretended objective.
## Architecture and reuse
Static native WebAudio + ESM browser UI; offline AudioBuffer processor in worker when feasible; DSP isolated behind typed contract {id, render(decodedPCM, sampleRate, speed, semitones)->PCM}. Reuse or adapt only actual relevant source/UX from frequency-warp-vst/web-demo with explicit provenance and compatibility tests; no duplicate heavy VST3 build. Common UI/UX may later import kinotch-site-kit, but no blocked dependency.
## Scope boundaries
No microphone/live/streaming required in v1; no source separation guarantee, no claimed uncertainty-principle bypass, no unattended deployment, credentials, paid API or new external data service. No inclusion of user audio in tests/public repository.
## Acceptance
R1 actual repo and parent Issues/control created through devflow native workflow; R2 independently adjustable preview and WAV export; R3 at least two independently implemented DSP models audibly different, B0 plus tests showing time/pitch independence; R4 test metrics; R5 optional advanced hybrid and AM model with objective measurements before labeling implemented; R6 reviewed PR and authorized publish when explicitly approved.
