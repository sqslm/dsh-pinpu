"""Stream system audio as raw mono float32 PCM — the capture side of dsh-pinpu.

Why this exists: Chromium can only capture an *enabled capture endpoint*, so
`getUserMedia` sees microphones and (at best) a Stereo Mix that mirrors one
specific output device. What a listener wants is "whatever the machine is
playing", i.e. the WASAPI **loopback of the default render device** — and that is
not exposed as a capture endpoint at all. PyAudioWPatch bundles a PortAudio build
that adds a `[Loopback]` input for every render device, which is exactly the
capability needed here. It is vendored next to this file (≈290 KB) so nothing has
to be downloaded.

Contract with the host half (`lib/loopback.js`):

- **stdout** — raw little-endian float32 mono samples at the device's mix rate,
  nothing else, flushed per chunk.
- **stderr** — one JSON header line first: `{"rate":48000,"channels":2,"device":"…"}`,
  then free-form diagnostics, one per line.
- `--list` — print a JSON array of loopback devices on stdout and exit.
- The process runs until killed (SIGTERM / stdin EOF / BrokenPipe).

Usage:
  python loopback.py [--device <index|name-substring>] [--chunk 1024]
  python loopback.py --list
"""
import argparse
import json
import sys
from array import array

try:
    import pyaudiowpatch as pyaudio
except ImportError as error:  # pragma: no cover - reported to the host as a status line
    sys.stderr.write(json.dumps({"error": "pyaudiowpatch-missing", "detail": str(error)}) + "\n")
    raise SystemExit(3)


def list_devices(audio):
    """Every loopback (render-device) input, plus which one is the default output."""
    try:
        default = audio.get_default_wasapi_loopback()
        default_name = default["name"]
    except Exception:  # noqa: BLE001 - any PortAudio failure means "no default loopback"
        default_name = None
    out = []
    for info in audio.get_loopback_device_info_generator():
        out.append(
            {
                "index": int(info["index"]),
                "name": str(info["name"]),
                "channels": int(info["maxInputChannels"]),
                "rate": int(info["defaultSampleRate"]),
                "default": str(info["name"]) == default_name,
            }
        )
    return out


def pick_device(audio, wanted):
    """Resolve `--device` (index or name substring) to a loopback device; default = default output."""
    devices = list_devices(audio)
    if len(devices) == 0:
        return None
    if wanted is None or wanted == "":
        for device in devices:
            if device["default"]:
                return device
        return devices[0]
    if wanted.isdigit():
        for device in devices:
            if device["index"] == int(wanted):
                return device
        return None
    needle = wanted.lower()
    for device in devices:
        if needle in device["name"].lower():
            return device
    return None


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--device", default="")
    parser.add_argument("--chunk", type=int, default=1024)
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    audio = pyaudio.PyAudio()

    if args.list:
        sys.stdout.write(json.dumps(list_devices(audio), ensure_ascii=False))
        sys.stdout.flush()
        audio.terminate()
        return

    device = pick_device(audio, args.device)
    if device is None:
        sys.stderr.write(json.dumps({"error": "no-loopback-device", "wanted": args.device}) + "\n")
        raise SystemExit(4)

    rate = int(device["rate"])
    channels = max(1, int(device["channels"]))
    # Announce the format before any sample: the host cannot infer it from raw bytes.
    sys.stderr.write(
        json.dumps({"rate": rate, "channels": channels, "device": device["name"]}, ensure_ascii=False) + "\n"
    )
    sys.stderr.flush()

    stream = audio.open(
        format=pyaudio.paFloat32,
        channels=channels,
        rate=rate,
        input=True,
        input_device_index=device["index"],
        frames_per_buffer=args.chunk,
    )

    out = sys.stdout.buffer
    try:
        while True:
            raw = stream.read(args.chunk, exception_on_overflow=False)
            if channels == 1:
                out.write(raw)
            else:
                samples = array("f")
                samples.frombytes(raw)
                frames = len(samples) // channels
                mono = array("f", bytes(4 * frames))
                for index in range(frames):
                    base = index * channels
                    total = 0.0
                    for channel in range(channels):
                        total += samples[base + channel]
                    mono[index] = total / channels
                out.write(mono.tobytes())
            out.flush()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except OSError as error:
        # Device removed, format change, exclusive-mode conflict: the host restarts us.
        sys.stderr.write(json.dumps({"error": "capture-failed", "detail": str(error)}) + "\n")
        sys.stderr.flush()
        raise SystemExit(5)
    finally:
        try:
            stream.stop_stream()
            stream.close()
        finally:
            audio.terminate()


if __name__ == "__main__":
    main()
