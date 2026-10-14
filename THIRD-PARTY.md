# Third-party components

This plugin ships two small binaries so that it needs no dependency installation at runtime.
Both are permissively licensed, and both are vendored verbatim (no modifications):

| Path | Component | Licence |
| --- | --- | --- |
| `vendor/pyaudiowpatch/` | [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch) 0.2.12.9 — a PortAudio build with WASAPI loopback support | MIT |
| `vendor/_portaudiowpatch.cp312-win_amd64.pyd` | the PyAudioWPatch extension module for CPython 3.12 on Windows x64 | MIT |
| (inside the above) | [PortAudio](https://portaudio.com/) | MIT |

The Python helper `vendor/loopback.py` is part of this repository (MIT, as above) and is the
only code that talks to PortAudio: it opens the default output device's loopback endpoint and
streams mono `float32` PCM on stdout. The host half never loads a native module itself.

The ABI matters: the `.pyd` is built for **CPython 3.12**, so the helper must run with a 3.12
interpreter (DeepSeek Harness bundles one). A 3.13+ interpreter fails with
`No module named '_portaudiowpatch'`, which the host half reports as
`pyaudiowpatch-missing` and retries with the next candidate interpreter it finds.

Everything else in this repository is original work; there are no runtime npm dependencies.
