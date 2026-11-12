"""Process entry point: one realtime voice session per process, driven by the Happier daemon.

Control protocol: one JSON object per line. stdin carries daemon -> runtime messages, stdout
carries runtime -> daemon messages, and stderr carries logs only.

daemon -> runtime
  {"type": "start", "config": RuntimeConfig, "offer": {"sdp": str, "type": "offer"}}   (first line)
runtime -> daemon
  {"type": "answer", "sdp": str, "sdpType": str, "pcId": str}
  {"type": "ended", "reason": "client_disconnected" | "stopped" | "stdin_closed" | "finished"}
  {"type": "error", "code": str, "fields": [str]}   (fields name invalid config keys, never values)

The daemon stops a session the way it stops every child it owns, by terminating the process
tree: SIGTERM ends the session cleanly ("stopped"), and the daemon escalates if it does not exit.
Closing stdin also ends the session, so a daemon that dies cannot leave a runtime streaming audio
to Deepgram on its behalf. The process exits after "ended" or "error".
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from typing import Any

from loguru import logger
from pydantic import ValidationError

from .config import RuntimeConfig


def _emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _invalid_fields(error: ValidationError) -> list[str]:
    # Pydantic's messages quote the rejected input, which may be the credential.
    return sorted({".".join(str(part) for part in issue["loc"]) for issue in error.errors()})


async def _read_line(reader: asyncio.StreamReader) -> dict[str, Any] | None:
    line = await reader.readline()
    if not line:
        return None
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        return {"type": "invalid"}
    return message if isinstance(message, dict) else {"type": "invalid"}


async def _stdin_reader() -> asyncio.StreamReader:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    return reader


async def run_session(reader: asyncio.StreamReader) -> int:
    # Imported here so a malformed start line is answered without paying Pipecat's import time.
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
    from pipecat.workers.runner import WorkerRunner

    from .pipeline import build_pipeline_task

    start = await _read_line(reader)
    if start is None or start.get("type") != "start":
        _emit({"type": "error", "code": "expected_start", "fields": []})
        return 2
    try:
        config = RuntimeConfig.model_validate(start.get("config"))
    except ValidationError as error:
        _emit({"type": "error", "code": "invalid_config", "fields": _invalid_fields(error)})
        return 2
    offer = start.get("offer")
    if not isinstance(offer, dict) or not isinstance(offer.get("sdp"), str) or offer.get("type") != "offer":
        _emit({"type": "error", "code": "invalid_offer", "fields": ["offer"]})
        return 2

    connection = SmallWebRTCConnection(
        ice_servers=[
            IceServer(
                urls=server.urls,
                username=server.username,
                credential=server.credential.get_secret_value() if server.credential else None,
            )
            for server in config.ice_servers
        ]
    )
    try:
        await connection.initialize(sdp=offer["sdp"], type=offer["type"])
    except Exception as error:  # aiortc rejects malformed SDP with assorted exception types
        logger.warning(f"Rejected the WebRTC offer: {error}")
        _emit({"type": "error", "code": "invalid_offer", "fields": ["offer"]})
        return 2
    answer = connection.get_answer()
    if answer is None:
        _emit({"type": "error", "code": "no_answer", "fields": []})
        return 1
    _emit({"type": "answer", "sdp": answer["sdp"], "sdpType": answer["type"], "pcId": answer["pc_id"]})

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    task = build_pipeline_task(config, transport)
    end_reason = "finished"

    async def end(reason: str) -> None:
        nonlocal end_reason
        if end_reason == "finished":
            end_reason = reason
        await task.cancel()

    @transport.event_handler("on_client_disconnected")
    async def _on_client_disconnected(_transport: Any, _client: Any) -> None:
        await end("client_disconnected")

    async def watch_stdin() -> None:
        # Nothing else is read after the start line; this only notices the daemon going away.
        while await _read_line(reader) is not None:
            pass
        await end("stdin_closed")

    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        # Windows has no SIGTERM to catch: the daemon's process-tree termination ends it outright.
        loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.ensure_future(end("stopped")))
    control = asyncio.create_task(watch_stdin())
    try:
        await WorkerRunner(handle_sigint=False).run(task)
    finally:
        control.cancel()
        await connection.disconnect()
    _emit({"type": "ended", "reason": end_reason})
    return 0


def main() -> None:
    logger.remove()
    # Logs go to the daemon's log; DEBUG includes what the user said, so it is opt-in.
    logger.add(sys.stderr, level=os.environ.get("HAPPIER_VOICE_RUNTIME_LOG_LEVEL", "INFO").upper())

    async def entry() -> int:
        return await run_session(await _stdin_reader())

    sys.exit(asyncio.run(entry()))


if __name__ == "__main__":
    main()
