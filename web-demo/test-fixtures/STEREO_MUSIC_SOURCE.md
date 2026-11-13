# Real full-mix STEREO MUSIC regression source — Audio Lab #36

**User requirement (2026-11-14):** Use actual complete stereo musical material as the PRIMARY audio-quality acceptance target instead of treating a mono one-note piano recording as a representative song.

- **Title:** Determined Pursuit (epic orchestra loop)
- **Composer / uploader:** Emma_MA
- **Recording/content:** complete orchestral music with strings, horns and drums, originally published January 2017; NOT a synthetic mono test tone.
- **Canonical work, author CC0 declaration and provenance:** https://opengameart.org/content/determined-pursuit-epic-orchestra-loop
- **License:** CC0 1.0 Universal. Author's page explicitly states the track entered the public domain in January 2017, no attribution required. The author credit is retained for traceability.
- **Original source file:** https://opengameart.org/sites/default/files/determined_pursuit_loop.wav
- **Acquisition:** only within GitHub Actions CI, from this exact documented URL. Download into `web-demo/test-fixtures/determined-pursuit-cc0-full-stereo.wav` (not tracked or shipped by the Pages dependency-graph builder). Verify hash/RIFF/channel count, actual left–right sample difference and duration from the full decoded song before any test acceptance. Do not silently replace with a generated or unrelated sample.
- **SHA-256:** PENDING initial exact CI fetch; pin before treating the source as accepted canonical fixture.
- **Limitations:** One finished stereo orchestral composition is not evidence about singing, every recording/mix style, codecs, hardware DAC or human subjective quality. Keep previous mono piano fixture for narrow source-precision regressions only; do NOT use it as the main music-quality criterion.

The production app itself must continue to open arbitrary user-supplied files. This fixture is only for CI measurement and must NOT be uploaded to Pages.
