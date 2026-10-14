"""Probe: can PyAudioWPatch capture the *default render device's* loopback?

Prints every WASAPI loopback device, then records ~3 s from the default one and
reports RMS + peak per 100 ms window, so "is anything actually playing" is a
measurement rather than a guess.

Usage: python probe-loopback.py [seconds]
"""
import sys
import time

import numpy as np
import pyaudiowpatch as pyaudio

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0

audio = pyaudio.PyAudio()

print("WASAPI loopback devices:")
for info in audio.get_loopback_device_info_generator():
    print(
        "  idx={index} name={name!r} in={maxInputChannels} rate={defaultSampleRate}".format(**info)
    )

try:
    default = audio.get_default_wasapi_loopback()
except OSError as error:
    print("no default loopback:", error)
    raise SystemExit(1)

print("default loopback:", default["name"])
print("  index", default["index"], "channels", default["maxInputChannels"], "rate", default["defaultSampleRate"])

rate = int(default["defaultSampleRate"])
channels = int(default["maxInputChannels"])
stream = audio.open(
    format=pyaudio.paFloat32,
    channels=channels,
    rate=rate,
    input=True,
    input_device_index=default["index"],
    frames_per_buffer=1024,
)

windows = []
overall_peak = 0.0
frames = int(rate * seconds)
captured = 0
window = []
started = time.time()
while captured < frames:
    raw = stream.read(1024, exception_on_overflow=False)
    block = np.frombuffer(raw, dtype=np.float32)
    if channels > 1:
        block = block.reshape(-1, channels).mean(axis=1)
    window.append(block)
    captured += len(block)
    if sum(len(part) for part in window) >= rate // 10:
        chunk = np.concatenate(window)
        window = []
        rms = float(np.sqrt(np.mean(np.square(chunk))))
        peak = float(np.max(np.abs(chunk)))
        overall_peak = max(overall_peak, peak)
        windows.append((rms, peak))

stream.stop_stream()
stream.close()
audio.terminate()

print("windows (rms, peak) every 100 ms over %.1fs:" % (time.time() - started))
for rms, peak in windows:
    bar = "#" * int(min(60, rms * 300))
    print("  rms=%.4f peak=%.4f %s" % (rms, peak, bar))
print("OVERALL PEAK %.4f" % overall_peak)
print("RESULT:", "captured audio" if overall_peak > 0.001 else "silence")
