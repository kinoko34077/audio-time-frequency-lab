# Audio Lab — Source-time transport contract (#36)

Status: R0/R1 accepted in main via PR #37; R2 experimental PCM AudioWorklet via PR #38 and original-audio opt-in integration via PR #39, followed by cache/seek fixes in PR #40 (2026-11-12). The time mapper is used by the experimental Worklet only at `?pcmTransport=1` + original play. Normal music DSP/UI/export are not migrated. **These changes do not demonstrate independent-pitch negative/zero speed or complete gapless output.**

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

**Next:** R2 must establish real-time PCM continuity under source-window underruns, loop changes, long recordings and audio-thread load. R1 was already reviewed and merged. Keep gapless and zero/negative musical sonic acceptance OPEN until measured.

## R2 bounded experimental source-PCM slice (not full R2 acceptance)

Source files added for the bounded first step:
- `web-demo/source-pcm-renderer.mjs` provides a persistent raw-PCM block renderer, linear source-frame interpolation, source-time loop wrap and bounded source-window cache (max 65,536 source frames/window, four windows by default; mono/stereo). A/B endpoints can occupy two pinned windows while two moving windows overlap during prefetch. Cache eviction protects the currently read source window and the nearest upcoming window, rejecting speculative far-ahead refills when necessary; this bounds cache allocations but is not proof of zero underrun under main-thread stalls. `missingFrames` is an explicit source-cache underrun count; normal source EOF silence is not mislabeled as a cache underrun.
- `web-demo/source-pcm.worklet.js` is a distinct experimental AudioWorkletProcessor, named `audio-lab-source-pcm`, with one persistent node and commands for seek/speed/bounds/loop/play/pause. It reports **command accepted** separately from audio-render progress and cache misses.
- `web-demo/source-pcm-bridge.mjs` sends bounded slices of local decoded PCM to the worklet. It does not send the whole track. Worklet cache refill requests are message-driven and may be delayed by the browser main thread. Explicit far seeks send the destination PCM and source-frame seek in one atomic `seek-window` Worklet message, admitting the destination range even when a full loop cache would otherwise reject distant speculative prefetch. This avoids a cache-eviction-induced seek gap; it does not establish zero end-to-end latency or all-device gaplessness.
- `web-demo/source-pcm-renderer.test.mjs` plus `web-demo/source-pcm-worklet.browser.test.mjs` test source-frame order, tiny A/B loops, reverse, sample-rate conversion, stereo, cache bounds, underruns and live Chrome callback activity.

**R2 completion remains OPEN:** The raw renderer has an explicit experimental original-audio entry path (`?pcmTransport=1`); regular pages and the real musical-pitch DSP remain unchanged. It is not pitch-preserving for non-unit speed. At speed 0 it outputs a held PCM sample (DC) instead of a useful stationary sound. A cache miss still produces zero output frames and is counted; therefore the architecture must be strengthened and stress-tested before **no underrun / no buffering sensation** may be accepted. Loop audio clicks, interpolation anti-aliasing, independent pitch at ±8, real-time scrubbing, and physical iOS Safari remain unverified. An all-green Node test only proves the bounded deterministic fixture, not device performance. The existing Rust live and 1.5-second model-preview implementation remains the unchanged user-facing path during this slice.

## R2 experimental local-file end-to-end opt-in (follow-up slice)

- `web-demo/app.mjs` imports `createSourcePCMBridge`, but calls it **only** when the URL query is exactly `pcmTransport=1` and the existing **original-audio** button is used. No experimental PCM mode is selected by default; the existing Rust/WASM wet output and PV/WSOLA/dual/AM paths retain their established audio semantics.
- The existing native local file decode and `state.dry` PCM are reused. `source-pcm-bridge.mjs` sends bounded windows; a new `AudioWorkletNode` is created only when starting the explicitly selected raw source session. Waveform seek sends a sample-frame command to that same node rather than executing the imported BufferSource stop/start and 40ms mute path. The existing `transportEpoch` fences old async launches and `stop()` disposes the raw node.
- Test the actual `index.html` with a synthetic native WAV loaded through `#audio-file`, start `#play-dry`, confirm raw source AudioWorklet progress and 0 reported cache misses, drag waveform while playing and prove no node restart, then stop with state cleanup; this tests the actual route rather than only the isolated Worklet fixture.
- The opt-in raw session intentionally uses speed **+1** and whole-file looping to preserve previous original-audio semantics. User-facing signed ±8 and independent pitch are **not** enabled or claimed. Do not present this query flag as a completed AudioStretch player.
- The seek test proves *node reuse*, not zero output silence, imperceptible audio discontinuity, sample-accurate audible latency, sustained 0 speed, or iPhone Safari operation; those remain open R2/R3/R5 acceptance. Never silently fall back to a different pitch/transport DSP when an explicit opt-in raw backend fails.


