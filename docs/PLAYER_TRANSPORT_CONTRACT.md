# Audio Lab — Source-time transport contract (#36)

Status: R0/R1 implementation boundary, 2026-11-12. The pure source-time mapper is implemented in web-demo/source-timeline.mjs and tested in web-demo/source-timeline.test.mjs. It is NOT connected to the current playback engine, DSP, UI, AudioWorklet, or export. **It does not demonstrate audible negative/zero speed or gapless output.**

## Purpose and priority

Current user request and [Issue #36](https://github.com/kinoko34077/audio-time-frequency-lab/issues/36) supersede the model-comparison-first default UI from the historical initial specification. Preserve the former model research and existing accepted features. Existing owning issues: [#2](https://github.com/kinoko34077/audio-time-frequency-lab/issues/2) DSP/fidelity; [#3](https://github.com/kinoko34077/audio-time-frequency-lab/issues/3) Web transport; [#8](https://github.com/kinoko34077/audio-time-frequency-lab/issues/8) physical iPhone; [#20](https://github.com/kinoko34077/audio-time-frequency-lab/issues/20) research.

## Coordinate and transport invariants

1. Source position and A/B endpoints are measured in **the original decoded PCM sample frames**. Source and output device sample rates may differ. Never confuse source time, scheduled output time, AudioContext time, visual playhead, and audible time.
2. A/B is the ordered, end-exclusive interval [A,B), with integer endpoints 0 <= A < B <= sourceFrames. A one-sample interval is **selectable**. It is not a guarantee that one sample will produce a natural sustained pitch.
3. Canonical playback speed is signed finite Float64 -8..8. Negative = backwards along source time; zero = freeze source time (NOT silent Pause); positive = forwards. Speed rail range is user-configurable to any finite positive maximum up to 8; ±1/±2/±4/±8 are only optional presets. The rail range is presentation-only. They must not erase a previously typed canonical value. Display normally rounds to two decimals; editor exposes original value with at least 0.001 resolution. Never snap typed values silently.
4. For each output sample, fractional source-frame coordinate advances by speed * sourceSampleRate / outputSampleRate. The future renderer owns interpolation, synthesis phase and latency. Source frame index for PCM lookup is floor(source-coordinate). This pure mapper itself does not supply or interpolate audio.
5. If looping, wrap modulo [A,B) in both directions, including when 128 rendered frames at ±8 speed cross multiple laps. Changing an enabled loop's bounds with the head outside moves to A for nonnegative speed or B-1 for negative speed. Seeking within the active loop preserves that position.
6. Without looping, a read beyond the source ends returns null (does not unexpectedly repeat). Render-time advance saturates the public position at 0 or sourceFrames **and retains an exhausted state** after crossing either unlooped terminus. Subsequent render quanta read null until a seek, actual directional reversal back toward the source, or enabled loop intentionally re-arms playback. Same-direction speed-magnitude edits and setting speed=0 preserve the exhausted state; they do not resurrect the terminal sample. A seek to the same clamped coordinate is meaningful if it re-arms an exhausted stream. Negative speed starting at source EOF starts on the last available sample.
7. The render-time advance(n) method returns only the scalar source-frame coordinate and allocates no frozen state snapshot; UI callers may request the immutable state getter separately. Every distinct user command increments source-time control revision once; rendering frames does not. No-op commands do not increment it. DSP requested/applied revisions are separate and must not be conflated with transport revision.

## Current DSP capability matrix, not implementation acceptance

| Required signed speed | Current main at 8caa8f3 | To implement and verify |
| --- | --- | --- |
| 0.5..2, positive | Rust liveFactors sourceRate=s and spectralRatio=p/s; offline models plan 1.5s chunks | Move to continuous source transport and preserve independent pitch |
| 0 < s < 0.5 and 2 < s <= 8 | Current liveFactors and renderPCM reject these bounds; planChunk alone allows positive values, but its downstream renderPCM rejects them | Extended time-stretch model processing, CPU/fidelity evidence |
| -8 <= s < 0 | Rejected; no proven reverse source reader | Reverse PCM access and DSP pitch preservation, stereo/transient checks |
| s = 0 | Rejected; undefined p/s | Deliberate frozen-time synthesis algorithm that produces acceptable audible output |
| Loop 1..N frames | No source-sample loop in current Worker scheduler | Render without per-lap buffer/node recreation, verify no inserted silent output frames |

Pitch remains independent, current accepted range ±12 semitones unless separately changed; ordinary display one decimal, editable canonical precision at least 0.001. Source-time freeze at speed=0 **does not** by itself produce a usable sustained sound. Output quality must be independently measured.

## Integration rules

- Audio Lab existing lab-stream.mjs has CHUNK_SECONDS=1.5 and schedules new AudioBufferSourceNode instances. Extending planChunk with A/B parameters does not solve the no-gap requirement. A continuous bounded PCM producer and real-time renderer must implement the mapping rather than relying on a 1.5s Worker buffer at each loop.
- **Do not widen liveFactors validation alone.** The p/s ratio is undefined for zero and a negative value is not an established reverse-time/pitch-independent synthesis path.
- Separate source time, PCM frame access, time-stretch/pitch DSP, UI input drafts/rail/display, output clock and audible latency. A UI request is not proof that a DSP backend has applied it; use existing playback-feedback semantics for explicit applied acknowledgment.
- Do not copy Frequency Warp dual-thumb.mjs semantics: its two values are unordered; musical time A/B bounds are ordered and refer to source sample coordinates.
- Preserve existing source load generation fences, native file picker, model comparison, research controls and last-good state when new paths fail. A failed negative/zero speed request must not masquerade as successful positive-speed original playback.

## R2/R3 acceptance boundary

- Source-frame producer and a persistent audio callback with no per-lap node recreation or Worker wait; no allocations in real-time render loop when possible. Test for zero inserted output frames and loop phase/joins independently.
- Tests at 1, 2, 16, 127, 128, 129 and 256 source samples; positive/negative/zero speed, mid-playback loop edits, exact sample-rate conversion at 44.1/48/96kHz, source stereo, transients and actual music.
- Test the negative-to-zero-to-positive transition without false DSP applied/ready status. Verify 1.237 remains internally 1.237 when shown as 1.24 and after rail range change.
- Measure UI event -> requested -> applied -> rendered -> audible latency separately. Do not report a zero-ms physical response merely because a 128-frame callback exists.
- Physical iPhone Safari waveform gesture, source picker, background/resume, CPU/underrun and real recordings remain independent acceptance; emulated Chromium is not sufficient.

**Next:** R1 implementation must be reviewed and merged independently. R2 is the first stage that can provide actual continuous real-time audio; keep gapless and zero/negative sonic acceptance OPEN until measured.
