"""MikoPark voice engine: a tiny local HTTP service that speaks text in a cloned voice.

It wraps Chatterbox (MIT license, https://github.com/resemble-ai/chatterbox). MikoPark's server
calls it with the text to speak and the path of a voice sample on this machine; it returns WAV audio.

    GET  /health  -> {"ok": true, "model": "turbo", "device": "mps"}
    POST /speak   {"text": "...", "voice_path": "/abs/path/sample.mp3"} -> audio/wav

Environment:
    VOICE_ENGINE_PORT   default 5055
    VOICE_MODEL         turbo (default, fast English) | standard | nano (small, CPU-friendly)
    VOICE_DEVICE        auto (default) | mps | cuda | cpu
    VOICE_ENGINE_FAKE=1 skip loading a model and return a test tone (for development and tests)
"""

import io
import json
import math
import os
import struct
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("VOICE_ENGINE_PORT", "5055"))
MODEL = os.environ.get("VOICE_MODEL", "turbo")
FAKE = os.environ.get("VOICE_ENGINE_FAKE") == "1"
MAX_CHARS = 1000


def pick_device() -> str:
    wanted = os.environ.get("VOICE_DEVICE", "auto")
    if wanted != "auto":
        return wanted
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class Engine:
    """Loads the model once and serialises generation (one request at a time)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.voice_path = None
        if FAKE:
            self.device, self.model, self.sr = "none", None, 24000
            return
        self.device = pick_device()
        if MODEL == "standard":
            from chatterbox.tts import ChatterboxTTS

            self.model = ChatterboxTTS.from_pretrained(device=self.device)
        else:
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            self.model = ChatterboxTurboTTS.from_pretrained(device=self.device, **({"nano": True} if MODEL == "nano" else {}))
        self.sr = self.model.sr

    def speak(self, text: str, voice_path: str, exaggeration=None, cfg_weight=None) -> bytes:
        with self.lock:
            if FAKE:
                return to_wav(fake_tone(len(text)), self.sr)
            kwargs = {}
            if exaggeration is not None:
                kwargs["exaggeration"] = float(exaggeration)
            if cfg_weight is not None:
                kwargs["cfg_weight"] = float(cfg_weight)
            # Reuse the voice's conditioning when the same sample is asked for again.
            if voice_path != self.voice_path and hasattr(self.model, "prepare_conditionals"):
                self.model.prepare_conditionals(voice_path)
                self.voice_path = voice_path
            if self.voice_path == voice_path:
                wav = self.model.generate(text, **kwargs)
            else:
                wav = self.model.generate(text, audio_prompt_path=voice_path, **kwargs)
            return to_wav(wav.squeeze().detach().cpu().numpy(), self.sr)


def fake_tone(n_chars: int):
    seconds = min(0.2 + n_chars * 0.01, 5)
    return [0.2 * math.sin(2 * math.pi * 440 * i / 24000) for i in range(int(24000 * seconds))]


def to_wav(samples, sr: int) -> bytes:
    """Float samples in [-1, 1] (a numpy array or a list) -> 16-bit mono WAV bytes."""
    if hasattr(samples, "clip"):
        pcm = (samples.clip(-1.0, 1.0) * 32767).astype("<i2").tobytes()
    else:
        pcm = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


ENGINE = None


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": "fake" if FAKE else MODEL, "device": ENGINE.device})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        text = str(body.get("text", "")).strip()
        voice_path = str(body.get("voice_path", ""))
        if not text:
            return self._json(400, {"error": "text is required"})
        if len(text) > MAX_CHARS:
            return self._json(400, {"error": f"text is longer than {MAX_CHARS} characters"})
        if not os.path.isfile(voice_path):
            return self._json(400, {"error": "voice sample not found"})
        try:
            audio = ENGINE.speak(text, voice_path, body.get("exaggeration"), body.get("cfg_weight"))
        except Exception as err:  # surface model errors to MikoPark instead of dropping the connection
            return self._json(500, {"error": f"{type(err).__name__}: {err}"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet; errors are returned to MikoPark


def main():
    global ENGINE
    print(f"Voice engine: loading {'fake engine' if FAKE else MODEL + ' model'}… (first run downloads the model)", flush=True)
    ENGINE = Engine()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Voice engine ready on http://127.0.0.1:{PORT} ({ENGINE.device})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