## R2 F1/F2 audit fixes — render clock and atomic A/B changes

- **F1 (source-cache miss):** Rendered output advances the source clock for the entire output quantum **even if some frames are zero-filled due to missing PCM**. Missing output frames are still counted and the first missing source frame is requested. Previously the renderer emitted a valid prefix but held the entire source clock, replaying audible samples after refilling the cache. The revised contract deliberately **drops the unavailable source interval** instead of replaying already rendered samples; this is recoverable real-time behavior, **not** a guarantee of no audible dropout. Explicit loop time and no-loop EOF follow the same time rule.
- **F2 (A/B or loop-on change):** Source-frame bounds, loop enablement and both endpoint PCM cache windows are transferred in a single `loop-config` AudioWorklet message and validated **before** mutation. The synchronous processor handler applies the new transport interval and its endpoint caches without a process quantum between them. Explicit seek already uses an independent atomic `seek-window` message. Loop-off releases the old endpoint pins so unlooped playback can use the bounded cache.
- **Evidence boundaries:** Dedicated deterministic unit tests reproduce the former partial-underrun replay and stale-A/B PCM pin state. Native Chrome Worklet regression tests change loop bounds while the Worklet is playing and inspect the applied source-frame interval and missing-frame count. Device-level audible discontinuities, filter/DSP effects, and physical iPhone Safari remain open R2/R5 acceptance.

## R2 worklet lifecycle and command recovery

- Worklet command/control request IDs (including source-seek and atomic A/B updates) require a matching processor acknowledgment. The host bounds each outstanding command to a configurable timeout (default **5 seconds**); late or missing acknowledgments cannot leave pending Promises unresolved indefinitely. A timeout enters a **fatal** state rather than claiming an applied setting.
- Unexpected `AudioWorkletNode.processorerror` is distinct from ordinary pause/stop, expected no-loop EOF or low-level cache underrun. Fatal errors disconnect the unusable output, reject all outstanding commands, clear outstanding timers and emit `fatal-error` to the owning session. The opt-in original player stops and displays the error while retaining the last successfully decoded file for retry. Normal dispose remains an intentional operation and must not emit a fatal error.
- Real Chrome tests inject a processor fatal event during a pending seek, blackhole a command acknowledgement until timeout, and trigger a processor fatal in the **actual user file/playback path**, asserting file retention/restart and no stale `raw-experimental` state.
- Recovery/timeout does not imply uninterrupted sound under a true processor crash. Source-cache underruns and unexpected processor termination are different fault classes with different telemetry.


## R2 real output PCM stress gate (instrumentation, not acceptance of all loads)

A test-only `source-pcm-probe.worklet.js` measures PCM **after** the experimental source renderer's AudioWorkletNode, without reusing the source cache's `missingFrames` counter as proof of audible output. Chrome `source-pcm-stress.browser.test.mjs` reports:
- 44.1kHz source → 48kHz output, stereo nonzero constant test signal and 1/2/16/127/128/129/256-sample A/B loops at ±8 raw source speed. Only these *fully cached, static* loops are gated for **zero output frames containing unexpected silence** and no unexplained sample jumps.
- A pinned short loop while the browser main thread is synchronously blocked, verifying that independent audio rendering does not rely on the blocked thread when its source data is already cached.
- 2,000,000-source-frame long stereo audio at +8 raw speed with a deliberately 1,050ms blocked main thread. This exceeds the finite window cache's supply horizon; the test **reports** source cache misses, independent post-render zero frames, sample jumps and output counts, **without requiring an impossible zero-gap result**. It then seeks, changes speed and measures recovery and command ACK latency (ACK latency is *not* physical audible latency).

For constant nonzero PCM, observed exact zeros are unintended inserted silence, not legitimate program quiet. For arbitrary musical recordings this simple metric is not enough; source-equivalent PCM alignment, intentional loop-boundary jumps, envelope/click tests, source-to-render ACK and actual device output latency must be measured separately. Headless Chrome is not a physical iPhone, and a CI green result cannot replace live device acceptance.
