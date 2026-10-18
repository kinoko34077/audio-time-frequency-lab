# Audio Time–Frequency Lab

Browser-based offline audio audition laboratory for independently controlled time stretching and pitch shifting, comparing signal models on the same uploaded WAV/MP3 (browser decode supported formats).

## Scope
- Import via file picker or drag/drop, decode locally, transport/seeking, independent speed and pitch, switch/select model, A/B with matched conditions, optional export WAV.
- DSP candidates: phase vocoder, WSOLA/granular alignment, onset-aware hybrid, and modulation/partial-track experimental model (each must be genuinely distinct, documented, and tested). Original/bypass baseline.
- Respect waveform/phase and preserve stereo where possible; display limitations, latency, CPU/memory constraints, reconstruction quality, failure fallback.
- Audio never uploaded to external server. Static browser page, no paid provider. Browser/offline computation first.
- Reuse proven audio-import / transport / UX patterns from frequency-warp-vst; keep frequency-axis warp and time/pitch model ownership separate. No need to fork the entire VST3 tree.
- No claims that physically different generators can be uniquely inferred when they produce identical waveforms.
## Development authority
Follow kinoko34077/devflow/AGENTS.md, this repository's docs/SPECIFICATION.md and owning Issues. Run tests, PR review and branch-based changes. No production publication/credential change without authorization.
