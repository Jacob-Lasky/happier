"""Live round trip against the real Deepgram service, playing the Happier app's part.

    DEEPGRAM_API_KEY=... uv run python scripts/live_roundtrip.py --out <dir> [--stt-model flux-general-en]

1. Synthesizes a spoken request with Deepgram TTS (the "user"), padded with silence so the turn ends.
2. Starts the runtime as the daemon would (stdio control protocol) and connects to it over WebRTC.
3. Streams the speech in, waits for the bridge's `happier.user_turn`, streams a reply back as
   `happier.speak` deltas, and records the audio the bot sends.
4. Transcribes that recording with Deepgram, so the proof covers STT -> bridge -> TTS -> transport.

Writes `<out>/proof.json`, `<out>/user.wav` and `<out>/bot.wav`. The key is read from the
environment and is never written anywhere.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer, MediaRecorder

USER_PROMPT = "Please ask the coding session to run the unit tests."
REPLY_DELTAS = ["Sure, I asked the session ", "to run the unit tests. ", "I will tell you when they finish."]
EXPECTED_USER_WORDS = {"unit", "tests"}
EXPECTED_REPLY_WORDS = {"session", "unit", "tests", "finish"}

# Barge-in: the user talks over a long reply, which must stop and be reported as interrupted.
BARGE_IN_PROMPT = "Stop, wait a second."
LONG_REPLY_DELTAS = [
    "Sure, I asked the session to run the unit tests. ",
    "While they run, here is a summary of what changed today. ",
    "The parser now handles empty files, the cache key includes the locale, ",
    "and the retry loop backs off exponentially instead of hammering the server. ",
    "There were also several small documentation fixes across the repository.",
]


async def synthesize_user_wav(
    session: aiohttp.ClientSession, key: str, path: Path, script: list[tuple[str, float]]
) -> None:
    """Writes 1 s of silence, then each (utterance, seconds of silence after it)."""
    params = None
    chunks: list[bytes] = []
    for text, gap_s in script:
        async with session.post(
            "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=48000&container=wav",
            headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
            json={"text": text},
        ) as response:
            response.raise_for_status()
            speech = await response.read()
        with wave.open(io.BytesIO(speech)) as source:
            params = source.getparams()
            chunks.append(source.readframes(source.getnframes()))
        chunks.append(b"\x00" * int(params.sampwidth * params.nchannels * params.framerate * gap_s))
    assert params is not None
    with wave.open(str(path), "wb") as out:
        out.setparams(params)
        out.writeframes(b"\x00" * (params.sampwidth * params.framerate) + b"".join(chunks))


async def transcribe(session: aiohttp.ClientSession, key: str, path: Path) -> str:
    async with session.post(
        "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
        headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
        data=path.read_bytes(),
    ) as response:
        response.raise_for_status()
        body = await response.json()
    return body["results"]["channels"][0]["alternatives"][0]["transcript"]


def words(text: str) -> set[str]:
    return {w.strip(".,!?").lower() for w in text.split()}


def rtvi(kind: str, data: dict[str, Any] | None, msg_id: str) -> str:
    return json.dumps({"label": "rtvi-ai", "type": kind, "id": msg_id, "data": data})


async def run(args: argparse.Namespace) -> dict[str, Any]:
    key = os.environ["DEEPGRAM_API_KEY"]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    user_wav, bot_wav = out / "user.wav", out / "bot.wav"
    events: list[dict[str, Any]] = []
    t0 = time.monotonic()

    def mark(kind: str, **extra: Any) -> None:
        events.append({"t_ms": round((time.monotonic() - t0) * 1000), "event": kind, **extra})

    barge_in = args.scenario == "barge-in"
    script = [(USER_PROMPT, 2.5), (BARGE_IN_PROMPT, 5.0)] if barge_in else [(USER_PROMPT, 4.0)]
    reply = LONG_REPLY_DELTAS if barge_in else REPLY_DELTAS
    async with aiohttp.ClientSession() as http:
        await synthesize_user_wav(http, key, user_wav, script)

        runtime = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "happier_voice_runtime",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=open(out / "runtime.log", "wb"),
            # The runtime gets its credential on stdin, as from the daemon; it never inherits the key.
            env={name: value for name, value in os.environ.items() if name != "DEEPGRAM_API_KEY"},
        )
        assert runtime.stdin and runtime.stdout

        pc = RTCPeerConnection()
        player = MediaPlayer(str(user_wav))
        pc.addTrack(player.audio)
        recorder = MediaRecorder(str(bot_wav))
        channel = pc.createDataChannel("chat", ordered=True)
        user_turn: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        user_turns: list[str] = []
        second_turn = asyncio.Event()
        interrupted: list[int] = []
        bot_stopped = asyncio.Event()
        bot_started_at: list[float] = []
        bot_speaking = False

        @pc.on("track")
        def on_track(track: Any) -> None:
            if track.kind == "audio":
                recorder.addTrack(track)

        @channel.on("message")
        def on_message(raw: Any) -> None:
            nonlocal bot_speaking
            message = json.loads(raw) if isinstance(raw, str) else {}
            kind = message.get("type")
            if kind == "server-message":
                data = message.get("data") or {}
                mark("server-message", data=data)
                if data.get("type") == "happier.user_turn":
                    user_turns.append(data.get("text", ""))
                    if not user_turn.done():
                        user_turn.set_result(data.get("text", ""))
                    else:
                        second_turn.set()
            elif kind == "bot-interrupted":
                # Pipecat reports every user turn start as an interruption; only one that cut the
                # bot off mid-reply is a barge-in.
                if bot_speaking:
                    interrupted.append(len(user_turns))
                mark(kind, bot_speaking=bot_speaking)
            elif kind in (
                "bot-ready",
                "user-started-speaking",
                "user-stopped-speaking",
                "bot-started-speaking",
                "bot-stopped-speaking",
                "error",
            ):
                mark(kind)
                if kind == "bot-started-speaking":
                    bot_started_at.append(time.monotonic())
                    bot_speaking = True
                if kind == "bot-stopped-speaking":
                    bot_speaking = False
                if kind == "bot-stopped-speaking" and user_turn.done():
                    bot_stopped.set()
            elif kind == "user-transcription":
                mark(kind, final=(message.get("data") or {}).get("final"), text=(message.get("data") or {}).get("text"))

        async def keepalive() -> None:
            while True:
                if channel.readyState == "open":
                    channel.send(f"ping: {time.time()}")
                await asyncio.sleep(1)

        @channel.on("open")
        def on_open() -> None:
            mark("datachannel-open")
            channel.send(
                rtvi(
                    "client-ready",
                    {
                        "version": "2.3.0",
                        "about": {"library": "happier-live-harness", "library_version": "0.1.0", "platform": "python"},
                    },
                    "ready",
                )
            )

        await pc.setLocalDescription(await pc.createOffer())  # aiortc gathers ICE before returning
        start = {
            "type": "start",
            "config": {
                "credential": {"kind": "api_key", "value": key},
                "stt": {"model": args.stt_model},
                "tts": {"voice": args.tts_voice},
            },
            "offer": {"sdp": pc.localDescription.sdp, "type": "offer"},
        }
        runtime.stdin.write((json.dumps(start) + "\n").encode())
        await runtime.stdin.drain()
        answer = json.loads(await asyncio.wait_for(runtime.stdout.readline(), 60))
        assert answer.get("type") == "answer", answer
        mark("answer")
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["sdpType"]))
        await recorder.start()
        pinger = asyncio.create_task(keepalive())

        text = await asyncio.wait_for(user_turn, 45)
        turn_at = time.monotonic()
        for index, delta in enumerate(reply):
            channel.send(
                rtvi(
                    "client-message",
                    {"t": "happier.speak", "d": {"seq": 0, "text": delta, "final": index == len(reply) - 1}},
                    f"speak-{index}",
                )
            )
        if barge_in:
            await asyncio.wait_for(second_turn.wait(), 45)
        await asyncio.wait_for(bot_stopped.wait(), 45)
        await asyncio.sleep(0.5)

        runtime.terminate()  # what the daemon's process-tree termination sends first
        ended = json.loads(await asyncio.wait_for(runtime.stdout.readline(), 30))
        mark("ended", reason=ended.get("reason"))
        pinger.cancel()
        await recorder.stop()
        await pc.close()
        await asyncio.wait_for(runtime.wait(), 30)

        bot_transcript = await transcribe(http, key, bot_wav)

    first_audio_ms = round((bot_started_at[0] - turn_at) * 1000) if bot_started_at else None
    proof = {
        "stt_model": args.stt_model,
        "tts_voice": args.tts_voice,
        "user_prompt": USER_PROMPT,
        "user_turn_text": text,
        "scenario": args.scenario,
        "user_turns": user_turns,
        "interrupted_seqs": interrupted,
        "reply_text": "".join(reply),
        "bot_audio_transcript": bot_transcript,
        "reply_to_first_bot_audio_ms": first_audio_ms,
        "runtime_exit_code": runtime.returncode,
        "ended_reason": ended.get("reason"),
        "checks": {
            "user_turn_has_expected_words": EXPECTED_USER_WORDS <= words(text),
            "runtime_ended_cleanly": runtime.returncode == 0 and ended.get("reason") == "stopped",
            **(
                {
                    # The first reply (to user turn 1) was cut off by the user speaking again.
                    "reply_was_interrupted": interrupted[:1] == [1],
                    "second_turn_heard": len(user_turns) >= 2 and "stop" in words(user_turns[1]),
                    # Only the start of the long reply may be audible; its last sentence must not be.
                    "bot_audio_stops_early": "documentation" not in words(bot_transcript),
                }
                if barge_in
                else {"bot_audio_has_expected_words": EXPECTED_REPLY_WORDS <= words(bot_transcript)}
            ),
        },
        "events": events,
    }
    (out / "proof.json").write_text(json.dumps(proof, indent=2))
    return proof


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--stt-model", default="flux-general-en")
    parser.add_argument("--tts-voice", default="aura-2-helena-en")
    parser.add_argument("--scenario", choices=["round-trip", "barge-in"], default="round-trip")
    proof = asyncio.run(run(parser.parse_args()))
    print(
        json.dumps(
            {
                k: proof[k]
                for k in (
                    "scenario",
                    "stt_model",
                    "user_turns",
                    "interrupted_seqs",
                    "bot_audio_transcript",
                    "reply_to_first_bot_audio_ms",
                    "checks",
                )
            },
            indent=2,
        )
    )
    sys.exit(0 if all(proof["checks"].values()) else 1)


if __name__ == "__main__":
    main()
