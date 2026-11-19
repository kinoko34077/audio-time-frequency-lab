# Progressive decoder fixtures

The `progressive-probe.*` files are generated test tones, not recordings. Each
contains two seconds of a 440 Hz sine wave duplicated to stereo at 48 kHz.
FFmpeg generated the MP3, AAC-LC/M4A, Opus/Ogg, and FLAC encodings. They exist
to exercise the browser demuxer and bounded source-frame reads without adding
third-party audio to the product.
